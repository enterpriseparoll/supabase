// How the worker turns a container check into a project status. A busy host can make
// health checks time out for a minute or two (Docker reports "unhealthy" while the
// service is fine), so a project only counts as failing once a service has stayed
// unhealthy past the grace period, or has stopped outright.
export const UNHEALTHY_GRACE_MS = 3 * 60000

const failing = (container) => container.state !== 'running' || container.health === 'unhealthy'

export function projectHealth(metrics, previous = {}, now = Date.now()) {
  const containers = Array.isArray(metrics?.containers) ? metrics.containers : []
  const unhealthyServices = containers
    .filter(failing)
    .map((container) => container.service)
    .sort()
  if (metrics?.healthy && !unhealthyServices.length)
    return { status: 'ready', serving: true, metrics: { ...metrics, unhealthyServices: [] } }
  const stopped =
    !containers.length || containers.some((c) => !['running', 'restarting'].includes(c.state))
  const since = Number.isFinite(Date.parse(previous?.unhealthySince))
    ? previous.unhealthySince
    : new Date(now).toISOString()
  const expired = now - Date.parse(since) >= UNHEALTHY_GRACE_MS
  return {
    status: stopped || expired ? 'error' : 'ready',
    // Keep Studio and the API reachable during the grace period.
    serving: !stopped && !expired,
    metrics: { ...metrics, unhealthySince: since, unhealthyServices },
  }
}
