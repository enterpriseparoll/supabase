// Usage across every project a person can access: what is reserved (memory, CPU)
// and what is measured (container memory and CPU, disk, database size and
// connections, backups). Figures come from the worker's latest observations.
import { publicProject } from './service.mjs'

const UNITS = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
}

// Docker reports sizes like "43.16MiB", "1.091GiB", "18.9MB", or "0B".
export function parseBytes(value) {
  const match = String(value ?? '')
    .trim()
    .match(/^([\d.]+)\s*([kmgt]?i?b)$/i)
  if (!match) return null
  const factor = UNITS[match[2].toLowerCase()]
  return factor === undefined ? null : Math.round(Number(match[1]) * factor)
}
export const parsePercent = (value) => {
  const number = Number.parseFloat(String(value ?? '').replace('%', ''))
  return Number.isFinite(number) ? number : null
}

// Sums one project's container statistics ("used / limit" memory, CPU percent).
export function containerUsage(metrics) {
  const stats = Array.isArray(metrics?.stats) ? metrics.stats : []
  if (!stats.length) return { memoryUsedBytes: null, cpuPercent: null }
  let memory = 0
  let cpu = 0
  for (const row of stats) {
    memory += parseBytes(String(row.memory ?? '').split('/')[0]) ?? 0
    cpu += parsePercent(row.cpu) ?? 0
  }
  return { memoryUsedBytes: memory, cpuPercent: Math.round(cpu * 100) / 100 }
}

export async function platformUsage(db, config, actor) {
  const { rows } = await db.query(
    `SELECT p.*,
       COALESCE((SELECT role FROM control.members WHERE subject=$1),
         (SELECT role FROM control.project_members WHERE subject=$1 AND project_id=p.id)) AS effective_role,
       i.performance, i.collected_at AS insights_at,
       (SELECT count(*)::int FROM control.backups b WHERE b.project_id=p.id) AS backup_count,
       (SELECT b.size_bytes FROM control.backups b WHERE b.project_id=p.id ORDER BY b.created_at DESC LIMIT 1) AS last_backup_bytes,
       (SELECT max(b.created_at) FROM control.backups b WHERE b.project_id=p.id) AS last_backup_at
     FROM control.projects p
     LEFT JOIN control.project_insights i ON i.project_id=p.id
     WHERE p.status<>'deleted'
       AND (EXISTS(SELECT 1 FROM control.members WHERE subject=$1)
         OR EXISTS(SELECT 1 FROM control.project_members WHERE subject=$1 AND project_id=p.id))
     ORDER BY p.name, p.id LIMIT 1000`,
    [actor]
  )
  let hostAvailableBytes = null
  const projects = rows.map((row) => {
    const project = publicProject(row, config)
    const running = row.desired_state === 'running'
    const performance = row.performance ?? {}
    const disk = row.metrics?.disk ?? {}
    if (Number.isFinite(disk.hostAvailableBytes)) hostAvailableBytes = disk.hostAvailableBytes
    // Live measurements only describe running projects.
    const live = running ? containerUsage(row.metrics) : { memoryUsedBytes: 0, cpuPercent: 0 }
    return {
      id: project.id,
      name: project.name,
      status: project.status,
      running,
      memoryMb: project.memoryMb,
      cpus: project.cpus,
      memoryUsedBytes: live.memoryUsedBytes,
      cpuPercent: live.cpuPercent,
      diskBytes: Number.isFinite(disk.projectBytes) ? disk.projectBytes : null,
      databaseBytes: performance.database_bytes != null ? Number(performance.database_bytes) : null,
      connections: running ? (performance.connections?.total ?? null) : 0,
      maxConnections: performance.max_connections ?? null,
      backupCount: row.backup_count,
      lastBackupBytes: row.last_backup_bytes != null ? Number(row.last_backup_bytes) : null,
      lastBackupAt: row.last_backup_at,
      observedAt: row.last_observed_at,
      insightsAt: row.insights_at,
    }
  })
  return {
    capacity: {
      memoryMb: config.capacityMb ?? null,
      cpus: config.capacityCpus ?? null,
      hostAvailableBytes,
    },
    projects,
  }
}
