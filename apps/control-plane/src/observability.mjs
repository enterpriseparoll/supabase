// Observability for Studio without a logs analytics service. Every minute the worker
// stores a resource sample (CPU, memory, disk, IO, network, connections) and counts
// each service's log lines by outcome. The API turns those into the responses
// Studio's Observability pages expect from the platform's infra-monitoring and
// service-health endpoints.
import { invariant } from './core.mjs'
import { dockerGet, decodeDockerLogs, parseLogLine } from './logs.mjs'
import { projectName } from './templates.mjs'
import { parseBytes, parsePercent } from './usage.mjs'

const MIB = 1024 * 1024
const RETENTION = "interval '8 days'"

// Docker reports cumulative IO as "1.2MB / 3.4MB".
export function parsePair(value) {
  const [first, second] = String(value ?? '').split('/')
  return [parseBytes(first) ?? 0, parseBytes(second) ?? 0]
}

export const CONNECTIONS_SQL = `SELECT json_build_object(
  'roles', coalesce((SELECT json_object_agg(r, c) FROM (
    SELECT coalesce(usename::text, 'unknown') AS r, count(*) AS c FROM pg_stat_activity
    WHERE backend_type = 'client backend' GROUP BY 1) x), '{}'::json),
  'database_bytes', pg_database_size(current_database()),
  'max_connections', current_setting('max_connections')::int
)::text`

/** One resource sample from the worker's container statistics and database counters. */
export function metricSample(project, metrics, database = {}) {
  const stats = Array.isArray(metrics?.stats) ? metrics.stats : []
  const sample = {
    cpus: Number(project.cpus) || 1,
    cpuPercent: 0,
    memoryUsed: 0,
    memoryLimit: (Number(project.memory_mb) || 0) * MIB,
    blockRead: 0,
    blockWrite: 0,
    netRx: 0,
    netTx: 0,
    diskProject: metrics?.disk?.projectBytes ?? null,
    diskAvailable: metrics?.disk?.hostAvailableBytes ?? null,
    databaseBytes: database.database_bytes ?? null,
    maxConnections: database.max_connections ?? null,
    connections: database.roles ?? null,
  }
  for (const row of stats) {
    sample.cpuPercent += parsePercent(row.cpu) ?? 0
    sample.memoryUsed += parsePair(row.memory)[0]
    const [read, write] = parsePair(row.blockIO)
    sample.blockRead += read
    sample.blockWrite += write
    const [rx, tx] = parsePair(row.net)
    sample.netRx += rx
    sample.netTx += tx
  }
  return sample
}

const KNOWN_ROLES = [
  'postgres',
  'authenticator',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
]
const clampPercent = (value) => Math.max(0, Math.min(100, value))

