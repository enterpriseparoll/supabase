// One-time setup for PLATFORM_MODE=local on a developer machine (Docker Desktop).
// Generates control-plane secrets and the local Traefik routes, then prints the
// sign-in token. Safe to re-run: existing secrets are never replaced.
import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const root = resolve(process.env.PLATFORM_DATA_ROOT ?? '/srv/supabase-platform')
const port = Number(process.env.LOCAL_PORT ?? 8090)
if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('Invalid LOCAL_PORT')

await mkdir(`${root}/projects`, { recursive: true, mode: 0o700 })
await mkdir(`${root}/routes`, { recursive: true, mode: 0o755 })
// Backup downloads: written by the worker, read by the API (uid 1000).
await mkdir(`${root}/exports`, { recursive: true, mode: 0o755 })
// Containers with different users (postgres, node) read these files. This is
// acceptable only inside a single-user Docker Desktop VM, never on a server.
await mkdir(`${root}/secrets`, { recursive: true, mode: 0o755 })
await chmod(`${root}/secrets`, 0o755)

const hex = () => randomBytes(32).toString('hex')
const passwords = { owner: hex(), api: hex(), worker: hex() }
const wanted = {
  master_key: hex(),
  local_admin_token: randomBytes(24).toString('base64url'),
  // Encrypts the local backup repository. Losing it makes backups unreadable.
  restic_password: hex(),
}
for (const [role, password] of Object.entries(passwords)) {
  wanted[`db_${role}_password`] = password
  wanted[`database_url_${role}`] =
    `postgresql://control_${role}:${password}@control-db:5432/control`
}
// Database URLs must match passwords that already exist, so keep each pair together.
let created = 0
for (const role of Object.keys(passwords)) {
  const pass = `${root}/secrets/db_${role}_password`
  try {
    const existing = (await readFile(pass, 'utf8')).trim()
    wanted[`db_${role}_password`] = existing
    wanted[`database_url_${role}`] =
      `postgresql://control_${role}:${existing}@control-db:5432/control`
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
for (const [name, value] of Object.entries(wanted)) {
  try {
    await writeFile(`${root}/secrets/${name}`, value, { flag: 'wx', mode: 0o444 })
    created++
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

const entry = { entryPoints: ['web'] }
const routes = {
  http: {
    routers: {
      management: {
        rule: 'Host(`manage.localhost`)',
        ...entry,
        service: 'management',
        middlewares: ['management-limit', 'management-body'],
      },
    },
    services: { management: { loadBalancer: { servers: [{ url: 'http://api:3000' }] } } },
    middlewares: {
      'studio-auth': {
        forwardAuth: {
          address: 'http://api:3000/internal/studio-auth',
          trustForwardHeader: false,
          authRequestHeaders: ['Cookie', 'Origin'],
        },
      },
      'studio-headers': {
        headers: {
          customResponseHeaders: { 'Referrer-Policy': 'no-referrer' },
          frameDeny: true,
          contentTypeNosniff: true,
        },
      },
      'management-limit': { rateLimit: { average: 30, burst: 60 } },
      'management-body': { buffering: { maxRequestBodyBytes: 16384 } },
      'api-limit': { rateLimit: { average: 200, burst: 400 } },
    },
  },
}
// Traefik's file provider only loads .yml/.yaml/.toml files. JSON is valid YAML.
await writeFile(`${root}/routes/platform.yml`, JSON.stringify(routes, null, 2), { mode: 0o644 })
await rm(`${root}/routes/platform.json`, { force: true })

const signIn = (await readFile(`${root}/secrets/local_admin_token`, 'utf8')).trim()
console.log(
  [
    '',
    created ? 'Local platform secrets created.' : 'Local platform secrets already exist.',
    `Dashboard:      http://manage.localhost:${port}`,
    `Sign-in token:  ${signIn}`,
    '',
  ].join('\n')
)
