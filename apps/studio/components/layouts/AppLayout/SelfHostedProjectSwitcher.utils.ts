// Studios provisioned by the self-hosted project platform are served from
// `<project-id>.studio.<base-domain>`, and the platform dashboard from
// `manage.<base-domain>` on the same scheme and port.
const PLATFORM_STUDIO_HOST = /^(p[a-f0-9]{24})\.studio\.(.+)$/

export type SelfHostedPlatformContext = {
  projectId: string
  dashboardUrl: string
}

export function getSelfHostedPlatformContext(
  location: Pick<Location, 'protocol' | 'hostname' | 'port'>
): SelfHostedPlatformContext | undefined {
  const match = location.hostname.match(PLATFORM_STUDIO_HOST)
  if (!match) return undefined
  const [, projectId, baseDomain] = match
  const port = location.port ? `:${location.port}` : ''
  return { projectId, dashboardUrl: `${location.protocol}//manage.${baseDomain}${port}` }
}

export const getOpenProjectUrl = (dashboardUrl: string, projectId: string) =>
  `${dashboardUrl}/open/${projectId}`

export const getNewProjectUrl = (dashboardUrl: string) => `${dashboardUrl}/#new`