/** Studio's infra-monitoring attribute values for one sample (rates use the previous). */
export function sampleValues(sample, previous, seconds) {
  const values = {}
  const cpu = clampPercent(sample.cpuPercent / (sample.cpus || 1))
  Object.assign(values, {
    cpu_usage: cpu,
    avg_cpu_usage: cpu,
    max_cpu_usage: cpu,
    cpu_usage_busy_user: cpu,
    cpu_usage_busy_system: 0,
    cpu_usage_busy_iowait: 0,
    cpu_usage_busy_irqs: 0,
    cpu_usage_busy_other: 0,
    cpu_usage_busy_idle: 100 - cpu,
    cpu_usage_max: 100,
  })
  if (sample.memoryLimit > 0)
    Object.assign(values, {
      ram_usage: clampPercent((sample.memoryUsed / sample.memoryLimit) * 100),
      ram_usage_used: sample.memoryUsed,
      ram_usage_total: sample.memoryLimit,
      ram_usage_available: Math.max(0, sample.memoryLimit - sample.memoryUsed),
      ram_usage_free: Math.max(0, sample.memoryLimit - sample.memoryUsed),
      ram_usage_cache_and_buffers: 0,
      ram_usage_swap: 0,
      swap_usage: 0,
    })
  if (Number.isFinite(sample.diskProject)) {
    const database = Number(sample.databaseBytes) || 0
    Object.assign(values, {
      disk_fs_used_system: Math.max(0, sample.diskProject - database),
      disk_fs_used_wal: 0,
      pg_database_size: database,
    })
    if (Number.isFinite(sample.diskAvailable))
      values.disk_fs_size = sample.diskProject + sample.diskAvailable
  }
  if (sample.connections) {
    const counts = sample.connections
    const total = Object.values(counts).reduce((sum, count) => sum + Number(count), 0)
    values.pg_stat_database_num_backends = total
    for (const role of KNOWN_ROLES) values[`client_connections_${role}`] = Number(counts[role] ?? 0)
    values.client_connections_other =
      total - KNOWN_ROLES.reduce((sum, role) => sum + Number(counts[role] ?? 0), 0)
  }
  if (sample.maxConnections) values.max_db_connections = sample.maxConnections
  // Counters restart with containers; skip negative differences.
  if (previous && seconds > 0 && seconds <= 600) {
    const rate = (key) => {
      const difference = sample[key] - previous[key]
      return difference >= 0 ? difference / seconds : undefined
    }
    for (const [attribute, key] of [
      ['disk_bytes_read', 'blockRead'],
      ['disk_bytes_written', 'blockWrite'],
      ['network_receive_bytes', 'netRx'],
      ['network_transmit_bytes', 'netTx'],
    ]) {
      const value = rate(key)
      if (value !== undefined) values[attribute] = value
    }
  }
  return values
}

const INTERVALS = {
  '1m': 60,
  '5m': 300,
  '10m': 600,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '1d': 86400,
}
const PERCENT_ATTRIBUTE =
  /^(cpu_usage|avg_cpu_usage|max_cpu_usage|cpu_usage_busy_|ram_usage$|swap_usage)/

export function infraMonitoringInput(searchParams, now = Date.now()) {
  const attributes = [
    ...searchParams.getAll('attributes'),
    ...searchParams.getAll('attributes[]'),
    ...searchParams.getAll('attribute'),
  ].flatMap((value) => value.split(','))
  invariant(attributes.length > 0 && attributes.length <= 50, 400, 'Choose one or more metrics')
  invariant(
    attributes.every((attribute) => /^[a-z0-9_]{1,80}$/.test(attribute)),
    400,
    'Unknown metric'
  )
  const start = Date.parse(searchParams.get('startDate') ?? '')
  const end = Date.parse(searchParams.get('endDate') ?? '') || now
  invariant(Number.isFinite(start) && end > start, 400, 'Choose a valid time range')
  invariant(end - start <= 31 * 86400000, 400, 'Choose a time range of 31 days or less')
  const interval = INTERVALS[searchParams.get('interval') ?? '1h']
  invariant(interval, 400, 'Choose a supported interval')
  invariant((end - start) / 1000 / interval <= 5000, 400, 'Choose a longer interval')
  return { attributes: [...new Set(attributes)], start, end, interval }
}

