import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
export const token = () => randomBytes(32).toString('base64url')
export const hash = (value) => createHash('sha256').update(value).digest('hex')
export function invariant(condition, status, message) {
  if (!condition) throw new HttpError(status, message)
}
// Local mode serves plain HTTP on *.localhost with a port; server mode is HTTPS on 443.
export const publicUrl = (config, host) =>
  `${config.local ? 'http' : 'https'}://${host}${config.local ? `:${config.publicPort}` : ''}`
// __Host- cookies require Secure, which browsers do not offer on plain-HTTP origins.
export const cookieName = (config, name) => `${config.local ? '' : '__Host-'}${name}`
export function projectId(value) {
  invariant(typeof value === 'string' && /^p[a-f0-9]{24}$/.test(value), 400, 'Invalid project ID')
  return value
}
export function domainName(value) {
  invariant(
    typeof value === 'string' &&
      value.length <= 253 &&
      value === value.toLowerCase() &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value),
    400,
    'Invalid domain name'
  )
  return value
}
export function allocationInput({ memoryMb, cpus }) {
  invariant(
    Number.isInteger(memoryMb) && memoryMb >= 2048 && memoryMb <= 131072,
    400,
    'Memory must be 2048–131072 MiB'
  )
  invariant(Number.isFinite(cpus) && cpus >= 1 && cpus <= 32, 400, 'CPU allocation must be 1–32')
  return { memoryMb, cpus }
}
export function projectInput(input, { allowLocalhost = false } = {}) {
  invariant(
    input && typeof input === 'object' && !Array.isArray(input),
    400,
    'Expected a project object'
  )
  invariant(
    Object.keys(input).every((key) => ['name', 'siteUrl', 'memoryMb', 'cpus'].includes(key)),
    400,
    'Unknown project field'
  )
  invariant(
    typeof input.name === 'string' &&
      input.name.trim().length > 0 &&
      input.name.length <= 80 &&
      !/[\x00-\x1f]/.test(input.name),
    400,
    'Project name must contain 1–80 characters'
  )
  let site
  try {
    site = new URL(input.siteUrl)
  } catch {
    throw new HttpError(400, 'Enter an HTTPS application URL')
  }
  const localhost = site.hostname === 'localhost' || site.hostname.endsWith('.localhost')
  invariant(
    (site.protocol === 'https:' || (allowLocalhost && localhost && site.protocol === 'http:')) &&
      !site.username &&
      !site.password &&
      !site.hash,
    400,
    allowLocalhost
      ? 'Enter an HTTPS or http://localhost application URL'
      : 'Enter an HTTPS application URL'
  )
  const { memoryMb, cpus } = allocationInput({
    memoryMb: input.memoryMb ?? 4096,
    cpus: input.cpus ?? 2,
  })
  return { name: input.name.trim(), siteUrl: site.href, memoryMb, cpus }
}
const permissions = {
  owner: [
    'read',
    'create',
    'operate',
    'delete',
    'secrets',
    'studio',
    'members',
    'restore',
    'domains',
  ],
  operator: ['read', 'create', 'operate', 'secrets', 'studio', 'domains'],
  viewer: ['read'],
}
export function authorize(role, action) {
  invariant(
    Object.hasOwn(permissions, role ?? '') && permissions[role].includes(action),
    403,
    'You do not have permission for this action'
  )
}
export function seal(value, key, context) {
  invariant(
    Buffer.from(key, 'hex').length === 32 && /^[a-f0-9]{64}$/.test(key),
    500,
    'Invalid encryption key'
  )
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
  cipher.setAAD(Buffer.from(context))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
}
export function unseal(value, key, context) {
  const [version, iv, tag, ciphertext] = value.split('.')
  invariant(version === 'v1', 500, 'Unsupported encrypted secret version')
  const cipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    Buffer.from(iv, 'base64url')
  )
  cipher.setAAD(Buffer.from(context))
  cipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return JSON.parse(
    Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64url')), cipher.final()]).toString()
  )
}
export function legacyJwt(secret, role) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, iss: 'supabase', iat: now, exp: now + 315360000 })}`
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`
}
export function generateSecrets() {
  const hex = (n = 32) => randomBytes(n).toString('hex')
  const jwt = hex()
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const kid = randomUUID()
  const publicKey = {
    kty: 'EC',
    kid,
    use: 'sig',
    key_ops: ['verify'],
    alg: 'ES256',
    ext: true,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  }
  const oct = { kty: 'oct', k: Buffer.from(jwt).toString('base64url'), alg: 'HS256' }
  const asymmetric = (role) => {
    const now = Math.floor(Date.now() / 1000)
    const payload = [
      { alg: 'ES256', typ: 'JWT', kid },
      { role, iss: 'supabase', iat: now, exp: now + 157680000 },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
      .join('.')
    return `${payload}.${sign('SHA256', Buffer.from(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
  }
  const opaque = (prefix) => {
    const intermediate = `${prefix}${randomBytes(17).toString('base64url').slice(0, 22)}`
    return `${intermediate}_${createHash('sha256').update(`supabase-self-hosted|${intermediate}`).digest('base64url').slice(0, 8)}`
  }
  return {
    POSTGRES_PASSWORD: hex(),
    JWT_SECRET: jwt,
    ANON_KEY: legacyJwt(jwt, 'anon'),
    SERVICE_ROLE_KEY: legacyJwt(jwt, 'service_role'),
    DASHBOARD_USERNAME: 'platform',
    DASHBOARD_PASSWORD: hex(),
    SECRET_KEY_BASE: hex(48),
    REALTIME_DB_ENC_KEY: hex(8),
    VAULT_ENC_KEY: hex(16),
    PG_META_CRYPTO_KEY: hex(),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: hex(),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: hex(),
    S3_PROTOCOL_ACCESS_KEY_ID: hex(16),
    S3_PROTOCOL_ACCESS_KEY_SECRET: hex(),
    MINIO_ROOT_PASSWORD: hex(),
    JWT_KEYS: JSON.stringify([{ ...publicKey, key_ops: ['sign', 'verify'], d: jwk.d }, oct]),
    JWT_JWKS: JSON.stringify({ keys: [publicKey, oct] }),
    ANON_KEY_ASYMMETRIC: asymmetric('anon'),
    SERVICE_ROLE_KEY_ASYMMETRIC: asymmetric('service_role'),
    SUPABASE_PUBLISHABLE_KEY: opaque('sb_publishable_'),
    SUPABASE_SECRET_KEY: opaque('sb_secret_'),
  }
}
// Token bucket keyed by authenticated identity. State is per process: with more than
// one API replica, each replica enforces its own budget (see README).
export function rateLimiter({ capacity, perMinute, maxKeys = 10000, now = Date.now }) {
  const buckets = new Map()
  return {
    take(key) {
      const time = now()
      let bucket = buckets.get(key)
      if (bucket) {
        bucket.tokens = Math.min(capacity, bucket.tokens + ((time - bucket.at) * perMinute) / 60000)
        bucket.at = time
        buckets.delete(key)
      } else {
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value)
        bucket = { tokens: capacity, at: time }
      }
      buckets.set(key, bucket)
      if (bucket.tokens < 1) return false
      bucket.tokens -= 1
      return true
    },
  }
}
export function operationAction(kind) {
  if (kind === 'delete') return 'delete'
  if (kind === 'restore' || kind === 'recover') return 'restore'
  if (['upgrade', 'rollback'].includes(kind)) return 'restore'
  if (['verify-domain', 'remove-domain'].includes(kind)) return 'domains'
  // resize falls through to 'operate': operators manage service allocations.
  return 'operate'
}
