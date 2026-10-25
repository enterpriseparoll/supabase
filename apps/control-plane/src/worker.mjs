import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { configuration } from './config.mjs'
import { database, audit, roleFor, transaction } from './database.mjs'
import { authorize, invariant, operationAction, hash } from './core.mjs'
import { enqueue } from './service.mjs'
import { Infrastructure } from './infrastructure.mjs'

const safeErrorCodes = new Set([
  'COMMAND_FAILED',
  'COMMAND_TIMEOUT',
  'COMMAND_OUTPUT_LIMIT',
  'BACKUPS_NOT_CONFIGURED',
  'DOMAIN_NOT_FOUND',
  'DOMAIN_NOT_VERIFIED',
  'BACKUP_RELEASE_MISMATCH',
  'INVALID_RELEASE',
  'INVALID_RELEASE_MANIFEST',
  'RELEASE_CHECKSUM_MISMATCH',
  'IMAGE_DIGEST_REQUIRED',
  'IMAGE_DIGEST_UNAVAILABLE',
  'DATABASE_UPGRADE_REQUIRES_MIGRATION_RUNBOOK',
  'RELEASE_NOT_COMPATIBLE',
  'ROLLBACK_NOT_APPROVED',
  'RESTORE_MANIFEST_MISMATCH',
  'MANUAL_RECOVERY_REQUIRED',
  'PROJECT_DELETED',
  'BACKUP_SNAPSHOT_MISSING',
])

