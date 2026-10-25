import { randomBytes, randomUUID } from 'node:crypto'
import { diffLines } from './insights.mjs'
import { backupDownloadName, backupDownloadPath } from './backup-files.mjs'
import { githubLinkInput } from './github.mjs'
import { audit, roleFor, transaction } from './database.mjs'
import {
  allocationInput,
  authorize,
  generateSecrets,
  hash,
  invariant,
  operationAction,
  projectId,
  projectInput,
  publicUrl,
  seal,
  unseal,
  domainName,
  token,
} from './core.mjs'

const pendingOperationColumn = `(SELECT json_build_object('id',o.id,'kind',o.kind,'state',o.state,'createdAt',o.created_at)
  FROM control.operations o WHERE o.project_id=p.id AND o.state IN ('queued','running')
  ORDER BY o.created_at,o.id LIMIT 1) AS pending_operation`

export const publicProject = (row, config) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  desiredState: row.desired_state,
  pendingOperation: row.pending_operation ?? null,
  apiUrl: publicUrl(config, `${row.id}.api.${config.baseDomain}`),
  studioUrl: publicUrl(config, `${row.id}.studio.${config.baseDomain}`),
  siteUrl: row.site_url,
  memoryMb: row.memory_mb,
  backupIntervalHours: row.backup_interval_hours,
  backupRetention: row.backup_retention,
  cpus: Number(row.cpus),
  metrics: row.metrics,
  lastObservedAt: row.last_observed_at,
  createdAt: row.created_at,
  release: row.release,
  role: row.effective_role,
  // Local mode publishes the pooler on 127.0.0.1; servers keep databases private.
  databaseUrl: config.local
    ? `postgresql://postgres.${row.id}:[YOUR-PASSWORD]@localhost:${row.db_port}/postgres`
    : null,
})
export async function projectAccess(db, subject, id, action, includeDeleted = false) {
  projectId(id)
  authorize(await roleFor(db, subject, id), action)
  const project = (
    await db.query(
      `SELECT p.*, ${pendingOperationColumn} FROM control.projects p WHERE p.id=$1 AND (p.status<>'deleted' OR $2)`,
      [id, includeDeleted]
    )
  ).rows[0]
  invariant(project, 404, 'Project not found')
  return project
}
export async function enqueue(db, { actor, project, kind, payload = {}, key, requestHash }) {
  invariant(
    typeof key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(key),
    400,
    'Provide an Idempotency-Key with 8–128 letters, numbers, underscores, or hyphens'
  )
  const existing = (
    await db.query('SELECT * FROM control.operations WHERE actor=$1 AND idempotency_key=$2', [
      actor,
      key,
    ])
  ).rows[0]
  if (existing) {
    invariant(
      existing.request_hash === requestHash,
      409,
      'Idempotency key was already used for a different request'
    )
    return existing
  }
  const operation = (
    await db.query(
      'INSERT INTO control.operations(id,project_id,actor,kind,payload,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [randomUUID(), project, actor, kind, payload, key, requestHash]
    )
  ).rows[0]
  await audit(db, actor, `project.${kind}.requested`, project, { operationId: operation.id })
  return operation
}
export async function createProject(pool, config, actor, input, key) {
  const { github: repository, ...fields } = input ?? {}
  const values = projectInput(fields, { allowLocalhost: config.local })
  // One-click provisioning: the new project follows a repository from the start.
  const github = repository ? githubLinkInput(repository) : null
  return transaction(pool, async (db) => {
    authorize(await roleFor(db, actor), 'create')
    // Serialize reservations and idempotency checks, not project count.
    await db.query('SELECT pg_advisory_xact_lock(8734142)')
    const requestHash = hash(
      JSON.stringify({
        kind: 'create',
        ...values,
        ...(github ? { github: { ...github, token: Boolean(github.token) } } : {}),
      })
    )
    const prior = (
      await db.query('SELECT * FROM control.operations WHERE actor=$1 AND idempotency_key=$2', [
        actor,
        key,
      ])
    ).rows[0]
    if (prior) {
      invariant(prior.request_hash === requestHash, 409, 'Idempotency key conflict')
      return prior
    }
    const allocated = (
      await db.query(
        "SELECT COALESCE(sum(memory_mb),0)::int AS memory, COALESCE(sum(cpus),0)::float AS cpus FROM control.projects WHERE status<>'deleted'"
      )
    ).rows[0]
    invariant(
      allocated.memory + values.memoryMb <= config.capacityMb &&
        allocated.cpus + values.cpus <= config.capacityCpus,
      409,
      'Host capacity exceeded. Add capacity or reduce the allocation.'
    )
    const id = `p${randomBytes(12).toString('hex')}`
    // Two consecutive pooler ports per project (session, transaction). Allocation is
    // serialized by the advisory lock above; ports are never reused.
    const dbPort = (
      await db.query('SELECT COALESCE(max(db_port), 55430) + 2 AS port FROM control.projects')
    ).rows[0].port
    invariant(dbPort <= 65534, 409, 'No database ports are left for new projects')
    await db.query(
      'INSERT INTO control.projects(id,name,site_url,memory_mb,cpus,encrypted_secrets,release,db_port) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        values.name,
        values.siteUrl,
        values.memoryMb,
        values.cpus,
        seal(generateSecrets(), config.key, id),
        config.release,
        dbPort,
      ]
    )
    await db.query(
      'INSERT INTO control.project_members(project_id,subject,role) VALUES($1,$2,$3)',
      [id, actor, 'owner']
    )
    if (github)
      await db.query(
        'INSERT INTO control.github_links(project_id,repository,branch,directory,encrypted_token,auto_deploy,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          github.repository,
          github.branch,
          github.directory,
          github.token ? seal({ token: github.token }, config.key, `github:${id}`) : null,
          github.autoDeploy,
          actor,
        ]
      )
    return enqueue(db, { actor, project: id, kind: 'create', key, requestHash })
  })
}
export async function requestOperation(pool, config, actor, id, kind, input, key) {
  invariant(
    [
      'start',
      'stop',
      'restart',
      'delete',
      'backup',
      'restore',
      'verify-domain',
      'remove-domain',
      'upgrade',
      'rollback',
      'recover',
      'resize',
      'inspect',
      'deploy',
    ].includes(kind),
    400,
    'Unsupported operation'
  )
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(8734142)')
    projectId(id)
    authorize(await roleFor(db, actor, id), operationAction(kind))
    const payload = {}
    if (['delete', 'restore', 'recover'].includes(kind))
      invariant(input.confirmation === id, 400, 'Confirm the project ID before continuing')
    if (kind === 'restore') {
      invariant(typeof input.backupId === 'string', 400, 'Select a backup')
      payload.backupId = input.backupId
    }
    if (['verify-domain', 'remove-domain'].includes(kind)) payload.domain = domainName(input.domain)
    if (['upgrade', 'rollback'].includes(kind)) {
      invariant(
        typeof input.release === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(input.release),
        400,
        'Select an approved release'
      )
      payload.release = input.release
    }
    if (kind === 'resize') Object.assign(payload, allocationInput(input))
    if (kind === 'deploy') payload.source = 'manual'
    const requestHash = hash(JSON.stringify({ id, kind, payload }))
    const prior = (
      await db.query('SELECT * FROM control.operations WHERE actor=$1 AND idempotency_key=$2', [
        actor,
        key,
      ])
    ).rows[0]
    if (prior) {
      invariant(prior.request_hash === requestHash, 409, 'Idempotency key conflict')
      return prior
    }
    const project = await projectAccess(db, actor, id, operationAction(kind), kind === 'recover')
    if (['start', 'stop', 'restart'].includes(kind)) {
      const pending = (
        await db.query(
          "SELECT * FROM control.operations WHERE project_id=$1 AND kind=$2 AND state IN ('queued','running') ORDER BY created_at,id LIMIT 1",
          [id, kind]
        )
      ).rows[0]
      if (pending) return pending
    }
    if (kind === 'restore')
      invariant(
        (
          await db.query('SELECT id FROM control.backups WHERE id::text=$1 AND project_id=$2', [
            payload.backupId,
            id,
          ])
        ).rowCount,
        404,
        'Backup not found for this project'
      )
    if (kind === 'deploy') {
      invariant(
        (await db.query('SELECT 1 FROM control.github_links WHERE project_id=$1', [id])).rowCount,
        409,
        'Connect a GitHub repository first'
      )
      invariant(project.desired_state === 'running', 409, 'Resume the project before deploying')
    }
    if (kind === 'resize') {
      // Reserve the new allocation now so concurrent requests cannot oversubscribe;
      // the queued operation re-renders and restarts the stack with it.
      invariant(project.status !== 'deleted', 409, 'Project is deleted')
      const others = (
        await db.query(
          "SELECT COALESCE(sum(memory_mb),0)::int AS memory,COALESCE(sum(cpus),0)::float AS cpus FROM control.projects WHERE status<>'deleted' AND id<>$1",
          [id]
        )
      ).rows[0]
      invariant(
        others.memory + payload.memoryMb <= config.capacityMb &&
          others.cpus + payload.cpus <= config.capacityCpus,
        409,
        `Host capacity exceeded. ${config.capacityMb - others.memory} MiB and ${Number((config.capacityCpus - others.cpus).toFixed(2))} CPU are available for this project.`
      )
      await db.query('UPDATE control.projects SET memory_mb=$2,cpus=$3 WHERE id=$1', [
        id,
        payload.memoryMb,
        payload.cpus,
      ])
    }
    if (kind === 'recover') {
      invariant(project.status === 'deleted', 409, 'Project is not deleted')
      const allocation = (
        await db.query(
          "SELECT COALESCE(sum(memory_mb),0)::int AS memory,COALESCE(sum(cpus),0)::float AS cpus FROM control.projects WHERE status<>'deleted'"
        )
      ).rows[0]
      invariant(
        allocation.memory + project.memory_mb <= config.capacityMb &&
          allocation.cpus + Number(project.cpus) <= config.capacityCpus,
        409,
        'Host capacity exceeded'
      )
      await db.query(
        "UPDATE control.projects SET status='pending',desired_state='running' WHERE id=$1",
        [id]
      )
    }
    return enqueue(db, {
      actor,
      project: id,
      kind,
      payload,
      key,
      requestHash,
    })
  })
}
export async function listProjects(db, config, actor, cursor = '', limit = 30) {
  invariant(cursor === '' || /^p[a-f0-9]{24}$/.test(cursor), 400, 'Invalid cursor')
  invariant(Number.isInteger(limit) && limit > 0 && limit <= 100, 400, 'Limit must be 1–100')
  const { rows } = await db.query(
    `SELECT p.*, ${pendingOperationColumn}, COALESCE((SELECT role FROM control.members WHERE subject=$1),(SELECT role FROM control.project_members WHERE subject=$1 AND project_id=p.id)) AS effective_role FROM control.projects p WHERE p.status<>'deleted' AND p.id>$2
    AND (EXISTS(SELECT 1 FROM control.members WHERE subject=$1) OR EXISTS(SELECT 1 FROM control.project_members WHERE subject=$1 AND project_id=p.id))
    ORDER BY p.id LIMIT $3`,
    [actor, cursor, limit + 1]
  )
  return {
    projects: rows.slice(0, limit).map((row) => publicProject(row, config)),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  }
}
export async function projectSecrets(pool, config, actor, id) {
  return transaction(pool, async (db) => {
    const project = await projectAccess(db, actor, id, 'secrets')
    await audit(db, actor, 'project.secrets.read', id)
    const secret = unseal(project.encrypted_secrets, config.key, id)
    return {
      apiUrl: publicUrl(config, `${id}.api.${config.baseDomain}`),
      publishableKey: secret.SUPABASE_PUBLISHABLE_KEY,
      secretKey: secret.SUPABASE_SECRET_KEY,
      anonKey: secret.ANON_KEY,
      serviceRoleKey: secret.SERVICE_ROLE_KEY,
      databasePassword: secret.POSTGRES_PASSWORD,
    }
  })
}
export async function addDomain(pool, config, actor, id, value) {
  const domain = domainName(value)
  invariant(
    domain !== config.baseDomain && !domain.endsWith(`.${config.baseDomain}`),
    400,
    'Platform domains are reserved'
  )
  return transaction(pool, async (db) => {
    await projectAccess(db, actor, id, 'domains')
    const row = (
      await db.query(
        'INSERT INTO control.domains(domain,project_id,verification_token) VALUES($1,$2,$3) RETURNING *',
        [domain, id, token()]
      )
    ).rows[0]
    await audit(db, actor, 'project.domain.added', id, { domain })
    return row
  })
}

