// Developer tools against real PostgreSQL: access tokens, the MCP endpoint, the
// worker's live requests, and GitHub deployments. A second database stands in for
// a project's database (CONTROL_TEST_PROJECT_DATABASE_URL, superuser access).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { database, migrate } from '../src/database.mjs'
import { createProject } from '../src/service.mjs'
import { hash, token } from '../src/core.mjs'
import { managementServer } from '../src/server.mjs'
import { serveLiveRequests } from '../src/live.mjs'
import { ProjectDatabase } from '../src/project-db.mjs'
import { pollGithub, runDeployment, webhookSecret } from '../src/github.mjs'

const url = process.env.CONTROL_TEST_DATABASE_URL
const projectUrl = process.env.CONTROL_TEST_PROJECT_DATABASE_URL
const skip = !url || !projectUrl
let pool, server, base, cookie, live, projectDb, dataRoot, metaServer, project
const restarts = []
const config = {
  baseDomain: 'platform.example.com',
  origin: 'https://manage.platform.example.com',
  key: 'cd'.repeat(32),
  capacityMb: 1048576,
  capacityCpus: 1024,
  release: 'test',
  // This file creates more tokens than the production limit of 5 a minute.
  rateLimits: { sensitive: { capacity: 100, perMinute: 100 } },
}
class TestProjectDatabase extends ProjectDatabase {
  secrets() {
    return { POSTGRES_PASSWORD: new URL(projectUrl).password }
  }
}
const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' })

