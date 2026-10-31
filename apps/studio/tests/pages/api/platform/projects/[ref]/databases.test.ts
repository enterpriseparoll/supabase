import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import handler from '@/pages/api/platform/projects/[ref]/databases'

vi.mock('@/lib/constants', () => ({ IS_PLATFORM: false }))

describe('self-hosted database connection details', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses the published pooler host, port, and project tenant user', async () => {
    vi.stubEnv('POOLER_TENANT_ID', 'p0123456789abcdef01234567')
    vi.stubEnv('POOLER_PUBLIC_HOST', 'localhost')
    vi.stubEnv('POOLER_PUBLIC_PORT', '55432')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

    await handler(req, res)

    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([
      expect.objectContaining({
        identifier: 'default',
        db_host: 'localhost',
        db_port: 55432,
        db_user: 'postgres.p0123456789abcdef01234567',
        db_name: 'postgres',
      }),
    ])
  })
})
