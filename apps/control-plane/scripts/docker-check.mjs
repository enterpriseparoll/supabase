import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { generateSecrets } from '../src/core.mjs'
import { projectEnvironment, publicGateway, renderCompose, renderEnv } from '../src/templates.mjs'
import { command } from '../src/process.mjs'

const directory = resolve('.test-data', 'rendered')
await mkdir(directory, { recursive: true })
const project = {
  id: 'p0123456789abcdef01234567',
  name: "Test's ${PRIVATE_ENV}",
  site_url: 'https://app.example.com',
  memory_mb: 4096,
  cpus: 2,
  release: 'test',
}
const secrets = generateSecrets()
const config = { baseDomain: 'platform.example.com' }
const templateRoot = new URL('../../../docker/', import.meta.url)
await writeFile(
  `${directory}/docker-compose.yml`,
  renderCompose(await readFile(new URL('docker-compose.yml', templateRoot), 'utf8'), project)
)
await writeFile(
  `${directory}/.env`,
  renderEnv(
    await readFile(new URL('.env.example', templateRoot), 'utf8'),
    projectEnvironment(project, secrets, config)
  ),
  { mode: 0o600 }
)
await command('docker', [
  'compose',
  '--project-directory',
  directory,
  '--file',
  `${directory}/docker-compose.yml`,
  'config',
  '--quiet',
])
const resolved = JSON.parse(
  await command('docker', [
    'compose',
    '--project-directory',
    directory,
    '--file',
    `${directory}/docker-compose.yml`,
    'config',
    '--format',
    'json',
  ])
)
// Compose escapes dollar signs in its reusable config output. Verify the actual
// container environment as well so config formatting cannot mask interpolation.
if (
  resolved.services.studio.environment.DEFAULT_PROJECT_NAME.replaceAll('$$', '$') !== project.name
)
  throw new Error('Environment literal changed during Compose interpolation')
if (resolved.services.auth.environment.GOTRUE_JWT_KEYS !== secrets.JWT_KEYS)
  throw new Error('Signing keys changed during Compose interpolation')
await writeFile(
  `${directory}/env-check.yml`,
  JSON.stringify({
    services: {
      check: {
        image: 'node:22.14.0-alpine3.21',
        network_mode: 'none',
        environment: { NAME: '${STUDIO_DEFAULT_PROJECT}' },
        command: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env.NAME))'],
      },
    },
  })
)
const actual = await command('docker', [
  'compose',
  '--project-directory',
  directory,
  '--file',
  `${directory}/env-check.yml`,
  'run',
  '--rm',
  '--no-deps',
  'check',
])
if (JSON.parse(actual.trim()) !== project.name)
  throw new Error('Environment value changed inside the container')
await command(
  'docker',
  ['compose', '--file', resolve('../../deploy/platform/compose.yml'), 'config', '--quiet'],
  {
    env: {
      ...process.env,
      PLATFORM_DOMAIN: config.baseDomain,
      OIDC_ISSUER: 'https://identity.example.com',
      OIDC_CLIENT_ID: 'test',
      OIDC_REQUIRED_ACR: 'mfa',
      ACME_EMAIL: 'test@example.com',
      PLATFORM_DATA_ROOT: directory,
    },
  }
)

const gatewayDir = `${directory}/envoy`
await mkdir(gatewayDir, { recursive: true })
for (const name of ['envoy.yaml', 'cds.yaml'])
  await writeFile(
    `${gatewayDir}/${name}`,
    await readFile(new URL(`volumes/api/envoy/${name}`, templateRoot))
  )
let gateway = publicGateway(
  await readFile(new URL('volumes/api/envoy/lds.template.yaml', templateRoot), 'utf8')
)
const values = {
  ...secrets,
  SUPABASE_PUBLIC_URL: `https://${project.id}.api.${config.baseDomain}`,
  DASHBOARD_BASIC_AUTH: `platform:{SHA}${createHash('sha1').update(secrets.DASHBOARD_PASSWORD).digest('base64')}`,
}
for (const [name, value] of Object.entries(values))
  gateway = gateway.replaceAll(`\${${name}}`, value)
await writeFile(`${gatewayDir}/lds.yaml`, gateway, { mode: 0o600 })
console.log(
  'Generated project and platform Compose configuration validated; literal values and signing keys preserved.'
)
if (process.env.CHECK_ENVOY === 'true') {
  await command('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'envoy',
    '--mount',
    `type=bind,source=${gatewayDir},target=/etc/envoy,readonly`,
    'envoyproxy/envoy:v1.39.1',
    '--mode',
    'validate',
    '-c',
    '/etc/envoy/envoy.yaml',
  ])
  console.log('Public gateway validated by Envoy.')
}
