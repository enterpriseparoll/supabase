import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { storageCredentialsKeys } from './s3-access-key-keys'
import { get, handleError } from '@/data/fetchers'
import type { ResponseError } from '@/types'

export type SelfHostedS3CredentialsVariables = { projectRef?: string }
export type SelfHostedS3CredentialsError = ResponseError
const schema = z.object({
  data: z.array(z.object({ access_key: z.string(), secret_key: z.string() })),
})

async function getCredentials(
  { projectRef }: SelfHostedS3CredentialsVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('projectRef is required')
  const { data, error } = await get('/platform/storage/{ref}/credentials', {
    params: { path: { ref: projectRef } },
    signal,
  })
  if (error) handleError(error)
  return schema.parse(data).data[0] ?? null
}
export type SelfHostedS3CredentialsData = Awaited<ReturnType<typeof getCredentials>>

export const selfHostedS3CredentialsQueryOptions = ({
  projectRef,
}: SelfHostedS3CredentialsVariables) =>
  queryOptions({
    queryKey: [...storageCredentialsKeys.credentials(projectRef), 'host-managed'],
    queryFn: ({ signal }) => getCredentials({ projectRef }, signal),
    enabled: false,
    gcTime: 0,
    retry: false,
    // Credentials are fetched only when the user explicitly requests them.
    refetchOnWindowFocus: false,
  })
