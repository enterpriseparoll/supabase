// Interactive requests (SQL, type generation, Edge Functions) that need an answer in
// seconds. The API never connects to project databases: it records the request,
// and the worker runs it outside the operation queue and stores the result.
import { randomUUID } from 'node:crypto'
import { authorize, HttpError, invariant } from './core.mjs'
import { roleFor } from './database.mjs'

export const LIVE_KINDS = {
  // kind: permission the requester needs, and how long the API waits.
  sql: { action: 'secrets', timeoutMs: 65000 },
  types: { action: 'read', timeoutMs: 65000 },
  functions: { action: 'read', timeoutMs: 30000 },
  logs: { action: 'operate', timeoutMs: 45000 },
  'deploy-function': { action: 'operate', timeoutMs: 120000 },
  migrations: { action: 'read', timeoutMs: 30000 },
  'apply-migration': { action: 'secrets', timeoutMs: 120000 },
}
const MAX_RESULT_BYTES = 5 * 1024 * 1024

export async function liveRequest(
  pool,
  { subject, project, kind, payload = {}, readOnly = false },
  { pollMs = 50 } = {}
) {
  const spec = LIVE_KINDS[kind]
  invariant(spec, 400, 'Unsupported request')
  authorize(await roleFor(pool, subject, project), spec.action)
  const id = randomUUID()
  const deadline = Date.now() + spec.timeoutMs
  await pool.query(
    'INSERT INTO control.live_requests(id,project_id,subject,kind,payload,read_only) VALUES($1,$2,$3,$4,$5,$6)',
    [id, project, subject, kind, { ...payload, deadline }, readOnly]
  )
  await pool.query("SELECT pg_notify('live_requests', $1)", [id])
  let delay = pollMs
  while (Date.now() < deadline + 2000) {
    await new Promise((done) => setTimeout(done, delay))
    delay = Math.min(delay * 1.5, 500)
    const row = (
      await pool.query('SELECT state, result, error FROM control.live_requests WHERE id=$1', [id])
    ).rows[0]
    if (row?.state === 'succeeded') return row.result
    if (row?.state === 'failed') throw new HttpError(422, row.error ?? 'Request failed')
  }
  throw new HttpError(504, 'The platform worker did not answer in time. Check that it is running.')
}

// Worker side: claims queued requests (woken by NOTIFY, polling every second as a
// fallback) and runs up to `concurrency` at once.
export function serveLiveRequests(pool, handlers, { concurrency = 4, log = console } = {}) {
  let stopped = false
  let wake = () => {}
  const running = new Set()
  let listener
  pool
    .connect()
    .then(async (client) => {
      listener = client
      client.on('error', () => {})
      client.on('notification', () => wake())
      await client.query('LISTEN live_requests')
    })
    .catch(() => {
      /* polling still works */
    })
  const claim = async () =>
    (
      await pool.query(
        `UPDATE control.live_requests SET state='running', started_at=now()
         WHERE id=(SELECT id FROM control.live_requests WHERE state='queued'
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`
      )
    ).rows[0]
  const finish = (id, state, result, error) =>
    pool.query(
      'UPDATE control.live_requests SET state=$2, result=$3, error=$4, finished_at=now() WHERE id=$1',
      [id, state, result === undefined ? null : JSON.stringify(result), error ?? null]
    )
  const handle = async (row) => {
    try {
      invariant(Date.now() < Number(row.payload.deadline), 408, 'Request expired before it ran')
      const spec = LIVE_KINDS[row.kind]
      invariant(spec && handlers[row.kind], 400, 'Unsupported request')
      // Recheck permission: the requester may have lost access since queueing.
      authorize(await roleFor(pool, row.subject, row.project_id), spec.action)
      const project = (
        await pool.query("SELECT * FROM control.projects WHERE id=$1 AND status<>'deleted'", [
          row.project_id,
        ])
      ).rows[0]
      invariant(project, 404, 'Project not found')
      invariant(
        row.kind === 'logs' || project.desired_state === 'running',
        409,
        'The project is paused. Resume it first.'
      )
      const result = await handlers[row.kind](project, row.payload, { readOnly: row.read_only })
      const size = Buffer.byteLength(JSON.stringify(result ?? null))
      invariant(
        size <= MAX_RESULT_BYTES,
        413,
        'The result is larger than 5 MB. Narrow the query, for example with LIMIT.'
      )
      await finish(row.id, 'succeeded', result ?? null)
    } catch (error) {
      // Database errors are the requester's own query errors; return their message.
      const message = error.status || error.code ? error.message : 'Request failed'
      if (!error.status && !error.code)
        log.error(JSON.stringify({ event: 'live.failed', kind: row.kind, project: row.project_id }))
      await finish(row.id, 'failed', undefined, String(message).slice(0, 4000)).catch(() => {})
    }
  }
  const loop = (async () => {
    let lastCleanup = 0
    while (!stopped) {
      try {
        while (running.size < concurrency) {
          const row = await claim()
          if (!row) break
          const task = handle(row).finally(() => running.delete(task))
          running.add(task)
        }
        if (Date.now() - lastCleanup > 60000) {
          await pool.query(
            "UPDATE control.live_requests SET state='failed', error='The worker stopped while running this request', finished_at=now() WHERE state='running' AND started_at<now()-interval '10 minutes'"
          )
          await pool.query(
            "DELETE FROM control.live_requests WHERE created_at<now()-interval '1 day'"
          )
          lastCleanup = Date.now()
        }
      } catch {
        log.error(JSON.stringify({ event: 'live.cycle.failed' }))
      }
      await new Promise((done) => {
        wake = done
        setTimeout(done, 1000)
      })
    }
  })()
  return {
    async stop() {
      stopped = true
      wake()
      await loop
      await Promise.allSettled([...running])
      listener?.release()
    },
  }
}
