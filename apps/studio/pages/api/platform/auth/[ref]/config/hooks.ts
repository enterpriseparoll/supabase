import type { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getAuthConfigStore } from '@/lib/api/self-hosted/auth-config'
import { rejectMethod, respondWithAuthConfig } from '@/lib/api/self-hosted/auth-config/handlers'

// Auth Hooks are Auth settings too (HOOK_*), saved the same way.
export default function handlerWithErrorCatching(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler, { withAuth: true })
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') return rejectMethod(req, res, ['PATCH'])
  return respondWithAuthConfig(res, () => getAuthConfigStore().update(req.body))
}
