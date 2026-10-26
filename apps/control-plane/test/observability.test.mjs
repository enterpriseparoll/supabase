import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countLines,
  infraMonitoring,
  infraMonitoringInput,
  metricSample,
  ProjectObservability,
  serviceHealth,
  serviceHealthInput,
} from '../src/observability.mjs'

const project = { id: 'p0123456789abcdef01234567', cpus: 2, memory_mb: 1024 }
const metrics = (cpu, rx) => ({
  disk: { projectBytes: 500e6, hostAvailableBytes: 9500e6 },
  stats: [
    { cpu: `${cpu}%`, memory: '256MiB / 512MiB', blockIO: '10MB / 20MB', net: `${rx}MB / 1MB` },
    { cpu: '10%', memory: '256MiB / 512MiB', blockIO: '0B / 0B', net: '0B / 0B' },
  ],
})
const database = {
  roles: { postgres: 3, authenticator: 2, supabase_admin: 1, pgbouncer: 4 },
  database_bytes: 100e6,
  max_connections: 100,
}

test('a sample sums container figures and keeps database counters', () => {
  const sample = metricSample(project, metrics(30, 5), database)
  assert.equal(sample.cpuPercent, 40)
  assert.equal(sample.memoryUsed, 512 * 1024 * 1024)
  assert.equal(sample.memoryLimit, 1024 * 1024 * 1024)
  assert.equal(sample.blockRead, 10e6)
  assert.equal(sample.netRx, 5e6)
  assert.equal(sample.databaseBytes, 100e6)
})

test('infra-monitoring buckets samples and derives rates and percentages', () => {
  const rows = [
    { sampled_at: '2026-10-26T10:00:00Z', sample: metricSample(project, metrics(30, 5), database) },
    {
      sampled_at: '2026-10-26T10:01:00Z',
      sample: metricSample(project, metrics(50, 11), database),
    },
  ]
  const result = infraMonitoring(rows, {
    attributes: [
      'avg_cpu_usage',
      'ram_usage',
      'network_receive_bytes',
      'pg_stat_database_num_backends',
      'client_connections_other',
      'disk_fs_size',
      'disk_io_budget',
    ],
    interval: 60,
  })
  assert.equal(result.data.length, 2)
  assert.equal(result.data[0].values.avg_cpu_usage, '20')
  assert.equal(result.data[1].values.avg_cpu_usage, '30')
  assert.equal(result.data[0].values.network_receive_bytes, undefined)
  assert.equal(result.data[1].values.network_receive_bytes, '100000')
  assert.equal(result.series.ram_usage.totalAverage, 50)
  assert.equal(result.series.ram_usage.format, '%')
  assert.equal(result.series.pg_stat_database_num_backends.total, 20)
  assert.equal(result.data[0].values.client_connections_other, '4')
  assert.equal(result.series.disk_fs_size.totalAverage, 10e9)
  // Local disks have no IO budget.
  assert.equal(result.series.disk_io_budget, undefined)

  const single = infraMonitoring(rows, { attributes: ['avg_cpu_usage'], interval: 3600 })
  assert.deepEqual(single.data, [{ period_start: '2026-10-26T10:00:00.000Z', avg_cpu_usage: '25' }])
  assert.equal(single.totalAverage, 25)

  const later = infraMonitoring(rows, {
    attributes: ['avg_cpu_usage', 'ram_usage'],
    interval: 60,
    start: Date.parse('2026-10-26T10:01:00Z'),
  })
  assert.equal(later.data.length, 1)
})

test('request parameters are checked', () => {
  const params = new URLSearchParams(
    'attributes=avg_cpu_usage&attributes=ram_usage&startDate=2026-10-26T00:00:00Z&endDate=2026-10-26T01:00:00Z&interval=1m'
  )
  assert.deepEqual(infraMonitoringInput(params).attributes, ['avg_cpu_usage', 'ram_usage'])
  assert.throws(() => infraMonitoringInput(new URLSearchParams('attributes=x;drop')), /metric/)
  assert.throws(
    () =>
      infraMonitoringInput(
        new URLSearchParams(
          'attributes=a&startDate=2026-10-26T00:00:00Z&endDate=2026-10-26T01:00:00Z&interval=9y'
        )
      ),
    /interval/
  )
  assert.throws(
    () =>
      serviceHealthInput(
        new URLSearchParams('iso_timestamp_start=2026-10-26T00:00:00Z&granularity=week')
      ),
    /granularity/
  )
})