before(async () => {
  if (skip) return
  pool = database(url)
  await pool.query('DROP SCHEMA IF EXISTS control CASCADE')
  await pool.query('DROP TABLE IF EXISTS public.platform_migrations')
  await migrate(pool)
  await pool.query(
    "INSERT INTO control.members(subject,role) VALUES('owner','owner'),('viewer','viewer')"
  )
  cookie = token()
  await pool.query(
    "INSERT INTO control.sessions(token_hash,subject,expires_at) VALUES($1,'owner',now()+interval '1 hour')",
    [hash(cookie)]
  )
  // A clean project database.
  const admin = new pg.Client({ connectionString: projectUrl.replace(/\/[^/]+$/, '/postgres') })
  await admin.connect()
  const name = new URL(projectUrl).pathname.slice(1)
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  dataRoot = await mkdtemp(join(tmpdir(), 'platform-dev-'))
  metaServer = createServer((request, response) => {
    const target = new URL(request.url, 'http://meta')
    response.end(
      `// types for ${target.searchParams.get('included_schemas')}\nexport type Database = {}\n`
    )
  })
  await new Promise((done) => metaServer.listen(0, '127.0.0.1', done))
  const target = new URL(projectUrl)
  const workerConfig = {
    ...config,
    projectDbHost: target.hostname,
    projectDbPort: Number(target.port || 5432),
    projectDbName: target.pathname.slice(1),
    projectMetaUrl: `http://127.0.0.1:${metaServer.address().port}`,
  }
  const infrastructure = {
    directory: (id) => join(dataRoot, id),
    compose: async (_project, args) => restarts.push(args.join(' ')),
  }
  projectDb = new TestProjectDatabase(workerConfig, infrastructure, {
    Client: class extends pg.Client {
      constructor(options) {
        super({ ...options, user: options.user === 'postgres' ? target.username : options.user })
      }
    },
  })
  live = serveLiveRequests(
    pool,
    {
      sql: (p, payload, options) => projectDb.sql(p, payload, options),
      types: (p, payload) => projectDb.types(p, payload),
      functions: (p, payload) => projectDb.functions(p, payload),
      'deploy-function': (p, payload) => projectDb.deployFunction(p, payload),
      migrations: (p) => projectDb.migrations(p),
      'apply-migration': (p, payload) => projectDb.applyNamedMigration(p, payload),
    },
    { log: { error() {} } }
  )
  server = managementServer(pool, config, { begin() {} })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${server.address().port}`
  const created = await createProject(
    pool,
    config,
    'owner',
    { name: 'Developer tools', siteUrl: 'https://app.example.com' },
    'developer-tools-project'
  )
  project = created.project_id
  await mkdir(join(dataRoot, project, 'volumes', 'functions', 'main'), { recursive: true })
  await writeFile(
    join(dataRoot, project, 'volumes', 'functions', 'deno.jsonc'),
    '{\n  // platform imports\n  "imports": { "@supabase/functions-js": "jsr:@supabase/functions-js@^2" }\n}\n'
  )
})
after(async () => {
  if (skip) return
  await live?.stop()
  if (server) await new Promise((done) => server.close(done))
  if (metaServer) await new Promise((done) => metaServer.close(done))
  await pool?.end()
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
})

const sessionPost = (path, payload, method = 'POST') =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: config.origin,
      Cookie: `__Host-platform=${cookie}`,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
const newToken = async (body) =>
  (await (await sessionPost('/api/access-tokens', body)).json()).token
let rpcId = 0
const mcp = async (accessToken, method, params, query = '') => {
  const response = await fetch(`${base}/mcp${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  return { status: response.status, body: response.status === 202 ? null : await response.json() }
}
const call = async (accessToken, name, args, query) => {
  const { body } = await mcp(accessToken, 'tools/call', { name, arguments: args }, query)
  if (!body.result) throw new Error(`${name}: ${JSON.stringify(body)}`)
  const text = body.result.content[0].text
  return { isError: Boolean(body.result.isError), text }
}

test(
  'access tokens authenticate API calls, respect read-only, and can be revoked',
  { skip },
  async () => {
    const created = await (await sessionPost('/api/access-tokens', { name: 'CI' })).json()
    assert.match(created.token, /^sbp_[a-f0-9]{40}$/)
    const bearer = { Authorization: `Bearer ${created.token}` }
    assert.equal((await fetch(`${base}/api/projects`, { headers: bearer })).status, 200)
    // No Origin needed for bearer mutations; token management needs the dashboard.
    const backup = await fetch(`${base}/api/projects/${project}/backup-settings`, {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalHours: 12, retention: 3 }),
    })
    assert.equal(backup.status, 200)
    assert.equal((await fetch(`${base}/api/access-tokens`, { headers: bearer })).status, 403)
    const readOnly = await newToken({ name: 'Viewer agent', readOnly: true })
    const denied = await fetch(`${base}/api/projects/${project}/backup-settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readOnly}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalHours: 6, retention: 3 }),
    })
    assert.equal(denied.status, 403)
    const listed = await (
      await fetch(`${base}/api/access-tokens`, { headers: { Cookie: `__Host-platform=${cookie}` } })
    ).json()
    assert.equal(listed.length, 2)
    assert(listed.every((row) => !('token' in row) && !('token_hash' in row)))
    assert.equal(
      (await sessionPost(`/api/access-tokens/${created.id}`, undefined, 'DELETE')).status,
      200
    )
    assert.equal((await fetch(`${base}/api/projects`, { headers: bearer })).status, 401)
    assert.equal(
      (await fetch(`${base}/api/projects`, { headers: { Authorization: 'Bearer sbp_nope' } }))
        .status,
      401
    )
  }
)

test('MCP handshake, tool listing, scoping, and protocol errors', { skip }, async () => {
  const unauthenticated = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })
  assert.equal(unauthenticated.status, 401)
  assert.match(unauthenticated.headers.get('www-authenticate'), /^Bearer/)
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource`)).status, 404)
  const full = await newToken({ name: 'Agent' })
  const init = await mcp(full, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  assert.equal(init.body.result.serverInfo.name, 'supabase-platform')
  const notification = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${full}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  assert.equal(notification.status, 202)
  const names = (await mcp(full, 'tools/list')).body.result.tools.map((tool) => tool.name)
  for (const name of [
    'list_projects',
    'execute_sql',
    'apply_migration',
    'deploy_edge_function',
    'create_project',
  ])
    assert(names.includes(name), name)
  const readOnly = await newToken({ name: 'Reader', readOnly: true })
  const readNames = (await mcp(readOnly, 'tools/list')).body.result.tools.map((tool) => tool.name)
  assert(readNames.includes('execute_sql') && !readNames.includes('apply_migration'))
  const scoped = (await mcp(full, 'tools/list', {}, `?project_id=${project}&read_only=true`)).body
    .result.tools
  assert(
    !scoped.some((tool) =>
      ['list_projects', 'create_project', 'apply_migration'].includes(tool.name)
    )
  )
  const projects = JSON.parse((await call(full, 'list_projects', {})).text)
  assert(projects.some((row) => row.id === project))
  assert.equal((await mcp(full, 'nope')).body.error.code, -32601)
  const foreign = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${full}`,
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  assert.equal(foreign.status, 403)
  // A scoped connection cannot reach other projects.
  const other = await call(
    full,
    'get_project',
    { project_id: 'p000000000000000000000000' },
    `?project_id=${project}`
  )
  assert(other.isError && /limited to project/.test(other.text))
})

test(
  'MCP runs SQL, migrations, types, and Edge Functions through the worker',
  { skip },
  async () => {
    const full = await newToken({ name: 'Builder' })
    const migration = await call(full, 'apply_migration', {
      project_id: project,
      name: 'Create students',
      query:
        'create table public.students (id bigint generated always as identity primary key, name text not null); alter table public.students enable row level security;',
    })
    assert.equal(migration.isError, false, migration.text)
    assert.equal(JSON.parse(migration.text).name, 'create_students')
    const insert = await call(full, 'execute_sql', {
      project_id: project,
      query:
        "insert into public.students(name) values ('Ama'),('Kofi'); select id, name, '\\x01'::bytea as raw from public.students order by id",
    })
    assert.equal(insert.isError, false, insert.text)
    assert.match(insert.text, /untrusted-data-/)
    const rows = JSON.parse(insert.text.match(/<untrusted-data-[^>]+>\n(.*)\n<\/untrusted/s)[1])
    assert.deepEqual(
      rows.map((row) => row.name),
      ['Ama', 'Kofi']
    )
    assert.equal(rows[0].raw, '\\x01')
    const tables = JSON.parse((await call(full, 'list_tables', { project_id: project })).text)
    const students = tables.find((table) => table.name === 'students')
    assert.equal(students.rls_enabled, true)
    assert.deepEqual(students.primary_key, ['id'])
    assert.deepEqual(
      students.columns.map((column) => column.name),
      ['id', 'name']
    )
    const history = JSON.parse((await call(full, 'list_migrations', { project_id: project })).text)
    assert.equal(history.length, 1)
    assert.equal(history[0].name, 'create_students')
    // Read-only tokens read (past RLS) but cannot write, even if they try to switch.
    const reader = await newToken({ name: 'Reader 2', readOnly: true })
    const read = await call(reader, 'execute_sql', {
      project_id: project,
      query: 'select count(*)::int as n from public.students',
    })
    assert.match(read.text, /"n":2/)
    for (const query of [
      "insert into public.students(name) values ('Yaw')",
      "set transaction read write; insert into public.students(name) values ('Yaw')",
      'drop table public.students',
    ]) {
      const write = await call(reader, 'execute_sql', { project_id: project, query })
      assert.equal(write.isError, true, query)
    }
    const check = await call(full, 'execute_sql', {
      project_id: project,
      query: 'select count(*)::int as n from public.students',
    })
    assert.match(check.text, /"n":2/)
    const syntax = await call(full, 'execute_sql', { project_id: project, query: 'selec 1' })
    assert(syntax.isError && /syntax error/.test(syntax.text))
    const types = await call(full, 'generate_typescript_types', {
      project_id: project,
      schemas: ['public'],
    })
    assert.match(types.text, /types for public/)
    const deployed = await call(full, 'deploy_edge_function', {
      project_id: project,
      name: 'hello-world',
      files: [
        {
          name: 'index.ts',
          content: "import { z } from 'zod'\nDeno.serve(() => new Response('hi'))\n",
        },
        { name: 'deno.json', content: '{ "imports": { "zod": "npm:zod@3" } }' },
      ],
    })
    assert.equal(deployed.isError, false, deployed.text)
    assert.equal(
      await readFile(
        join(dataRoot, project, 'volumes', 'functions', 'hello-world', 'index.ts'),
        'utf8'
      ),
      "import { z } from 'zod'\nDeno.serve(() => new Response('hi'))\n"
    )
    const importMap = JSON.parse(
      await readFile(join(dataRoot, project, 'volumes', 'functions', 'deno.jsonc'), 'utf8')
    )
    assert.equal(importMap.imports.zod, 'npm:zod@3')
    assert.equal(importMap.imports['@supabase/functions-js'], 'jsr:@supabase/functions-js@^2')
    assert(restarts.includes('restart functions'))
    for (const name of ['main', '../escape'])
      assert.equal(
        (
          await call(full, 'deploy_edge_function', {
            project_id: project,
            name,
            files: [{ name: 'index.ts', content: '' }],
          })
        ).isError,
        true
      )
    const escape = await call(full, 'deploy_edge_function', {
      project_id: project,
      name: 'bad',
      files: [
        { name: 'index.ts', content: '' },
        { name: '../../x.ts', content: '' },
      ],
    })
    assert.equal(escape.isError, true)
    const listed = JSON.parse(
      (await call(full, 'list_edge_functions', { project_id: project })).text
    )
    assert.deepEqual(
      listed.map((fn) => fn.name),
      ['hello-world']
    )
    const source = JSON.parse(
      (await call(full, 'get_edge_function', { project_id: project, function_slug: 'hello-world' }))
        .text
    )
    assert.deepEqual(source.files.map((file) => file.name).sort(), ['deno.json', 'index.ts'])
  }
)

test('viewers cannot run SQL through MCP', { skip }, async () => {
  const viewerCookie = token()
  await pool.query(
    "INSERT INTO control.sessions(token_hash,subject,expires_at) VALUES($1,'viewer',now()+interval '1 hour')",
    [hash(viewerCookie)]
  )
  const created = await (
    await fetch(`${base}/api/access-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: config.origin,
        Cookie: `__Host-platform=${viewerCookie}`,
      },
      body: JSON.stringify({ name: 'Viewer token' }),
    })
  ).json()
  const result = await call(created.token, 'execute_sql', {
    project_id: project,
    query: 'select 1',
  })
  assert(result.isError && /permission/.test(result.text))
})

