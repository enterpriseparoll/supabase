import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importJWK, jwtVerify } from 'jose'
import { parse } from 'yaml'
import { readFile } from 'node:fs/promises'
import {
  authorize,
  cookieName,
  domainName,
  generateSecrets,
  projectId,
  projectInput,
  rateLimiter,
  seal,
  unseal,
} from '../src/core.mjs'
import { cookieValue, sessionCookie, verifyOrigin } from '../src/auth.mjs'
import { configuration } from '../src/config.mjs'
import {
  projectEnvironment,
  publicGateway,
  readinessProbe,
  renderCompose,
  renderEnv,
  routeConfiguration,
} from '../src/templates.mjs'

const root = new URL('../../../docker/', import.meta.url)
const id = 'p0123456789abcdef01234567'
const project = { id, memory_mb: 4096, cpus: 2, release: 'test' }
test('encrypted secrets authenticate both ciphertext and project ownership', () => {
  const key = 'ab'.repeat(32)
  const encrypted = seal({ password: 'do-not-disclose' }, key, id)
  assert(!encrypted.includes('do-not-disclose'))
  assert.deepEqual(unseal(encrypted, key, id), { password: 'do-not-disclose' })
  assert.throws(() => unseal(encrypted, key, 'another-project'))
  assert.throws(() => unseal(encrypted, 'cd'.repeat(32), id))
  const chunks = encrypted.split('.')
  chunks[3] = `${chunks[3][0] === 'A' ? 'B' : 'A'}${chunks[3].slice(1)}`
  assert.throws(() => unseal(chunks.join('.'), key, id))
})
test('generated project keys cannot authorize another project', async () => {
  const first = generateSecrets(),
    second = generateSecrets()
  assert.equal(first.REALTIME_DB_ENC_KEY.length, 16)
  assert.equal(first.VAULT_ENC_KEY.length, 32)
  const result = await jwtVerify(first.ANON_KEY, new TextEncoder().encode(first.JWT_SECRET), {
    algorithms: ['HS256'],
  })
  assert.equal(result.payload.role, 'anon')
  await assert.rejects(
    jwtVerify(first.SERVICE_ROLE_KEY, new TextEncoder().encode(second.JWT_SECRET), {
      algorithms: ['HS256'],
    })
  )
  const publicKey = JSON.parse(first.JWT_JWKS).keys.find((key) => key.kty === 'EC')
  assert.equal(publicKey.d, undefined)
  const ec = await importJWK(publicKey, 'ES256')
  assert.equal(
    (await jwtVerify(first.ANON_KEY_ASYMMETRIC, ec, { algorithms: ['ES256'] })).payload.role,
    'anon'
  )
  assert.match(first.SUPABASE_PUBLISHABLE_KEY, /^sb_publishable_/)
  assert.match(first.SUPABASE_SECRET_KEY, /^sb_secret_/)
})
test('RBAC denies unknown roles and prevents viewers operating or revealing secrets', () => {
  for (const role of [undefined, '', 'admin', '__proto__', 'toString'])
    assert.throws(() => authorize(role, 'read'))
  for (const action of ['operate', 'secrets', 'restore', 'studio', 'delete', 'members'])
    assert.throws(() => authorize('viewer', action))
  assert.throws(() => authorize('operator', 'restore'))
  authorize('owner', 'restore')
  authorize('operator', 'operate')
  authorize('viewer', 'read')
})
test('validation rejects path, route, shell, and resource injection', () => {
  for (const value of ['../../other', 'p123', `${id}/../other`, id.toUpperCase()])
    assert.throws(() => projectId(value))
  for (const value of [
    'x`)',
    'localhost',
    '*.example.com',
    'a.example.com/path',
    'a.example.com\n',
  ])
    assert.throws(() => domainName(value))
  for (const input of [
    null,
    {},
    { name: 'a', siteUrl: 'file:///etc/passwd' },
    { name: 'a', siteUrl: 'https://app.example.com', memoryMb: -1 },
    { name: 'a', siteUrl: 'https://app.example.com', mounts: ['/'] },
  ])
    assert.throws(() => projectInput(input))
  assert.equal(projectInput({ name: 'App', siteUrl: 'https://app.example.com' }).memoryMb, 4096)
})
test('duplicate session cookies and foreign origins fail closed', () => {
  assert.equal(cookieValue('__Host-platform=a; __Host-platform=b', '__Host-platform'), undefined)
  assert.equal(cookieValue('other=x; __Host-platform=abc', '__Host-platform'), 'abc')
  assert.throws(() =>
    verifyOrigin({ headers: { origin: 'https://attacker.example' } }, 'https://manage.example.com')
  )
  assert.throws(() => verifyOrigin({ headers: {} }, 'https://manage.example.com'))
})
test('every generated service has isolated names, limits, no host ports, and no socket', async () => {
  const compose = parse(
    renderCompose(await readFile(new URL('docker-compose.yml', root), 'utf8'), project)
  )
  assert.equal(compose.name, `sp-${id}`)
  assert.equal(compose.networks.private.internal, true)
  assert.equal(compose.networks.ingress.internal, true)
  let memory = 0,
    cpus = 0
  for (const service of Object.values(compose.services)) {
    assert.equal(service.container_name, undefined)
    assert.equal(service.ports, undefined)
    assert.equal(service.privileged, undefined)
    assert(service.mem_limit && service.cpus && service.pids_limit)
    assert(!JSON.stringify(service.volumes ?? []).includes('docker.sock'))
    memory += Number(service.mem_limit.replace('m', ''))
    cpus += service.cpus
  }
  assert(memory <= project.memory_mb)
  assert(cpus <= project.cpus + 0.01)
  assert.deepEqual(Object.keys(compose.services.db.networks), ['private'])
})
test('public gateway has no route to Studio, metadata, analytics, or catch-all administration', async () => {
  const source = await readFile(new URL('volumes/api/envoy/lds.template.yaml', root), 'utf8')
  const gateway = parse(publicGateway(source))
  const config = gateway.resources[0].filter_chains[0].filters[0].typed_config
  const routes = config.route_config.virtual_hosts[0].routes
  assert(routes.some((row) => row.route?.cluster === 'auth'))
  assert(routes.some((row) => row.route?.cluster === 'rest'))
  assert(routes.some((row) => row.route?.cluster === 'storage'))
  assert(routes.some((row) => row.route?.cluster === 'realtime'))
  assert(!routes.some((row) => ['studio', 'meta', 'analytics'].includes(row.route?.cluster)))
  const fallback = routes.at(-1)
  assert.deepEqual(fallback.match, { prefix: '/' })
  assert.deepEqual(fallback.direct_response, { status: 404 })
  // No dashboard password prompt on the public API URL.
  assert.equal(fallback.typed_per_filter_config['envoy.filters.http.basic_auth'].disabled, true)
  assert.deepEqual(config.access_log, [])
})
test('environment values do not become new variables or Compose expansions', () => {
  const env = renderEnv('NAME=default\nOTHER=keep', { NAME: 'hello ${PRIVATE_SECRET}' })
  assert(env.includes("NAME='hello ${PRIVATE_SECRET}'"))
  assert(env.includes('OTHER=keep'))
  assert.throws(() => renderEnv('NAME=x', { NAME: 'a\nPOSTGRES_PASSWORD=injected' }))
})
test('routing uses unique backend names and requires authentication on Studio', () => {
  const route = routeConfiguration(project, ['api.custom.example'], {
    baseDomain: 'platform.example.com',
  })
  const studio = route.http.routers[`${id}-studio`]
  assert(studio.middlewares.includes('studio-auth@file'))
  assert(!route.http.routers[`${id}-api`].middlewares.includes('studio-auth@file'))
  assert(route.http.services[`${id}-api`].loadBalancer.servers[0].url.includes(id))
})
test('rate limiter enforces per-identity budgets and refills over time', () => {
  let time = 0
  const limiter = rateLimiter({ capacity: 3, perMinute: 6, maxKeys: 2, now: () => time })
  for (let i = 0; i < 3; i++) assert.equal(limiter.take('alice'), true)
  assert.equal(limiter.take('alice'), false)
  assert.equal(limiter.take('bob'), true, 'one identity cannot exhaust another identity')
  time += 10000
  assert.equal(limiter.take('alice'), true, 'one token refills after 10 seconds at 6/minute')
  assert.equal(limiter.take('alice'), false)
  time += 3600000
  for (let i = 0; i < 3; i++) assert.equal(limiter.take('alice'), true, 'refill caps at capacity')
  assert.equal(limiter.take('alice'), false)
})
test('local mode requires no identity provider and refuses to skip the firewall on servers', async () => {
  const base = {
    MASTER_KEY: 'ab'.repeat(32),
    DATABASE_URL: 'postgresql://localhost/control_test',
  }
  const local = await configuration({ ...base, PLATFORM_MODE: 'local', LOCAL_ADMIN_TOKEN: 'tok' })
  assert.equal(local.origin, 'http://manage.localhost:8090')
  assert.equal(local.firewall, 'skip')
  assert.equal(local.issuer, undefined)
  await assert.rejects(configuration({ ...base, PLATFORM_MODE: 'local' }), /LOCAL_ADMIN_TOKEN/)
  await assert.rejects(configuration({ ...base, PLATFORM_DOMAIN: 'platform.example.com' }), /OIDC/)
  await assert.rejects(
    configuration({
      ...base,
      PLATFORM_DOMAIN: 'platform.example.com',
      OIDC_ISSUER: 'https://id.example.com',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      OIDC_REQUIRED_ACR: 'mfa',
      PLATFORM_FIREWALL: 'skip',
    }),
    /only allowed with PLATFORM_MODE=local/
  )
  await assert.rejects(configuration({ ...base, PLATFORM_MODE: 'dev' }), /PLATFORM_MODE/)
})
test('local mode serves projects over plain HTTP on localhost with non-Secure cookies', () => {
  const config = { local: true, publicPort: 8090, baseDomain: 'localhost' }
  const route = routeConfiguration(project, [], config)
  for (const router of Object.values(route.http.routers)) {
    assert.deepEqual(router.entryPoints, ['web'])
    assert.equal(router.tls, undefined)
  }
  assert.equal(route.http.routers[`${id}-api`].rule, `Host(\`${id}.api.localhost\`)`)
  const env = projectEnvironment(project, {}, config)
  assert.equal(env.SUPABASE_PUBLIC_URL, `http://${id}.api.localhost:8090`)
  assert.equal(env.API_EXTERNAL_URL, `http://${id}.api.localhost:8090/auth/v1`)
  assert.equal(cookieName(config, 'platform'), 'platform')
  assert.equal(cookieName({}, 'platform'), '__Host-platform')
  assert(!sessionCookie('platform', 'x', 60, false).includes('Secure'))
  assert(sessionCookie('__Host-platform', 'x').includes('Secure'))
  const server = routeConfiguration(project, [], { baseDomain: 'platform.example.com' })
  assert.equal(server.http.routers[`${id}-api`].tls.certResolver, 'letsencrypt')
  assert.equal(
    projectEnvironment(project, {}, { baseDomain: 'platform.example.com' }).SUPABASE_PUBLIC_URL,
    `https://${id}.api.platform.example.com`
  )
  const site = { name: 'App', siteUrl: 'http://localhost:3000' }
  assert.throws(() => projectInput(site))
  assert.equal(projectInput(site, { allowLocalhost: true }).siteUrl, 'http://localhost:3000/')
  assert.throws(() =>
    projectInput({ name: 'App', siteUrl: 'http://example.com' }, { allowLocalhost: true })
  )
})
test('local setup writes routes Traefik will load and keeps secrets on re-run', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtemp, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dataRoot = await mkdtemp(`${tmpdir()}/local-init-`)
  const run = () =>
    execFileSync(process.execPath, [new URL('../src/local-init.mjs', import.meta.url).pathname], {
      env: { ...process.env, PLATFORM_DATA_ROOT: dataRoot },
    }).toString()
  assert.match(run(), /Sign-in token: +\S{20,}/)
  const password = await readFile(`${dataRoot}/secrets/db_api_password`, 'utf8')
  run()
  assert.equal(await readFile(`${dataRoot}/secrets/db_api_password`, 'utf8'), password)
  const files = await readdir(`${dataRoot}/routes`)
  assert(files.length > 0)
  // Traefik's file provider silently skips any other extension.
  for (const file of files) assert.match(file, /\.(ya?ml|toml)$/)
  const routes = parse(await readFile(`${dataRoot}/routes/platform.yml`, 'utf8'))
  assert.equal(routes.http.routers.management.rule, 'Host(`manage.localhost`)')
  assert.deepEqual(routes.http.routers.management.entryPoints, ['web'])
})
test('Studio origin forwards only platform API paths to the control API', () => {
  for (const config of [
    { baseDomain: 'platform.example.com' },
    { local: true, publicPort: 8090, baseDomain: 'localhost' },
  ]) {
    const route = routeConfiguration(project, [], config)
    const platform = route.http.routers[`${id}-platform`]
    assert.equal(
      platform.rule,
      `Host(\`${id}.studio.${config.baseDomain}\`) && PathPrefix(\`/_platform/api/\`)`
    )
    assert.equal(platform.service, 'management@file')
    assert(platform.priority > 0)
    assert.deepEqual(platform.entryPoints, route.http.routers[`${id}-studio`].entryPoints)
  }
})
test('custom Studio image setting is validated', async () => {
  const base = {
    MASTER_KEY: 'ab'.repeat(32),
    DATABASE_URL: 'postgresql://localhost/control_test',
    PLATFORM_MODE: 'local',
    LOCAL_ADMIN_TOKEN: 'tok',
  }
  assert.equal((await configuration(base)).studioImage, undefined)
  const image = 'ghcr.io/enterpriseparoll/supabase-studio-platform:latest'
  assert.equal((await configuration({ ...base, PLATFORM_STUDIO_IMAGE: image })).studioImage, image)
  await assert.rejects(
    configuration({ ...base, PLATFORM_STUDIO_IMAGE: 'bad image; rm -rf /' }),
    /PLATFORM_STUDIO_IMAGE/
  )
})
test('health checks get a start-up grace and local mode keeps a CPU floor', async () => {
  const source = await readFile(new URL('docker-compose.yml', root), 'utf8')
  const server = parse(renderCompose(source, project))
  const local = parse(renderCompose(source, project, { local: true }))
  assert.equal(server.services.storage.healthcheck.start_period, '120s')
  assert(server.services.storage.cpus < 0.5, 'servers keep strict per-project CPU shares')
  for (const service of Object.values(local.services)) assert(service.cpus >= 0.5)
  assert.equal(local.services.db.cpus, server.services.db.cpus)
})
test('local mode publishes each project pooler on its own loopback ports', async () => {
  const source = await readFile(new URL('docker-compose.yml', root), 'utf8')
  const withPort = { ...project, db_port: 55432 }
  const local = parse(renderCompose(source, withPort, { local: true }))
  assert.deepEqual(local.services.supavisor.ports, ['127.0.0.1:55432:5432', '127.0.0.1:55433:6543'])
  assert('egress' in local.services.supavisor.networks)
  assert.deepEqual(Object.keys(local.services.db.networks), ['private'])
  for (const [name, service] of Object.entries(local.services))
    if (name !== 'supavisor') assert.equal(service.ports, undefined)
  assert.equal(local.services.studio.environment.POOLER_PUBLIC_PORT, '${POOLER_PUBLIC_PORT}')
  const server = parse(renderCompose(source, withPort))
  assert.equal(server.services.supavisor.ports, undefined, 'servers never publish databases')
  const localEnv = projectEnvironment(
    withPort,
    {},
    { local: true, publicPort: 8090, baseDomain: 'localhost' }
  )
  assert.equal(localEnv.POOLER_PUBLIC_HOST, 'localhost')
  assert.equal(localEnv.POOLER_PUBLIC_PORT, '55432')
  assert.equal(localEnv.POOLER_TENANT_ID, id)
  const serverEnv = projectEnvironment(withPort, {}, { baseDomain: 'platform.example.com' })
  assert.equal(serverEnv.POOLER_PUBLIC_PORT, '')
})
test('readiness probe uses the keys the public gateway requires', async () => {
  const source = await readFile(new URL('volumes/api/envoy/lds.template.yaml', root), 'utf8')
  const routes =
    parse(source).resources[0].filter_chains[0].filters[0].typed_config.route_config
      .virtual_hosts[0].routes
  const restRoot = routes.find((row) => row.match?.path === '/rest/v1/')
  const principals = JSON.stringify(
    restRoot.typed_per_filter_config['envoy.filters.http.rbac'].rbac.rules.policies
  )
  assert(!principals.includes('${ANON_KEY}'), 'REST root accepts only service-role keys')
  assert(principals.includes('${SERVICE_ROLE_KEY}'))
  assert.match(readinessProbe, /\/rest\/v1\/',\{apikey:service/)
  assert.match(readinessProbe, /\/auth\/v1\/health',\{apikey:process\.env\.SUPABASE_ANON_KEY/)
  assert.match(readinessProbe, /console\.error/)
  // The probe must be valid JavaScript.
  new Function(`return (async () => { ${readinessProbe.replaceAll('process.exit', 'void')} })`)
})
test('schema diff groups distant changes into separate hunks with context', async () => {
  const { diffLines } = await import('../src/insights.mjs')
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  const after = [...before]
  after[2] = 'changed near the top'
  after.splice(30, 0, 'inserted near the end')
  const diff = diffLines(before.join('\n'), after.join('\n'))
  assert.equal(diff.added, 2)
  assert.equal(diff.removed, 1)
  assert.equal(diff.hunks.length, 2)
  assert.deepEqual(
    diff.hunks[0].lines.filter((line) => line.type !== ' '),
    [
      { type: '-', text: 'line 2' },
      { type: '+', text: 'changed near the top' },
    ]
  )
  assert(diff.hunks[0].lines.length <= 2 + 3 * 2, 'at most three context lines each side')
  assert.equal(diff.hunks[1].fromLine, 28)
  assert.deepEqual(diffLines('same\ntext', 'same\ntext'), { added: 0, removed: 0, hunks: [] })
  assert.equal(diffLines('', 'a\nb').added, 2)
})
test('schema dumps normalize away per-run noise so identical schemas hash the same', async () => {
  const { normalizeSchemaDump, schemaHash } = await import('../src/insights.mjs')
  const dump = (key, version) =>
    `--\n-- PostgreSQL database dump\n--\n\n\\restrict ${key}\n\n-- Dumped from database version ${version}\n-- Dumped by pg_dump version ${version}\n\nCREATE TABLE public.a (id int);\n\n\n\n\\unrestrict ${key}\n`
  const first = normalizeSchemaDump(dump('abc', '17.6'))
  const second = normalizeSchemaDump(dump('xyz', '17.7').replaceAll('\n', '\r\n'))
  assert.equal(first, second)
  assert.equal(schemaHash(first), schemaHash(second))
  assert(!first.includes('restrict') && first.includes('CREATE TABLE public.a'))
})
test('restore swap only drops the safety copy while the live database still exists', async () => {
  const { restoreSwapPlan } = await import('../src/insights.mjs')
  assert.deepEqual(restoreSwapPlan(['postgres', 'postgres_restoring']), [
    'ALTER DATABASE postgres RENAME TO postgres_before_restore',
    'ALTER DATABASE postgres_restoring RENAME TO postgres',
  ])
  assert.deepEqual(
    restoreSwapPlan(['postgres', 'postgres_before_restore', 'postgres_restoring'])[0],
    'DROP DATABASE postgres_before_restore WITH (FORCE)'
  )
  // After a partial swap the original is already renamed: never drop it.
  assert.deepEqual(restoreSwapPlan(['postgres_before_restore', 'postgres_restoring']), [
    'ALTER DATABASE postgres_restoring RENAME TO postgres',
  ])
  assert.deepEqual(restoreSwapPlan(['postgres', 'postgres_before_restore']), [])
})
test('insight collection degrades gracefully when optional pieces are missing', async () => {
  const { collectInsights, SQL } = await import('../src/insights.mjs')
  const performance = {
    database_bytes: 1024,
    max_connections: 100,
    connections: { total: 3, active: 1 },
    counters: { xact_commit: 10, xact_rollback: 1, deadlocks: 0 },
    cache_hit_ratio: 0.99,
    tables: [],
  }
  const answers = new Map([
    [SQL.hasMigrationTable, 'false'],
    [SQL.performance, JSON.stringify(performance)],
    [SQL.statementsSchema, ''],
    [SQL.userSchemas, '[]'],
  ])
  let dumped = false
  const result = await collectInsights({
    query: async (sql) => {
      assert(answers.has(sql), `unexpected query: ${sql.slice(0, 40)}`)
      return `${answers.get(sql)}\n`
    },
    dumpSchema: async () => {
      dumped = true
      return ''
    },
  })
  assert.deepEqual(result.migrations, [])
  assert.equal(result.performance.top_queries, null)
  assert.equal(result.schema, '')
  assert.equal(dumped, false, 'no user schemas means no pg_dump')
  const { statsSample } = await import('../src/insights.mjs')
  assert.deepEqual(statsSample(performance), {
    database_bytes: 1024,
    connections: 3,
    active: 1,
    cache_hit_ratio: 0.99,
    xact_commit: 10,
    xact_rollback: 1,
    deadlocks: 0,
  })
})

test('backup downloads use the cloud file name and stay inside the project folder', async () => {
  const { backupDownloadName, backupDownloadPath, clusterDumpArgs } = await import(
    '../src/backup-files.mjs'
  )
  assert.equal(
    backupDownloadName('2026-10-24T20:31:36.000Z'),
    'db_cluster-24-10-2026@20-31-36.backup.gz'
  )
  const id = '5e1f88ec-fec1-407e-b5a3-bb9c2cdcd082'
  assert.equal(
    backupDownloadPath('/srv/data', 'p4eb6d2ee001a0adebc7ac563', id),
    `/srv/data/exports/p4eb6d2ee001a0adebc7ac563/${id}.backup.gz`
  )
  for (const bad of ['../secrets', `${id}/..`, '', null])
    assert.throws(() => backupDownloadPath('/srv/data', 'p4eb6d2ee001a0adebc7ac563', bad), {
      status: 400,
    })
  assert.throws(() => backupDownloadPath('/srv/data', '../x', id))
  const args = clusterDumpArgs()
  assert.equal(args[0], 'pg_dumpall')
  assert(args.includes('--no-role-passwords'))
  for (const name of ['_supabase', 'postgres_before_restore', 'postgres_restoring'])
    assert(args.includes(`--exclude-database=${name}`))
})
