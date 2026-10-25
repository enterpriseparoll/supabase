// Worker-only access to project databases, pg-meta, and Edge Function files. The
// worker joins each project's private network on demand and connects by container
// name; nothing here is reachable from the API.
import { createHmac, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import pg from 'pg'
import { HttpError, invariant, unseal } from './core.mjs'
import { command } from './process.mjs'
import { projectName } from './templates.mjs'

export const READ_ONLY_ROLE = 'platform_read_only'
export const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/
const RESERVED_FUNCTIONS = new Set(['main'])
const FUNCTION_FILE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/

// Same history tables the Supabase CLI creates, so `supabase migration list` and the
// platform agree on what has been applied.
export const HISTORY_SQL = `SET lock_timeout = '4s';
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;
CREATE TABLE IF NOT EXISTS supabase_migrations.seed_files (path text NOT NULL PRIMARY KEY, hash text NOT NULL);
RESET lock_timeout;`

// Versions are digit strings; compare numerically regardless of length.
export const compareVersions = (a, b) =>
  a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length

export const migrationVersion = (date = new Date()) =>
  date
    .toISOString()
    .replace(/[-:TZ]/g, '')
    .slice(0, 14)

export const migrationName = (value) => {
  invariant(typeof value === 'string', 400, 'Name the migration')
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
  invariant(name.length > 0, 400, 'Name the migration with letters or numbers')
  return name
}

// JSON-safe values: binary data as \x hex (like psql), everything else unchanged.
export function jsonValue(value) {
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = jsonValue(item)
    return out
  }
  return value
}

