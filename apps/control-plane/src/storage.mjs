import { readFile, writeFile, rename } from 'node:fs/promises'
import { parse } from 'yaml'
import { invariant } from './core.mjs'

export function storagePatch(input) {
  invariant(
    input && typeof input === 'object' && !Array.isArray(input),
    400,
    'Invalid storage settings'
  )
  invariant(
    Object.keys(input).every((key) => ['fileSizeLimit', 'features'].includes(key)),
    400,
    'Unknown storage setting'
  )
  const patch = {}
  if (input.fileSizeLimit !== undefined) {
    invariant(
      Number.isSafeInteger(input.fileSizeLimit) &&
        input.fileSizeLimit >= 1 &&
        input.fileSizeLimit <= 500 * 1024 ** 3,
      400,
      'File size limit must be between 1 byte and 500 GiB'
    )
    patch.fileSizeLimit = input.fileSizeLimit
  }
  if (input.features !== undefined) {
    invariant(
      input.features && typeof input.features === 'object' && !Array.isArray(input.features),
      400,
      'Invalid storage features'
    )
    patch.features = {}
    for (const [key, value] of Object.entries(input.features)) {
      invariant(
        ['imageTransformation', 's3Protocol'].includes(key),
        400,
        'This storage feature cannot be changed here'
      )
      invariant(
        value && Object.keys(value).length === 1 && typeof value.enabled === 'boolean',
        400,
        'Invalid storage feature value'
      )
      patch.features[key] = { enabled: value.enabled }
    }
  }
  return patch
}

export function applyStorageSettings(compose, settings = {}) {
  const env = compose.services.storage.environment
  if (settings.fileSizeLimit !== undefined) env.FILE_SIZE_LIMIT = settings.fileSizeLimit
  if (settings.features?.imageTransformation)
    env.ENABLE_IMAGE_TRANSFORMATION = String(settings.features.imageTransformation.enabled)
  if (settings.features?.s3Protocol)
    env.S3_PROTOCOL_ENABLED = String(settings.features.s3Protocol.enabled)
}

export class ProjectStorage {
  constructor(infrastructure) {
    this.infrastructure = infrastructure
  }

  async read(project) {
    const compose = parse(
      await readFile(`${this.infrastructure.directory(project.id)}/docker-compose.yml`, 'utf8')
    )
    const env = compose.services.storage.environment
    return {
      fileSizeLimit: Number(env.FILE_SIZE_LIMIT ?? 52428800),
      features: {
        imageTransformation: { enabled: String(env.ENABLE_IMAGE_TRANSFORMATION) === 'true' },
        s3Protocol: { enabled: String(env.S3_PROTOCOL_ENABLED) !== 'false' },
        icebergCatalog: {
          enabled: String(env.ICEBERG_ENABLED) === 'true',
          maxCatalogs: 2,
          maxNamespaces: 25,
          maxTables: 10,
        },
        vectorBuckets: {
          enabled: String(env.VECTOR_ENABLED) === 'true',
          maxBuckets: 10,
          maxIndexes: 20,
        },
        purgeCache: { enabled: false },
      },
      capabilities: {
        iceberg_catalog: String(env.ICEBERG_ENABLED) === 'true',
        list_v2: true,
        object_versioning: false,
      },
      external: { upstreamTarget: 'main' },
      migrationVersion: null,
      selfHosted: { canUpdate: true },
    }
  }

  async update(project, input) {
    const patch = storagePatch(input)
    const infra = this.infrastructure
    const db = await infra.db.connect()
    let locked = false
    try {
      locked = (
        await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,8734144)) AS locked', [
          project.id,
        ])
      ).rows[0].locked
      invariant(locked, 409, 'Another project operation is running. Try again after it finishes.')
      const pending = await db.query(
        "SELECT 1 FROM control.operations WHERE project_id=$1 AND state IN ('queued','running')",
        [project.id]
      )
      invariant(
        !pending.rowCount,
        409,
        'Another project operation is queued. Try again after it finishes.'
      )
      if (patch.fileSizeLimit !== undefined) {
        const result = await infra.projectDb.sql(
          project,
          { query: 'SELECT max(file_size_limit)::text AS limit FROM storage.buckets' },
          { readOnly: true }
        )
        invariant(
          Number(result.rows[0]?.limit ?? 0) <= patch.fileSizeLimit,
          400,
          'A bucket has a larger file size limit. Lower its limit before changing the global limit.'
        )
      }
      const file = `${infra.directory(project.id)}/storage-settings.json`
      let previous = {}
      try {
        previous = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const next = { ...previous, ...patch, features: { ...previous.features, ...patch.features } }
      await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
      await rename(`${file}.tmp`, file)
      try {
        await infra.invalidate(project)
        await infra.prepare(project)
        await infra.compose(
          project,
          ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '90', 'storage'],
          { timeout: 120000 }
        )
      } catch (error) {
        await writeFile(file, JSON.stringify(previous), { mode: 0o600 })
        await infra.invalidate(project)
        await infra.prepare(project)
        await infra.compose(project, ['up', '-d', '--no-deps', 'storage']).catch(() => {})
        throw error
      }
      return this.read(project)
    } finally {
      if (locked)
        await db.query('SELECT pg_advisory_unlock(hashtextextended($1,8734144))', [project.id])
      db.release()
    }
  }
}
