import { test, before, after } from 'node:test'
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
