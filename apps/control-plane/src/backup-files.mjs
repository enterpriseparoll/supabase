// Downloadable backup files. The worker writes them; the API only reads them through
// a read-only mount, so it never needs Docker, restic, or project database access.
import { resolve, sep } from 'node:path'
import { invariant, projectId } from './core.mjs'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Databases that are never part of the download: the self-hosted analytics/pooler
// database (absent on Supabase Cloud) and leftovers from a restore.
export const CLUSTER_DUMP_EXCLUDED_DATABASES = [
  '_supabase',
  'postgres_before_restore',
  'postgres_restoring',
]

export function backupDownloadPath(dataRoot, project, backupId) {
  invariant(typeof backupId === 'string' && uuid.test(backupId), 400, 'Invalid backup ID')
  const root = resolve(dataRoot, 'exports')
  const path = resolve(root, projectId(project), `${backupId}.backup.gz`)
  invariant(path.startsWith(`${root}${sep}`), 400, 'Invalid backup path')
  return path
}

// Matches Supabase Cloud's naming, e.g. db_cluster-24-10-2026@20-31-36.backup.gz (UTC).
export function backupDownloadName(createdAt) {
  const date = new Date(createdAt)
  invariant(!Number.isNaN(date.getTime()), 500, 'Invalid backup date')
  const two = (value) => String(value).padStart(2, '0')
  return `db_cluster-${two(date.getUTCDate())}-${two(date.getUTCMonth() + 1)}-${date.getUTCFullYear()}@${two(
    date.getUTCHours()
  )}-${two(date.getUTCMinutes())}-${two(date.getUTCSeconds())}.backup.gz`
}

// pg_dumpall arguments for a cloud-compatible cluster dump: roles without password
// hashes, then every database except the excluded ones.
export function clusterDumpArgs() {
  return [
    'pg_dumpall',
    '-h',
    '127.0.0.1',
    '-U',
    'supabase_admin',
    '--no-role-passwords',
    ...CLUSTER_DUMP_EXCLUDED_DATABASES.map((name) => `--exclude-database=${name}`),
  ]
}
