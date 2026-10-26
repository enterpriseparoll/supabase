import { test, before, after } from 'node:test'
import { request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import { database, migrate, transaction, sessionSubject } from '../src/database.mjs'
import {
  createProject,
  listProjects,
  projectAccess,
  projectSecrets,
  requestOperation,
} from '../src/service.mjs'
import { hash, token, authorize } from '../src/core.mjs'
import { runOne, scheduleBackups } from '../src/worker.mjs'
import { Infrastructure } from '../src/infrastructure.mjs'
import { randomUUID } from 'node:crypto'
import { managementServer } from '../src/server.mjs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { backupDownloadPath } from '../src/backup-files.mjs'
import { serveLiveRequests } from '../src/live.mjs'

const url = process.env.CONTROL_TEST_DATABASE_URL
const config = {
  baseDomain: 'platform.example.com',
  origin: 'https://manage.platform.example.com',
  key: 'ab'.repeat(32),
  capacityMb: 1048576,
  capacityCpus: 1024,
  release: 'test',
}
let pool, server, base, ownerCookie, viewerCookie
const input = { name: 'Integration project', siteUrl: 'https://app.example.com' }
before(async () => {
  assert(
    url,
    'Set CONTROL_TEST_DATABASE_URL to a disposable database. Tests reset its control schema.'
  )
  assert(new URL(url).pathname.endsWith('_test'), 'Integration database name must end in _test')
  pool = database(url)
  config.dataRoot = await mkdtemp(join(tmpdir(), 'platform-data-'))
  await pool.query('DROP SCHEMA IF EXISTS control CASCADE')
  await pool.query('DROP TABLE IF EXISTS public.platform_migrations')
  // Like a real install (init-db.sh), the runtime roles exist before migrations run,
  // so every migration's grants apply to them.
  if (process.env.CONTROL_TEST_RUNTIME_ROLES === 'true')
    for (const [role, password] of [
      ['control_api', 'integration-api'],
      ['control_worker', 'integration-worker'],
    ])
      if (!(await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount)
        await pool.query(
          `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`
        )
  await migrate(pool)
  await migrate(pool)
  await pool.query(
    "INSERT INTO control.members(subject,role) VALUES('owner','owner'),('operator','operator'),('viewer','viewer')"
  )
  ownerCookie = token()
  viewerCookie = token()
  for (const [raw, subject] of [
    [ownerCookie, 'owner'],
    [viewerCookie, 'viewer'],
  ])
    await pool.query(
      "INSERT INTO control.sessions(token_hash,subject,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [hash(raw), subject]
    )
  server = managementServer(pool, config, {
    begin() {
      throw new Error('Unexpected login')
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  await pool?.end()
  if (config.dataRoot) await rm(config.dataRoot, { recursive: true, force: true })
})
test('concurrent project requests reserve capacity and honor idempotency', async () => {
  const [first, second] = await Promise.all([
    createProject(pool, config, 'owner', input, 'concurrent-create'),
    createProject(pool, config, 'owner', input, 'concurrent-create'),
  ])
  assert.equal(first.id, second.id)
  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM control.projects')).rows[0].count,
    1
  )
  await assert.rejects(
    createProject(pool, config, 'owner', { ...input, name: 'Different' }, 'concurrent-create'),
    { status: 409 }
  )
  await assert.rejects(
    createProject(pool, { ...config, capacityMb: 4096 }, 'owner', input, 'over-capacity'),
    { status: 409 }
  )
})
test('project-scoped membership cannot access other project secrets or operations', async () => {
  const other = await createProject(pool, config, 'owner', input, 'second-project')
  const first = (await listProjects(pool, config, 'owner')).projects.find(
    (p) => p.id !== other.project_id
  )
  await pool.query(
    "INSERT INTO control.project_members(project_id,subject,role) VALUES($1,'scoped','viewer')",
    [first.id]
  )
  assert.equal((await listProjects(pool, config, 'scoped')).projects.length, 1)
  await assert.rejects(projectAccess(pool, 'scoped', other.project_id, 'read'), { status: 403 })
  await assert.rejects(projectSecrets(pool, config, 'scoped', first.id), { status: 403 })
  await assert.rejects(
    requestOperation(pool, config, 'scoped', first.id, 'stop', {}, 'viewer-stop'),
    { status: 403 }
  )
  assert(!JSON.stringify(await listProjects(pool, config, 'owner')).includes('encrypted_secrets'))
})
test('API rejects anonymous requests, CSRF, and viewer mutations', async () => {
  assert.equal((await fetch(`${base}/api/projects`)).status, 401)
  const headers = {
    Cookie: `__Host-platform=${ownerCookie}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'csrf-create',
  }
  assert.equal(
    (await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify(input) }))
      .status,
    403
  )
  assert.equal(
    (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { ...headers, Origin: config.origin, Cookie: `__Host-platform=${viewerCookie}` },
        body: JSON.stringify(input),
      })
    ).status,
    403
  )
  const response = await fetch(`${base}/api/projects`, {
    headers: { Cookie: `__Host-platform=${ownerCookie}` },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})
test('worker recovers an interrupted operation and serializes concurrent workers', async () => {
  let inFlight = 0,
    peak = 0,
    called = 0
  const fake = {
    async up() {
      called++
      peak = Math.max(peak, ++inFlight)
      await new Promise((resolve) => setTimeout(resolve, 30))
      inFlight--
    },
  }
  const row = (
    await pool.query(
      "SELECT * FROM control.operations WHERE kind='create' ORDER BY created_at LIMIT 1"
    )
  ).rows[0]
  await pool.query("UPDATE control.operations SET state='running',attempts=1 WHERE id=$1", [row.id])
  await Promise.all([runOne(pool, config, fake), runOne(pool, config, fake)])
  assert(peak <= 2) // Different projects may run concurrently.
  assert(called >= 1)
  assert.equal(
    (await pool.query('SELECT state FROM control.operations WHERE id=$1', [row.id])).rows[0].state,
    'succeeded'
  )
  // Explicitly hold a project lock: another worker must not execute its operation.
  const lease = await pool.connect()
  await lease.query('SELECT pg_advisory_lock(hashtextextended($1,8734144))', [row.project_id])
  const op = await requestOperation(
    pool,
    config,
    'owner',
    row.project_id,
    'restart',
    {},
    'locked-restart'
  )
  try {
    await runOne(pool, config, { ...fake, async stop() {} })
    assert.equal(
      (await pool.query('SELECT state FROM control.operations WHERE id=$1', [op.id])).rows[0].state,
      'queued'
    )
  } finally {
    await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,8734144))', [row.project_id])
    lease.release()
  }
})
test('queued destructive actions recheck revoked permissions', async () => {
  const operation = await createProject(pool, config, 'operator', input, 'revoked-creation')
  await pool.query("DELETE FROM control.members WHERE subject='operator'")
  await pool.query("DELETE FROM control.project_members WHERE subject='operator'")
  // Drain older jobs first using a harmless execution adapter.
  const fake = { async up() {}, async stop() {} }
  for (let i = 0; i < 10; i++) if (!(await runOne(pool, config, fake))) break
  const result = (
    await pool.query('SELECT state,error_code FROM control.operations WHERE id=$1', [operation.id])
  ).rows[0]
  assert.equal(result.state, 'failed')
  assert.equal(result.error_code, 'PERMISSION_REVOKED')
})
test('Connect handoffs open the full Studio connection sheet', async () => {
  const project = (await listProjects(pool, config, 'owner')).projects[0]
  const response = await fetch(`${base}/api/projects/${project.id}/studio-ticket?connect=true`, {
    method: 'POST',
    headers: {
      Cookie: `__Host-platform=${ownerCookie}`,
      Origin: config.origin,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(response.status, 200)
  const ticketUrl = new URL((await response.json()).url)
  const handoff = await fetch(`${base}/internal/studio-auth`, {
    headers: {
      'X-Forwarded-Host': ticketUrl.hostname,
      'X-Forwarded-URI': `${ticketUrl.pathname}${ticketUrl.search}`,
      'X-Forwarded-Method': 'GET',
    },
    redirect: 'manual',
  })
  assert.equal(handoff.status, 303)
  assert.equal(
    handoff.headers.get('location'),
    `${ticketUrl.origin}/project/default?showConnect=true`
  )
})
test('Studio handoffs are single-use, project-bound, and revoked with membership', async () => {
  const project = (await listProjects(pool, config, 'owner')).projects[0]
  const ticketResponse = await fetch(`${base}/api/projects/${project.id}/studio-ticket`, {
    method: 'POST',
    headers: {
      Cookie: `__Host-platform=${ownerCookie}`,
      Origin: config.origin,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  const ticketUrl = new URL((await ticketResponse.json()).url)
  const headers = {
    'X-Forwarded-Host': ticketUrl.hostname,
    'X-Forwarded-URI': `${ticketUrl.pathname}${ticketUrl.search}`,
    'X-Forwarded-Method': 'GET',
  }
  const handoff = await fetch(`${base}/internal/studio-auth`, { headers, redirect: 'manual' })
  assert.equal(handoff.status, 303)
  assert.equal(handoff.headers.get('location'), `${ticketUrl.origin}/`)
  const cookie = handoff.headers.get('set-cookie').split(';')[0]
  assert(cookie.startsWith('__Host-studio='))
  assert.equal(
    (await fetch(`${base}/internal/studio-auth`, { headers, redirect: 'manual' })).status,
    401
  )
  assert.equal(
    (
      await fetch(`${base}/internal/studio-auth`, {
        headers: { ...headers, 'X-Forwarded-URI': '/', Cookie: cookie },
      })
    ).status,
    204
  )
  assert.equal(await sessionSubject(pool, cookie.split('=')[1]), undefined)
  assert.equal(
    (
      await fetch(`${base}/internal/studio-auth`, {
        headers: {
          ...headers,
          'X-Forwarded-Host': `paaaaaaaaaaaaaaaaaaaaaaaa.studio.${config.baseDomain}`,
          'X-Forwarded-URI': '/',
          Cookie: cookie,
        },
      })
    ).status,
    401
  )
})
test('transaction failure rolls back metadata and audit together', async () => {
  await assert.rejects(
    transaction(pool, async (db) => {
      await db.query("INSERT INTO control.members(subject,role) VALUES('rollback-user','viewer')")
      throw new Error('injected failure')
    })
  )
  assert.equal(
    (await pool.query("SELECT 1 FROM control.members WHERE subject='rollback-user'")).rowCount,
    0
  )
})
test('project pagination continues beyond a dashboard page without a fixed project count', async () => {
  for (let index = 0; index < 32; index++)
    await createProject(
      pool,
      config,
      'owner',
      { ...input, name: `Page test ${index}` },
      `page-test-${index}`
    )
  const seen = new Set()
  let cursor = ''
  do {
    const page = await listProjects(pool, config, 'owner', cursor, 10)
    for (const project of page.projects) {
      assert(!seen.has(project.id))
      seen.add(project.id)
    }
    cursor = page.nextCursor
  } while (cursor)
  assert(seen.size > 30)
})
test('a revoked project membership denies existing Studio sessions immediately', async () => {
  const project = (await listProjects(pool, config, 'owner')).projects[0]
  await pool.query(
    "INSERT INTO control.project_members(project_id,subject,role) VALUES($1,'studio-member','operator')",
    [project.id]
  )
  const raw = token()
  await pool.query(
    "INSERT INTO control.sessions(token_hash,subject,project_id,expires_at) VALUES($1,'studio-member',$2,now()+interval '1 hour')",
    [hash(raw), project.id]
  )
  const headers = {
    'X-Forwarded-Host': `${project.id}.studio.${config.baseDomain}`,
    'X-Forwarded-URI': '/',
    'X-Forwarded-Method': 'GET',
    Cookie: `__Host-studio=${raw}`,
  }
  assert.equal((await fetch(`${base}/internal/studio-auth`, { headers })).status, 204)
  await pool.query("DELETE FROM control.project_members WHERE subject='studio-member'")
  assert.equal((await fetch(`${base}/internal/studio-auth`, { headers })).status, 403)
})
test('deletion retries and recovery reserve capacity without losing the operation identity', async () => {
  const project = (await listProjects(pool, config, 'owner')).projects[0]
  const deletion = await requestOperation(
    pool,
    config,
    'owner',
    project.id,
    'delete',
    { confirmation: project.id },
    'delete-and-retry'
  )
  const fake = { async up() {}, async stop() {}, async destroy() {} }
  for (let count = 0; count < 100; count++) {
    if (
      (await pool.query('SELECT state FROM control.operations WHERE id=$1', [deletion.id])).rows[0]
        .state === 'succeeded'
    )
      break
    await runOne(pool, config, fake)
  }
  assert.equal(
    (
      await requestOperation(
        pool,
        config,
        'owner',
        project.id,
        'delete',
        { confirmation: project.id },
        'delete-and-retry'
      )
    ).id,
    deletion.id
  )
  await assert.rejects(
    requestOperation(
      pool,
      { ...config, capacityMb: 4096 },
      'owner',
      project.id,
      'recover',
      { confirmation: project.id },
      'capacity-recover'
    ),
    { status: 409 }
  )
  const recovery = await requestOperation(
    pool,
    config,
    'owner',
    project.id,
    'recover',
    { confirmation: project.id },
    'recover-project'
  )
  assert.equal(
    (
      await requestOperation(
        pool,
        config,
        'owner',
        project.id,
        'recover',
        { confirmation: project.id },
        'recover-project'
      )
    ).id,
    recovery.id
  )
  await runOne(pool, config, fake)
  assert.equal((await projectAccess(pool, 'owner', project.id, 'read')).status, 'ready')
})
test(
  'runtime database roles cannot alter schema or rewrite audit history',
  { skip: process.env.CONTROL_TEST_RUNTIME_ROLES !== 'true' },
  async () => {
    for (const [role, password] of [
      ['control_api', 'integration-api'],
      ['control_worker', 'integration-worker'],
    ]) {
      const connection = new URL(url)
      connection.username = role
      connection.password = password
      const restricted = database(connection.href)
      try {
        await restricted.query('SELECT id FROM control.projects LIMIT 1')
        await restricted.query(
          "INSERT INTO control.audit(actor,action) VALUES('test','permission.probe')"
        )
        await assert.rejects(restricted.query('DELETE FROM control.audit'), { code: '42501' })
        await assert.rejects(restricted.query('DROP TABLE control.projects'), { code: '42501' })
      } finally {
        await restricted.end()
      }
    }
  }
)
test('credential disclosure is rate limited per identity', async () => {
  const project = await createProject(pool, config, 'owner', input, 'rate-limit-project')
  const cookie = token()
  await pool.query("INSERT INTO control.members(subject,role) VALUES('rate-limited','operator')")
  await pool.query(
    "INSERT INTO control.sessions(token_hash,subject,expires_at) VALUES($1,'rate-limited',now()+interval '1 hour')",
    [hash(cookie)]
  )
  const reveal = (raw) =>
    fetch(`${base}/api/projects/${project.project_id}/secrets`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-platform=${raw}`,
        Origin: config.origin,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
  const statuses = []
  for (let i = 0; i < 6; i++) statuses.push((await reveal(cookie)).status)
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429])
  assert.equal((await reveal(ownerCookie)).status, 200, 'other identities keep their budget')
})
test('local mode signs in with the generated token over plain HTTP', async () => {
  const localConfig = {
    ...config,
    local: true,
    publicPort: 8090,
    baseDomain: 'localhost',
    origin: 'http://manage.localhost:8090',
    localAdminToken: 'correct-local-token',
  }
  await pool.query(
    "INSERT INTO control.members(subject,role) VALUES('local-admin','owner') ON CONFLICT DO NOTHING"
  )
  const local = managementServer(pool, localConfig, null)
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve))
  const at = `http://127.0.0.1:${local.address().port}`
  try {
    const page = await fetch(`${at}/auth/login`)
    assert.equal(page.status, 200)
    const loginHtml = await page.text()
    assert.match(loginHtml, /Welcome back/)
    assert.match(loginHtml, /name="token"/)
    assert.equal((await fetch(`${at}/login.mjs`)).status, 200)
    const failedLogin = await fetch(`${at}/auth/login?failed`)
    assert.match(await failedLogin.text(), /role="alert"/)
    // Browsers send "Origin: null" for form posts from no-referrer pages.
    assert.equal(page.headers.get('referrer-policy'), 'same-origin')
    assert.equal((await fetch(`${at}/auth/callback?code=x&state=y`)).status, 401)
    const signIn = (value, origin = localConfig.origin) =>
      fetch(`${at}/auth/local`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
        body: new URLSearchParams({ token: value }),
      })
    const wrong = await signIn('wrong-token')
    assert.equal(wrong.status, 303)
    assert.equal(wrong.headers.get('location'), '/auth/login?failed')
    assert.equal(wrong.headers.get('set-cookie'), null)
    assert.equal((await signIn('correct-local-token', 'http://evil.localhost')).status, 403)
    assert.equal((await signIn('correct-local-token', 'null')).status, 403)
    const right = await signIn('correct-local-token')
    assert.equal(right.status, 303)
    const setCookie = right.headers.get('set-cookie')
    assert.match(setCookie, /^platform=[A-Za-z0-9_-]{43};/)
    assert(!setCookie.includes('Secure'))
    const cookie = setCookie.split(';')[0]
    const me = await fetch(`${at}/api/me`, { headers: { Cookie: cookie } })
    // Agents outside the browser reach MCP on 127.0.0.1 (Windows can't resolve *.localhost).
    assert.deepEqual(await me.json(), {
      subject: 'local-admin',
      role: 'owner',
      local: true,
      mcpUrl: 'http://127.0.0.1:8090/mcp',
      capacityMb: localConfig.capacityMb,
      capacityCpus: localConfig.capacityCpus,
    })
    const created = await fetch(`${at}/api/projects`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: localConfig.origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'local-mode-create',
      },
      body: JSON.stringify({ name: 'Local app', siteUrl: 'http://localhost:3000' }),
    })
    assert.equal(created.status, 202)
    const { project_id: projectId } = await created.json()
    const listed = await (
      await fetch(`${at}/api/projects/${projectId}`, { headers: { Cookie: cookie } })
    ).json()
    assert.equal(listed.apiUrl, `http://${projectId}.api.localhost:8090`)
    const ticket = await (
      await fetch(`${at}/api/projects/${projectId}/studio-ticket`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: localConfig.origin },
      })
    ).json()
    const handoff = new URL(ticket.url)
    assert.equal(handoff.origin, `http://${projectId}.studio.localhost:8090`)
    const studio = await fetch(`${at}/internal/studio-auth`, {
      redirect: 'manual',
      headers: {
        'X-Forwarded-Host': handoff.host,
        'X-Forwarded-URI': `${handoff.pathname}${handoff.search}`,
        'X-Forwarded-Method': 'GET',
      },
    })
    assert.equal(studio.status, 303)
    assert.equal(studio.headers.get('location'), `${handoff.origin}/`)
    const studioCookie = studio.headers.get('set-cookie').split(';')[0]
    assert.match(studioCookie, /^studio=/)
    const check = (host) =>
      fetch(`${at}/internal/studio-auth`, {
        headers: {
          'X-Forwarded-Host': host,
          'X-Forwarded-URI': '/',
          'X-Forwarded-Method': 'GET',
          Cookie: studioCookie,
        },
      })
    assert.equal((await check(handoff.host)).status, 204)
    assert.equal((await check(`${projectId}.studio.localhost:9999`)).status, 403)
    // Studio's project switcher: list on the Studio origin with the Studio cookie.
    // fetch() cannot override Host, which Traefik passes through from the Studio origin.
    const list = (host, headers = {}) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          `${at}/_platform/api/projects`,
          { headers: { ...headers, Host: host } },
          (response) => {
            let body = ''
            response.on('data', (chunk) => (body += chunk))
            response.on('end', () =>
              resolve({ status: response.statusCode, json: async () => JSON.parse(body) })
            )
          }
        )
        request.on('error', reject)
        request.end()
      })
    const listed2 = await list(handoff.host, { Cookie: studioCookie })
    assert.equal(listed2.status, 200)
    const { projects } = await listed2.json()
    assert(projects.some((row) => row.id === projectId))
    assert.deepEqual(Object.keys(projects[0]).sort(), ['id', 'name', 'status'])
    assert.equal((await list(handoff.host)).status, 401)
    assert.equal((await list(handoff.host, { Cookie: cookie })).status, 401)
    assert.equal((await list('evil.example.com', { Cookie: studioCookie })).status, 403)
    // Switching opens the other project's Studio through a single-use handoff.
    const open = await fetch(`${at}/open/${projectId}`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    })
    assert.equal(open.status, 303)
    assert.match(
      open.headers.get('location'),
      new RegExp(`^http://${projectId}\\.studio\\.localhost:8090/_platform/session\\?ticket=`)
    )
    const anonymous = await fetch(`${at}/open/${projectId}`, { redirect: 'manual' })
    assert.equal(anonymous.status, 303)
    assert.equal(anonymous.headers.get('location'), '/auth/login')
    assert.equal(
      (await fetch(`${at}/open/../etc`, { redirect: 'manual', headers: { Cookie: cookie } }))
        .status,
      404
    )
  } finally {
    await new Promise((resolve) => local.close(resolve))
  }
})
test('resizing reserves capacity against other projects and restarts with new limits', async () => {
  const limited = { ...config, capacityMb: 12288, capacityCpus: 6 }
  await pool.query("UPDATE control.projects SET status='deleted'")
  const first = await createProject(pool, limited, 'owner', input, 'resize-first')
  const second = await createProject(pool, limited, 'owner', input, 'resize-second')
  // 4096 + 4096 in use; growing one to 8192 needs 12288 total: allowed.
  const grow = await requestOperation(
    pool,
    limited,
    'owner',
    first.project_id,
    'resize',
    { memoryMb: 8192, cpus: 3 },
    'resize-grow'
  )
  assert.deepEqual(grow.payload, { memoryMb: 8192, cpus: 3 })
  const reserved = (
    await pool.query('SELECT memory_mb,cpus FROM control.projects WHERE id=$1', [first.project_id])
  ).rows[0]
  assert.deepEqual([reserved.memory_mb, Number(reserved.cpus)], [8192, 3])
  // The other project cannot now grow past the remaining 4096 MiB.
  await assert.rejects(
    requestOperation(
      pool,
      limited,
      'owner',
      second.project_id,
      'resize',
      { memoryMb: 6144, cpus: 2 },
      'resize-too-big'
    ),
    { status: 409, message: /4096 MiB/ }
  )
  for (const bad of [{ memoryMb: 1024, cpus: 2 }, { memoryMb: 4096, cpus: 0 }, {}])
    await assert.rejects(
      requestOperation(
        pool,
        limited,
        'owner',
        second.project_id,
        'resize',
        bad,
        `bad-${Math.random()}`.replace('.', '')
      ),
      { status: 400 }
    )
  await assert.rejects(
    requestOperation(
      pool,
      limited,
      'viewer',
      first.project_id,
      'resize',
      { memoryMb: 4096, cpus: 2 },
      'viewer-resize'
    ),
    { status: 403 }
  )
  // The worker re-renders, then restarts, then marks the project ready.
  const calls = []
  const fake = {
    async invalidate(project) {
      calls.push(['invalidate', project.memory_mb])
    },
    async stop() {
      calls.push(['stop'])
    },
    async up(project) {
      calls.push(['up', project.memory_mb, Number(project.cpus)])
    },
  }
  await pool.query("UPDATE control.operations SET state='succeeded' WHERE kind='create'")
  for (let count = 0; count < 20; count++) {
    const state = (await pool.query('SELECT state FROM control.operations WHERE id=$1', [grow.id]))
      .rows[0].state
    if (state === 'succeeded') break
    await runOne(pool, limited, fake)
  }
  assert.deepEqual(calls, [['invalidate', 8192], ['stop'], ['up', 8192, 3]])
  assert.equal(
    (await pool.query('SELECT status FROM control.projects WHERE id=$1', [first.project_id]))
      .rows[0].status,
    'ready'
  )
})
test('projects get unique, consecutive pooler port pairs', async () => {
  const roomy = { ...config, local: true, capacityMb: 1048576, capacityCpus: 1024 }
  const a = await createProject(pool, roomy, 'owner', input, 'ports-alpha')
  const b = await createProject(pool, roomy, 'owner', input, 'ports-bravo')
  const ports = (
    await pool.query('SELECT id, db_port FROM control.projects WHERE id = ANY($1)', [
      [a.project_id, b.project_id],
    ])
  ).rows
  const [first, second] = [a, b].map((op) => ports.find((row) => row.id === op.project_id).db_port)
  assert.equal(second - first, 2)
  const nulls = (
    await pool.query('SELECT count(*)::int AS n FROM control.projects WHERE db_port IS NULL')
  ).rows[0].n
  assert.equal(nulls, 0)
  const listed = await projectAccess(pool, 'owner', a.project_id, 'read')
  assert.equal(listed.db_port, first)
  const { projects } = await listProjects(pool, roomy, 'owner')
  const shown = projects.find((row) => row.id === a.project_id)
  assert.equal(
    shown.databaseUrl,
    `postgresql://postgres.${a.project_id}:[YOUR-PASSWORD]@localhost:${first}/postgres`
  )
})
test('insights, performance history, and schema comparison respect project access', async () => {
  const roomy = { ...config, capacityMb: 1048576, capacityCpus: 1024 }
  const a = (await createProject(pool, roomy, 'owner', input, 'insights-alpha')).project_id
  const b = (await createProject(pool, roomy, 'owner', input, 'insights-bravo')).project_id
  await pool.query(
    `INSERT INTO control.project_insights(project_id,migrations,performance,collected_at)
     VALUES($1,$2,$3,now())`,
    [
      a,
      JSON.stringify([{ version: '20240101000000', name: 'init', statements: 2 }]),
      JSON.stringify({ database_bytes: 100 }),
    ]
  )
  for (const minutes of [30, 20, 10])
    await pool.query(
      "INSERT INTO control.project_stats(project_id,collected_at,sample) VALUES($1, now() - ($2 * interval '1 minute'), $3)",
      [a, minutes, { connections: minutes }]
    )
  await pool.query(
    "INSERT INTO control.project_stats(project_id,collected_at,sample) VALUES($1, now() - interval '3 days', '{}')",
    [a]
  )
  const snap = async (project, content, minutesAgo) => {
    const id = randomUUID()
    await pool.query(
      "INSERT INTO control.schema_snapshots(id,project_id,content,hash,size_bytes,created_at) VALUES($1,$2,$3,$4,$5, now() - ($6 * interval '1 minute'))",
      [id, project, content, hash(content), content.length, minutesAgo]
    )
    return id
  }
  const oldA = await snap(a, 'CREATE TABLE public.courses (id int);', 60)
  const newA = await snap(
    a,
    'CREATE TABLE public.courses (id int, title text);\nCREATE POLICY p ON public.courses;',
    5
  )
  const onlyB = await snap(b, 'CREATE TABLE public.courses (id int);', 5)
  const cookie = { Cookie: `__Host-platform=${ownerCookie}` }
  const get = async (path) => {
    const response = await fetch(`${base}${path}`, { headers: cookie })
    return { status: response.status, body: await response.json() }
  }
  const insights = await get(`/api/projects/${a}/insights`)
  assert.equal(insights.status, 200)
  assert.equal(insights.body.migrations[0].name, 'init')
  assert.deepEqual((await get(`/api/projects/${b}/insights`)).body.migrations, null)
  const stats = await get(`/api/projects/${a}/stats?hours=24`)
  assert.deepEqual(
    stats.body.map((row) => row.sample.connections),
    [30, 20, 10],
    'oldest first, window applied'
  )
  assert.equal((await get(`/api/projects/${a}/stats?hours=999`)).status, 400)
  const snapshots = await get(`/api/projects/${a}/schema-snapshots`)
  assert.deepEqual(
    snapshots.body.map((row) => row.id),
    [newA, oldA],
    'newest first'
  )
  assert(!('content' in snapshots.body[0]), 'list never ships schema text')
  const overTime = await get(`/api/schema-diff?from=${oldA}&to=${newA}`)
  assert.equal(overTime.status, 200)
  assert.equal(overTime.body.added, 2)
  assert.equal(overTime.body.removed, 1)
  const crossProject = await get(`/api/schema-diff?from=${onlyB}&to=${newA}`)
  assert.equal(crossProject.body.from.projectId, b)
  assert.equal((await get(`/api/schema-diff?from=nope&to=${newA}`)).status, 400)
  assert.equal((await get(`/api/schema-diff?from=${randomUUID()}&to=${newA}`)).status, 404)
  // A member of one project cannot read another project's schema through a diff.
  await pool.query(
    "INSERT INTO control.project_members(project_id,subject,role) VALUES($1,'insights-scoped','viewer')",
    [a]
  )
  await assert.rejects(schemaDiffFor('insights-scoped', onlyB, newA), { status: 403 })
  await schemaDiffFor('insights-scoped', oldA, newA)
  await assert.rejects(
    import('../src/service.mjs').then((m) => m.projectInsights(pool, 'insights-scoped', b)),
    { status: 403 }
  )
})
async function schemaDiffFor(actor, from, to) {
  const { schemaDiff } = await import('../src/service.mjs')
  return schemaDiff(pool, actor, from, to)
}
test('backup schedules are per project and validated', async () => {
  const { updateBackupSettings } = await import('../src/service.mjs')
  const roomy = { ...config, capacityMb: 1048576, capacityCpus: 1024 }
  const id = (await createProject(pool, roomy, 'owner', input, 'backup-schedule')).project_id
  const row = (
    await pool.query(
      'SELECT backup_interval_hours, backup_retention FROM control.projects WHERE id=$1',
      [id]
    )
  ).rows[0]
  assert.deepEqual(
    [row.backup_interval_hours, row.backup_retention],
    [24, 7],
    'daily, keep 7 by default'
  )
  assert.deepEqual(
    await updateBackupSettings(pool, 'owner', id, { intervalHours: 6, retention: 3 }),
    { intervalHours: 6, retention: 3 }
  )
  for (const bad of [
    { intervalHours: -1, retention: 3 },
    { intervalHours: 6, retention: 0 },
    { intervalHours: 1.5, retention: 3 },
    null,
  ])
    await assert.rejects(updateBackupSettings(pool, 'owner', id, bad), { status: 400 })
  await pool.query(
    "INSERT INTO control.project_members(project_id,subject,role) VALUES($1,'backup-viewer','viewer')",
    [id]
  )
  await assert.rejects(
    updateBackupSettings(pool, 'backup-viewer', id, { intervalHours: 0, retention: 1 }),
    { status: 403 }
  )
  const response = await fetch(`${base}/api/projects/${id}`, {
    headers: { Cookie: `__Host-platform=${ownerCookie}` },
  })
  const shown = await response.json()
  assert.deepEqual([shown.backupIntervalHours, shown.backupRetention], [6, 3])
})
test('the scheduler queues backups by each project interval and skips disabled ones', async () => {
  const roomy = { ...config, capacityMb: 1048576, capacityCpus: 1024 }
  await pool.query("UPDATE control.projects SET status='deleted'")
  const due = (await createProject(pool, roomy, 'owner', input, 'sched-due-1')).project_id
  const off = (await createProject(pool, roomy, 'owner', input, 'sched-off-1')).project_id
  const recent = (await createProject(pool, roomy, 'owner', input, 'sched-recent')).project_id
  await pool.query("UPDATE control.projects SET status='ready' WHERE id = ANY($1)", [
    [due, off, recent],
  ])
  await pool.query('UPDATE control.projects SET backup_interval_hours=0 WHERE id=$1', [off])
  await pool.query(
    "INSERT INTO control.backups(id,project_id,snapshot,source_path,release,created_at) VALUES($1,$2,'s','/x','test', now() - interval '1 hour')",
    [randomUUID(), recent]
  )
  const saved = { ...process.env }
  process.env.RESTIC_REPOSITORY = '/tmp/repository'
  process.env.RESTIC_PASSWORD_FILE = '/tmp/password'
  try {
    await scheduleBackups(pool)
    await scheduleBackups(pool) // idempotent within an interval
  } finally {
    process.env = saved
  }
  const queued = (
    await pool.query(
      "SELECT project_id, actor FROM control.operations WHERE kind='backup' AND project_id = ANY($1)",
      [[due, off, recent]]
    )
  ).rows
  assert.deepEqual(
    queued.map((row) => row.project_id),
    [due]
  )
  assert.equal(queued[0].actor, '@scheduler')
})
test('retention keeps the newest backups and forgets the rest', async () => {
  const roomy = { ...config, capacityMb: 1048576, capacityCpus: 1024 }
  const id = (await createProject(pool, roomy, 'owner', input, 'retention-test')).project_id
  for (let i = 0; i < 5; i++)
    await pool.query(
      "INSERT INTO control.backups(id,project_id,snapshot,source_path,release,created_at) VALUES($1,$2,$3,'/x','test', now() - ($4 * interval '1 hour'))",
      [randomUUID(), id, `snap-${i}`, i]
    )
  const infrastructure = new Infrastructure(config, pool)
  let forgotten = []
  await infrastructure.applyRetention({ id, backup_retention: 2 }, async (snapshots) => {
    forgotten = snapshots
  })
  assert.deepEqual(forgotten.sort(), ['snap-2', 'snap-3', 'snap-4'])
  const left = (
    await pool.query(
      'SELECT snapshot FROM control.backups WHERE project_id=$1 ORDER BY created_at DESC',
      [id]
    )
  ).rows
  assert.deepEqual(
    left.map((row) => row.snapshot),
    ['snap-0', 'snap-1']
  )
})
test('a failed inspection is recorded without failing the operation or the project', async () => {
  const roomy = { ...config, capacityMb: 1048576, capacityCpus: 1024 }
  const created = await createProject(pool, roomy, 'owner', input, 'inspect-fails')
  await pool.query("UPDATE control.operations SET state='succeeded' WHERE id=$1", [created.id])
  await pool.query("UPDATE control.projects SET status='ready' WHERE id=$1", [created.project_id])
  const op = await requestOperation(
    pool,
    roomy,
    'owner',
    created.project_id,
    'inspect',
    {},
    'inspect-op-key'
  )
  const fake = {
    config: {},
    async inspect() {
      throw Object.assign(new Error('COMMAND_FAILED'), { step: 'docker compose', stderr: 'boom' })
    },
  }
  for (let i = 0; i < 10; i++) {
    const state = (await pool.query('SELECT state FROM control.operations WHERE id=$1', [op.id]))
      .rows[0].state
    if (state === 'succeeded') break
    await runOne(pool, roomy, fake)
  }
  assert.equal(
    (await pool.query('SELECT state FROM control.operations WHERE id=$1', [op.id])).rows[0].state,
    'succeeded'
  )
  assert.equal(
    (await pool.query('SELECT status FROM control.projects WHERE id=$1', [created.project_id]))
      .rows[0].status,
    'ready'
  )
  assert.equal(
    (
      await pool.query('SELECT error_code FROM control.project_insights WHERE project_id=$1', [
        created.project_id,
      ])
    ).rows[0].error_code,
    'INSPECTION_FAILED'
  )
})
test(
  'runtime roles: the worker writes insights and prunes backups; the API only reads them',
  { skip: process.env.CONTROL_TEST_RUNTIME_ROLES !== 'true' },
  async () => {
    const roomy = { ...config, capacityMb: 1048576, capacityCpus: 1024 }
    const id = (await createProject(pool, roomy, 'owner', input, 'grants-insights')).project_id
    const connect = (role, password) => {
      const connection = new URL(url)
      connection.username = role
      connection.password = password
      return database(connection.href)
    }
    const worker = connect('control_worker', 'integration-worker')
    const api = connect('control_api', 'integration-api')
    try {
      await worker.query(
        "INSERT INTO control.project_insights(project_id,migrations,collected_at) VALUES($1,'[]',now()) ON CONFLICT (project_id) DO UPDATE SET collected_at=now()",
        [id]
      )
      await worker.query("INSERT INTO control.project_stats(project_id,sample) VALUES($1,'{}')", [
        id,
      ])
      await worker.query('DELETE FROM control.project_stats WHERE project_id=$1', [id])
      await worker.query(
        "INSERT INTO control.schema_snapshots(id,project_id,content,hash,size_bytes) VALUES($1,$2,'','h',0)",
        [randomUUID(), id]
      )
      await worker.query(
        "INSERT INTO control.backups(id,project_id,snapshot,source_path,release,trigger) VALUES($1,$2,'s','/x','t','scheduled')",
        [randomUUID(), id]
      )
      await worker.query('DELETE FROM control.backups WHERE project_id=$1', [id])
      await api.query('SELECT * FROM control.project_insights WHERE project_id=$1', [id])
      await api.query('SELECT * FROM control.schema_snapshots WHERE project_id=$1', [id])
      await assert.rejects(
        api.query("INSERT INTO control.project_stats(project_id,sample) VALUES($1,'{}')", [id]),
        { code: '42501' }
      )
      await assert.rejects(api.query('DELETE FROM control.schema_snapshots'), { code: '42501' })
      await assert.rejects(api.query('DELETE FROM control.backups'), { code: '42501' })
    } finally {
      await worker.end()
      await api.end()
    }
  }
)