// ---- GitHub ----
async function repository(files) {
  const directory = await mkdtemp(join(tmpdir(), 'platform-repo-'))
  sh(directory, 'git', 'init', '-q')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, '..'), { recursive: true })
    await writeFile(join(directory, path), content)
  }
  sh(directory, 'git', 'add', '-A')
  sh(
    directory,
    'git',
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    'commit',
    '-qm',
    'commit'
  )
  const sha = sh(directory, 'git', 'rev-parse', 'HEAD').trim()
  const tarball = execFileSync(
    'git',
    ['archive', '--format=tar.gz', `--prefix=owner-app-${sha.slice(0, 7)}/`, 'HEAD'],
    { cwd: directory }
  )
  await rm(directory, { recursive: true, force: true })
  return { sha, tarball }
}
function fakeGithub(repo) {
  const calls = []
  const fetchImpl = async (target, options) => {
    calls.push(target)
    if (target.includes('/commits/')) {
      if (options.headers['If-None-Match'] === `"${repo.sha}"`)
        return new Response(null, { status: 304 })
      return new Response(repo.sha, { status: 200, headers: { etag: `"${repo.sha}"` } })
    }
    if (target.includes(`/tarball/${repo.sha}`)) return new Response(repo.tarball, { status: 200 })
    return new Response('{}', { status: 404 })
  }
  return { fetchImpl, calls }
}