export async function projectInsights(db, actor, id) {
  await projectAccess(db, actor, id, 'read')
  const row = (
    await db.query(
      'SELECT migrations, performance, collected_at, error_code FROM control.project_insights WHERE project_id=$1',
      [id]
    )
  ).rows[0]
  return {
    collectedAt: row?.collected_at ?? null,
    errorCode: row?.error_code ?? null,
    migrations: row?.migrations ?? null,
    performance: row?.performance ?? null,
  }
}
export async function projectStats(db, actor, id, hours = 24) {
  invariant(Number.isInteger(hours) && hours >= 1 && hours <= 168, 400, 'Hours must be 1–168')
  await projectAccess(db, actor, id, 'read')
  return (
    await db.query(
      `SELECT collected_at AS "collectedAt", sample FROM control.project_stats
       WHERE project_id=$1 AND collected_at > now() - ($2 * interval '1 hour')
       ORDER BY collected_at`,
      [id, hours]
    )
  ).rows
}
export async function schemaSnapshots(db, actor, id) {
  await projectAccess(db, actor, id, 'read')
  return (
    await db.query(
      `SELECT id, hash, size_bytes AS "sizeBytes", created_at AS "createdAt"
       FROM control.schema_snapshots WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    )
  ).rows
}
const snapshotId = (value) => {
  invariant(
    typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
    400,
    'Select two schema snapshots to compare'
  )
  return value
}
// Compares two snapshots, of one project over time or of two projects. The caller
// needs read access to every project involved.
export async function schemaDiff(db, actor, fromId, toId) {
  const ids = [snapshotId(fromId), snapshotId(toId)]
  const rows = (
    await db.query(
      `SELECT s.id, s.project_id, s.content, s.created_at, p.name
       FROM control.schema_snapshots s JOIN control.projects p ON p.id = s.project_id
       WHERE s.id = ANY($1::uuid[])`,
      [ids]
    )
  ).rows
  const [from, to] = ids.map((value) => rows.find((row) => row.id === value))
  invariant(from && to, 404, 'Schema snapshot not found')
  for (const project of new Set([from.project_id, to.project_id]))
    await projectAccess(db, actor, project, 'read')
  invariant(
    from.content.length + to.content.length <= 4 * 1024 * 1024,
    413,
    'Schemas are too large to compare here'
  )
  const describe = (row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.name,
    createdAt: row.created_at,
  })
  return { from: describe(from), to: describe(to), ...diffLines(from.content, to.content) }
}
export async function updateBackupSettings(pool, actor, id, input) {
  invariant(input && typeof input === 'object', 400, 'Expected backup settings')
  const { intervalHours, retention } = input
  invariant(
    Number.isInteger(intervalHours) && intervalHours >= 0 && intervalHours <= 720,
    400,
    'Backup interval must be 0 (off) to 720 hours'
  )
  invariant(
    Number.isInteger(retention) && retention >= 1 && retention <= 365,
    400,
    'Keep between 1 and 365 backups'
  )
  return transaction(pool, async (db) => {
    await projectAccess(db, actor, id, 'operate')
    await db.query(
      'UPDATE control.projects SET backup_interval_hours=$2, backup_retention=$3 WHERE id=$1',
      [id, intervalHours, retention]
    )
    await audit(db, actor, 'project.backup_settings.updated', id, { intervalHours, retention })
    return { intervalHours, retention }
  })
}

// Full-cluster SQL dump of one backup. It contains every row, so it needs the same
// permission as revealing credentials, and every download is audited.
export async function backupDownload(pool, config, actor, id, backupId) {
  const path = backupDownloadPath(config.dataRoot, id, backupId)
  return transaction(pool, async (db) => {
    await projectAccess(db, actor, id, 'secrets')
    const backup = (
      await db.query(
        'SELECT created_at, download_bytes FROM control.backups WHERE id=$1 AND project_id=$2',
        [backupId, id]
      )
    ).rows[0]
    invariant(backup, 404, 'Backup not found')
    invariant(backup.download_bytes !== null, 404, 'This backup has no download')
    await audit(db, actor, 'project.backup.downloaded', id, { backup: backupId })
    return { path, name: backupDownloadName(backup.created_at) }
  })
}
