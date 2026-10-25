import { createFileRoute } from '@tanstack/react-router'

import { handleDeployRequest } from '@/lib/api/self-hosted/functions/handlers'

// Twin of `pages/api/v1/projects/[ref]/functions/deploy.ts`. `toWebHandler`
// cannot read multipart bodies, so this route hands the Web `Request` straight
// to the shared handler. It asserts self-hosted mode, like the other function
// routes, so no auth wrapper is needed.
export const Route = createFileRoute('/api/v1/projects/$ref/functions/deploy')({
  server: { handlers: { POST: ({ request }) => handleDeployRequest(request) } },
})