test(
  'GitHub deployments apply migrations once, seed new projects, and deploy functions',
  { skip },
  async () => {
    // Start from an empty project database (the MCP test applied its own migration).
    const reset = new pg.Client({ connectionString: projectUrl })
    await reset.connect()
    await reset.query(
      'DROP SCHEMA IF EXISTS supabase_migrations CASCADE; DROP TABLE IF EXISTS public.students'
    )
    await reset.end()
    const created = await createProject(
      pool,
      config,
      'owner',
      {
        name: 'From GitHub',
        siteUrl: 'https://app.example.com',
        github: { repository: 'https://github.com/owner/app.git', branch: 'main' },
      },
      'github-provision'
    )
    const id = created.project_id
    const link = (await pool.query('SELECT * FROM control.github_links WHERE project_id=$1', [id]))
      .rows[0]
    assert.equal(link.repository, 'owner/app')
    assert.equal(link.directory, 'supabase')
    await mkdir(join(dataRoot, id, 'volumes', 'functions'), { recursive: true })
    const first = await repository({
      'supabase/migrations/20250101000000_courses.sql':
        'create table public.courses (id int primary key, title text);',
      'supabase/migrations/20250201000000_course_code.sql':
        'alter table public.courses add column code text;',
      'supabase/seed.sql': "insert into public.courses values (1, 'Algebra', 'MATH101');",
      'supabase/functions/enroll/index.ts': 'Deno.serve(() => new Response("ok"))',
      'supabase/functions/_shared/cors.ts': 'export const cors = {}',
      'supabase/functions/enroll/.env': 'SECRET=1',
      'README.md': '# app',
    })
    const row = (await pool.query('SELECT * FROM control.projects WHERE id=$1', [id])).rows[0]
    const github = fakeGithub(first)
    const deploy = (payload) =>
      runDeployment({
        db: pool,
        config,
        projectDb,
        project: row,
        operation: { id: randomUUID(), payload },
        fetchImpl: github.fetchImpl,
      })
    await deploy({ source: 'provision', seed: true })
    const project = new pg.Client({ connectionString: projectUrl })
    await project.connect()
    try {
      assert.deepEqual((await project.query('select title, code from public.courses')).rows, [
        { title: 'Algebra', code: 'MATH101' },
      ])
      const deployment = (
        await pool.query(
          "SELECT * FROM control.deployments WHERE project_id=$1 AND source='provision'",
          [id]
        )
      ).rows[0]
      assert.equal(deployment.state, 'succeeded')
      assert.equal(deployment.commit_sha, first.sha)
      assert.deepEqual(deployment.migrations, [
        '20250101000000_courses.sql',
        '20250201000000_course_code.sql',
      ])
      assert.deepEqual(deployment.functions.sort(), ['_shared', 'enroll'])
      assert(deployment.warnings.some((warning) => /seed\.sql/.test(warning)))
      assert.equal(
        await readFile(join(dataRoot, id, 'volumes', 'functions', 'enroll', 'index.ts'), 'utf8'),
        'Deno.serve(() => new Response("ok"))'
      )
      await assert.rejects(readFile(join(dataRoot, id, 'volumes', 'functions', 'enroll', '.env')), {
        code: 'ENOENT',
      })
      // Redeploying the same commit changes nothing and never reruns the seed.
      await deploy({ source: 'manual', seed: true })
      assert.equal(
        (await project.query('select count(*)::int as n from public.courses')).rows[0].n,
        1
      )
      // A migration older than the newest applied one is refused, like supabase db push.
      const stale = await repository({
        'supabase/migrations/20250101000000_courses.sql':
          'create table public.courses (id int primary key, title text);',
        'supabase/migrations/20250201000000_course_code.sql':
          'alter table public.courses add column code text;',
        'supabase/migrations/20250115000000_late.sql': 'create table public.late (id int);',
      })
      Object.assign(github, fakeGithub(stale))
      await assert.rejects(
        runDeployment({
          db: pool,
          config,
          projectDb,
          project: row,
          operation: { id: randomUUID(), payload: { source: 'push' } },
          fetchImpl: github.fetchImpl,
        }),
        { message: 'DEPLOYMENT_FAILED' }
      )
      const refused = (
        await pool.query(
          'SELECT * FROM control.deployments WHERE project_id=$1 AND commit_sha=$2',
          [id, stale.sha]
        )
      ).rows[0]
      assert.equal(refused.state, 'failed')
      assert.match(
        refused.error,
        /20250115000000_late\.sql is older than the last applied migration/
      )
      assert.equal((await project.query("select to_regclass('public.late') as t")).rows[0].t, null)
      // A broken migration stops the deployment; the ones before it stay applied.
      const broken = await repository({
        'supabase/migrations/20250101000000_courses.sql': 'x',
        'supabase/migrations/20250201000000_course_code.sql': 'x',
        'supabase/migrations/20250301000000_ok.sql': 'create table public.ok (id int);',
        'supabase/migrations/20250401000000_bad.sql': 'create tabel public.bad (id int);',
      })
      const brokenGithub = fakeGithub(broken)
      await assert.rejects(
        runDeployment({
          db: pool,
          config,
          projectDb,
          project: row,
          operation: { id: randomUUID(), payload: { source: 'push' } },
          fetchImpl: brokenGithub.fetchImpl,
        }),
        { message: 'DEPLOYMENT_FAILED' }
      )
      const failed = (
        await pool.query(
          'SELECT * FROM control.deployments WHERE project_id=$1 AND commit_sha=$2',
          [id, broken.sha]
        )
      ).rows[0]
      assert.match(failed.error, /20250401000000_bad\.sql: syntax error/)
      assert.deepEqual(failed.migrations, ['20250301000000_ok.sql'])
      assert.equal(
        (await project.query("select to_regclass('public.ok') is not null as t")).rows[0].t,
        true
      )
      assert.equal(
        (
          await project.query(
            "select count(*)::int as n from supabase_migrations.schema_migrations where version like '2025%'"
          )
        ).rows[0].n,
        3
      )
    } finally {
      await project.end()
    }
  }
)

