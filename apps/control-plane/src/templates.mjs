import { parse, stringify } from 'yaml'
import { invariant, projectId, publicUrl } from './core.mjs'

export const projectName = (id) => `sp-${projectId(id)}`
export function renderCompose(source, project, { local = false } = {}) {
  const compose = parse(source)
  const name = projectName(project.id)
  compose.name = name
  const services = Object.entries(compose.services)
  // Node/Erlang services need room for their runtimes even at the smallest
  // project size; single shares cause repeated out-of-memory exits.
  const weights = {
    db: 5,
    studio: 4,
    meta: 4,
    realtime: 4,
    functions: 2,
    supavisor: 4,
    storage: 2,
    rest: 2,
  }
  const total = services.reduce((sum, [key]) => sum + (weights[key] ?? 1), 0)
  for (const [key, service] of services) {
    delete service.container_name
    delete service.ports
    service.networks = { private: {} }
    if (key === 'api-gw') service.networks.ingress = { aliases: [`gateway-${project.id}`] }
    if (key === 'studio') service.networks.ingress = { aliases: [`studio-${project.id}`] }
    if (['auth', 'functions'].includes(key)) service.networks.egress = {}
    const weight = weights[key] ?? 1
    service.mem_limit = `${Math.floor((project.memory_mb * weight) / total)}m`
    service.memswap_limit = service.mem_limit
    service.cpus = Number(((Number(project.cpus) * weight) / total).toFixed(3))
    // Strict shares leave small services ~0.1 CPU, so first boots outlast their
    // health checks. A laptop can oversubscribe: give every service half a CPU.
    if (local) service.cpus = Math.max(service.cpus, 0.5)
    // Throttled first starts (migrations, JIT warm-up) must not count as failures,
    // or `compose up --wait` aborts while services are still booting.
    if (service.healthcheck && !service.healthcheck.disable)
      service.healthcheck.start_period = '120s'
    service.pids_limit = key === 'db' ? 1024 : 512
    service.security_opt = ['no-new-privileges:true']
    service.cap_drop = ['NET_RAW', 'NET_ADMIN']
    service.logging = { driver: 'local', options: { 'max-size': '10m', 'max-file': '3' } }
    service.labels = { 'platform.project': project.id, 'platform.release': project.release }
  }
  compose.networks = {
    private: { internal: true },
    ingress: { name: `${name}-ingress`, internal: true },
    egress: { name: `${name}-egress` },
  }
  // Studio deploys Edge Functions and manages their secrets by writing to the
  // functions folder, so its mount is writable (the template mounts it read-only).
  compose.services.studio.volumes = (compose.services.studio.volumes ?? []).map((volume) =>
    typeof volume === 'string' && volume.includes(':/app/edge-functions:')
      ? volume.replace(/:ro,/, ':').replace(/:ro$/, '')
      : volume
  )
  // Auth settings from Studio: Studio writes settings.json to a shared folder, and the
  // Auth server watches it (--config-dir) and reloads without a restart. Studio gets the
  // Auth server's own settings (minus database and signing secrets) to show what's in effect.
  compose.services.auth.command = ['auth', '--config-dir', '/etc/auth.d']
  compose.services.auth.volumes = [
    ...(compose.services.auth.volumes ?? []),
    './volumes/auth-config:/etc/auth.d:ro,z',
  ]
  compose.services.studio.volumes.push('./volumes/auth-config:/app/auth-config:z')
  const hiddenAuthSettings = new Set([
    'GOTRUE_DB_DATABASE_URL',
    'GOTRUE_JWT_SECRET',
    'GOTRUE_JWT_KEYS',
  ])
  for (const [key, value] of Object.entries(compose.services.auth.environment ?? {}))
    if (key.startsWith('GOTRUE_') && !hiddenAuthSettings.has(key))
      compose.services.studio.environment[key] = value
  // Studio shows the tenant user and, locally, the published pooler in Connect.
  Object.assign(compose.services.studio.environment, {
    AUTH_CONFIG_MANAGEMENT_FOLDER: '/app/auth-config',
    API_EXTERNAL_URL: '${API_EXTERNAL_URL}',
    POOLER_TENANT_ID: '${POOLER_TENANT_ID}',
    POOLER_PUBLIC_HOST: '${POOLER_PUBLIC_HOST}',
    POOLER_PUBLIC_PORT: '${POOLER_PUBLIC_PORT}',
  })
  if (local && project.db_port) {
    // Session and transaction pooling on this machine only. Publishing needs a
    // non-internal network; the database itself stays on the private network.
    compose.services.supavisor.ports = [
      `127.0.0.1:${project.db_port}:5432`,
      `127.0.0.1:${project.db_port + 1}:6543`,
    ]
    compose.services.supavisor.networks.egress = {}
  }
  compose.services.auth.environment.GOTRUE_JWT_KEYS = '${JWT_KEYS}'
  // Restore normal server diagnostics; the upstream template suppresses all but fatal messages.
  compose.services.db.command = compose.services.db.command.map((arg) =>
    arg === 'log_min_messages=fatal' ? 'log_min_messages=warning' : arg
  )
  compose.services.rest.environment.PGRST_JWT_SECRET = '${JWT_JWKS}'
  compose.services.realtime.environment.API_JWT_JWKS = '${JWT_JWKS}'
  compose.services.storage.environment.JWT_JWKS = '${JWT_JWKS}'
  compose.services.storage.environment.VECTOR_ENABLED = 'true'
  compose.services.storage.environment.VECTOR_BUCKET_PROVIDER = 'pgvector'
  compose.services.storage.environment.VECTOR_DATABASE_URL =
    'postgres://postgres:${POSTGRES_PASSWORD}@db:5432/postgres'
  compose.services.storage.environment.VECTOR_DATABASE_CREATE = 'false'
  compose.services.storage.environment.VECTOR_STORE_MIGRATIONS_ENABLED = 'true'
  compose.services.functions.environment.SUPABASE_JWKS = '${JWT_JWKS}'
  return stringify(compose)
}
export function publicGateway(source) {
  const doc = parse(source)
  const allowed = new Set(['auth', 'rest', 'realtime', 'storage', 'imgproxy', 'functions'])
  for (const resource of doc.resources)
    for (const chain of resource.filter_chains ?? [])
      for (const filter of chain.filters ?? []) {
        const config = filter.typed_config
        if (!config?.route_config) continue
        for (const host of config.route_config.virtual_hosts) {
          host.routes = host.routes.filter((route) => allowed.has(route.route?.cluster))
          // Plain 404 for anything else. Disable the dashboard Basic Auth filter here,
          // or browsers opening the API URL get a password prompt for nothing.
          host.routes.push({
            match: { prefix: '/' },
            direct_response: { status: 404 },
            typed_per_filter_config: {
              'envoy.filters.http.basic_auth': {
                '@type': 'type.googleapis.com/envoy.config.route.v3.FilterConfig',
                disabled: true,
              },
            },
          })
        }
        // Only method, path without query, status, and timing. Never headers or tokens.
        config.access_log = [
          {
            name: 'envoy.access_loggers.stdout',
            typed_config: {
              '@type':
                'type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog',
              log_format: {
                json_format: {
                  timestamp: '%START_TIME%',
                  method: '%REQ(:METHOD)%',
                  path: '%PATH(NQ:PATH)%',
                  status: '%RESPONSE_CODE%',
                  duration_ms: '%DURATION%',
                  message: '%REQ(:METHOD)% %PATH(NQ:PATH)% %RESPONSE_CODE%',
                },
              },
            },
          },
        ]
      }
  return stringify(doc, { lineWidth: 0 })
}
export function renderEnv(source, values) {
  const remaining = new Map(Object.entries(values))
  const lines = source.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/)
    if (!match || !remaining.has(match[1])) return line
    const value = String(remaining.get(match[1]))
    invariant(!/[\r\n\x00]/.test(value), 500, 'Invalid environment value')
    remaining.delete(match[1])
    // Single quotes prevent Compose interpolation of user-controlled dollar signs.
    return `${match[1]}='${value.replaceAll("'", "\\'")}'`
  })
  for (const [key, value] of remaining) {
    invariant(!/[\r\n\x00']/.test(String(value)), 500, 'Invalid environment value')
    lines.push(`${key}='${value}'`)
  }
  return lines.join('\n')
}
export function projectEnvironment(project, secrets, config) {
  const url = publicUrl(config, `${project.id}.api.${config.baseDomain}`)
  return {
    ...secrets,
    SUPABASE_PUBLIC_URL: url,
    API_EXTERNAL_URL: `${url}/auth/v1`,
    SITE_URL: project.site_url,
    STUDIO_DEFAULT_ORGANIZATION: 'Self-hosted platform',
    STUDIO_DEFAULT_PROJECT: project.name,
    POOLER_TENANT_ID: project.id,
    POOLER_PUBLIC_HOST: config.local && project.db_port ? 'localhost' : '',
    POOLER_PUBLIC_PORT: config.local && project.db_port ? String(project.db_port) : '',
    STORAGE_TENANT_ID: project.id,
    ENABLE_PHONE_SIGNUP: 'false',
    ENABLE_PHONE_AUTOCONFIRM: 'false',
    FUNCTIONS_VERIFY_JWT: 'true',
    ENABLE_EMAIL_AUTOCONFIRM: 'false',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    OPENAI_API_KEY: '',
    COMPOSE_FILE: 'docker-compose.yml',
  }
}
export function routeConfiguration(project, domains, config) {
  const id = projectId(project.id)
  const apiHosts = [`${id}.api.${config.baseDomain}`, ...domains]
  const apiRule = apiHosts.map((host) => `Host(\`${host}\`)`).join(' || ')
  // Local mode has a single plain-HTTP entrypoint and no certificate resolver.
  const entry = config.local
    ? { entryPoints: ['web'] }
    : { entryPoints: ['websecure'], tls: { certResolver: 'letsencrypt' } }
  const routers = {
    [`${id}-api`]: {
      rule: apiRule,
      ...entry,
      service: `${id}-api`,
      middlewares: ['api-limit@file'],
    },
    [`${id}-studio`]: {
      rule: `Host(\`${id}.studio.${config.baseDomain}\`)`,
      ...entry,
      service: `${id}-studio`,
      middlewares: ['studio-auth@file', 'studio-headers@file'],
    },
    // Platform endpoints served on the Studio origin (the project switcher's list).
    // The control API authenticates these with the Studio session cookie itself.
    [`${id}-platform`]: {
      rule: `Host(\`${id}.studio.${config.baseDomain}\`) && (PathPrefix(\`/_platform/api/\`) || Path(\`/api/platform/projects/default/config/storage\`) || Path(\`/api/platform/storage/default/credentials\`))`,
      priority: 1000,
      ...entry,
      service: 'management@file',
      middlewares: ['studio-headers@file'],
    },
  }
  return {
    http: {
      routers,
      services: {
        [`${id}-api`]: { loadBalancer: { servers: [{ url: `http://gateway-${id}:8000` }] } },
        [`${id}-studio`]: { loadBalancer: { servers: [{ url: `http://studio-${id}:3000` }] } },
      },
    },
  }
}

// Runs inside the project's Studio container after start-up, through the public
// gateway. The gateway accepts the anon key on Auth routes but only the
// service-role key on the REST root. Failures print the path and status.
export const readinessProbe = [
  'const service=process.env.SUPABASE_SERVICE_KEY;',
  "const targets=[['/auth/v1/health',{apikey:process.env.SUPABASE_ANON_KEY}],",
  "['/rest/v1/',{apikey:service,Authorization:'Bearer '+service}]];",
  'for(const [path,headers] of targets){',
  "const response=await fetch('http://api-gw:8000'+path,{headers,signal:AbortSignal.timeout(10000)});",
  "if(!response.ok){console.error('probe '+path+' returned '+response.status);process.exit(1)}}",
].join('')
