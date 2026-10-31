import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeDockerLogs, logsInput, parseLogLine, ProjectLogs, redactLog } from '../src/logs.mjs'
import { seal } from '../src/core.mjs'
import { logHistogram, logsCsv } from '../public/logs.utils.mjs'

const id = 'p0123456789abcdef01234567'
const key = 'ab'.repeat(32)
const secret = 'a-project-password-not-for-logs'
const project = { id, encrypted_secrets: seal({ POSTGRES_PASSWORD: secret }, key, id) }
const frame = (text, stream = 1) => {
  const bytes = Buffer.from(text),
    header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(bytes.length, 4)
  return Buffer.concat([header, bytes])
}

test('log filters reject service injection, unbounded output, and invalid dates', () => {
  for (const input of [
    { service: '../../db' },
    { service: '__proto__' },
    { minutes: 0 },
    { limit: 100000 },
    { level: 'fatal' },
    { end: 'not-a-date' },
    { search: 'a'.repeat(201) },
  ])
    assert.throws(() => logsInput(input))
  const input = logsInput({ minutes: '15', limit: '50', service: 'auth' }, 2000000000000)
  assert.equal(input.end - input.start, 15 * 60000)
  assert.equal(input.limit, 50)
})

test('Docker stdout and stderr frames preserve UTF-8 and reject truncated responses', () => {
  assert.equal(
    decodeDockerLogs(Buffer.concat([frame('hello '), frame('world 🌍', 2)])),
    'hello world 🌍'
  )
  assert.equal(decodeDockerLogs(Buffer.from('plain TTY output')), 'plain TTY output')
  assert.throws(() => decodeDockerLogs(frame('long message').subarray(0, 10)), /Incomplete/)
})

test('logs redact known secrets, bearer headers, passwords, cookies, and query credentials', () => {
  const text = `${secret} Bearer jwt.token.value postgresql://postgres:private@db/postgres?apikey=key&code=oauth "password":"private" "cookie":"session=abc"`
  const redacted = redactLog(text, [secret])
  for (const value of [secret, 'jwt.token.value', ':private@', '=key', '=oauth', 'session=abc'])
    assert(!redacted.includes(value))
  assert(redacted.includes('[REDACTED]'))
})

test('structured status overrides info severity and event details remain bounded', () => {
  const entry = parseLogLine(
    `2026-10-25T12:00:00.000000001Z {"level":"info","status":500,"method":"POST","path":"/auth/v1?token=secret","msg":"${secret}"}`,
    'auth',
    [secret]
  )
  assert.equal(entry.level, 'error')
  assert.equal(entry.path, '/auth/v1')
  assert.equal(entry.message, '[REDACTED]')
  assert(!entry.details.includes(secret))
  const nested = parseLogLine(
    '2026-10-25T12:00:00Z {"headers":{"cookie":["private-session"],"apiKey":"private-key"},"message":"ok"}',
    'auth'
  )
  assert(!nested.details.includes('private-session'))
  assert(!nested.details.includes('private-key'))
  assert.equal(
    parseLogLine('2026-10-25T12:00:00Z WARNING: disk nearly full', 'db').level,
    'warning'
  )
  assert.equal(
    parseLogLine('2026-10-25T12:00:00Z 12:00:00 [error] connection closed', 'realtime').level,
    'error'
  )
  assert.equal(parseLogLine('2026-10-25T12:00:00Z   ', 'db'), null)
  assert.equal(parseLogLine('no timestamp', 'db'), null)
  const large = parseLogLine(`2026-10-25T12:00:00Z ${'🌍'.repeat(5000)}`, 'db')
  assert(Buffer.byteLength(large.message) < 2010)
  assert(Buffer.byteLength(large.details) < 3010)
})

test('project log reads cannot select another project or unsupported container', async () => {
  const timestamp = new Date(Date.now() - 1000).toISOString()
  const own = 'a'.repeat(64),
    other = 'b'.repeat(64),
    forbidden = 'c'.repeat(64)
  const container = (Id, projectName, service) => ({
    Id,
    Labels: { 'com.docker.compose.project': projectName, 'com.docker.compose.service': service },
  })
  const paths = []
  const logs = new ProjectLogs(
    { key },
    {
      get: async (path) => {
        paths.push(path)
        if (path.startsWith('/containers/json'))
          return Buffer.from(
            JSON.stringify([
              container(own, `sp-${id}`, 'db'),
              container(other, 'sp-other', 'db'),
              container(forbidden, `sp-${id}`, 'worker'),
            ])
          )
        assert(path.startsWith(`/containers/${own}/logs?`))
        return frame(`${timestamp} ERROR: ${secret}\n${timestamp} normal message\n`, 2)
      },
    }
  )
  const result = await logs.read(project, { level: 'error', search: 'redacted', limit: 1 })
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].source, 'Postgres')
  assert(!JSON.stringify(result).includes(secret))
  assert.equal(paths.length, 2)
  assert(decodeURIComponent(paths[0]).includes(`com.docker.compose.project=sp-${id}`))
  await assert.rejects(logs.read({ ...project, id: '../other' }, {}), /Invalid project ID/)
})

test('partial service failures stay visible while total failures are reported', async () => {
  const own = (service, char) => ({
    Id: char.repeat(64),
    Labels: { 'com.docker.compose.project': `sp-${id}`, 'com.docker.compose.service': service },
  })
  const reader = (allFail) =>
    new ProjectLogs(
      { key },
      {
        get: async (path) => {
          if (path.startsWith('/containers/json'))
            return Buffer.from(JSON.stringify([own('db', 'a'), own('auth', 'b')]))
          if (allFail || path.includes('b'.repeat(64))) throw new Error('not available')
          return frame(`${new Date(Date.now() - 1000).toISOString()} database ready\n`)
        },
      }
    )
  const partial = await reader(false).read(project, {})
  assert.equal(partial.entries.length, 1)
  assert.deepEqual(partial.unavailable, ['Auth'])
  await assert.rejects(reader(true).read(project, {}), /temporarily unavailable/)
})

test('histograms include both interval boundaries and ignore out-of-range samples', () => {
  const start = '2026-10-25T12:00:00Z',
    end = '2026-10-25T13:00:00Z'
  assert.deepEqual(
    logHistogram(
      [{ timestamp: start }, { timestamp: end }, { timestamp: '2026-10-25T14:00:00Z' }],
      start,
      end,
      2
    ),
    [1, 1]
  )
})

test('CSV exports escape quotes and neutralize spreadsheet formulas', () => {
  const csv = logsCsv([
    { message: '=HYPERLINK("https://example.com")', source: 'Auth', status: 200 },
  ])
  assert(csv.includes('"\'=HYPERLINK(""https://example.com"")"'))
  assert(csv.startsWith('"timestamp","source","level"'))
})