test('pushes are picked up by polling (with ETags) and signed webhooks', { skip }, async () => {
  const created = await createProject(
    pool,
    config,
    'owner',
    {
      name: 'Polled',
      siteUrl: 'https://app.example.com',
      github: {
        repository: 'owner/polled',
        branch: 'release/v1',
        token: 'github_pat_' + 'a'.repeat(40),
      },
    },
    'github-polled'
  )
  const id = created.project_id
  await pool.query("UPDATE control.projects SET status='ready' WHERE id=$1", [id])
  const repo = { sha: 'a'.repeat(40), tarball: Buffer.alloc(0) }
  const github = fakeGithub(repo)
  await pollGithub(pool, config, { fetchImpl: github.fetchImpl })
  assert(github.calls.some((target) => target.endsWith('/repos/owner/polled/commits/release%2Fv1')))
  const queued = (
    await pool.query("SELECT * FROM control.operations WHERE project_id=$1 AND kind='deploy'", [id])
  ).rows
  assert.equal(queued.length, 1)
  assert.equal(queued[0].actor, '@github')
  assert.equal(queued[0].payload.sha, repo.sha)
  // Checked recently: no request. Forced recheck: 304, and nothing new is queued.
  github.calls.length = 0
  await pollGithub(pool, config, { fetchImpl: github.fetchImpl })
  assert.equal(github.calls.length, 0)
  await pool.query(
    "UPDATE control.github_links SET checked_at=now()-interval '1 hour' WHERE project_id=$1",
    [id]
  )
  await pollGithub(pool, config, { fetchImpl: github.fetchImpl })
  assert.equal(github.calls.length, 1)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM control.operations WHERE project_id=$1 AND kind='deploy'",
        [id]
      )
    ).rows[0].n,
    1
  )
  // The stored token is encrypted and never returned.
  const status = await (
    await fetch(`${base}/api/projects/${id}/github`, {
      headers: { Cookie: `__Host-platform=${cookie}` },
    })
  ).json()
  assert.equal(status.link.hasToken, true)
  assert(!JSON.stringify(status).includes('github_pat_'))
  // Webhooks: a valid signature queues the pushed commit once.
  const payload = JSON.stringify({
    ref: 'refs/heads/release/v1',
    after: 'b'.repeat(40),
    repository: { full_name: 'Owner/Polled' },
  })
  const sign = (secret) => `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
  const hook = (signature) =>
    fetch(`${base}/hooks/github/${id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signature,
      },
      body: payload,
    })
  assert.equal((await hook(sign('wrong'))).status, 401)
  await pool.query("UPDATE control.operations SET state='succeeded' WHERE project_id=$1", [id])
  const accepted = await hook(sign(webhookSecret(config, id)))
  assert.equal(accepted.status, 202)
  assert.deepEqual(await accepted.json(), { queued: true })
  assert.equal((await hook(sign(webhookSecret(config, id)))).status, 202)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM control.operations WHERE project_id=$1 AND kind='deploy' AND payload->>'sha'=$2",
        [id, 'b'.repeat(40)]
      )
    ).rows[0].n,
    1
  )
})

