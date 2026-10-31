import { getFunctionsManager } from './index'
import { FunctionsManagementError, readDeployForm } from './manage'
import { uuidv4 } from '@/lib/helpers'

const MAX_DEPLOY_BYTES = 12 * 1024 * 1024

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export const errorResponse = (error: unknown) =>
  error instanceof FunctionsManagementError
    ? json(error.status, { message: error.message, error: { message: error.message } })
    : json(500, { message: 'Request failed', error: { message: 'Request failed' } })

/**
 * POST /v1/projects/{ref}/functions/deploy?slug=… for self-hosted projects. Shared by
 * the pages-router and TanStack routes; both hand over a Web `Request`.
 */
export async function handleDeployRequest(request: Request): Promise<Response> {
  try {
    const slug = new URL(request.url).searchParams.get('slug')
    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > MAX_DEPLOY_BYTES)
      throw new FunctionsManagementError('The upload is larger than 12 MB', 413)
    if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data'))
      throw new FunctionsManagementError('Send the function as multipart/form-data', 415)
    const { metadata, files } = await readDeployForm(await request.formData())
    const deployed = await getFunctionsManager().deploy(slug ?? '', metadata, files)
    return json(201, {
      id: uuidv4(),
      slug: deployed.slug,
      name: metadata.name ?? deployed.slug,
      version: 1,
      status: 'ACTIVE',
      entrypoint_path: deployed.entrypoint_path,
      verify_jwt: metadata.verify_jwt,
      created_at: deployed.created_at,
      updated_at: deployed.updated_at,
      warnings: deployed.warnings,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
