import type { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getStorageConfig } from '@/lib/api/self-hosted/storage'

export default function storageConfigHandler(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler)
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return res.status(200).json(getStorageConfig())
  res.setHeader('Allow', ['GET'])
  return res.status(501).json({
    message:
      'Storage settings are managed by your host. Update the Storage server environment and restart it.',
  })
}
