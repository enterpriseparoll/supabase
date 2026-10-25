import type { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getAuthConfigStore } from '@/lib/api/self-hosted/auth-config'
import { rejectMethod, respondWithAuthConfig } from '@/lib/api/self-hosted/auth-config/handlers'

export default function handlerWithErrorCatching(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler, { withAuth: true })
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return rejectMethod(req, res, ['POST'])
  const template = String(req.query.template ?? '')
  return respondWithAuthConfig(res, () => getAuthConfigStore().resetTemplate(template))
}