export async function runOne(pool, config, infrastructure) {
  // A session advisory lock is held throughout each operation. Another worker
  // can resume a crashed job only after PostgreSQL releases that connection.
  const candidates = (
    await pool.query(
      "SELECT id,project_id FROM control.operations WHERE state IN ('queued','running') AND retry_at<=now() ORDER BY created_at LIMIT 50"
    )
  ).rows
  for (const candidate of candidates) {
    const db = await pool.connect()
    let locked = false
    try {
      locked = (
        await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,8734144)) AS locked', [
          candidate.project_id,
        ])
      ).rows[0].locked
      if (!locked) continue
      const operation = await transaction(db, async (client) => {
        const row = (
          await client.query(
            "SELECT * FROM control.operations WHERE project_id=$1 AND state IN ('queued','running') ORDER BY created_at,id LIMIT 1 FOR UPDATE",
            [candidate.project_id]
          )
        ).rows[0]
        if (!row || new Date(row.retry_at).getTime() > Date.now()) return undefined
        await client.query(
          "UPDATE control.operations SET state='running', attempts=attempts+1, started_at=now(),error_code=NULL WHERE id=$1",
          [row.id]
        )
        return { ...row, attempts: row.attempts + 1 }
      })
      if (!operation) continue
      try {
        invariant(
          !(['restore', 'upgrade', 'rollback'].includes(operation.kind) && operation.attempts > 1),
          409,
          'MANUAL_RECOVERY_REQUIRED'
        )
        if (!(operation.actor === '@scheduler' && operation.kind === 'backup'))
          authorize(
            await roleFor(db, operation.actor, operation.project_id),
            operationAction(operation.kind)
          )
        const project = (
          await db.query('SELECT * FROM control.projects WHERE id=$1', [operation.project_id])
        ).rows[0]
        invariant(
          project &&
            (project.status !== 'deleted' || ['delete', 'recover'].includes(operation.kind)),
          404,
          'PROJECT_DELETED'
        )
        const kind = operation.kind
        if (['create', 'start', 'restart', 'recover'].includes(kind)) {
          if (kind === 'restart') await infrastructure.stop(project)
          await infrastructure.up(project)
        } else if (kind === 'stop') await infrastructure.stop(project)
        else if (kind === 'delete') await infrastructure.destroy(project)
        else if (kind === 'backup') await infrastructure.backup(project)
        else if (kind === 'restore')
          await infrastructure.restore(project, operation.payload.backupId)
        else if (kind === 'verify-domain')
          await infrastructure.verifyDomain(project, operation.payload.domain)
        else if (kind === 'remove-domain')
          await infrastructure.removeDomain(project, operation.payload.domain)
        else if (kind === 'upgrade' || kind === 'rollback')
          await infrastructure.changeRelease(
            project,
            operation.payload.release,
            kind === 'rollback'
          )
        else throw new Error('UNSUPPORTED_OPERATION')
        await transaction(db, async (client) => {
          const state = {
            create: 'ready',
            start: 'ready',
            restart: 'ready',
            recover: 'ready',
            stop: 'stopped',
            delete: 'deleted',
          }[kind]
          if (state)
            await client.query(
              'UPDATE control.projects SET status=$2,desired_state=$3 WHERE id=$1',
              [project.id, state, state === 'ready' ? 'running' : state]
            )
          await client.query(
            "UPDATE control.operations SET state='succeeded',finished_at=now() WHERE id=$1",
            [operation.id]
          )
          await audit(client, operation.actor, `project.${kind}.succeeded`, project.id, {
            operationId: operation.id,
          })
          if (kind === 'delete') {
            await client.query('DELETE FROM control.sessions WHERE project_id=$1', [project.id])
            await client.query('DELETE FROM control.domains WHERE project_id=$1', [project.id])
          }
        })
      } catch (error) {
        const errorCode =
          error.status === 403
            ? 'PERMISSION_REVOKED'
            : safeErrorCodes.has(error.message)
              ? error.message
              : 'OPERATION_FAILED'
        console.error(
          JSON.stringify({
            event: 'operation.failed',
            operation: operation.id,
            project: operation.project_id,
            code: errorCode,
          })
        )
        const retry =
          operation.attempts < 3 &&
          !error.status &&
          !['restore', 'upgrade', 'rollback'].includes(operation.kind)
        await transaction(db, async (client) => {
          await client.query(
            "UPDATE control.operations SET state=$2,error_code=$3,retry_at=now()+interval '30 seconds',finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1",
            [operation.id, retry ? 'queued' : 'failed', errorCode]
          )
          if (
            !retry &&
            [
              'create',
              'start',
              'restart',
              'stop',
              'delete',
              'recover',
              'restore',
              'upgrade',
              'rollback',
            ].includes(operation.kind) &&
            error.status !== 403
          )
            await client.query(
              "UPDATE control.projects SET status='error' WHERE id=$1 AND status<>'deleted'",
              [operation.project_id]
            )
          await audit(
            client,
            operation.actor,
            `project.${operation.kind}.failed`,
            operation.project_id,
            { operationId: operation.id, retry }
          )
        })
      }
      return true
    } finally {
      if (locked)
        await db.query('SELECT pg_advisory_unlock(hashtextextended($1,8734144))', [
          candidate.project_id,
        ])
      db.release()
    }
  }
  return false
}
export async function observe(pool, infrastructure) {
  const projects = (
    await pool.query(
      "SELECT * FROM control.projects WHERE status IN ('ready','error') AND desired_state='running' ORDER BY last_observed_at NULLS FIRST LIMIT 20"
    )
  ).rows
  for (const project of projects) {
    const db = await pool.connect()
    let locked = false
    try {
      locked = (
        await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,8734144)) AS locked', [
          project.id,
        ])
      ).rows[0].locked
      if (!locked) continue
      try {
        const metrics = await infrastructure.metrics(project)
        await db.query(
          'UPDATE control.projects SET metrics=$2,last_observed_at=now(),status=$3 WHERE id=$1',
          [project.id, metrics, metrics.healthy ? 'ready' : 'error']
        )
        if (metrics.healthy) await infrastructure.route(project)
        else await infrastructure.unroute(project)
      } catch {
        await db.query(
          "UPDATE control.projects SET last_observed_at=now(),metrics=jsonb_build_object('error','OBSERVATION_FAILED') WHERE id=$1",
          [project.id]
        )
      }
    } finally {
      if (locked)
        await db.query('SELECT pg_advisory_unlock(hashtextextended($1,8734144))', [project.id])
      db.release()
    }
  }
}
export async function scheduleBackups(pool, config) {
  if (!process.env.RESTIC_REPOSITORY || !process.env.RESTIC_PASSWORD_FILE) return
  const projects = (
    await pool.query(
      `SELECT p.id FROM control.projects p WHERE p.status IN ('ready','stopped')
    AND NOT EXISTS(SELECT 1 FROM control.operations o WHERE o.project_id=p.id AND o.kind='backup' AND (o.state IN ('queued','running') OR o.created_at>now()-($1*interval '1 hour')))
    AND NOT EXISTS(SELECT 1 FROM control.backups b WHERE b.project_id=p.id AND b.created_at>now()-($1*interval '1 hour'))`,
      [config.backupHours]
    )
  ).rows
  for (const project of projects)
    await transaction(pool, async (db) => {
      const key = `scheduled-${project.id}-${Math.floor(Date.now() / (config.backupHours * 3600000))}`
      await enqueue(db, {
        actor: '@scheduler',
        project: project.id,
        kind: 'backup',
        key,
        requestHash: hash(key),
      })
    })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await configuration()
  if (process.env.AWS_SECRET_ACCESS_KEY_FILE)
    process.env.AWS_SECRET_ACCESS_KEY = (
      await readFile(process.env.AWS_SECRET_ACCESS_KEY_FILE, 'utf8')
    ).trim()
  invariant(
    config.workerEnabled,
    500,
    'Set ENABLE_DOCKER_WORKER=true only on the private execution service'
  )
  const pool = database(config.databaseUrl)
  const infrastructure = new Infrastructure(config, pool)
  let stopping = false,
    lastObservation = 0
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      stopping = true
    })
  console.log(JSON.stringify({ event: 'worker.started' }))
  while (!stopping) {
    try {
      await runOne(pool, config, infrastructure)
      if (Date.now() - lastObservation > 60000) {
        await observe(pool, infrastructure)
        await scheduleBackups(pool, config)
        await pool.query('DELETE FROM control.sessions WHERE expires_at<now()')
        await pool.query('DELETE FROM control.login_flows WHERE expires_at<now()')
        await pool.query('DELETE FROM control.studio_tickets WHERE expires_at<now()')
        lastObservation = Date.now()
      }
    } catch {
      console.error(JSON.stringify({ event: 'worker.cycle.failed' }))
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  await pool.end()
}
