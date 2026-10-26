import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectHealth, UNHEALTHY_GRACE_MS } from '../src/health.mjs'

const now = Date.parse('2026-10-26T10:00:00Z')
const metrics = (containers) => ({
  containers,
  healthy: containers.every((c) => c.state === 'running' && (!c.health || c.health === 'healthy')),
})
const ok = { service: 'db', state: 'running', health: 'healthy' }
const slow = { service: 'realtime', state: 'running', health: 'unhealthy' }

test('a healthy project is ready and clears earlier trouble', () => {
  const health = projectHealth(metrics([ok]), { unhealthySince: '2026-10-26T09:00:00Z' }, now)
  assert.equal(health.status, 'ready')
  assert.equal(health.serving, true)
  assert.deepEqual(health.metrics.unhealthyServices, [])
  assert.equal(health.metrics.unhealthySince, undefined)
})

test('a briefly unhealthy service keeps the project running and reachable', () => {
  const first = projectHealth(metrics([ok, slow]), {}, now)
  assert.equal(first.status, 'ready')
  assert.equal(first.serving, true)
  assert.deepEqual(first.metrics.unhealthyServices, ['realtime'])
  const later = projectHealth(metrics([ok, slow]), first.metrics, now + 60000)
  assert.equal(later.metrics.unhealthySince, first.metrics.unhealthySince)
  assert.equal(later.status, 'ready')
})

test('a service unhealthy past the grace period is an error', () => {
  const since = new Date(now - UNHEALTHY_GRACE_MS).toISOString()
  const health = projectHealth(metrics([ok, slow]), { unhealthySince: since }, now)
  assert.equal(health.status, 'error')
  assert.equal(health.serving, false)
})

test('a stopped service is an error at once', () => {
  const health = projectHealth(metrics([ok, { service: 'auth', state: 'exited' }]), {}, now)
  assert.equal(health.status, 'error')
  assert.deepEqual(health.metrics.unhealthyServices, ['auth'])
  assert.equal(projectHealth({ containers: [], healthy: false }, {}, now).status, 'error')
})
