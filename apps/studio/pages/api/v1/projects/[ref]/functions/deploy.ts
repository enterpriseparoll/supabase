import { Readable } from 'node:stream'
import { type NextApiRequest, type NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { handleDeployRequest } from '@/lib/api/self-hosted/functions/handlers'

// Multipart uploads are read as a stream, not parsed by Next.
export const config = { api: { bodyParser: false } }

export default function handlerWithErrorCatching(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler, { withAuth: true })
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const headers = new Headers()
  for (const name of ['content-type', 'content-length']) {
    const value = req.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  const request = new Request(`http://localhost${req.url ?? ''}`, {
    method: 'POST',
    headers,
    body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    duplex: 'half',
  } as RequestInit)
  const response = await handleDeployRequest(request)
  return res.status(response.status).json(await response.json())
}
