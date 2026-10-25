import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { command } from '../../apps/control-plane/src/process.mjs'

const require = createRequire(new URL('../../apps/control-plane/package.json', import.meta.url))
const { parse, stringify } = require('yaml')

// Local administrator tool. This never accepts files or release manifests over HTTP.
const [release, source, compatibleFrom, rollbackFlag] = process.argv.slice(2)
if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(release ?? '') || !source || !compatibleFrom) throw new Error('Usage: node stage-release.mjs <release> <reviewed-docker-directory> <compatible-from,comma-separated> [--rollback-compatible]')
const directory = resolve(process.env.PLATFORM_DATA_ROOT ?? '/srv/supabase-platform', 'releases', release)
await mkdir(directory, { recursive: false, mode: 0o700 })
const parsed = parse(await readFile(resolve(source, 'docker-compose.yml'), 'utf8'))
for (const service of Object.values(parsed.services)) {
  if (service.image.includes('@sha256:')) continue
  let digests
  try { digests = JSON.parse(await command('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', service.image])) } catch {
    await command('docker', ['pull', service.image])
    digests = JSON.parse(await command('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', service.image]))
  }
  if (!digests?.length) throw new Error('Every release image must have a registry digest')
  service.image = digests[0]
}
const compose = stringify(parsed)
const gateway = await readFile(resolve(source, 'volumes/api/envoy/lds.template.yaml'), 'utf8')
const digest = (value) => createHash('sha256').update(value).digest('hex')
await writeFile(`${directory}/docker-compose.yml`, compose, { flag: 'wx', mode: 0o600 })
await writeFile(`${directory}/lds.template.yaml`, gateway, { flag: 'wx', mode: 0o600 })
await writeFile(`${directory}/manifest.json`, JSON.stringify({ version: 1, release, composeHash: digest(compose), gatewayHash: digest(gateway), compatibleFrom: compatibleFrom.split(','), rollbackCompatible: rollbackFlag === '--rollback-compatible' }, null, 2), { flag: 'wx', mode: 0o600 })
console.log(`Staged ${release}. Only gateway and Compose changes are supported; init SQL, key format, and database image changes require a separate migration.`)
