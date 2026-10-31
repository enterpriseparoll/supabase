import type { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getAuthConfigStore } from '@/lib/api/self-hosted/auth-config'
import { rejectMethod, respondWithAuthConfig } from '@/lib/api/self-hosted/auth-config/handlers'

// Auth settings for self-hosted projects (see lib/api/self-hosted/auth-config/store.ts).
export default function handlerWithErrorCatching(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler, { withAuth: true })
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const store = getAuthConfigStore()
  switch (req.method) {
    case 'GET':
      return respondWithAuthConfig(res, () => store.read())
    case 'PATCH':
      return respondWithAuthConfig(res, () => store.update(req.body))
    default:
      return rejectMethod(req, res, ['GET', 'PATCH'])
  }
}
