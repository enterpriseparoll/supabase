import { request } from 'node:http'
import { createHash } from 'node:crypto'
import { HttpError, invariant, unseal } from './core.mjs'
import { projectName } from './templates.mjs'
import { LOG_SERVICES, LOG_LEVELS } from '../public/logs.utils.mjs'

export { LOG_SERVICES, LOG_LEVELS }
const clip = (value, bytes) => Buffer.from(String(value)).subarray(0, bytes).toString('utf8')

export function logsInput(input = {}, now = Date.now()) {
  const minutes = Number(input.minutes ?? 60)
  const limit = Number(input.limit ?? 200)
  const service = input.service ?? 'all'
  const level = input.level ?? 'all'
  const search = input.search ?? ''
  invariant([15, 60, 360, 1440].includes(minutes), 400, 'Select a supported time range')
  invariant(
    Number.isInteger(limit) && limit >= 1 && limit <= 500,
    400,
    'Log limit must be between 1 and 500'
  )
  invariant(
    service === 'all' || Object.hasOwn(LOG_SERVICES, service),
    400,
    'Select a supported log type'
  )
  invariant(level === 'all' || LOG_LEVELS.includes(level), 400, 'Select a supported log level')
  invariant(
    typeof search === 'string' && search.length <= 200,
    400,
    'Search must be 200 characters or fewer'
  )
  const end = input.end ? Date.parse(input.end) : now
  invariant(
    Number.isFinite(end) && end <= now + 60000 && end >= now - 7 * 86400000,
    400,
    'Invalid log end time'
  )
  return { minutes, limit, service, level, search, start: end - minutes * 60000, end }
}

export function redactLog(text, secrets = []) {
  let result = String(text).replace(/\x1b\[[0-9;]*m/g, '')
  for (const secret of secrets)
    if (typeof secret === 'string' && secret.length >= 8)
      result = result.replaceAll(secret, '[REDACTED]')
  return result
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:postgres(?:ql)?|https?):\/\/[^\s/:]+:)[^\s@]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:apikey|api_key|token|access_token|refresh_token|password|code|ticket)=)[^&\s"']+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /("(?:authorization|apikey|api_key|password|secret|access_token|refresh_token|token|cookie|set-cookie)"\s*:\s*")[^"\r\n]*(")/gi,
      '$1[REDACTED]$2'
    )
}

// Docker's non-TTY logs multiplex stdout and stderr in eight-byte frames.
export function decodeDockerLogs(buffer) {
  if (buffer.length < 8 || buffer[0] > 2 || buffer[1] || buffer[2] || buffer[3])
    return buffer.toString('utf8')
  const chunks = []
  for (let offset = 0; offset < buffer.length; ) {
    invariant(offset + 8 <= buffer.length, 502, 'Incomplete log response')
    const length = buffer.readUInt32BE(offset + 4)
    invariant(offset + 8 + length <= buffer.length, 502, 'Incomplete log response')
    chunks.push(buffer.subarray(offset + 8, offset + 8 + length))
    offset += 8 + length
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function parseLogLine(line, service, secrets = []) {
  const match = line.match(/^(\d{4}-\d\d-\d\dT\S+Z)\s+(.*)$/)
  if (!match || !Number.isFinite(Date.parse(match[1]))) return null
  let raw = redactLog(match[2], secrets)
  let fields = {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const scrub = (value, depth = 0) => {
        if (depth > 20) return '[TRUNCATED]'
        if (typeof value === 'string') return redactLog(value, secrets)
        if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1))
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              /password|secret|authorization|cookie|api[_-]?key|(?:access|refresh)[_-]?token|^token$/i.test(
                key
              )
                ? '[REDACTED]'
                : scrub(item, depth + 1),
            ])
          )
        return value
      }
      fields = scrub(parsed)
      raw = JSON.stringify(fields)
    }
  } catch {
    /* Plain service output is valid. */
  }
  const statusValue = Number(fields.status ?? fields.status_code ?? fields.response_code)
  const status =
    Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : null
  const message = String(fields.msg ?? fields.message ?? fields.event_message ?? raw)
  if (!message.trim()) return null
  const severity = String(
    fields.level ??
      fields.severity ??
      fields.severity_text ??
      message.match(/\[(error|critical|warning|warn|debug|trace|info|notice)\]/i)?.[1] ??
      ''
  ).toLowerCase()
  const level =
    status >= 500 ||
    /^(error|critical|fatal|panic|50|60)$/.test(severity) ||
    /(?:^|\s)(?:ERROR|FATAL|PANIC):/i.test(message)
      ? 'error'
      : status >= 400 || /^(warn|warning|40)$/.test(severity) || /\bWARNING\b/.test(message)
        ? 'warning'
        : /^(debug|trace|10|20)$/.test(severity)
          ? 'debug'
          : 'info'
  return {
    id: createHash('sha256').update(`${service}\0${line}`).digest('hex').slice(0, 24),
    timestamp: match[1],
    service,
    source: LOG_SERVICES[service],
    level,
    message: clip(message, 2000),
    method: typeof fields.method === 'string' ? fields.method.slice(0, 16) : null,
    path: typeof fields.path === 'string' ? clip(fields.path.split('?')[0], 1000) : null,
    status,
    details: clip(raw, 3000),
  }
}

