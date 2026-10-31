import { command } from './process.mjs'
import { invariant, projectId } from './core.mjs'

const id = projectId(process.argv[2])
const subnets = process.argv.slice(3)
invariant(
  subnets.length === 3 &&
    subnets.every((value) => /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(value)),
  500,
  'Expected three IPv4 Docker subnets'
)
const chain = `SP-${id}`
const iptables = (args) => command('iptables', ['--wait', '10', ...args])
const exists = async (args) => {
  try {
    await iptables(args)
    return true
  } catch {
    return false
  }
}
// Fail closed on unsupported Docker firewall backends. Never flush host rules.
await iptables(['-S', 'DOCKER-USER'])
if (!(await exists(['-S', chain]))) await iptables(['-N', chain])
async function rule(parent, args, insert = false) {
  if (!(await exists(['-C', parent, ...args])))
    await iptables([insert ? '-I' : '-A', parent, ...args])
}
// Keep this project's own service traffic, then deny all private, metadata, and
// special-use destinations on egress. Public internet access remains available.
for (const subnet of subnets) await rule(chain, ['-d', subnet, '-j', 'RETURN'])
for (const destination of [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
])
  await rule(chain, ['-d', destination, '-j', 'REJECT'])
await rule(chain, ['-j', 'RETURN'])
for (const subnet of subnets) {
  await rule('DOCKER-USER', ['-s', subnet, '-j', chain], true)
  await rule('INPUT', ['-s', subnet, '-j', 'REJECT'], true)
}
