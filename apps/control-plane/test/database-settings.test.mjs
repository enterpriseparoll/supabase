import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDatabase } from '../src/project-db.mjs'
import {
  databasePassword,
  databaseSettingsPatch,
  managedPoolerScript,
  applyDatabaseSettings,
  ProjectDatabaseSettings,
} from '../src/database-settings.mjs'

test('database settings validate connection bounds, CIDRs, passwords, and unknown fields', () => {
  for (const patch of [
    { poolSize: 0 },
    { poolSize: '10' },
    { poolSize: 1001 },
    { maxClientConnections: 10001 },
    { allowedCidrs: ['127.0.0.1/33'] },
    { allowedCidrs: ['::/129'] },
    { allowedCidrs: ['127.0.0.1/8/extra'] },
    { allowedCidrs: ['#{evil}/24'] },
    { enforceSsl: 'false' },
    { sql: 'select 1' },
  ])
    assert.throws(() => databaseSettingsPatch(patch))
  assert.deepEqual(
    databaseSettingsPatch({ allowedCidrs: ['127.0.0.1/32', '::1/128'], poolSize: 10 }),
    { allowedCidrs: ['127.0.0.1/32', '::1/128'], poolSize: 10 }
  )
  assert.throws(() => databasePassword('short'))
  assert.throws(() => databasePassword('password-with-unsafe-@-character'))
  assert.equal(databasePassword('safe-database-password-2026'), 'safe-database-password-2026')
})
test('pooler renders preserve credentials from the environment and restore saved restrictions', () => {
  const source =
    'params = %{}\nif !Supavisor.Tenants.get_tenant_by_external_id(params["external_id"]) do\n  create()\nend\n'
  const text = managedPoolerScript(source, {
    poolSize: 10,
    maxClientConnections: 100,
    enforceSsl: true,
    allowedCidrs: [],
  })
  assert.match(text, /"default_pool_size" => 10/)
  assert.match(text, /"allow_list" => \["0.0.0.0\/32","::\/128"\]/)
  assert.match(text, /update_manager_user_credentials/)
  assert.match(text, /System.get_env\("POSTGRES_PASSWORD"\)/)
  const compose = { services: { supavisor: { environment: {}, volumes: [] } } }
  applyDatabaseSettings(compose, { tlsConfigured: true, poolSize: 10 })
  assert.equal(
    compose.services.supavisor.environment.GLOBAL_DOWNSTREAM_KEY_PATH,
    '/etc/pooler/tls/server.key'
  )
  assert.equal(compose.services.supavisor.volumes[0], './volumes/pooler-tls:/etc/pooler/tls:ro,z')
})
test('database settings fail closed on unavailable TLS and serialize updates with lifecycle operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'database-settings-'))
  let locked = true
  const infra = {
    directory: () => root,
    db: {
      connect: async () => ({
        query: async (text) => (text.includes('pg_try') ? { rows: [{ locked }] } : { rowCount: 0 }),
        release() {},
      }),
    },
  }
  const settings = new ProjectDatabaseSettings(infra, { local: true })
  settings.read = async () => ({ maxDatabaseConnections: 100 })
  try {
    await assert.rejects(settings.update({ id: 'project' }, { enforceSsl: true }), /certificate/)
    await assert.rejects(settings.update({ id: 'project' }, { poolSize: 95 }), /Leave at least 10/)
    locked = false
    await assert.rejects(
      settings.update({ id: 'project' }, { poolSize: 10 }),
      /Another project operation/
    )
    await assert.rejects(settings.clearBans({ id: 'project' }, ['not-an-ip']), /valid IP/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('database reads sanitize native tenant secrets and normalize real network bans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'database-read-'))
  const infra = {
    directory: () => root,
    projectDb: {
      withClient: async (_project, _options, action) =>
        action({
          query: async () => ({
            rows: [
              { name: 'max_connections', setting: '100' },
              { name: 'log_connections', setting: 'on' },
            ],
          }),
        }),
    },
  }
  const settings = new ProjectDatabaseSettings(infra, {
    local: true,
    origin: 'http://manage.localhost:8090',
  })
  settings.pooler = async (_project, suffix) =>
    suffix
      ? { banned_ipv4_addresses: [{ banned_address: '192.0.2.1', banned_until: 123 }] }
      : {
          data: {
            db_password: 'private-password',
            users: [{ db_password: 'private-password' }],
            default_pool_size: 20,
            default_max_clients: 100,
            allow_list: ['0.0.0.0/32', '::/128'],
          },
        }
  try {
    const data = await settings.read({ id: 'project', db_port: 55432 })
    assert.equal(data.poolSize, 20)
    assert.equal(data.logConnections, true)
    assert.deepEqual(data.allowedCidrs, [])
    assert.deepEqual(data.networkBans.items, [{ address: '192.0.2.1', expiresAt: 123 }])
    assert.equal(JSON.stringify(data).includes('private-password'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('concurrent settings reads join the project network once and tolerate an external join', async () => {
  let attempts = 0,
    joined = false
  const id = 'p0123456789abcdef01234567',
    network = `sp-${id}_private`
  const database = new ProjectDatabase(
    {},
    {},
    {
      command: async (_program, args) => {
        if (args[0] === 'inspect') return JSON.stringify(joined ? { [network]: {} } : {})
        attempts++
        joined = true
        throw new Error('another request joined this network')
      },
    }
  )
  await Promise.all([
    database.ensureNetwork({ id }),
    database.ensureNetwork({ id }),
    database.ensureNetwork({ id }),
  ])
  assert.equal(attempts, 1)
  await database.ensureNetwork({ id })
  assert.equal(attempts, 1)
})
