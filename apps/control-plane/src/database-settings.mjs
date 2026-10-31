import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { invariant, seal, unseal } from './core.mjs'
import { command } from './process.mjs'

const DENY_ALL = ['0.0.0.0/32', '::/128']
const PASSWORD_ROLES = [
  'postgres',
  'supabase_admin',
  'authenticator',
  'pgbouncer',
  'supabase_auth_admin',
  'supabase_functions_admin',
  'supabase_storage_admin',
  'supabase_read_only_user',
]
export function databasePassword(value) {
  invariant(
    typeof value === 'string' && /^[A-Za-z0-9._~-]{20,128}$/.test(value),
    400,
    'Use 20–128 letters, numbers, periods, hyphens, underscores, or tildes for the database password'
  )
  return value
}
export function databaseSettingsPatch(input) {
  invariant(
    input && typeof input === 'object' && !Array.isArray(input),
    400,
    'Invalid database settings'
  )
  const result = {}
  for (const [key, value] of Object.entries(input)) {
    if (['poolSize', 'maxClientConnections'].includes(key)) {
      invariant(
        Number.isInteger(value) && value >= 1 && value <= (key === 'poolSize' ? 1000 : 10000),
        400,
        'Connection limits are outside the supported range'
      )
    } else if (
      ['logConnections', 'logDisconnections', 'enforceSsl', 'configureTls'].includes(key)
    ) {
      invariant(typeof value === 'boolean', 400, 'Invalid database setting value')
    } else if (key === 'allowedCidrs') {
      invariant(
        Array.isArray(value) && value.length <= 50,
        400,
        'Provide up to 50 network restrictions'
      )
      for (const cidr of value) {
        invariant(typeof cidr === 'string' && cidr.length <= 50, 400, 'Invalid network restriction')
        const [address, prefix, extra] = cidr.split('/')
        const version = isIP(address)
        invariant(
          version &&
            extra === undefined &&
            /^\d{1,3}$/.test(prefix ?? '') &&
            Number(prefix) <= (version === 4 ? 32 : 128),
          400,
          'Use IPv4 or IPv6 CIDR notation, such as 192.168.1.0/24'
        )
      }
    } else invariant(false, 400, 'Unknown database setting')
    result[key] = value
  }
  return result
}

export function applyDatabaseSettings(compose, settings) {
  if (settings.poolSize !== undefined)
    compose.services.supavisor.environment.POOLER_DEFAULT_POOL_SIZE = String(settings.poolSize)
  if (settings.maxClientConnections !== undefined)
    compose.services.supavisor.environment.POOLER_MAX_CLIENT_CONN = String(
      settings.maxClientConnections
    )
  if (settings.tlsConfigured) {
    compose.services.supavisor.volumes.push('./volumes/pooler-tls:/etc/pooler/tls:ro,z')
    Object.assign(compose.services.supavisor.environment, {
      GLOBAL_DOWNSTREAM_CERT_PATH: '/etc/pooler/tls/server.crt',
      GLOBAL_DOWNSTREAM_KEY_PATH: '/etc/pooler/tls/server.key',
    })
  }
}
export function managedPoolerScript(source, settings) {
  const values = {}
  if (settings.poolSize !== undefined) values.default_pool_size = settings.poolSize
  if (settings.maxClientConnections !== undefined)
    values.default_max_clients = settings.maxClientConnections
  if (settings.enforceSsl !== undefined) values.enforce_ssl = settings.enforceSsl
  if (settings.allowedCidrs !== undefined)
    values.allow_list = settings.allowedCidrs.length ? settings.allowedCidrs : DENY_ALL
  const fields = Object.entries(values)
    .map(([key, value]) => `${JSON.stringify(key)} => ${JSON.stringify(value)}`)
    .join(',\n')
  return source.replace(
    /if !Supavisor\.Tenants\.get_tenant_by_external_id[\s\S]*$/,
    `managed = %{${fields}}\ntenant = Supavisor.Tenants.get_tenant_by_external_id(params["external_id"])\nif tenant do\n  {:ok, _} = Supavisor.Tenants.update_tenant(tenant, managed)\n  :ok = Supavisor.Tenants.update_manager_user_credentials(tenant, %{"db_user" => "pgbouncer", "db_password" => System.get_env("POSTGRES_PASSWORD")})\nelse\n  {:ok, _} = Supavisor.Tenants.create_tenant(Map.merge(params, managed))\nend\n`
  )
}

