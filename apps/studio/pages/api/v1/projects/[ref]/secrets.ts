import { type NextApiRequest, type NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getFunctionsManager } from '@/lib/api/self-hosted/functions'
import { FunctionsManagementError } from '@/lib/api/self-hosted/functions/manage'

// Edge Function secrets for self-hosted projects: environment variables the
// runtime passes to every function (stored beside the functions).
export default function handlerWithErrorCatching(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler, { withAuth: true })
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const manager = getFunctionsManager()
  try {
    switch (req.method) {
      case 'GET':
        return res.status(200).json(await manager.listSecrets())
      case 'POST':
        await manager.setSecrets(req.body)
        return res.status(201).json({})
      case 'DELETE':
        await manager.deleteSecrets(req.body)
        return res.status(200).json({})
      default:
        res.setHeader('Allow', ['GET', 'POST', 'DELETE'])
        return res
          .status(405)
          .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
    }
  } catch (error) {
    if (error instanceof FunctionsManagementError)
      return res
        .status(error.status)
        .json({ message: error.message, error: { message: error.message } })
    throw error
  }
}
