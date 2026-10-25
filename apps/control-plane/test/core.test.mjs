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
  assert.deepEqual(routes.at(-1), { match: { prefix: '/' }, direct_response: { status: 404 } })
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
