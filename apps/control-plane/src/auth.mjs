import { createRemoteJWKSet, jwtVerify } from 'jose'
import { cookieName, hash, HttpError, invariant, seal, token, unseal } from './core.mjs'
import { audit, roleFor, sessionSubject, transaction } from './database.mjs'

export function cookieValue(header, name) {
  const entries = (header ?? '').split(';').map((part) => part.trim().split('='))
  const matches = entries.filter(([key]) => key === name)
  return matches.length === 1 ? matches[0][1] : undefined
}
export const sessionCookie = (name, value, age = 3600, secure = true) =>
  `${name}=${value}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${age}`
export function verifyOrigin(request, expected) {
  invariant(request.headers.origin === expected, 403, 'Request origin is not allowed')
}
export async function oidcClient(config, dependencies = {}) {
  const fetchIdentity = dependencies.fetch ?? fetch
  const issuer = new URL(config.issuer)
  invariant(
    issuer.protocol === 'https:' && !issuer.username && !issuer.password,
    500,
    'OIDC issuer must use HTTPS'
  )
  const response = await fetchIdentity(
    `${issuer.href.replace(/\/$/, '')}/.well-known/openid-configuration`,
    { signal: AbortSignal.timeout(10000), redirect: 'error' }
  )
  invariant(response.ok, 500, 'Cannot load identity provider configuration')
  const metadata = await response.json()
  invariant(metadata.issuer === config.issuer, 500, 'OIDC issuer does not match discovery')
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'])
    invariant(new URL(metadata[key]).protocol === 'https:', 500, 'OIDC endpoints must use HTTPS')
  const jwks = dependencies.jwks ?? createRemoteJWKSet(new URL(metadata.jwks_uri))
  return {
    async begin(db) {
      const state = token(),
        nonce = token(),
        verifier = token()
      await db.query(
        "INSERT INTO control.login_flows(state_hash,encrypted_flow,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
        [hash(state), seal({ nonce, verifier }, config.key, hash(state))]
      )
      const url = new URL(metadata.authorization_endpoint)
      for (const [key, value] of Object.entries({
        client_id: config.clientId,
        response_type: 'code',
        scope: 'openid profile',
        redirect_uri: `${config.origin}/auth/callback`,
        state,
        nonce,
        code_challenge: Buffer.from(hash(verifier), 'hex').toString('base64url'),
        code_challenge_method: 'S256',
        acr_values: config.requiredAcr,
      }))
        url.searchParams.set(key, value)
      return { url: url.href, state }
    },
    async finish(pool, code, state, flowCookie) {
      invariant(
        state &&
          flowCookie &&
          hash(state) === hash(flowCookie) &&
          typeof code === 'string' &&
          code.length <= 4096,
        400,
        'Login flow is invalid or expired'
      )
      const flow = (
        await pool.query(
          'DELETE FROM control.login_flows WHERE state_hash=$1 AND expires_at>now() RETURNING encrypted_flow',
          [hash(state)]
        )
      ).rows[0]
      invariant(flow, 400, 'Login flow is invalid or expired')
      const { nonce, verifier } = unseal(flow.encrypted_flow, config.key, hash(state))
      const response = await fetchIdentity(metadata.token_endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: `${config.origin}/auth/callback`,
          code_verifier: verifier,
        }),
      })
      invariant(response.ok, 401, 'Identity provider rejected the login')
      const tokens = await response.json()
      const { payload } = await jwtVerify(tokens.id_token, jwks, {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ['RS256', 'ES256', 'PS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'acr'],
        maxTokenAge: 600,
        clockTolerance: 5,
      }).catch(() => {
        throw new HttpError(401, 'Identity token is invalid or expired')
      })
      invariant(
        payload.nonce === nonce && payload.acr === config.requiredAcr,
        401,
        'Sign in with the required multi-factor authentication policy'
      )
      if (payload.azp !== undefined || (Array.isArray(payload.aud) && payload.aud.length > 1))
        invariant(payload.azp === config.clientId, 401, 'Invalid authorized party')
      const subject = payload.sub
      invariant(
        typeof subject === 'string' && subject.length > 0 && subject.length <= 255,
        401,
        'Invalid identity subject'
      )
      const raw = token()
      await transaction(pool, async (db) => {
        const hasAccess =
          (await roleFor(db, subject)) ||
          (
            await db.query('SELECT 1 FROM control.project_members WHERE subject=$1 LIMIT 1', [
              subject,
            ])
          ).rowCount
        invariant(hasAccess, 403, 'Ask a platform owner to grant access')
        await db.query(
          "INSERT INTO control.sessions(token_hash,subject,expires_at) VALUES($1,$2,now()+interval '1 hour')",
          [hash(raw), subject]
        )
        await audit(db, subject, 'session.created')
      })
      return raw
    },
  }
}
export async function authenticate(pool, request, config = {}) {
  const subject = await sessionSubject(
    pool,
    cookieValue(request.headers.cookie, cookieName(config, 'platform'))
  )
  invariant(subject, 401, 'Sign in to continue')
  return subject
}