test('backup downloads serve the cloud-format dump to permitted users only', async () => {
  const roomy = { ...config, capacityMb: 1048576, capacityCpus: 1024 }
  const id = (await createProject(pool, roomy, 'owner', input, 'download-test')).project_id
  const other = (await createProject(pool, roomy, 'owner', input, 'download-other')).project_id
  const dump = '--\n-- PostgreSQL database cluster dump\n--\n'
  const infrastructure = new Infrastructure({ ...config, apiUid: process.getuid() }, pool)
  const backup = randomUUID()
  const source = join(config.dataRoot, 'source.backup.gz')
  await writeFile(source, gzipSync(dump))
  const size = await infrastructure.publishDownload({ id }, backup, source)
  assert.equal((await stat(backupDownloadPath(config.dataRoot, id, backup))).mode & 0o777, 0o400)
  await pool.query(
    "INSERT INTO control.backups(id,project_id,snapshot,source_path,release,created_at,download_bytes) VALUES($1,$2,'s','/x','test','2026-10-24T20:31:36Z',$3)",
    [backup, id, size]
  )
  // Operators may download too; a fresh identity keeps this test's rate-limit budget.
  const operatorCookie = token()
  await pool.query("INSERT INTO control.members(subject,role) VALUES('downloader','operator')")
  await pool.query(
    "INSERT INTO control.sessions(token_hash,subject,expires_at) VALUES($1,'downloader',now()+interval '1 hour')",
    [hash(operatorCookie)]
  )
  const fetchAs = (cookie, path) =>
    fetch(`${base}${path}`, { headers: { Cookie: `__Host-platform=${cookie}` } })
  const response = await fetchAs(operatorCookie, `/api/projects/${id}/backups/${backup}/download`)
  assert.equal(response.status, 200)
  assert.equal(
    response.headers.get('content-disposition'),
    'attachment; filename="db_cluster-24-10-2026@20-31-36.backup.gz"'
  )
  assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), dump)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM control.audit WHERE action='project.backup.downloaded' AND project_id=$1",
        [id]
      )
    ).rows[0].count,
    1
  )
  // Viewers cannot download; another project's path cannot reach this backup.
  assert.equal(
    (await fetchAs(viewerCookie, `/api/projects/${id}/backups/${backup}/download`)).status,
    403
  )
  assert.equal(
    (await fetchAs(operatorCookie, `/api/projects/${other}/backups/${backup}/download`)).status,
    404
  )
  assert.equal(
    (await fetchAs(operatorCookie, `/api/projects/${id}/backups/..%2F..%2Fsecrets/download`))
      .status,
    400
  )
  // Backups made before downloads existed report that clearly.
  const older = randomUUID()
  await pool.query(
    "INSERT INTO control.backups(id,project_id,snapshot,source_path,release) VALUES($1,$2,'s2','/x','test')",
    [older, id]
  )
  const missing = await fetchAs(operatorCookie, `/api/projects/${id}/backups/${older}/download`)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error, 'This backup has no download')
  // Retention removes the downloadable copy together with the backup.
  await infrastructure.applyRetention({ id, backup_retention: 1 }, async () => {})
  await assert.rejects(readFile(backupDownloadPath(config.dataRoot, id, backup)), {
    code: 'ENOENT',
  })
})
test('lifecycle operations stay visible after reload and duplicate clicks share a job', async () => {
  const creation = await createProject(pool, config, 'owner', input, randomUUID())
  const project = { id: creation.project_id }
  await pool.query("UPDATE control.operations SET state='succeeded' WHERE project_id=$1", [
    project.id,
  ])
  const [first, second] = await Promise.all([
    requestOperation(pool, config, 'owner', project.id, 'stop', { kind: 'stop' }, randomUUID()),
    requestOperation(pool, config, 'owner', project.id, 'stop', { kind: 'stop' }, randomUUID()),
  ])
  assert.equal(first.id, second.id)
  const read = async () => {
    const response = await fetch(`${base}/api/projects/${project.id}`, {
      headers: { Cookie: `__Host-platform=${ownerCookie}` },
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  assert.equal((await read()).pendingOperation.kind, 'stop')
  assert.equal(
    (await listProjects(pool, config, 'owner', '', 100)).projects.find((p) => p.id === project.id)
      ?.pendingOperation.id,
    first.id
  )
  await pool.query("UPDATE control.operations SET state='running' WHERE id=$1", [first.id])
  assert.equal((await read()).pendingOperation.state, 'running')
  await pool.query("UPDATE control.operations SET state='succeeded' WHERE id=$1", [first.id])
  assert.equal((await read()).pendingOperation, null)
})

test('project log requests enforce membership and roles and work for paused projects', async () => {
  const creation = await createProject(pool, config, 'owner', input, randomUUID())
  const id = creation.project_id
  await pool.query(
    "UPDATE control.projects SET status='stopped',desired_state='stopped' WHERE id=$1",
    [id]
  )
  const raw = token()
  await pool.query(
    "INSERT INTO control.project_members(project_id,subject,role) VALUES($1,'logs-operator','operator')",
    [id]
  )
  await pool.query(
    "INSERT INTO control.sessions(token_hash,subject,expires_at) VALUES($1,'logs-operator',now()+interval '1 hour')",
    [hash(raw)]
  )
  let reads = 0
  const live = serveLiveRequests(
    pool,
    {
      logs: async (project, payload) => {
        assert.equal(project.id, id)
        assert.equal(payload.service, 'db')
        reads++
        return { entries: [], unavailable: [] }
      },
    },
    { log: { error() {} } }
  )
  try {
    const request = (project, cookie, query = 'service=db') =>
      fetch(`${base}/api/projects/${project}/logs?${query}`, {
        headers: { Cookie: `__Host-platform=${cookie}` },
      })
    assert.equal((await request(id, viewerCookie)).status, 403)
    const another = (await listProjects(pool, config, 'owner')).projects.find((p) => p.id !== id)
    assert.equal((await request(another.id, raw)).status, 403)
    assert.equal((await request(id, ownerCookie, 'service=../../db')).status, 400)
    const result = await request(id, raw)
    assert.equal(result.status, 200)
    assert.deepEqual((await result.json()).entries, [])
    assert.equal(reads, 1)
  } finally {
    await live.stop()
  }
})

test('Studio storage routes bind configuration and credentials to the authenticated project host', async () => {
  const id = (await createProject(pool, config, 'owner', input, randomUUID())).project_id
  const other = (await createProject(pool, config, 'owner', input, randomUUID())).project_id
  const raw = token()
  await pool.query(
    "INSERT INTO control.project_members(project_id,subject,role) VALUES($1,'storage-operator','operator')",
    [id]
  )
  await pool.query(
    "INSERT INTO control.sessions(token_hash,subject,project_id,expires_at) VALUES($1,'storage-operator',$2,now()+interval '1 hour')",
    [hash(raw), id]
  )
  const host = `${id}.studio.${config.baseDomain}`
  const path = '/api/platform/projects/default/config/storage'
  const live = serveLiveRequests(
    pool,
    {
      'storage-config': async (project) => {
        assert.equal(project.id, id)
        return { fileSizeLimit: 1024 }
      },
      'storage-update': async (project, payload) => {
        assert.equal(project.id, id)
        return payload.settings
      },
      'database-settings': async (project) => {
        assert.equal(project.id, id)
        return { poolSize: 20 }
      },
      'database-settings-update': async (project, payload) => {
        assert.equal(project.id, id)
        return payload.settings
      },
      logs: async (project) => {
        assert.equal(project.id, id)
        return { entries: [], unavailable: [] }
      },
    },
    { log: { error() {} } }
  )
  const request = (route, options = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        `${base}${route}`,
        {
          method: options.method,
          headers: { Host: host, Cookie: `__Host-studio=${raw}`, ...options.headers },
        },
        (res) => {
          let text = ''
          res.on('data', (chunk) => {
            text += chunk
          })
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: new Headers(res.headers),
              json: async () => JSON.parse(text),
            })
          )
        }
      )
      req.on('error', reject)
      req.end(options.body)
    })
  try {
    assert.equal(
      (await request(path, { headers: { Host: `${other}.studio.${config.baseDomain}` } })).status,
      401
    )
    assert.equal(
      (await request(path, { headers: { Cookie: `__Host-studio=${viewerCookie}` } })).status,
      401
    )
    const read = await request(path)
    assert.equal(read.status, 200)
    assert.equal((await read.json()).fileSizeLimit, 1024)
    const patch = (origin, body) =>
      request(path, {
        method: 'PATCH',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    assert.equal((await patch('https://attacker.example', { fileSizeLimit: 2048 })).status, 403)
    assert.equal(
      (await patch(`https://${host}`, { features: { vectorBuckets: { enabled: true } } })).status,
      400
    )
    assert.equal((await patch(`https://${host}`, { fileSizeLimit: 2048 })).status, 200)
    const credentials = await request('/api/platform/storage/default/credentials')
    assert.equal(credentials.status, 200)
    assert.equal(credentials.headers.get('cache-control'), 'no-store')
    const data = (await credentials.json()).data[0]
    assert.equal(typeof data.secret_key, 'string')
    assert.equal(JSON.stringify(data).includes('POSTGRES_PASSWORD'), false)
    const database = await request('/_platform/api/database-settings')
    assert.equal(database.status, 200)
    assert.equal((await database.json()).poolSize, 20)
    const logs = await request('/_platform/api/logs/entries?service=db')
    assert.equal(logs.status, 200)
    const view = await request('/_platform/api/logs/view')
    assert.equal(view.status, 200)
    assert.equal(view.headers.get('content-type'), 'text/html')
    assert.match(view.headers.get('content-security-policy'), /frame-ancestors 'self'/)
    const denied = token()
    await pool.query(
      "INSERT INTO control.sessions(token_hash,subject,project_id,expires_at) VALUES($1,'viewer',$2,now()+interval '1 hour')",
      [hash(denied), id]
    )
    for (const route of [
      '/_platform/api/database-settings',
      '/_platform/api/logs/view',
      '/api/platform/storage/default/credentials',
    ])
      assert.equal(
        (await request(route, { headers: { Cookie: `__Host-studio=${denied}` } })).status,
        403
      )
    await pool.query("UPDATE control.operations SET state='succeeded' WHERE project_id=$1", [id])
    const password = 'integration-only-reset-password-2026'
    const queued = await request('/_platform/api/database-settings/password', {
      method: 'POST',
      headers: {
        Origin: `https://${host}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `password-${randomUUID()}`,
      },
      body: JSON.stringify({ password }),
    })
    assert.equal(queued.status, 202)
    const operationId = (await queued.json()).id
    const operation = (
      await pool.query('SELECT payload FROM control.operations WHERE id=$1', [operationId])
    ).rows[0]
    assert.equal(JSON.stringify(operation.payload).includes(password), false)
    assert.equal(typeof operation.payload.encryptedPassword, 'string')
    assert.equal(
      (
        await request(`/_platform/api/database-settings/operations/${operationId}`, {
          headers: { Host: `${other}.studio.${config.baseDomain}` },
        })
      ).status,
      401
    )
    await pool.query("UPDATE control.operations SET state='failed' WHERE id=$1", [operationId])
  } finally {
    await live.stop()
  }
})

test('migration checksums ignore line endings but catch real edits', async () => {
  const { readFile } = await import('node:fs/promises')
  const sql = (
    await readFile(new URL('../migrations/001_control.sql', import.meta.url), 'utf8')
  ).replace(/\r\n/g, '\n')
  const set = (value) =>
    pool.query("UPDATE public.platform_migrations SET checksum=$1 WHERE name='001_control.sql'", [
      value,
    ])
  try {
    // Applied from a Windows (CRLF) checkout, now running from an LF checkout.
    await set(hash(sql.replace(/\n/g, '\r\n')))
    await migrate(pool)
    await set(hash(`${sql}-- edited\n`))
    await assert.rejects(migrate(pool), /Migration checksum changed: 001_control\.sql/)
  } finally {
    await set(hash(sql))
  }
})
test('usage totals every accessible project and hides others', async () => {
  const roomy = { ...config, capacityMb: 1048576, capacityCpus: 1024 }
  const id = (await createProject(pool, roomy, 'owner', input, 'usage-project')).project_id
  await pool.query(`UPDATE control.projects SET desired_state='running', metrics=$2 WHERE id=$1`, [
    id,
    {
      disk: { projectBytes: 5000, hostAvailableBytes: 10000 },
      stats: [{ memory: '1MiB / 2MiB', cpu: '10%' }],
    },
  ])
  await pool.query(
    `INSERT INTO control.project_insights(project_id,performance,collected_at) VALUES($1,$2,now())
     ON CONFLICT (project_id) DO UPDATE SET performance=excluded.performance`,
    [id, { database_bytes: 1234, connections: { total: 7 }, max_connections: 100 }]
  )
  const { platformUsage } = await import('../src/usage.mjs')
  const usage = await platformUsage(pool, roomy, 'owner')
  const row = usage.projects.find((p) => p.id === id)
  assert.deepEqual(
    {
      memoryUsedBytes: row.memoryUsedBytes,
      cpuPercent: row.cpuPercent,
      diskBytes: row.diskBytes,
      databaseBytes: row.databaseBytes,
      connections: row.connections,
    },
    {
      memoryUsedBytes: 1048576,
      cpuPercent: 10,
      diskBytes: 5000,
      databaseBytes: 1234,
      connections: 7,
    }
  )
  assert.equal(usage.capacity.memoryMb, 1048576)
  // Every project, not one dashboard page.
  assert.equal(
    usage.projects.length,
    (await pool.query("SELECT count(*)::int AS n FROM control.projects WHERE status<>'deleted'"))
      .rows[0].n
  )
  await pool.query(
    "INSERT INTO control.project_members(project_id,subject,role) VALUES($1,'usage-only','viewer')",
    [id]
  )
  assert.deepEqual(
    (await platformUsage(pool, roomy, 'usage-only')).projects.map((p) => p.id),
    [id]
  )
  const response = await fetch(`${base}/api/usage`, {
    headers: { Cookie: `__Host-platform=${ownerCookie}` },
  })
  assert.equal(response.status, 200)
})

test('Studio Observability reads only its own project samples and log counts', async () => {
  const id = (await createProject(pool, config, 'owner', input, randomUUID())).project_id
  const other = (await createProject(pool, config, 'owner', input, randomUUID())).project_id
  const raw = token()
  await pool.query(
    "INSERT INTO control.project_members(project_id,subject,role) VALUES($1,'obs-operator','operator')",
    [id]
  )
  await pool.query(
    "INSERT INTO control.sessions(token_hash,subject,project_id,expires_at) VALUES($1,'obs-operator',$2,now()+interval '1 hour')",
    [hash(raw), id]
  )
  const now = Date.now()
  const sample = (cpuPercent) => ({ cpus: 2, cpuPercent, memoryUsed: 256, memoryLimit: 1024 })
  for (const [project, cpu] of [
    [id, 50],
    [other, 190],
  ])
    await pool.query(
      'INSERT INTO control.project_metric_samples(project_id,sampled_at,sample) VALUES($1,$2,$3)',
      [project, new Date(now - 120000), sample(cpu)]
    )
  await pool.query(
    "INSERT INTO control.project_log_counts(project_id,bucket,service,ok,warning,error) VALUES($1,date_trunc('minute',now()-interval '2 minutes'),'api-gw',7,2,1)",
    [id]
  )
  const host = `${id}.studio.${config.baseDomain}`
  const get = (route) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        `${base}${route}`,
        { headers: { Host: host, Cookie: `__Host-studio=${raw}` } },
        (res) => {
          let text = ''
          res.on('data', (chunk) => (text += chunk))
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
        }
      )
      req.on('error', reject)
      req.end()
    })
  const start = new Date(now - 3600000).toISOString()
  const end = new Date(now).toISOString()
  const infra = await get(
    `/api/platform/projects/default/infra-monitoring?attributes=avg_cpu_usage&attributes=ram_usage&startDate=${start}&endDate=${end}&interval=1h`
  )
  assert.equal(infra.status, 200)
  assert.equal(infra.body.series.avg_cpu_usage.totalAverage, 25)
  assert.equal(infra.body.series.ram_usage.totalAverage, 25)
  const health = await get(
    `/api/platform/projects/default/analytics/endpoints/service-health?iso_timestamp_start=${start}&iso_timestamp_end=${end}&granularity=hour`
  )
  assert.equal(health.status, 200)
  assert.deepEqual(health.body.result[0].edge_logs, { ok: 7, warning: 2, error: 1, total: 10 })
  const invalid = await get(
    `/api/platform/projects/default/infra-monitoring?attributes=avg_cpu_usage&startDate=${start}&interval=2y`
  )
  assert.equal(invalid.status, 400)
})
