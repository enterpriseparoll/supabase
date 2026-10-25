import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Infrastructure } from '../src/infrastructure.mjs'
import { command } from '../src/process.mjs'

// Run inside the platform image with access only to a disposable test database
// container. The restic repository is local to this disposable test runner.
const container = process.env.BACKUP_TEST_CONTAINER
if (!container || !/^platform-control-test-[a-z0-9-]+$/.test(container))
  throw new Error('Select a disposable platform-control-test-* container')
const database = 'backup_recovery_test'
const user = process.env.BACKUP_TEST_USER ?? 'supabase_admin'
if (!['postgres', 'supabase_admin'].includes(user)) throw new Error('Invalid test database user')
const sql = (query) =>
  command('docker', [
    'exec',
    container,
    'psql',
    '-U',
    user,
    '-d',
    database,
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    query,
  ])
await command('docker', [
  'exec',
  container,
  'psql',
  '-U',
  user,
  '-d',
  'postgres',
  '-v',
  'ON_ERROR_STOP=1',
  '-c',
  `CREATE DATABASE ${database} OWNER ${user}`,
])
await sql(
  "CREATE TABLE public.recovery_probe(value text NOT NULL); INSERT INTO public.recovery_probe VALUES('before-backup')"
)
const root = '/tmp/platform-backup-test'
const project = { id: 'p0123456789abcdef01234567', release: 'test', desired_state: 'stopped' }
const records = []
const db = {
  async query(query, values) {
    if (query.startsWith('INSERT INTO control.backups')) {
      records.push({
        id: values[0],
        project_id: values[1],
        snapshot: values[2],
        source_path: values[3],
        release: values[4],
      })
      return { rows: [] }
    }
    if (query.startsWith('SELECT * FROM control.backups'))
      return {
        rows: records.filter(
          (record) => record.id === values[0] && record.project_id === values[1]
        ),
      }
    throw new Error('Unexpected test query')
  },
}
class TestInfrastructure extends Infrastructure {
  async stop() {}
  async up() {}
  async compose(project, args, options) {
    if (args[0] === 'up' || args[0] === 'stop') return ''
    if (args[0] === 'cp')
      return command('docker', ['cp', args[1], `${container}:${args[2].slice(3)}`], options)
    if (args[0] !== 'exec') throw new Error('Unexpected test operation')
    const executable = args
      .slice(3)
      .map((value, index, values) =>
        values[index - 1] === '-U' ? user : values[index - 1] === '-d' ? database : value
      )
    return command('docker', ['exec', '-i', container, ...executable], options)
  }
}
const infrastructure = new TestInfrastructure({ dataRoot: root }, db)
const directory = infrastructure.directory(project.id)
await mkdir(`${directory}/volumes/storage`, { recursive: true })
await writeFile(`${directory}/volumes/storage/probe.txt`, 'before-backup')
await writeFile(`${directory}/.env`, 'TEST_ONLY=1\n', { mode: 0o600 })
await writeFile('/tmp/restic-test-password', 'local-test-encryption-password', { mode: 0o600 })
process.env.RESTIC_REPOSITORY = '/tmp/platform-restic-test'
process.env.RESTIC_PASSWORD_FILE = '/tmp/restic-test-password'
await command('restic', ['init'])
await infrastructure.backup(project)
if (records.length !== 1) throw new Error('Backup record missing')
const backup = records[0]
await sql("UPDATE public.recovery_probe SET value='after-backup'")
await writeFile(`${directory}/volumes/storage/probe.txt`, 'after-backup')
await infrastructure.restore(project, backup.id)
if ((await sql('SELECT value FROM public.recovery_probe')).trim() !== 'before-backup')
  throw new Error('Database recovery failed')
if ((await readFile(`${directory}/volumes/storage/probe.txt`, 'utf8')) !== 'before-backup')
  throw new Error('Storage recovery failed')
if (records.length !== 2) throw new Error('Pre-restore safety backup missing')
await command('restic', ['check', '--read-data'])
await command('docker', [
  'exec',
  container,
  'psql',
  '-U',
  user,
  '-d',
  'postgres',
  '-c',
  `DROP DATABASE ${database}`,
])
console.log(
  'Encrypted restic backup, database restore, Storage restore, safety backup, and repository integrity checks passed.'
)
