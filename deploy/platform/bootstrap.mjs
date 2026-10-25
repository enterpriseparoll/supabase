import { mkdir, writeFile, chown, chmod, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

function domain(value) {
  if (!value || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) throw new Error('Provide a valid PLATFORM_DOMAIN')
  return value
}
const env = process.env
const base = domain(env.PLATFORM_DOMAIN)
for (const name of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REQUIRED_ACR', 'ACME_EMAIL']) if (!env[name] || /[\r\n']/.test(env[name])) throw new Error(`Set ${name} without newlines or quotes`)
if (new URL(env.OIDC_ISSUER).protocol !== 'https:') throw new Error('OIDC_ISSUER must use HTTPS')
const root = resolve(env.PLATFORM_DATA_ROOT ?? '/srv/supabase-platform')
if (process.platform !== 'linux' && env.PLATFORM_BOOTSTRAP_TEST !== 'true') throw new Error('Production bootstrap requires Linux')
if (/[\r\n']/.test(root)) throw new Error('Invalid data root')
const envPath = resolve(import.meta.dirname, '.env')
try { await stat(envPath); throw new Error('Deployment .env already exists; bootstrap will not replace secrets') } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(`${root}/secrets`, { recursive: true, mode: 0o700 })
await mkdir(`${root}/routes`, { recursive: true, mode: 0o700 })
const passwords = Object.fromEntries(['owner', 'api', 'worker'].map((name) => [name, randomBytes(32).toString('hex')]))
const secrets = { master_key: randomBytes(32).toString('hex'), oidc_client_secret: env.OIDC_CLIENT_SECRET, restic_password: randomBytes(32).toString('hex'), backup_secret: env.BACKUP_SECRET ?? '' }
for (const [role, password] of Object.entries(passwords)) {
  secrets[`db_${role}_password`] = password
  secrets[`database_url_${role}`] = `postgresql://control_${role}:${password}@control-db:5432/control`
}
for (const [name, value] of Object.entries(secrets)) {
  const path = `${root}/secrets/${name}`
  await writeFile(path, value, { flag: 'wx', mode: 0o400 })
  // PostgreSQL (alpine UID 70) reads the db_* passwords; the Node runtime (UID 1000) reads the rest.
  if (process.platform === 'linux') await chown(path, name.startsWith('db_') ? 70 : 1000, name.startsWith('db_') ? 70 : 1000)
}
const routes = {
  http: {
    routers: { management: { rule: `Host(\`manage.${base}\`)`, entryPoints: ['websecure'], service: 'management', tls: { certResolver: 'letsencrypt' }, middlewares: ['management-limit', 'management-body'] } },
    services: { management: { loadBalancer: { servers: [{ url: 'http://api:3000' }] } } },
    middlewares: {
      'studio-auth': { forwardAuth: { address: 'http://api:3000/internal/studio-auth', trustForwardHeader: false, authRequestHeaders: ['Cookie', 'Origin'] } },
      'studio-headers': { headers: { customResponseHeaders: { 'Referrer-Policy': 'no-referrer' }, frameDeny: true, contentTypeNosniff: true } },
      'management-limit': { rateLimit: { average: 30, burst: 60 } },
      'management-body': { buffering: { maxRequestBodyBytes: 16384 } },
      'api-limit': { rateLimit: { average: 200, burst: 400 } },
    },
  },
}
await writeFile(`${root}/routes/platform.json`, JSON.stringify(routes, null, 2), { flag: 'wx', mode: 0o600 })
const values = {
  PLATFORM_DOMAIN: base, PLATFORM_DATA_ROOT: root, OIDC_ISSUER: env.OIDC_ISSUER,
  OIDC_CLIENT_ID: env.OIDC_CLIENT_ID, OIDC_REQUIRED_ACR: env.OIDC_REQUIRED_ACR, ACME_EMAIL: env.ACME_EMAIL,
  ACME_SERVER: env.ACME_SERVER ?? 'https://acme-staging-v02.api.letsencrypt.org/directory',
  HOST_CAPACITY_MB: env.HOST_CAPACITY_MB ?? '12288', HOST_CAPACITY_CPUS: env.HOST_CAPACITY_CPUS ?? '3',
  RESTIC_REPOSITORY: env.RESTIC_REPOSITORY ?? '', BACKUP_ACCESS_KEY_ID: env.BACKUP_ACCESS_KEY_ID ?? '',
}
for (const value of Object.values(values)) if (/[\r\n']/.test(value)) throw new Error('Invalid deployment setting')
await writeFile(envPath, Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
await chmod(envPath, 0o600)
console.log('Bootstrap files created. Back up the secrets directory offline before starting the platform. ACME defaults to staging.')
