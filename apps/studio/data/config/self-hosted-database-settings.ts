import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import createClient from 'openapi-fetch'
import { toast } from 'sonner'
import { z } from 'zod'

import { configKeys } from './keys'
import { fetchHandler, handleError } from '@/data/fetchers'

const schema = z.object({
  projectId: z.string(),
  poolSize: z.number(),
  maxClientConnections: z.number(),
  maxDatabaseConnections: z.number(),
  logConnections: z.boolean(),
  logDisconnections: z.boolean(),
  enforceSsl: z.boolean(),
  tlsConfigured: z.boolean(),
  certificate: z.string().nullable(),
  allowedCidrs: z.array(z.string()),
  networkBans: z.object({
    available: z.boolean(),
    items: z.array(
      z.object({ address: z.string(), expiresAt: z.union([z.string(), z.number()]).optional() })
    ),
  }),
  managementUrl: z.string(),
  disk: z.object({
    projectBytes: z.number().optional(),
    hostAvailableBytes: z.number().optional(),
  }),
  localOnly: z.boolean(),
  databasePort: z.number().nullable(),
})
export type SelfHostedDatabaseSettingsData = z.infer<typeof schema>
export type SelfHostedDatabaseSettingsPatch = Partial<
  Pick<
    SelfHostedDatabaseSettingsData,
    | 'poolSize'
    | 'maxClientConnections'
    | 'logConnections'
    | 'logDisconnections'
    | 'enforceSsl'
    | 'allowedCidrs'
  >
> & { configureTls?: boolean }
type Json<T> = { content: { 'application/json': T } }
type Result<T> = { responses: { 200: Json<T>; 202: Json<T>; default: Json<{ error: string }> } }
type Body<T> = { requestBody: { content: { 'application/json': T } } }
type Operation = { id: string; state: string; error_code?: string | null }
type Paths = {
  '/_platform/api/database-settings': {
    get: Result<SelfHostedDatabaseSettingsData>
    patch: Result<SelfHostedDatabaseSettingsData> & Body<SelfHostedDatabaseSettingsPatch>
  }
  '/_platform/api/database-settings/bans': {
    delete: Result<SelfHostedDatabaseSettingsData> & Body<{ addresses: string[] }>
  }
  '/_platform/api/database-settings/password': {
    post: Result<Operation> & Body<{ password: string }>
  }
  '/_platform/api/database-settings/operations/{operationId}': {
    get: Result<Operation> & { parameters: { path: { operationId: string } } }
  }
}
// These endpoints belong to the local project host, not the hosted Management API.
const client = createClient<Paths>({ baseUrl: '', credentials: 'same-origin', fetch: fetchHandler })
const fail = (error: { error: string }) => handleError({ message: error.error })

export const selfHostedDatabaseSettingsQueryOptions = ({ projectRef }: { projectRef?: string }) =>
  queryOptions({
    queryKey: configKeys.selfHostedDatabase(projectRef),
    queryFn: async ({ signal }) => {
      const { data, error } = await client.GET('/_platform/api/database-settings', { signal })
      if (error) fail(error)
      return schema.parse(data)
    },
    enabled: !!projectRef,
    retry: false,
  })

export const useSelfHostedDatabaseSettingsMutation = (projectRef?: string) => {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: async (body: SelfHostedDatabaseSettingsPatch) => {
      const { data, error } = await client.PATCH('/_platform/api/database-settings', { body })
      if (error) fail(error)
      return schema.parse(data)
    },
    onSuccess: (data) => {
      cache.setQueryData(configKeys.selfHostedDatabase(projectRef), data)
      toast.success('Database settings saved')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}
export const useSelfHostedClearBansMutation = (projectRef?: string) => {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: async (addresses: string[]) => {
      const { data, error } = await client.DELETE('/_platform/api/database-settings/bans', {
        body: { addresses },
      })
      if (error) fail(error)
      return schema.parse(data)
    },
    onSuccess: (data) => {
      cache.setQueryData(configKeys.selfHostedDatabase(projectRef), data)
      toast.success('Network bans cleared')
    },
    onError: (error: Error) => toast.error(error.message),
  })
}
export const useSelfHostedPasswordResetMutation = () =>
  useMutation({
    mutationFn: async (password: string) => {
      const { data, error } = await client.POST('/_platform/api/database-settings/password', {
        body: { password },
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      if (error) fail(error)
      if (!data) throw new Error('Password reset did not return an operation')
      const deadline = Date.now() + 10 * 60 * 1000
      while (Date.now() < deadline) {
        const status = await client.GET(
          '/_platform/api/database-settings/operations/{operationId}',
          { params: { path: { operationId: data.id } } }
        )
        if (status.error) fail(status.error)
        if (status.data?.state === 'succeeded') return
        if (status.data?.state === 'failed')
          throw new Error(
            'Password reset failed. Check the project operation in the infrastructure dashboard.'
          )
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      throw new Error(
        'Password reset is still running. Check the project operation in the infrastructure dashboard.'
      )
    },
    onSuccess: () => toast.success('Database password reset'),
    onError: (error: Error) => toast.error(error.message),
  })