// Runs the statements of a migration and records it, all in one transaction.
export async function applyMigration(client, { version, name, sql }) {
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query(
      'INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3)',
      [version, name, [sql]]
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

// Decides which repository migrations to apply. Like `supabase db push`, a pending
// migration older than the newest applied one is refused rather than run out of order.
export function migrationPlan(local, remoteVersions) {
  const remote = new Set(remoteVersions)
  const latest = [...remote].sort(compareVersions).at(-1)
  const pending = local.filter((migration) => !remote.has(migration.version))
  const outOfOrder = latest
    ? pending.filter((migration) => compareVersions(migration.version, latest) < 0)
    : []
  const localVersions = new Set(local.map((migration) => migration.version))
  return {
    pending,
    outOfOrder,
    latest,
    remoteOnly: [...remote].filter((version) => !localVersions.has(version)).sort(compareVersions),
  }
}

export class ProjectDatabase {
  constructor(config, infrastructure, { Client = pg.Client } = {}) {
    this.config = config
    this.infrastructure = infrastructure
    this.Client = Client
    this.networks = new Set()
    this.readOnlyReady = new Set()
  }
  secrets(project) {
    return unseal(project.encrypted_secrets, this.config.key, project.id)
  }
  container(project, service) {
    return `${projectName(project.id)}-${service}-1`
  }
  readOnlyPassword(project) {
    return createHmac('sha256', this.config.key)
      .update(`read-only-role:${project.id}`)
      .digest('hex')
  }
  // Joins this worker to the project's private network once per process.
  async ensureNetwork(project) {
    if (this.config.projectDbHost) return
    const network = `${projectName(project.id)}_private`
    if (this.networks.has(network)) return
    const self = this.config.workerContainer ?? hostname()
    const joined = JSON.parse(
      await command('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', self])
    )
    if (!joined[network]) await command('docker', ['network', 'connect', network, self])
    this.networks.add(network)
  }
  host(project, service) {
    return this.config.projectDbHost ?? this.container(project, service)
  }
  async connect(project, { readOnly = false, admin = false } = {}) {
    await this.ensureNetwork(project)
    if (readOnly) await this.ensureReadOnlyRole(project)
    const secrets = this.secrets(project)
    const client = new this.Client({
      host: this.host(project, 'db'),
      port: this.config.projectDbPort ?? 5432,
      database: this.config.projectDbName ?? 'postgres',
      user: readOnly ? READ_ONLY_ROLE : admin ? 'supabase_admin' : 'postgres',
      password: readOnly ? this.readOnlyPassword(project) : secrets.POSTGRES_PASSWORD,
      connectionTimeoutMillis: 10000,
      statement_timeout: 60000,
      application_name: 'supabase-platform',
    })
    client.on('error', () => {})
    try {
      await client.connect()
    } catch (error) {
      // A recreated worker container loses its network memberships.
      this.networks.clear()
      throw error
    }
    return client
  }
  async ensureReadOnlyRole(project) {
    if (this.readOnlyReady.has(project.id)) return
    const client = await this.connect(project, { admin: true })
    try {
      // Can read every table (including past RLS) and nothing else; every
      // transaction starts read-only.
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READ_ONLY_ROLE}') THEN
          CREATE ROLE ${READ_ONLY_ROLE} LOGIN;
        END IF;
      END $$;
      ALTER ROLE ${READ_ONLY_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD '${this.readOnlyPassword(project)}';
      GRANT pg_read_all_data TO ${READ_ONLY_ROLE};
      ALTER ROLE ${READ_ONLY_ROLE} SET default_transaction_read_only = on;
      ALTER ROLE ${READ_ONLY_ROLE} SET statement_timeout = '60s';`)
      this.readOnlyReady.add(project.id)
    } finally {
      await client.end()
    }
  }
  async withClient(project, options, fn) {
    const client = await this.connect(project, options)
    try {
      return await fn(client)
    } finally {
      await client.end().catch(() => {})
    }
  }
  // Runs SQL and returns the rows of the last statement, like the SQL editor.
  async sql(project, { query }, { readOnly = false } = {}) {
    invariant(typeof query === 'string' && query.trim(), 400, 'Provide a SQL query')
    invariant(query.length <= 1_000_000, 413, 'The query is larger than 1 MB')
    return this.withClient(project, { readOnly }, async (client) => {
      const results = [].concat(await client.query(query))
      const last = results.findLast((result) => result.fields?.length) ?? results.at(-1)
      return {
        command: last?.command ?? null,
        rowCount: last?.rowCount ?? 0,
        rows: jsonValue(last?.rows ?? []),
      }
    })
  }
  async migrations(project) {
    return this.withClient(project, { readOnly: true }, async (client) => {
      const exists = (
        await client.query("SELECT to_regclass('supabase_migrations.schema_migrations') AS t")
      ).rows[0].t
      if (!exists) return []
      return (
        await client.query(
          'SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version'
        )
      ).rows
    })
  }
  async applyNamedMigration(project, { name, query }) {
    invariant(typeof query === 'string' && query.trim(), 400, 'Provide the migration SQL')
    invariant(query.length <= 1_000_000, 413, 'The migration is larger than 1 MB')
    const migration = { version: migrationVersion(), name: migrationName(name), sql: query }
    await this.withClient(project, {}, async (client) => {
      await client.query(HISTORY_SQL)
      await applyMigration(client, migration)
    })
    return { version: migration.version, name: migration.name }
  }
  // Applies a repository's pending migrations, then its seed file once (provisioning).
  async applyRepositoryMigrations(project, migrations, seed) {
    return this.withClient(project, {}, async (client) => {
      await client.query(HISTORY_SQL)
      const remote = (
        await client.query('SELECT version FROM supabase_migrations.schema_migrations')
      ).rows.map((row) => row.version)
      const plan = migrationPlan(migrations, remote)
      if (plan.outOfOrder.length)
        throw new DeploymentError(
          `${plan.outOfOrder.map((m) => m.file).join(', ')} ${plan.outOfOrder.length === 1 ? 'is' : 'are'} older than the last applied migration (${plan.latest}). Give ${plan.outOfOrder.length === 1 ? 'it' : 'them'} a newer timestamp, or apply ${plan.outOfOrder.length === 1 ? 'it' : 'them'} manually and record the version.`
        )
      const applied = []
      for (const migration of plan.pending) {
        try {
          await applyMigration(client, migration)
        } catch (error) {
          throw new DeploymentError(`${migration.file}: ${error.message}`, { applied })
        }
        applied.push(migration.file)
      }
      const warnings = plan.remoteOnly.length
        ? [
            `${plan.remoteOnly.length} applied migration${plan.remoteOnly.length === 1 ? ' is' : 's are'} not in the repository (${plan.remoteOnly.slice(0, 5).join(', ')}${plan.remoteOnly.length > 5 ? ', …' : ''}). Run supabase db pull to add ${plan.remoteOnly.length === 1 ? 'it' : 'them'}.`,
          ]
        : []
      let seeded = false
      if (seed) {
        const done = (
          await client.query('SELECT 1 FROM supabase_migrations.seed_files WHERE path=$1', [
            seed.path,
          ])
        ).rowCount
        if (!done) {
          await client.query('BEGIN')
          try {
            await client.query(seed.sql)
            await client.query(
              'INSERT INTO supabase_migrations.seed_files(path,hash) VALUES($1,$2)',
              [seed.path, seed.hash]
            )
            await client.query('COMMIT')
            seeded = true
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {})
            throw new DeploymentError(`${seed.path}: ${error.message}`, { applied })
          }
        }
      }
      return { applied, warnings, seeded }
    })
  }
  // TypeScript types from the project's own pg-meta service.
  async types(project, { schemas = ['public'] } = {}) {
    invariant(
      Array.isArray(schemas) &&
        schemas.length >= 1 &&
        schemas.length <= 20 &&
        schemas.every(
          (name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(name)
        ),
      400,
      'Schemas must be 1–20 schema names'
    )
    await this.ensureNetwork(project)
    const base = this.config.projectMetaUrl ?? `http://${this.container(project, 'meta')}:8080`
    const url = new URL(`${base}/generators/typescript`)
    url.searchParams.set('included_schemas', schemas.join(','))
    url.searchParams.set('detect_one_to_one_relationships', 'true')
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
    invariant(response.ok, 502, 'Type generation failed in the project')
    return { types: await response.text() }
  }
  functionsRoot(project) {
    return resolve(this.infrastructure.directory(project.id), 'volumes', 'functions')
  }
  async functions(project, { name } = {}) {
    const root = this.functionsRoot(project)
    if (name !== undefined) {
      invariant(typeof name === 'string' && FUNCTION_NAME.test(name), 400, 'Invalid function name')
      const directory = join(root, name)
      invariant(
        await stat(directory)
          .then((s) => s.isDirectory())
          .catch(() => false),
        404,
        'Function not found'
      )
      const files = []
      for (const path of await listFiles(directory)) {
        const content = await readFile(join(directory, path))
        files.push({ name: path, content: content.toString('utf8') })
      }
      return { name, files }
    }
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const result = []
    for (const entry of entries) {
      if (!entry.isDirectory() || RESERVED_FUNCTIONS.has(entry.name) || entry.name.startsWith('.'))
        continue
      const info = await stat(join(root, entry.name))
      result.push({
        name: entry.name,
        shared: entry.name.startsWith('_'),
        updatedAt: info.mtime.toISOString(),
      })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }
  // Replaces whole function folders atomically, then restarts the runtime so new
  // code is served immediately.
  async writeFunctions(project, folders, { restart = true, extraImportMaps = [] } = {}) {
    const root = this.functionsRoot(project)
    await mkdir(root, { recursive: true })
    const written = []
    for (const [name, files] of folders) {
      invariant(FUNCTION_NAME.test(name), 400, `Invalid function name: ${name}`)
      invariant(!RESERVED_FUNCTIONS.has(name), 400, `"${name}" is reserved by the platform`)
      const staging = join(root, `.deploy-${name}-${randomBytes(4).toString('hex')}`)
      try {
        for (const file of files) {
          invariant(
            FUNCTION_FILE.test(file.name) &&
              !file.name.split('/').some((part) => /^\.\.?$/.test(part)),
            400,
            `Invalid file path: ${file.name}`
          )
          const target = resolve(staging, file.name)
          invariant(target.startsWith(`${staging}${sep}`), 400, `Invalid file path: ${file.name}`)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, file.content, { mode: 0o644 })
        }
        const destination = join(root, name)
        const previous = join(root, `.previous-${name}-${randomBytes(4).toString('hex')}`)
        const exists = await lstat(destination).then(
          () => true,
          () => false
        )
        if (exists) await rename(destination, previous)
        await rename(staging, destination)
        if (exists) await rm(previous, { recursive: true, force: true })
        written.push(name)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
    // The runtime reads one import map (functions/deno.jsonc) for every function, so
    // each function's own deno.json / import_map.json imports are merged into it.
    const maps = [...extraImportMaps]
    for (const [name, files] of folders)
      for (const file of files)
        if (IMPORT_MAP_FILES.has(file.name))
          maps.push({ source: `${name}/${file.name}`, text: file.content })
    let warnings = []
    if (maps.length) {
      const rootFile = join(root, 'deno.jsonc')
      const current = await readFile(rootFile, 'utf8').catch(() => '{}')
      const merged = mergeImportMaps(current, maps)
      warnings = merged.warnings
      if (merged.text !== current) await writeFile(rootFile, merged.text, { mode: 0o644 })
    }
    if (restart && written.length)
      await this.infrastructure.compose(project, ['restart', 'functions'], { timeout: 120000 })
    return { written, warnings }
  }
  async deployFunction(project, { name, files, entrypoint = 'index.ts' }) {
    invariant(
      typeof name === 'string' && FUNCTION_NAME.test(name),
      400,
      'Function names use letters, numbers, - and _ (up to 64)'
    )
    invariant(
      Array.isArray(files) && files.length >= 1 && files.length <= 50,
      400,
      'Provide 1–50 files'
    )
    let total = 0
    const normalized = files.map((file) => {
      invariant(
        file && typeof file.name === 'string' && typeof file.content === 'string',
        400,
        'Each file needs a name and content'
      )
      total += Buffer.byteLength(file.content)
      return { name: file.name.replace(/^\.\//, ''), content: file.content }
    })
    invariant(total <= 1_000_000, 413, 'Function files are larger than 1 MB in total')
    invariant(
      normalized.some((file) => file.name === entrypoint),
      400,
      `Include the entrypoint ${entrypoint}`
    )
    // The runtime starts index.ts; point it at another entrypoint when asked.
    if (entrypoint !== 'index.ts') {
      invariant(
        !normalized.some((file) => file.name === 'index.ts'),
        400,
        'index.ts already exists; use it as the entrypoint'
      )
      normalized.push({ name: 'index.ts', content: `import './${entrypoint}'\n` })
    }
    const { warnings } = await this.writeFunctions(project, [[name, normalized]])
    return { name, files: normalized.map((file) => file.name), warnings }
  }
}

const IMPORT_MAP_FILES = new Set(['deno.json', 'deno.jsonc', 'import_map.json'])

// Removes // and /* */ comments and trailing commas outside strings (JSONC → JSON).
export function parseJsonc(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) break
      i++
    } else out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

// Adds every source's "imports" to the shared import map. Existing entries keep their
// value when a source disagrees, and the conflict is reported.
export function mergeImportMaps(rootText, sources) {
  const warnings = []
  let root
  try {
    root = parseJsonc(rootText)
  } catch {
    root = {}
    warnings.push('functions/deno.jsonc was not valid JSON and was replaced')
  }
  const imports = { ...(root.imports ?? {}) }
  for (const { source, text } of sources) {
    let parsed
    try {
      parsed = parseJsonc(text)
    } catch {
      warnings.push(`${source} is not valid JSON; its imports were skipped`)
      continue
    }
    for (const [specifier, target] of Object.entries(parsed.imports ?? {})) {
      if (typeof target !== 'string') continue
      if (imports[specifier] !== undefined && imports[specifier] !== target)
        warnings.push(
          `${source} maps "${specifier}" to ${target}, but ${imports[specifier]} is already used by another function`
        )
      else imports[specifier] = target
    }
  }
  return { text: `${JSON.stringify({ ...root, imports }, null, 2)}\n`, warnings }
}

export class DeploymentError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.status = 422
    Object.assign(this, details)
  }
}

async function listFiles(directory, prefix = '') {
  const out = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await listFiles(directory, path)))
    else if (entry.isFile()) out.push(path)
    if (out.length > 200) throw new HttpError(413, 'The function has too many files')
  }
  return out
}