/** Studio's infra-monitoring response from stored samples ({sampled_at, sample}, oldest first). */
export function infraMonitoring(rows, { attributes, interval, start = -Infinity }) {
  const firstBucket = Math.floor(start / 1000 / interval) * interval * 1000
  const buckets = new Map()
  let previous
  for (const row of rows) {
    const time = Date.parse(row.sampled_at)
    const seconds = previous ? (time - previous.time) / 1000 : 0
    const values = sampleValues(row.sample, previous?.sample, seconds)
    previous = { time, sample: row.sample }
    const key = Math.floor(time / 1000 / interval) * interval * 1000
    if (key < firstBucket) continue
    const bucket = buckets.get(key) ?? {}
    for (const attribute of attributes)
      if (Number.isFinite(values[attribute])) (bucket[attribute] ??= []).push(values[attribute])
    buckets.set(key, bucket)
  }
  const round = (value) => String(Math.round(value * 100) / 100)
  const data = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, bucket]) => ({
      period_start: new Date(key).toISOString(),
      values: Object.fromEntries(
        Object.entries(bucket).map(([attribute, list]) => [
          attribute,
          round(list.reduce((sum, value) => sum + value, 0) / list.length),
        ])
      ),
    }))
  const series = {}
  for (const attribute of attributes) {
    const points = data
      .map((point) => Number(point.values[attribute]))
      .filter((value) => Number.isFinite(value))
    if (!points.length) continue
    const total = points.reduce((sum, value) => sum + value, 0)
    const percent = PERCENT_ATTRIBUTE.test(attribute)
    series[attribute] = {
      format: percent ? '%' : '',
      yAxisLimit: percent ? 100 : Math.max(...points),
      total: Math.round(total * 100) / 100,
      totalAverage: Math.round((total / points.length) * 100) / 100,
    }
  }
  if (attributes.length === 1) {
    const [attribute] = attributes
    return {
      data: data.map((point) => ({
        period_start: point.period_start,
        [attribute]: point.values[attribute],
      })),
      ...(series[attribute] ?? { format: '', yAxisLimit: 0, total: 0, totalAverage: 0 }),
    }
  }
  return { data, series }
}

// Log sources Studio's service health table reads, by compose service.
export const HEALTH_SOURCES = {
  db: 'postgres_logs',
  auth: 'auth_logs',
  functions: 'function_edge_logs',
  storage: 'storage_logs',
  realtime: 'realtime_logs',
  rest: 'postgrest_logs',
  'api-gw': 'edge_logs',
  supavisor: 'supavisor_logs',
}
const ALL_SOURCES = [...Object.values(HEALTH_SOURCES), 'function_logs', 'etl_replication_logs']

export function serviceHealthInput(searchParams, now = Date.now()) {
  const start = Date.parse(searchParams.get('iso_timestamp_start') ?? '')
  const end = Date.parse(searchParams.get('iso_timestamp_end') ?? '') || now
  invariant(Number.isFinite(start) && end > start, 400, 'Choose a valid time range')
  invariant(end - start <= 31 * 86400000, 400, 'Choose a time range of 31 days or less')
  const granularity = searchParams.get('granularity') ?? 'hour'
  invariant(['minute', 'hour', 'day'].includes(granularity), 400, 'Unknown granularity')
  return { start, end, granularity }
}

/** Studio's service-health rows from grouped counts ({timestamp, service, ok, warning, error}). */
export function serviceHealth(rows) {
  const byTime = new Map()
  for (const row of rows) {
    const timestamp = new Date(row.timestamp).toISOString()
    let entry = byTime.get(timestamp)
    if (!entry) {
      entry = { timestamp }
      for (const source of ALL_SOURCES) entry[source] = { ok: 0, warning: 0, error: 0, total: 0 }
      byTime.set(timestamp, entry)
    }
    const source = HEALTH_SOURCES[row.service]
    if (!source) continue
    const counts = entry[source]
    counts.ok += Number(row.ok)
    counts.warning += Number(row.warning)
    counts.error += Number(row.error)
    counts.total = counts.ok + counts.warning + counts.error
  }
  return { result: [...byTime.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) }
}

/** Counts log lines per minute and outcome since the last count. */
export function countLines(text, service, since, until) {
  const buckets = new Map()
  for (const line of text.split('\n')) {
    const entry = parseLogLine(line, service)
    if (!entry) continue
    const time = Date.parse(entry.timestamp)
    if (!(time >= since && time < until)) continue
    const minute = Math.floor(time / 60000) * 60000
    const bucket = buckets.get(minute) ?? { ok: 0, warning: 0, error: 0 }
    bucket[entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'ok']++
    buckets.set(minute, bucket)
  }
  return buckets
}

export class ProjectObservability {
  constructor(pool, infrastructure, { get = dockerGet, now = () => Date.now() } = {}) {
    this.pool = pool
    this.infrastructure = infrastructure
    this.get = get
    this.now = now
  }