test('log lines are counted per minute and outcome', () => {
  const text = [
    '2026-10-26T10:00:01.000000000Z {"method":"GET","path":"/rest/v1/x","status":200}',
    '2026-10-26T10:00:02.000000000Z {"method":"GET","path":"/rest/v1/x","status":404}',
    '2026-10-26T10:01:00.000000000Z {"method":"POST","path":"/auth/v1/token","status":500}',
    '2026-10-26T09:59:59.000000000Z {"status":200}',
    'not a log line',
  ].join('\n')
  const since = Date.parse('2026-10-26T10:00:00Z')
  const buckets = countLines(text, 'api-gw', since, since + 120000)
  assert.deepEqual(buckets.get(since), { ok: 1, warning: 1, error: 0 })
  assert.deepEqual(buckets.get(since + 60000), { ok: 0, warning: 0, error: 1 })
  assert.equal(buckets.size, 2)
})

test('service health groups counts under Studio source names', () => {
  const { result } = serviceHealth([
    { timestamp: '2026-10-26T10:00:00Z', service: 'api-gw', ok: 5, warning: 1, error: 0 },
    { timestamp: '2026-10-26T10:00:00Z', service: 'db', ok: 2, warning: 0, error: 1 },
    { timestamp: '2026-10-26T09:00:00Z', service: 'rest', ok: 1, warning: 0, error: 0 },
  ])
  assert.equal(result.length, 2)
  assert.equal(result[0].timestamp, '2026-10-26T09:00:00.000Z')
  assert.deepEqual(result[0].postgrest_logs, { ok: 1, warning: 0, error: 0, total: 1 })
  assert.deepEqual(result[1].edge_logs, { ok: 5, warning: 1, error: 0, total: 6 })
  assert.deepEqual(result[1].postgres_logs, { ok: 2, warning: 0, error: 1, total: 3 })
  assert.deepEqual(result[1].realtime_logs, { ok: 0, warning: 0, error: 0, total: 0 })
})

test('the worker records a sample and counts new log lines once', async () => {
  const now = Date.parse('2026-10-26T10:05:00Z')
  const queries = []
  const pool = {
    query: async (sql, params) => {
      queries.push([sql.replace(/\s+/g, ' ').trim(), params])
      return {
        rows: sql.includes('project_log_cursors WHERE')
          ? [{ service: 'db', counted_until: '2026-10-26T10:04:00Z' }]
          : [],
      }
    },
  }
  const id = 'a'.repeat(64)
  const requests = []
  const get = async (path) => {
    requests.push(path)
    if (path.startsWith('/containers/json'))
      return Buffer.from(
        JSON.stringify([
          {
            Id: id,
            Labels: {
              'com.docker.compose.project': `sp-${project.id}`,
              'com.docker.compose.service': 'db',
            },
          },
          {
            Id: 'b'.repeat(64),
            Labels: {
              'com.docker.compose.project': `sp-${project.id}`,
              'com.docker.compose.service': 'meta',
            },
          },
        ])
      )
    return Buffer.from('2026-10-26T10:04:30.000000000Z ERROR:  relation "x" does not exist\n')
  }
  const infrastructure = { psql: async () => JSON.stringify(database) }
  await new ProjectObservability(pool, infrastructure, { get, now: () => now }).record(
    project,
    metrics(30, 5)
  )
  assert(queries.some(([sql]) => sql.startsWith('INSERT INTO control.project_metric_samples')))
  const counts = queries.find(([sql]) => sql.startsWith('INSERT INTO control.project_log_counts'))
  assert.deepEqual(counts[1].slice(2), ['db', 0, 0, 1])
  // Only the database's logs, read from where the last count stopped.
  const logRequests = requests.filter((path) => path.includes('/logs?'))
  assert.equal(logRequests.length, 1)
  assert.match(logRequests[0], /since=1793009040\.000/)
  const cursor = queries.find(([sql]) => sql.startsWith('INSERT INTO control.project_log_cursors'))
  assert.deepEqual(cursor[1], [project.id, 'db', new Date(now)])
})
