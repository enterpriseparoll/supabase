import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { hash, invariant } from './core.mjs'

export function database(url) {
  return new pg.Pool({
    connectionString: url,
    max: 12,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 30000,
    keepAlive: true,
  })
}
export async function transaction(pool, fn) {
  const ownsClient = typeof pool.release !== 'function'
  const client = ownsClient ? await pool.connect() : pool
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    if (ownsClient) client.release()
  }
}
export async function migrate(pool) {
  const root = fileURLToPath(new URL('../migrations/', import.meta.url))
  await transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(8734141)')
    await db.query(
      'CREATE TABLE IF NOT EXISTS public.platform_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())'
    )
    for (const name of (await readdir(root)).filter((n) => n.endsWith('.sql')).sort()) {
      const sql = await readFile(`${root}/${name}`, 'utf8')
      const { rows } = await db.query(
        'SELECT checksum FROM public.platform_migrations WHERE name=$1',
        [name]
      )
      if (rows.length) {
        invariant(rows[0].checksum === hash(sql), 500, 'Migration checksum changed')
        continue
      }
      await db.query(sql)
      await db.query('INSERT INTO public.platform_migrations(name,checksum) VALUES($1,$2)', [
        name,
        hash(sql),
      ])
    }
  })
}
export async function audit(db, actor, action, project = null, details = {}) {
  await db.query('INSERT INTO control.audit(actor,action,project_id,details) VALUES($1,$2,$3,$4)', [
    actor,
    action,
    project,
    details,
  ])
}
export async function roleFor(db, subject, project = null) {
  const global = await db.query('SELECT role FROM control.members WHERE subject=$1', [subject])
  if (global.rows[0]) return global.rows[0].role
  if (!project) return undefined
  return (
    await db.query('SELECT role FROM control.project_members WHERE subject=$1 AND project_id=$2', [
      subject,
      project,
    ])
  ).rows[0]?.role
}
export async function sessionSubject(db, raw, project = null) {
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined
  return (
    await db.query(
      'SELECT subject FROM control.sessions WHERE token_hash=$1 AND expires_at>now() AND project_id IS NOT DISTINCT FROM $2',
      [hash(raw), project]
    )
  ).rows[0]?.subject
}
