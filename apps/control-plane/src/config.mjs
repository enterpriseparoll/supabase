import { readFile } from 'node:fs/promises'
import { domainName, invariant } from './core.mjs'

export async function configuration(env = process.env) {
  const required = (name) => {
    invariant(env[name], 500, `Missing ${name}`)
    return env[name]
  }
  const secret = async (name) =>
    env[`${name}_FILE`] ? (await readFile(env[`${name}_FILE`], 'utf8')).trim() : required(name)
  const local = env.PLATFORM_MODE === 'local'
  invariant(
    local || env.PLATFORM_MODE === undefined || env.PLATFORM_MODE === 'server',
    500,
    'PLATFORM_MODE must be server or local'
  )
  const publicPort = Number(env.LOCAL_PORT ?? 8090)
  invariant(
    !local || (Number.isInteger(publicPort) && publicPort > 0 && publicPort < 65536),
    500,
    'Invalid LOCAL_PORT'
  )
  // Local mode is for a single developer machine: plain HTTP on *.localhost, a
  // generated sign-in token instead of OIDC, and no host firewall changes.
  const baseDomain = local ? 'localhost' : domainName(required('PLATFORM_DOMAIN'))
  const origin = local ? `http://manage.localhost:${publicPort}` : `https://manage.${baseDomain}`
  const key = await secret('MASTER_KEY')
  invariant(
    /^[a-f0-9]{64}$/.test(key),
    500,
    'MASTER_KEY must contain 64 lowercase hexadecimal characters'
  )
  const firewall = env.PLATFORM_FIREWALL ?? (local ? 'skip' : 'enforce')
  invariant(
    firewall === 'enforce' || (local && firewall === 'skip'),
    500,
    'PLATFORM_FIREWALL=skip is only allowed with PLATFORM_MODE=local'
  )
  const studioImage = env.PLATFORM_STUDIO_IMAGE || undefined
  invariant(
    studioImage === undefined || /^[a-z0-9][a-z0-9._/:@-]{0,254}$/.test(studioImage),
    500,
    'Invalid PLATFORM_STUDIO_IMAGE'
  )
  const apiUid = Number(env.API_UID ?? 1000)
  invariant(Number.isInteger(apiUid) && apiUid > 0, 500, 'Invalid API_UID')
  return {
    studioImage,
    databaseUrl: await secret('DATABASE_URL'),
    key,
    baseDomain,
    origin,
    local,
    publicPort: local ? publicPort : undefined,
    localAdminToken: local ? await secret('LOCAL_ADMIN_TOKEN') : undefined,
    firewall,
    issuer: local ? undefined : required('OIDC_ISSUER'),
    clientId: local ? undefined : required('OIDC_CLIENT_ID'),
    clientSecret: local ? undefined : await secret('OIDC_CLIENT_SECRET'),
    requiredAcr: local ? undefined : required('OIDC_REQUIRED_ACR'),
    dataRoot: env.PLATFORM_DATA_ROOT ?? '/srv/supabase-platform',
    routeRoot: env.PLATFORM_ROUTE_ROOT ?? '/srv/supabase-platform/routes',
    templateRoot: env.PLATFORM_TEMPLATE_ROOT ?? '/opt/platform/docker',
    release: env.PLATFORM_RELEASE ?? 'baseline-dfd1f588',
    port: Number(env.PORT ?? 3000),
    workerEnabled: env.ENABLE_DOCKER_WORKER === 'true',
    traefikContainer: env.TRAEFIK_CONTAINER ?? 'supabase-platform-traefik',
    executionImage: env.PLATFORM_IMAGE ?? 'supabase-platform:local',
    capacityMb: Number(env.HOST_CAPACITY_MB ?? 12288),
    capacityCpus: Number(env.HOST_CAPACITY_CPUS ?? 3),
    backupHours: Number(env.BACKUP_INTERVAL_HOURS ?? 24),
    insightsMinutes: Number(env.INSIGHTS_INTERVAL_MINUTES ?? 5),
    // The API image runs as the node user; backup downloads are owned by it.
    apiUid,
  }
}
