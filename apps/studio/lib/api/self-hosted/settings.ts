import { components } from 'api-types'

import { AUTH_JWT_SECRET, POSTGRES_PORT } from './constants'
import { assertSelfHosted } from './util'
import { PROJECT_DB_HOST, PROJECT_ENDPOINT, PROJECT_ENDPOINT_PROTOCOL } from '@/lib/constants/api'

type ProjectAppConfig = components['schemas']['ProjectSettingsResponse_Output']['app_config'] & {
  protocol?: string
}

export type ProjectSettings = components['schemas']['ProjectSettingsResponse_Output'] & {
  app_config?: ProjectAppConfig
}

/**
 * Gets self-hosted project settings
 *
 * _Only call this from server-side self-hosted code._
 */
export function getProjectSettings() {
  assertSelfHosted()

  // Optional: set by hosts that publish this project's Supavisor pooler, such as the
  // self-hosted project platform. They only change the connection details shown in
  // Connect; Studio's own database connection is unaffected.
  const poolerTenantId = process.env.POOLER_TENANT_ID
  const poolerPublicPort = Number.parseInt(process.env.POOLER_PUBLIC_PORT ?? '', 10)

  const response = {
    app_config: {
      db_schema: 'public',
      endpoint: PROJECT_ENDPOINT,
      storage_endpoint: PROJECT_ENDPOINT,
      // manually added to force the frontend to use the correct URL
      protocol: PROJECT_ENDPOINT_PROTOCOL,
    },
    cloud_provider: 'AWS',
    db_dns_name: '-',
    db_host: process.env.POOLER_PUBLIC_HOST || PROJECT_DB_HOST,
    db_ip_addr_config: 'legacy' as const,
    db_name: 'postgres',
    db_port: Number.isInteger(poolerPublicPort) ? poolerPublicPort : POSTGRES_PORT,
    db_user: poolerTenantId ? `postgres.${poolerTenantId}` : 'postgres',
    inserted_at: '2021-08-02T06:40:40.646Z',
    jwt_secret: AUTH_JWT_SECRET,
    name: process.env.DEFAULT_PROJECT_NAME || 'Default Project',
    ref: 'default',
    region: 'local',
    service_api_keys: [
      {
        api_key: process.env.SUPABASE_ANON_KEY ?? '',
        name: 'anon key',
        tags: 'anon',
      },
      {
        api_key: process.env.SUPABASE_SERVICE_KEY ?? '',
        name: 'service_role key',
        tags: 'service_role',
      },
    ],
    ssl_enforced: false,
    status: 'ACTIVE_HEALTHY',
  } satisfies ProjectSettings

  return response
}