export function dockerGet(
  path,
  { socketPath = '/var/run/docker.sock', maxBytes = 1024 * 1024 } = {}
) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET' }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          req.destroy()
          reject(new HttpError(413, 'Too many logs. Select a shorter time range or one log type.'))
        } else chunks.push(chunk)
      })
      res.on('end', () =>
        res.statusCode === 200
          ? resolve(Buffer.concat(chunks))
          : reject(new HttpError(502, 'Could not read project logs'))
      )
      res.on('error', () => reject(new HttpError(502, 'Log connection interrupted')))
    })
    req.setTimeout(8000, () => req.destroy(new Error('timeout')))
    req.on('error', () => reject(new HttpError(502, 'Could not connect to the log service')))
    req.end()
  })
}

export class ProjectLogs {
  constructor(config, { get = dockerGet } = {}) {
    this.config = config
    this.get = get
  }
  async read(project, payload) {
    const input = logsInput(payload)
    const name = projectName(project.id)
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`com.docker.compose.project=${name}`] })
    )
    const seen = new Set()
    const containers = JSON.parse(
      (await this.get(`/containers/json?all=true&filters=${filters}`)).toString()
    )
      .filter(
        (container) =>
          container.Labels?.['com.docker.compose.project'] === name &&
          Object.hasOwn(LOG_SERVICES, container.Labels?.['com.docker.compose.service'])
      )
      .filter(
        (container) =>
          input.service === 'all' ||
          container.Labels['com.docker.compose.service'] === input.service
      )
      .sort((a, b) => b.Created - a.Created)
      .filter((container) => {
        const service = container.Labels['com.docker.compose.service']
        if (seen.has(service)) return false
        seen.add(service)
        return true
      })
    const secrets = Object.values(unseal(project.encrypted_secrets, this.config.key, project.id))
    const entries = [],
      unavailable = []
    let sourceLimited = false
    // Two services at a time keeps repeated live queries bounded on small hosts.
    for (let offset = 0; offset < containers.length; offset += 2) {
      await Promise.all(
        containers.slice(offset, offset + 2).map(async (container) => {
          const service = container.Labels['com.docker.compose.service']
          try {
            invariant(/^[a-f0-9]{64}$/.test(container.Id), 502, 'Invalid log container')
            const query = new URLSearchParams({
              stdout: '1',
              stderr: '1',
              timestamps: '1',
              since: String(Math.floor(input.start / 1000)),
              until: String(Math.ceil(input.end / 1000)),
              tail: '500',
            })
            const text = decodeDockerLogs(
              await this.get(`/containers/${container.Id}/logs?${query}`)
            )
            if (text.trim().split('\n').length >= 500) sourceLimited = true
            for (const line of text.split('\n')) {
              const entry = parseLogLine(line, service, secrets)
              if (
                entry &&
                Date.parse(entry.timestamp) >= input.start &&
                Date.parse(entry.timestamp) <= input.end
              )
                entries.push(entry)
            }
          } catch (error) {
            if (error.status === 413) throw error
            unavailable.push(LOG_SERVICES[service])
          }
        })
      )
    }
    const search = input.search.toLowerCase()
    const filtered = entries
      .filter(
        (entry) =>
          (input.level === 'all' || entry.level === input.level) &&
          (!search ||
            `${entry.message} ${entry.path ?? ''} ${entry.details}`.toLowerCase().includes(search))
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id))
    invariant(
      !containers.length || unavailable.length < containers.length,
      502,
      'Project logs are temporarily unavailable. Try refreshing.'
    )
    return {
      entries: filtered.slice(0, input.limit),
      limited: filtered.length > input.limit || sourceLimited,
      unavailable,
      services: LOG_SERVICES,
      start: new Date(input.start).toISOString(),
      end: new Date(input.end).toISOString(),
    }
  }
}