export class ProjectDatabaseSettings {
  constructor(infrastructure, config) {
    this.infra = infrastructure
    this.config = config
  }
  async state(project) {
    try {
      return JSON.parse(
        await readFile(join(this.infra.directory(project.id), 'database-settings.json'), 'utf8')
      )
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw error
    }
  }
  async save(project, state) {
    const file = join(this.infra.directory(project.id), 'database-settings.json')
    await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  }
  async pooler(project, suffix = '', { method = 'GET', body } = {}) {
    await this.infra.projectDb.ensureNetwork(project)
    const secrets = unseal(project.encrypted_secrets, this.config.key, project.id)
    const response = await fetch(
      `http://${this.infra.projectDb.host(project, 'supavisor')}:4000/api/tenants/${project.id}${suffix}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${secrets.SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      }
    )
    if (response.status === 404 && suffix === '/network_bans') return { available: false, data: [] }
    invariant(response.ok, 502, `The pooler settings request failed (${response.status})`)
    return response.json()
  }
  async read(project) {
    const [tenantResult, bans, state, postgres] = await Promise.all([
      this.pooler(project),
      this.pooler(project, '/network_bans'),
      this.state(project),
      this.infra.projectDb.withClient(project, {}, (client) =>
        client.query(
          "SELECT name,setting FROM pg_settings WHERE name IN ('log_connections','log_disconnections','max_connections')"
        )
      ),
    ])
    const tenant = tenantResult.data ?? tenantResult
    const settings = Object.fromEntries(postgres.rows.map((row) => [row.name, row.setting]))
    const certificate = state.tlsConfigured
      ? await readFile(
          join(this.infra.directory(project.id), 'volumes/pooler-tls/server.crt'),
          'utf8'
        )
      : null
    return {
      projectId: project.id,
      poolSize: tenant.default_pool_size,
      maxClientConnections: tenant.default_max_clients,
      maxDatabaseConnections: Number(settings.max_connections),
      logConnections: settings.log_connections === 'on',
      logDisconnections: settings.log_disconnections === 'on',
      enforceSsl: tenant.enforce_ssl ?? false,
      tlsConfigured: !!certificate,
      certificate,
      allowedCidrs:
        JSON.stringify(tenant.allow_list) === JSON.stringify(DENY_ALL)
          ? []
          : (tenant.allow_list ?? ['0.0.0.0/0', '::/0']),
      networkBans: {
        available: bans.available !== false,
        items: (bans.banned_ipv4_addresses ?? bans.data ?? bans.bans ?? []).map((entry) => ({
          address: entry.banned_address ?? entry.ip ?? entry.ip_address,
          expiresAt: entry.banned_until ?? entry.unblock_at ?? entry.unblock_time,
        })),
      },
      managementUrl: `${this.config.origin}/#project/${project.id}`,
      disk: project.metrics?.disk ?? {},
      localOnly: this.config.local,
      databasePort: project.db_port,
    }
  }
  async update(project, input) {
    const patch = databaseSettingsPatch(input)
    const infra = this.infra
    const db = await infra.db.connect()
    let locked = false
    try {
      locked = (
        await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,8734144)) AS locked', [
          project.id,
        ])
      ).rows[0].locked
      invariant(locked, 409, 'Another project operation is running. Try again after it finishes.')
      invariant(
        !(
          await db.query(
            "SELECT 1 FROM control.operations WHERE project_id=$1 AND state IN ('queued','running')",
            [project.id]
          )
        ).rowCount,
        409,
        'Another project operation is queued'
      )
      const previous = await this.state(project)
      const current = await this.read(project)
      if (patch.poolSize !== undefined)
        invariant(
          patch.poolSize <= Math.max(1, current.maxDatabaseConnections - 10),
          400,
          'Leave at least 10 database connections available outside the pool'
        )
      const next = { ...previous, ...patch }
      delete next.configureTls
      if (patch.configureTls && !previous.tlsConfigured) {
        invariant(
          this.config.local,
          400,
          'Configure a host-issued TLS certificate for server deployments'
        )
        const folder = join(infra.directory(project.id), 'volumes/pooler-tls')
        await mkdir(folder, { recursive: true, mode: 0o700 })
        await command('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '365',
          '-keyout',
          join(folder, 'server.key'),
          '-out',
          join(folder, 'server.crt'),
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ])
        await chmod(join(folder, 'server.key'), 0o600)
        next.tlsConfigured = true
      }
      invariant(
        !next.enforceSsl || next.tlsConfigured,
        400,
        'Configure a TLS certificate before enforcing SSL'
      )
      const tenantPatch = {}
      if (patch.poolSize !== undefined) tenantPatch.default_pool_size = patch.poolSize
      if (patch.maxClientConnections !== undefined)
        tenantPatch.default_max_clients = patch.maxClientConnections
      if (patch.enforceSsl !== undefined) tenantPatch.enforce_ssl = patch.enforceSsl
      if (patch.allowedCidrs !== undefined)
        tenantPatch.allow_list = patch.allowedCidrs.length ? patch.allowedCidrs : DENY_ALL
      await this.save(project, next)
      try {
        await infra.invalidate(project)
        await infra.prepare(project)
        if (next.tlsConfigured && !previous.tlsConfigured)
          await infra.compose(
            project,
            ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '90', 'supavisor'],
            { timeout: 120000 }
          )
        if (Object.keys(tenantPatch).length)
          await this.pooler(project, '', { method: 'PUT', body: { tenant: tenantPatch } })
        await infra.projectDb.withClient(project, { admin: true }, async (client) => {
          if (patch.logConnections !== undefined)
            await client.query(
              patch.logConnections
                ? "ALTER SYSTEM SET log_connections = 'on'"
                : "ALTER SYSTEM SET log_connections = 'off'"
            )
          if (patch.logDisconnections !== undefined)
            await client.query(
              patch.logDisconnections
                ? "ALTER SYSTEM SET log_disconnections = 'on'"
                : "ALTER SYSTEM SET log_disconnections = 'off'"
            )
          await client.query('SELECT pg_reload_conf()')
        })
      } catch (error) {
        await this.save(project, previous)
        await this.pooler(project, '', {
          method: 'PUT',
          body: {
            tenant: {
              default_pool_size: current.poolSize,
              default_max_clients: current.maxClientConnections,
              enforce_ssl: current.enforceSsl,
              allow_list: current.allowedCidrs.length ? current.allowedCidrs : DENY_ALL,
            },
          },
        }).catch(() => {})
        await infra.invalidate(project)
        await infra.prepare(project)
        if (next.tlsConfigured && !previous.tlsConfigured)
          await infra.compose(project, ['up', '-d', '--no-deps', 'supavisor']).catch(() => {})
        await infra.projectDb
          .withClient(project, { admin: true }, async (client) => {
            await client.query(
              current.logConnections
                ? "ALTER SYSTEM SET log_connections = 'on'"
                : "ALTER SYSTEM SET log_connections = 'off'"
            )
            await client.query(
              current.logDisconnections
                ? "ALTER SYSTEM SET log_disconnections = 'on'"
                : "ALTER SYSTEM SET log_disconnections = 'off'"
            )
            await client.query('SELECT pg_reload_conf()')
          })
          .catch(() => {})
        throw error
      }
      return this.read(project)
    } finally {
      if (locked)
        await db.query('SELECT pg_advisory_unlock(hashtextextended($1,8734144))', [project.id])
      db.release()
    }
  }
  async clearBans(project, addresses) {
    invariant(
      Array.isArray(addresses) &&
        addresses.length > 0 &&
        addresses.length <= 100 &&
        addresses.every((address) => isIP(address)),
      400,
      'Select valid IP addresses to unblock'
    )
    await this.pooler(project, '/network_bans', {
      method: 'DELETE',
      body: { ipv4_addresses: addresses },
    })
    return this.read(project)
  }
  async rotatePassword(project, encryptedPassword) {
    const password = databasePassword(
      unseal(encryptedPassword, this.config.key, project.id).password
    )
    const secrets = unseal(project.encrypted_secrets, this.config.key, project.id)
    const updated = {
      ...project,
      encrypted_secrets: seal(
        { ...secrets, POSTGRES_PASSWORD: password },
        this.config.key,
        project.id
      ),
    }
    // A retried operation can connect with either password after an interrupted rotation.
    let client
    try {
      client = await this.infra.projectDb.connect(project, { admin: true })
    } catch {
      client = await this.infra.projectDb.connect(updated, { admin: true })
    }
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        "SELECT format('ALTER ROLE %I PASSWORD %L', rolname, $1::text) AS statement FROM pg_roles WHERE rolname = ANY($2::text[])",
        [password, PASSWORD_ROLES]
      )
      for (const row of rows) await client.query(row.statement)
      await client.query('COMMIT')
      await this.infra.db.query('UPDATE control.projects SET encrypted_secrets=$2 WHERE id=$1', [
        project.id,
        updated.encrypted_secrets,
      ])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error('DATABASE_PASSWORD_ROTATION_FAILED')
    } finally {
      await client.end()
    }
    await this.save(updated, await this.state(updated))
    await this.infra.invalidate(updated)
    await this.infra.up(updated)
  }
}
