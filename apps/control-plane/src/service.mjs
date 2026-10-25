import { randomBytes, randomUUID } from 'node:crypto'
import { audit, roleFor, transaction } from './database.mjs'
import {
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

export const publicProject = (row, config) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  desiredState: row.desired_state,
  apiUrl: publicUrl(config, `${row.id}.api.${config.baseDomain}`),
  studioUrl: publicUrl(config, `${row.id}.studio.${config.baseDomain}`),
  siteUrl: row.site_url,
  memoryMb: row.memory_mb,
  cpus: Number(row.cpus),
  metrics: row.metrics,
  lastObservedAt: row.last_observed_at,
  createdAt: row.created_at,
  release: row.release,
  role: row.effective_role,
})
export async function projectAccess(db, subject, id, action, includeDeleted = false) {
  projectId(id)
  authorize(await roleFor(db, subject, id), action)
  const project = (
    await db.query("SELECT * FROM control.projects WHERE id=$1 AND (status<>'deleted' OR $2)", [
      id,
      includeDeleted,
    ])
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
  const values = projectInput(input, { allowLocalhost: config.local })
  return transaction(pool, async (db) => {
    authorize(await roleFor(db, actor), 'create')
    // Serialize reservations and idempotency checks, not project count.
    await db.query('SELECT pg_advisory_xact_lock(8734142)')
    const requestHash = hash(JSON.stringify({ kind: 'create', ...values }))
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
    await db.query(
      'INSERT INTO control.projects(id,name,site_url,memory_mb,cpus,encrypted_secrets,release) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        values.name,
        values.siteUrl,
        values.memoryMb,
        values.cpus,
        seal(generateSecrets(), config.key, id),
        config.release,
      ]
    )
    await db.query(
      'INSERT INTO control.project_members(project_id,subject,role) VALUES($1,$2,$3)',
      [id, actor, 'owner']
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
    `SELECT p.*, COALESCE((SELECT role FROM control.members WHERE subject=$1),(SELECT role FROM control.project_members WHERE subject=$1 AND project_id=p.id)) AS effective_role FROM control.projects p WHERE p.status<>'deleted' AND p.id>$2
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
