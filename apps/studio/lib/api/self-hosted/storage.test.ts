import { describe, expect, it, vi } from 'vitest'

import { getStorageConfig } from './storage'

vi.mock('./util', () => ({ assertSelfHosted: vi.fn() }))

describe('self-hosted Storage configuration fallback', () => {
  it('reports environment settings without exposing credentials or claiming writable configuration', () => {
    const result = getStorageConfig({
      FILE_SIZE_LIMIT: '104857600',
      ENABLE_IMAGE_TRANSFORMATION: 'true',
      S3_PROTOCOL_ENABLED: 'false',
      VECTOR_ENABLED: 'true',
      S3_PROTOCOL_ACCESS_KEY_SECRET: 'private-key',
      DATABASE_URL: 'private-database',
    })
    expect(result.fileSizeLimit).toBe(104857600)
    expect(result.features.imageTransformation.enabled).toBe(true)
    expect(result.features.s3Protocol.enabled).toBe(false)
    expect(result.features.vectorBuckets.enabled).toBe(true)
    expect(result.selfHosted.canUpdate).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private-')
  })
  it('does not advertise unconfigured Analytics or Vector services', () => {
    const result = getStorageConfig({})
    expect(result.features.icebergCatalog.enabled).toBe(false)
    expect(result.features.vectorBuckets.enabled).toBe(false)
    expect(result.fileSizeLimit).toBe(52428800)
  })
})
