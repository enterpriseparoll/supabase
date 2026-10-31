import { command } from '../src/process.mjs'
const id = 'p0123456789abcdef01234567'
// Isolated network namespace only. Do not use --network=host for this test.
await command('iptables', ['-N', 'DOCKER-USER'])
const subnets = ['172.28.1.0/24', '172.28.2.0/24', '172.28.3.0/24']
await command('node', ['src/firewall.mjs', id, ...subnets])
await command('node', ['src/firewall.mjs', id, ...subnets])
const chain = await command('iptables', ['-S', `SP-${id}`])
for (const subnet of subnets) {
  if (!chain.includes(`-d ${subnet} -j RETURN`))
    throw new Error('Own-project traffic is not allowed')
}
for (const subnet of ['10.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']) {
  if (!chain.includes(`-d ${subnet} -j REJECT`))
    throw new Error('Private destination is not blocked')
}
const input = await command('iptables', ['-S', 'INPUT'])
if (input.split('\n').filter((line) => line.includes(id)).length)
  throw new Error('Unexpected INPUT rule shape')
for (const subnet of subnets)
  if (!input.includes(`-s ${subnet} -j REJECT`)) throw new Error('Host INPUT is not blocked')
const forwarding = await command('iptables', ['-S', 'DOCKER-USER'])
if (forwarding.split('\n').filter((line) => line.includes(`-j SP-${id}`)).length !== 3)
  throw new Error('Firewall reconciliation duplicated source rules')
console.log(
  'Firewall helper applied and reconciled private, metadata, and host-access denial in an isolated network namespace.'
)
