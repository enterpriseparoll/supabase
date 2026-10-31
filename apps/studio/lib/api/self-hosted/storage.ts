import { assertSelfHosted } from './util'

/** Standalone Studio fallback; the project platform supplies the writable endpoint. */
export function getStorageConfig(env: Record<string, string | undefined> = process.env) {
  assertSelfHosted()
  return {
    fileSizeLimit: Number(env.FILE_SIZE_LIMIT || 52428800),
    capabilities: { iceberg_catalog: false, list_v2: true, object_versioning: false },
    external: { upstreamTarget: 'main' },
    migrationVersion: null,
    features: {
      imageTransformation: { enabled: env.ENABLE_IMAGE_TRANSFORMATION === 'true' },
      s3Protocol: { enabled: env.S3_PROTOCOL_ENABLED !== 'false' },
      icebergCatalog: { enabled: false, maxCatalogs: 2, maxNamespaces: 25, maxTables: 10 },
      vectorBuckets: { enabled: env.VECTOR_ENABLED === 'true', maxBuckets: 10, maxIndexes: 20 },
      purgeCache: { enabled: false },
    },
    selfHosted: { canUpdate: false },
  }
}
