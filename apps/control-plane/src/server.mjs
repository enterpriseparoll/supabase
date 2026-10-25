import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { configuration } from './config.mjs'
import { database, audit, roleFor, sessionSubject, transaction } from './database.mjs'
import { authenticate, cookieValue, oidcClient, sessionCookie, verifyOrigin } from './auth.mjs'
import {
  authorize,
  cookieName,
  hash,
  HttpError,
  invariant,
  projectId,
  publicUrl,
  rateLimiter,
  token,
} from './core.mjs'
import {
  addDomain,
  createProject,
  listProjects,
  projectAccess,
  projectSecrets,
  publicProject,
  requestOperation,
} from './service.mjs'

async function body(request) {
  invariant(
    request.headers['content-type']?.split(';')[0] === 'application/json',
    415,
    'Send application/json'
  )
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    invariant(size <= 16384, 413, 'Request is too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}
async function formField(request, name) {
  invariant(
    request.headers['content-type']?.split(';')[0] === 'application/x-www-form-urlencoded',
    415,
    'Send a form'
  )
  let text = ''
  for await (const chunk of request) {
    text += chunk
    invariant(text.length <= 4096, 413, 'Request is too large')
  }
  return new URLSearchParams(text).get(name)
}
export const LOCAL_ADMIN = 'local-admin'
const localLoginPage = (failed) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in · Local project platform</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="bg-background text-foreground font-sans antialiased">
    <main class="mx-auto max-w-md px-6 py-16">
      <h1 class="text-3xl font-semibold tracking-tight">Sign in</h1>
      <p class="mt-3 text-subtle">
        Paste the sign-in token printed by <code>docker compose -f compose.local.yml logs local-init</code>.
      </p>
      ${failed ? '<p role="alert" class="my-4 text-sm">That token didn’t match. Copy it again from the logs.</p>' : ''}
      <form method="post" action="/auth/local" class="mt-6 grid gap-4">
        <label class="grid gap-2 text-sm">Sign-in token
          <input name="token" type="password" autocomplete="off" required autofocus />
        </label>
        <button type="submit" class="rounded border border-border px-4 py-2">Sign in</button>
      </form>
    </main>
  </body>
</html>`
function send(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  })
  response.end(value === undefined ? undefined : JSON.stringify(value))
}
// Credential disclosure, Studio handoff, and access management are stricter than
// other mutations. Reads are not limited; they are bounded by pagination.
const sensitivePath = /^\/api\/(?:members|projects\/[^/]+\/(?:secrets|studio-ticket|members))$/
export function managementServer(pool, config, oidc) {
  const limits = {
    mutation: rateLimiter(config.rateLimits?.mutation ?? { capacity: 30, perMinute: 30 }),
    sensitive: rateLimiter(config.rateLimits?.sensitive ?? { capacity: 5, perMinute: 10 }),
  }
  const assets = new Map([
    ['/', ['index.html', 'text/html']],
    ['/dashboard.mjs', ['dashboard.mjs', 'text/javascript']],
    ['/styles.css', ['styles.css', 'text/css']],
  ])
  const cookie = (name) => cookieName(config, name)
  const setCookie = (name, value, age) => sessionCookie(cookie(name), value, age, !config.local)
  return createServer(
    { maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 },
    async (request, response) => {
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
      )
      response.setHeader('Cache-Control', 'no-store')
      const requestId = randomUUID()
      response.setHeader('X-Request-ID', requestId)
      try {
        const url = new URL(request.url, config.origin)
        const path = url.pathname
        if (path === '/healthz' && request.method === 'GET') {
          await pool.query('SELECT 1')
          return send(response, 200, { status: 'ok' })
        }
        if (path === '/internal/studio-auth') {
          const host = request.headers['x-forwarded-host']
          // Local mode browsers send the published port in Host; server mode uses 443.
          const hostname =
            typeof host === 'string' && config.local
              ? host.replace(`:${config.publicPort}`, '')
              : host
          const match =
            typeof hostname === 'string' && hostname.match(/^([a-z0-9]+)\.studio\.(.+)$/)
          invariant(match && match[2] === config.baseDomain, 403, 'Invalid Studio host')
          const id = projectId(match[1])
          const studioOrigin = publicUrl(config, hostname)
          const forwarded = new URL(request.headers['x-forwarded-uri'] ?? '/', studioOrigin)
          if (
            forwarded.pathname === '/_platform/session' &&
            request.headers['x-forwarded-method'] === 'GET'
          ) {
            const ticket = forwarded.searchParams.get('ticket')
            invariant(
              ticket && /^[A-Za-z0-9_-]{43}$/.test(ticket),
              401,
              'Open Studio from the project dashboard'
            )
            const raw = token()
            await transaction(pool, async (db) => {
              const entry = (
                await db.query(
                  'DELETE FROM control.studio_tickets WHERE token_hash=$1 AND project_id=$2 AND expires_at>now() RETURNING subject',
                  [hash(ticket), id]
                )
              ).rows[0]
              invariant(entry, 401, 'Studio link expired. Open Studio from the dashboard.')
              await projectAccess(db, entry.subject, id, 'studio')
              await db.query(
                "INSERT INTO control.sessions(token_hash,subject,project_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
                [hash(raw), entry.subject, id]
              )
              await audit(db, entry.subject, 'studio.session.created', id)
            })
            // Absolute: Traefik resolves a relative Location from forward auth against
            // the auth service address (http://api:3000), not the Studio host.
            return send(response, 303, undefined, {
              Location: `${studioOrigin}/`,
              'Set-Cookie': setCookie('studio', raw),
            })
          }
          const subject = await sessionSubject(
            pool,
            cookieValue(request.headers.cookie, cookie('studio')),
            id
          )
          invariant(subject, 401, 'Open Studio from the project dashboard')
          await projectAccess(pool, subject, id, 'studio')
          const method = request.headers['x-forwarded-method']
          if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) verifyOrigin(request, studioOrigin)
          return send(response, 204)
        }
        if (request.method === 'GET' && assets.has(path)) {
          const [file, type] = assets.get(path)
          response.setHeader('Content-Type', type)
          response.end(await readFile(new URL(`../public/${file}`, import.meta.url)))
          return
        }
        if (config.local && path === '/auth/login' && request.method === 'GET') {
          // With no-referrer, browsers submit HTML forms with "Origin: null", which the
          // origin check rightly rejects. same-origin still sends nothing cross-site.
          response.setHeader('Referrer-Policy', 'same-origin')
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          return response.end(localLoginPage(url.searchParams.has('failed')))
        }
        if (config.local && path === '/auth/local' && request.method === 'POST') {
          verifyOrigin(request, config.origin)
          invariant(
            limits.sensitive.take('@local-login'),
            429,
            'Too many sign-in attempts. Wait a minute.'
          )
          const supplied = (await formField(request, 'token')) ?? ''
          const matches = timingSafeEqual(
            Buffer.from(hash(supplied), 'hex'),
            Buffer.from(hash(config.localAdminToken), 'hex')
          )
          if (!matches) return send(response, 303, undefined, { Location: '/auth/login?failed' })
          const raw = token()
          await pool.query(
            "INSERT INTO control.sessions(token_hash,subject,expires_at) VALUES($1,$2,now()+interval '12 hours')",
            [hash(raw), LOCAL_ADMIN]
          )
          await audit(pool, LOCAL_ADMIN, 'session.created')
          return send(response, 303, undefined, {
            Location: '/',
            'Set-Cookie': setCookie('platform', raw, 43200),
          })
        }
        if (!config.local && path === '/auth/login' && request.method === 'GET') {
          // Short-lived flows are bounded in the database and expire even if abandoned.
          const outstanding = (
            await pool.query(
              'SELECT count(*)::int AS count FROM control.login_flows WHERE expires_at>now()'
            )
          ).rows[0].count
          invariant(outstanding < 1000, 429, 'Too many sign-in attempts. Try again later.')
          const flow = await oidc.begin(pool)
          return send(response, 302, undefined, {
            Location: flow.url,
            'Set-Cookie': setCookie('login', flow.state, 600),
          })
        }
        if (!config.local && path === '/auth/callback' && request.method === 'GET') {
          const raw = await oidc.finish(
            pool,
            url.searchParams.get('code'),
            url.searchParams.get('state'),
            cookieValue(request.headers.cookie, cookie('login'))
          )
          return send(response, 303, undefined, {
            Location: '/',
            'Set-Cookie': [setCookie('platform', raw), setCookie('login', '', 0)],
          })
        }
        const subject = await authenticate(pool, request, config)
        if (!['GET', 'HEAD'].includes(request.method)) {
          verifyOrigin(request, config.origin)
          invariant(
            limits.mutation.take(subject) &&
              (!sensitivePath.test(path) || limits.sensitive.take(subject)),
            429,
            'Too many requests. Wait a minute and try again.'
          )
        }
        if (path === '/auth/logout' && request.method === 'POST') {
          await pool.query('DELETE FROM control.sessions WHERE subject=$1', [subject])
          await audit(pool, subject, 'session.revoked')
          return send(response, 200, { ok: true }, { 'Set-Cookie': setCookie('platform', '', 0) })
        }
        if (path === '/api/me' && request.method === 'GET')
          return send(response, 200, {
            subject,
            role: (await roleFor(pool, subject)) ?? 'project-member',
          })
        if (path === '/api/projects') {
          if (request.method === 'GET')
            return send(
              response,
              200,
              await listProjects(
                pool,
                config,
                subject,
                url.searchParams.get('cursor') ?? '',
                Number(url.searchParams.get('limit') ?? 30)
              )
            )
          if (request.method === 'POST')
            return send(
              response,
              202,
              await createProject(
                pool,
                config,
                subject,
                await body(request),
                request.headers['idempotency-key']
              )
            )
        }
        if (path === '/api/members' && request.method === 'GET') {
          authorize(await roleFor(pool, subject), 'members')
          return send(
            response,
            200,
            (
              await pool.query(
                'SELECT subject,role,created_at FROM control.members ORDER BY subject LIMIT 1000'
              )
            ).rows
          )
        }
        if (path === '/api/members' && request.method === 'POST') {
          const input = await body(request)
          invariant(
            typeof input.subject === 'string' &&
              input.subject.length > 0 &&
              input.subject.length <= 255 &&
              ['owner', 'operator', 'viewer', 'revoked'].includes(input.role),
            400,
            'Invalid member'
          )
          await transaction(pool, async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(8734143)')
            authorize(await roleFor(db, subject), 'members')
            const existing = (
              await db.query('SELECT role FROM control.members WHERE subject=$1', [input.subject])
            ).rows[0]
            if (existing?.role === 'owner' && input.role !== 'owner') {
              invariant(
                (
                  await db.query(
                    "SELECT count(*)::int AS count FROM control.members WHERE role='owner'"
                  )
                ).rows[0].count > 1,
                409,
                'Keep at least one platform owner'
              )
            }
            if (input.role === 'revoked') {
              await db.query('DELETE FROM control.members WHERE subject=$1', [input.subject])
              await db.query('DELETE FROM control.project_members WHERE subject=$1', [
                input.subject,
              ])
            } else
              await db.query(
                'INSERT INTO control.members(subject,role) VALUES($1,$2) ON CONFLICT(subject) DO UPDATE SET role=excluded.role',
                [input.subject, input.role]
              )
            await db.query('DELETE FROM control.sessions WHERE subject=$1', [input.subject])
            await audit(db, subject, 'member.updated', null, {
              subject: input.subject,
              role: input.role,
            })
          })
          return send(response, 200, { ok: true })
        }
        const match = path.match(
          /^\/api\/projects\/([^/]+)(?:\/(secrets|operations|backups|domains|studio-ticket|members))?$/
        )
        if (match) {
          const id = projectId(match[1]),
            resource = match[2]
          if (!resource && request.method === 'GET') {
            const project = await projectAccess(pool, subject, id, 'read')
            return send(
              response,
              200,
              publicProject(
                { ...project, effective_role: await roleFor(pool, subject, id) },
                config
              )
            )
          }
          if (resource === 'secrets' && request.method === 'POST')
            return send(response, 200, await projectSecrets(pool, config, subject, id))
          if (resource === 'operations' && request.method === 'POST') {
            const input = await body(request)
            return send(
              response,
              202,
              await requestOperation(
                pool,
                config,
                subject,
                id,
                input.kind,
                input,
                request.headers['idempotency-key']
              )
            )
          }
          if (['operations', 'backups', 'domains'].includes(resource) && request.method === 'GET') {
            await projectAccess(pool, subject, id, 'read')
            const queries = {
              operations:
                'SELECT id,kind,state,attempts,error_code,created_at,finished_at FROM control.operations WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',
              backups:
                'SELECT id,snapshot,release,created_at FROM control.backups WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',
              domains:
                'SELECT domain,verification_token,verified_at FROM control.domains WHERE project_id=$1 ORDER BY domain',
            }
            return send(response, 200, (await pool.query(queries[resource], [id])).rows)
          }
          if (resource === 'domains' && request.method === 'POST')
            return send(
              response,
              201,
              await addDomain(pool, config, subject, id, (await body(request)).domain)
            )
          if (resource === 'domains' && request.method === 'DELETE') {
            const { domain } = await body(request)
            return send(
              response,
              202,
              await requestOperation(
                pool,
                config,
                subject,
                id,
                'remove-domain',
                { domain },
                request.headers['idempotency-key']
              )
            )
          }
          if (resource === 'studio-ticket' && request.method === 'POST') {
            await projectAccess(pool, subject, id, 'studio')
            const ticket = token()
            await pool.query(
              "INSERT INTO control.studio_tickets(token_hash,subject,project_id,expires_at) VALUES($1,$2,$3,now()+interval '30 seconds')",
              [hash(ticket), subject, id]
            )
            return send(response, 200, {
              url: `${publicUrl(config, `${id}.studio.${config.baseDomain}`)}/_platform/session?ticket=${ticket}`,
            })
          }
          if (resource === 'members' && request.method === 'GET') {
            await projectAccess(pool, subject, id, 'members')
            return send(
              response,
              200,
              (
                await pool.query(
                  'SELECT subject,role FROM control.project_members WHERE project_id=$1 ORDER BY subject',
                  [id]
                )
              ).rows
            )
          }
          if (resource === 'members' && request.method === 'POST') {
            const input = await body(request)
            invariant(
              typeof input.subject === 'string' &&
                input.subject.length > 0 &&
                input.subject.length <= 255 &&
                ['owner', 'operator', 'viewer', 'revoked'].includes(input.role),
              400,
              'Invalid project member'
            )
            await transaction(pool, async (db) => {
              await projectAccess(db, subject, id, 'members')
              if (input.role === 'revoked')
                await db.query(
                  'DELETE FROM control.project_members WHERE project_id=$1 AND subject=$2',
                  [id, input.subject]
                )
              else
                await db.query(
                  'INSERT INTO control.project_members(project_id,subject,role) VALUES($1,$2,$3) ON CONFLICT(project_id,subject) DO UPDATE SET role=excluded.role',
                  [id, input.subject, input.role]
                )
              await db.query('DELETE FROM control.sessions WHERE subject=$1 AND project_id=$2', [
                input.subject,
                id,
              ])
              await audit(db, subject, 'project.member.updated', id, {
                subject: input.subject,
                role: input.role,
              })
            })
            return send(response, 200, { ok: true })
          }
        }
        if (path === '/api/audit' && request.method === 'GET') {
          authorize(await roleFor(pool, subject), 'members')
          return send(
            response,
            200,
            (await pool.query('SELECT * FROM control.audit ORDER BY id DESC LIMIT 200')).rows
          )
        }
        throw new HttpError(404, 'Endpoint not found')
      } catch (error) {
        const status = error.status ?? (error.code === '23505' ? 409 : 500)
        // Never log request bodies, cookies, SQL parameters, provider errors, or Docker output.
        if (status >= 500)
          console.error(
            JSON.stringify({ event: 'request.failed', requestId, code: 'INTERNAL_ERROR' })
          )
        send(response, status, {
          error:
            status >= 500
              ? 'Request failed. Check the request ID in the server logs.'
              : error.message,
          requestId,
        })
      }
    }
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await configuration()
  const pool = database(config.databaseUrl)
  if (config.local)
    // The single local operator is always an owner; there is no identity provider.
    await pool.query(
      "INSERT INTO control.members(subject,role) VALUES($1,'owner') ON CONFLICT (subject) DO NOTHING",
      [LOCAL_ADMIN]
    )
  const server = managementServer(pool, config, config.local ? null : await oidcClient(config))
  server.listen(config.port, '0.0.0.0', () =>
    console.log(JSON.stringify({ event: 'control.listening', port: config.port }))
  )
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () =>
      server.close(async () => {
        await pool.end()
        process.exit(0)
      })
    )
}