  async record(project, metrics) {
    let database = {}
    try {
      database = JSON.parse((await this.infrastructure.psql(project, CONNECTIONS_SQL)).trim())
    } catch {
      // Resource figures are still worth keeping without database counters.
    }
    await this.pool.query(
      'INSERT INTO control.project_metric_samples(project_id,sample) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [project.id, metricSample(project, metrics, database)]
    )
    await this.countLogs(project)
    await this.pool.query(
      `DELETE FROM control.project_metric_samples WHERE project_id=$1 AND sampled_at < now() - ${RETENTION}`,
      [project.id]
    )
    await this.pool.query(
      `DELETE FROM control.project_log_counts WHERE project_id=$1 AND bucket < now() - ${RETENTION}`,
      [project.id]
    )
  }

  async countLogs(project) {
    const name = projectName(project.id)
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`com.docker.compose.project=${name}`], status: ['running'] })
    )
    const containers = JSON.parse(
      (await this.get(`/containers/json?filters=${filters}`)).toString()
    ).filter(
      (container) =>
        container.Labels?.['com.docker.compose.project'] === name &&
        HEALTH_SOURCES[container.Labels?.['com.docker.compose.service']] &&
        /^[a-f0-9]{64}$/.test(container.Id)
    )
    const cursors = new Map(
      (
        await this.pool.query(
          'SELECT service, counted_until FROM control.project_log_cursors WHERE project_id=$1',
          [project.id]
        )
      ).rows.map((row) => [row.service, Date.parse(row.counted_until)])
    )
    const until = this.now()
    for (const container of containers) {
      const service = container.Labels['com.docker.compose.service']
      // First count, or after a long gap: look back at most 15 minutes.
      const since = Math.max(cursors.get(service) ?? 0, until - 15 * 60000)
      let buckets = new Map()
      try {
        const query = new URLSearchParams({
          stdout: '1',
          stderr: '1',
          timestamps: '1',
          since: (since / 1000).toFixed(3),
          until: (until / 1000).toFixed(3),
          tail: '20000',
        })
        const text = decodeDockerLogs(
          await this.get(`/containers/${container.Id}/logs?${query}`, {
            maxBytes: 8 * 1024 * 1024,
          })
        )
        buckets = countLines(text, service, since, until)
      } catch {
        // Too much output or a container that went away: skip this window.
      }
      for (const [minute, counts] of buckets)
        await this.pool.query(
          `INSERT INTO control.project_log_counts(project_id,bucket,service,ok,warning,error)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (project_id,bucket,service) DO UPDATE SET ok=project_log_counts.ok+excluded.ok,
             warning=project_log_counts.warning+excluded.warning, error=project_log_counts.error+excluded.error`,
          [project.id, new Date(minute), service, counts.ok, counts.warning, counts.error]
        )
      await this.pool.query(
        `INSERT INTO control.project_log_cursors(project_id,service,counted_until) VALUES($1,$2,$3)
         ON CONFLICT (project_id,service) DO UPDATE SET counted_until=excluded.counted_until`,
        [project.id, service, new Date(until)]
      )
    }
  }
}

export async function readInfraMonitoring(db, id, input) {
  const { rows } = await db.query(
    `SELECT sampled_at, sample FROM control.project_metric_samples
     WHERE project_id=$1 AND sampled_at >= $2 AND sampled_at < $3 ORDER BY sampled_at`,
    // One extra sample before the window gives the first rate a starting point.
    [id, new Date(input.start - input.interval * 1000), new Date(input.end)]
  )
  return infraMonitoring(rows, input)
}

export async function readServiceHealth(db, id, { start, end, granularity }) {
  const { rows } = await db.query(
    `SELECT date_trunc($4, bucket) AS timestamp, service,
       sum(ok)::int AS ok, sum(warning)::int AS warning, sum(error)::int AS error
     FROM control.project_log_counts
     WHERE project_id=$1 AND bucket >= $2 AND bucket < $3
     GROUP BY 1, 2 ORDER BY 1`,
    [id, new Date(start), new Date(end), granularity]
  )
  return serviceHealth(rows)
}