test(
  'runtime roles: the API queues and reads, only the worker records results and deployments',
  { skip: skip || process.env.CONTROL_TEST_RUNTIME_ROLES !== 'true' },
  async () => {
    const connect = (role, password) => {
      const connection = new URL(url)
      connection.username = role
      connection.password = password
      return database(connection.href)
    }
    const api = connect('control_api', 'integration-api')
    const worker = connect('control_worker', 'integration-worker')
    try {
      const id = randomUUID()
      await api.query(
        "INSERT INTO control.live_requests(id,project_id,subject,kind,payload) VALUES($1,$2,'owner','sql','{}')",
        [id, project]
      )
      await api.query(
        "INSERT INTO control.access_tokens(id,subject,name,token_hash) VALUES($1,'owner','x',$2)",
        [randomUUID(), randomUUID()]
      )
      await api.query('SELECT * FROM control.deployments LIMIT 1')
      await worker.query("UPDATE control.live_requests SET state='succeeded' WHERE id=$1", [id])
      await worker.query(
        "INSERT INTO control.deployments(id,project_id,source,repository,branch) VALUES($1,$2,'manual','o/r','main')",
        [randomUUID(), project]
      )
      await worker.query('UPDATE control.github_links SET checked_at=now() WHERE project_id=$1', [
        project,
      ])
      await assert.rejects(api.query("UPDATE control.live_requests SET state='succeeded'"), {
        code: '42501',
      })
      await assert.rejects(
        api.query(
          "INSERT INTO control.deployments(id,project_id,source,repository,branch) VALUES($1,$2,'manual','o/r','main')",
          [randomUUID(), project]
        ),
        { code: '42501' }
      )
      await assert.rejects(worker.query('SELECT * FROM control.access_tokens'), { code: '42501' })
    } finally {
      await api.end()
      await worker.end()
    }
  }
)
