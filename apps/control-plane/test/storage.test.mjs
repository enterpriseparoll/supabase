import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { applyStorageSettings, ProjectStorage, storagePatch } from '../src/storage.mjs'

test('storage settings reject unknown fields, unsafe limits, and feature injection', () => {
  for (const value of [
    null,
    [],
    { fileSizeLimit: 0 },
    { fileSizeLimit: '10' },
    { fileSizeLimit: 1.5 },
    { fileSizeLimit: Infinity },
    { fileSizeLimit: 501 * 1024 ** 3 },
    { DATABASE_URL: 'other-project' },
    { features: { vectorBuckets: { enabled: true } } },
    { features: { s3Protocol: { enabled: 'true' } } },
    { features: { s3Protocol: { enabled: true, secret: 'x' } } },
  ]) {
    assert.throws(() => storagePatch(value))
  }
  assert.deepEqual(
    storagePatch({ fileSizeLimit: 1024, features: { s3Protocol: { enabled: false } } }),
    { fileSizeLimit: 1024, features: { s3Protocol: { enabled: false } } }
  )
})

test('storage overrides preserve unrelated service credentials and native vector settings', () => {
  const compose = {
    services: {
      storage: {
        environment: {
          FILE_SIZE_LIMIT: 10,
          JWT_JWKS: 'private',
          VECTOR_ENABLED: 'true',
          S3_PROTOCOL_ENABLED: 'true',
        },
      },
    },
  }
  applyStorageSettings(compose, {
    fileSizeLimit: 20,
    features: { imageTransformation: { enabled: true }, s3Protocol: { enabled: false } },
  })
  assert.deepEqual(compose.services.storage.environment, {
    FILE_SIZE_LIMIT: 20,
    JWT_JWKS: 'private',
    VECTOR_ENABLED: 'true',
    S3_PROTOCOL_ENABLED: 'false',
    ENABLE_IMAGE_TRANSFORMATION: 'true',
  })
})

test('storage settings persist, reapply only Storage, and roll back a failed restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-test-'))
  const calls = []
  let fail = false
  const infra = {
    directory: () => root,
    db: {
      connect: async () => ({
        query: async (sql) =>
          sql.includes('pg_try') ? { rows: [{ locked: true }] } : { rows: [], rowCount: 0 },
        release() {},
      }),
    },
    projectDb: { sql: async () => ({ rows: [{ limit: '100' }] }) },
    invalidate: async () => {},
    prepare: async () => {
      const compose = {
        services: {
          storage: {
            environment: {
              FILE_SIZE_LIMIT: 100,
              SERVICE_KEY: 'never-return-this',
              VECTOR_ENABLED: 'true',
            },
          },
        },
      }
      applyStorageSettings(
        compose,
        JSON.parse(await readFile(join(root, 'storage-settings.json'), 'utf8'))
      )
      await writeFile(join(root, 'docker-compose.yml'), stringify(compose))
    },
    compose: async (_project, args) => {
      calls.push(args)
      if (fail && args.includes('--wait')) throw new Error('Storage did not become healthy')
    },
  }
  const storage = new ProjectStorage(infra)
  try {
    const saved = await storage.update(
      { id: 'project' },
      { fileSizeLimit: 200, features: { s3Protocol: { enabled: false } } }
    )
    assert.equal(saved.fileSizeLimit, 200)
    assert.equal(saved.features.s3Protocol.enabled, false)
    assert.equal(saved.features.vectorBuckets.enabled, true)
    assert.equal(JSON.stringify(saved).includes('never-return-this'), false)
    assert.deepEqual(calls[0].slice(-1), ['storage'])
    await assert.rejects(
      storage.update({ id: 'project' }, { fileSizeLimit: 50 }),
      /bucket has a larger/
    )
    fail = true
    await assert.rejects(
      storage.update({ id: 'project' }, { fileSizeLimit: 300 }),
      /did not become healthy/
    )
    assert.equal((await storage.read({ id: 'project' })).fileSizeLimit, 200)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
