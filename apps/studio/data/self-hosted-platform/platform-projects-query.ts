import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { selfHostedPlatformKeys } from './keys'
import { IS_PLATFORM } from '@/lib/constants'

export type SelfHostedPlatformProjectsVariables = { dashboardUrl?: string }
export type SelfHostedPlatformProjectsError = Error

const platformProjectsSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
})

async function getSelfHostedPlatformProjects(
  { dashboardUrl }: SelfHostedPlatformProjectsVariables,
  signal?: AbortSignal
) {
  if (!dashboardUrl) throw new Error('dashboardUrl is required')
  // The platform serves this list on each Studio's own origin, authenticated by the
  // Studio session cookie. It is a separate service from the Supabase platform API,
  // so it is not reachable through data/fetchers.
  const response = await fetch('/_platform/api/projects', { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`Failed to load projects (${response.status})`)
  return platformProjectsSchema.parse(await response.json()).projects
}

export type SelfHostedPlatformProjectsData = Awaited<
  ReturnType<typeof getSelfHostedPlatformProjects>
>

export const selfHostedPlatformProjectsQueryOptions = ({
  dashboardUrl,
}: SelfHostedPlatformProjectsVariables) =>
  queryOptions({
    queryKey: selfHostedPlatformKeys.projects(dashboardUrl),
    queryFn: ({ signal }) => getSelfHostedPlatformProjects({ dashboardUrl }, signal),
    enabled: !IS_PLATFORM && typeof dashboardUrl !== 'undefined',
    staleTime: 30_000,
  })
