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
import { runOne } from '../src/worker.mjs'
import { managementServer } from '../src/server.mjs'

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
  await pool.query('DROP SCHEMA IF EXISTS control CASCADE')
  await pool.query('DROP TABLE IF EXISTS public.platform_migrations')
  await migrate(pool)
  await migrate(pool)
  if (process.env.CONTROL_TEST_RUNTIME_ROLES === 'true') {
    for (const role of ['control_api', 'control_worker']) {
      if (!(await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
        if (role === 'control_api')
          await pool.query(
            "CREATE ROLE control_api LOGIN PASSWORD 'integration-api' NOSUPERUSER NOCREATEDB NOCREATEROLE"
          )
        else
          await pool.query(
            "CREATE ROLE control_worker LOGIN PASSWORD 'integration-worker' NOSUPERUSER NOCREATEDB NOCREATEROLE"
          )
      }
    }
    // Runtime grants are versioned migration SQL, applied here after test role setup.
    await pool.query("DELETE FROM public.platform_migrations WHERE name='002_runtime_roles.sql'")
    await migrate(pool)
  }
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
    assert.match(await page.text(), /Sign-in token/)
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
    assert.deepEqual(await me.json(), { subject: 'local-admin', role: 'owner' })
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
