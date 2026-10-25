import { readFile } from 'node:fs/promises'
import { domainName, invariant } from './core.mjs'

export async function configuration(env = process.env) {
  const required = (name) => {
    invariant(env[name], 500, `Missing ${name}`)
    return env[name]
  }
  const secret = async (name) =>
    env[`${name}_FILE`] ? (await readFile(env[`${name}_FILE`], 'utf8')).trim() : required(name)
  const baseDomain = domainName(required('PLATFORM_DOMAIN'))
  const origin = `https://manage.${baseDomain}`
  const key = await secret('MASTER_KEY')
  invariant(
    /^[a-f0-9]{64}$/.test(key),
    500,
    'MASTER_KEY must contain 64 lowercase hexadecimal characters'
  )
  return {
    databaseUrl: await secret('DATABASE_URL'),
    key,
    baseDomain,
    origin,
    issuer: required('OIDC_ISSUER'),
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: await secret('OIDC_CLIENT_SECRET'),
    requiredAcr: required('OIDC_REQUIRED_ACR'),
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
  }
}
