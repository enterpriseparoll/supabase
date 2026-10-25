import { useDeploymentMode } from '@/hooks/misc/useDeploymentMode'

/**
 * Whether functions can be deployed, deleted, and given secrets from Studio: on the
 * platform through the Management API, and in self-hosted Studio by writing to the
 * functions folder. The Supabase CLI's local stack manages functions on disk instead.
 */
export function useCanManageEdgeFunctions() {
  const { isPlatform, isSelfHosted } = useDeploymentMode()
  return { canManageFunctions: isPlatform || isSelfHosted, isSelfHosted }
}
