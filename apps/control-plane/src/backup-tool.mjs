import { readFile } from 'node:fs/promises'
import { command } from './process.mjs'

if (process.env.AWS_SECRET_ACCESS_KEY_FILE)
  process.env.AWS_SECRET_ACCESS_KEY = (
    await readFile(process.env.AWS_SECRET_ACCESS_KEY_FILE, 'utf8')
  ).trim()
if (!process.env.RESTIC_REPOSITORY || !process.env.RESTIC_PASSWORD_FILE)
  throw new Error('Configure the restic repository and password file')
// This CLI is available only to host administrators, not through the public API.
const output = await command('restic', process.argv.slice(2), { timeout: 3600000 })
process.stdout.write(output)
