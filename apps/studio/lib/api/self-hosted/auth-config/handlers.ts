import type { NextApiRequest, NextApiResponse } from 'next'

import { AuthConfigError } from './fields'

/** Runs a self-hosted Auth settings request, turning known failures into API errors. */
export async function respondWithAuthConfig(
  res: NextApiResponse,
  action: () => Promise<unknown>,
  status = 200
) {
  try {
    return res.status(status).json(await action())
  } catch (error) {
    if (error instanceof AuthConfigError)
      return res
        .status(error.status)
        .json({ message: error.message, error: { message: error.message } })
    throw error
  }
}

export function rejectMethod(req: NextApiRequest, res: NextApiResponse, allowed: string[]) {
  res.setHeader('Allow', allowed)
  return res
    .status(405)
    .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}
