import type { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getAuthConfigStore } from '@/lib/api/self-hosted/auth-config'
import { AuthConfigError } from '@/lib/api/self-hosted/auth-config/fields'
import { rejectMethod } from '@/lib/api/self-hosted/auth-config/handlers'

// The Auth server fetches customized email bodies from here when it sends an email.
export default function handlerWithErrorCatching(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler, { withAuth: true })
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return rejectMethod(req, res, ['GET'])
  try {
    const content = await getAuthConfigStore().templateContent(String(req.query.template ?? ''))
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).send(content)
  } catch (error) {
    if (error instanceof AuthConfigError)
      return res.status(error.status).json({ message: error.message })
    throw error
  }
}
