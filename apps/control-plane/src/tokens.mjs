// Personal access tokens for the Supabase CLI workflow, MCP clients, and scripts.
// A token acts as the person who created it, with their current role, so removing
// someone's access also disables their tokens. Only a hash is stored.
import { randomBytes, randomUUID } from 'node:crypto'
import { audit, transaction } from './database.mjs'
import { hash, invariant } from './core.mjs'

// Same shape as Supabase personal access tokens, so tools that check the format accept it.
export const ACCESS_TOKEN_PATTERN = /^sbp_[a-f0-9]{40}$/
export const newAccessToken = () => `sbp_${randomBytes(20).toString('hex')}`
const MAX_ACTIVE_TOKENS = 50

const publicToken = (row) => ({
  id: row.id,
  name: row.name,
  readOnly: row.read_only,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
})

export async function createAccessToken(pool, subject, input = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  invariant(name.length >= 1 && name.length <= 100, 400, 'Name the token (1–100 characters)')
  invariant(
    input.readOnly === undefined || typeof input.readOnly === 'boolean',
    400,
    'readOnly must be true or false'
  )
  const days = input.expiresInDays ?? null
  invariant(
    days === null || (Number.isInteger(days) && days >= 1 && days <= 365),
    400,
    'Expiry must be 1–365 days, or none'
  )
  const raw = newAccessToken()
  return transaction(pool, async (db) => {
    const active = (
      await db.query(
        'SELECT count(*)::int AS count FROM control.access_tokens WHERE subject=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())',
        [subject]
      )
    ).rows[0].count
    invariant(active < MAX_ACTIVE_TOKENS, 409, 'Revoke unused tokens before creating more')
    const row = (
      await db.query(
        `INSERT INTO control.access_tokens(id,subject,name,token_hash,read_only,expires_at)
         VALUES($1,$2,$3,$4,$5,CASE WHEN $6::int IS NULL THEN NULL ELSE now()+$6::int*interval '1 day' END)
         RETURNING *`,
        [randomUUID(), subject, name, hash(raw), input.readOnly === true, days]
      )
    ).rows[0]
    await audit(db, subject, 'access_token.created', null, {
      tokenId: row.id,
      readOnly: row.read_only,
    })
    // The raw token is shown once and never stored.
    return { ...publicToken(row), token: raw }
  })
}

export async function listAccessTokens(db, subject) {
  return (
    await db.query(
      'SELECT * FROM control.access_tokens WHERE subject=$1 AND revoked_at IS NULL ORDER BY created_at DESC',
      [subject]
    )
  ).rows.map(publicToken)
}

export async function revokeAccessToken(pool, subject, id) {
  invariant(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 400, 'Invalid token ID')
  return transaction(pool, async (db) => {
    const revoked = await db.query(
      'UPDATE control.access_tokens SET revoked_at=now() WHERE id=$1 AND subject=$2 AND revoked_at IS NULL',
      [id, subject]
    )
    invariant(revoked.rowCount, 404, 'Token not found')
    await audit(db, subject, 'access_token.revoked', null, { tokenId: id })
    return { ok: true }
  })
}

// Resolves "Authorization: Bearer sbp_..." to the token's owner.
export async function tokenSubject(pool, raw) {
  invariant(typeof raw === 'string' && ACCESS_TOKEN_PATTERN.test(raw), 401, 'Invalid access token')
  const row = (
    await pool.query(
      'SELECT id, subject, read_only FROM control.access_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())',
      [hash(raw)]
    )
  ).rows[0]
  invariant(row, 401, 'Access token is invalid, expired, or revoked')
  // At most one write a minute per token.
  await pool.query(
    "UPDATE control.access_tokens SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')",
    [row.id]
  )
  return { subject: row.subject, readOnly: row.read_only, tokenId: row.id }
}
