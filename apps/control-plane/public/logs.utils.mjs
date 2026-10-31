export const LOG_SERVICES = {
  'api-gw': 'API Gateway',
  db: 'Postgres',
  rest: 'PostgREST',
  auth: 'Auth',
  storage: 'Storage',
  functions: 'Edge Functions',
  realtime: 'Realtime',
  supavisor: 'Pooler',
}
export const LOG_LEVELS = ['debug', 'info', 'warning', 'error']

export function logHistogram(entries, start, end, buckets = 24) {
  const counts = Array(buckets).fill(0)
  const from = Date.parse(start),
    to = Date.parse(end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return counts
  for (const entry of entries) {
    const time = Date.parse(entry.timestamp)
    if (time < from || time > to || !Number.isFinite(time)) continue
    counts[Math.min(buckets - 1, Math.floor(((time - from) / (to - from)) * buckets))]++
  }
  return counts
}

export function logsCsv(entries) {
  const cell = (value) => {
    const text = String(value ?? '')
    // Prevent spreadsheet formulas from executing when downloaded logs are opened.
    const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(text) ? `'${text}` : text
    return `"${safe.replaceAll('"', '""')}"`
  }
  const fields = ['timestamp', 'source', 'level', 'method', 'path', 'status', 'message']
  return [
    fields.map(cell).join(','),
    ...entries.map((entry) => fields.map((field) => cell(entry[field])).join(',')),
  ].join('\r\n')
}
