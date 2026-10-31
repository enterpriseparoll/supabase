import { useParams } from 'common'
import { PropsWithChildren } from 'react'

import AuthLayout from './AuthLayout'
import { PageLayout } from '@/components/layouts/PageLayout/PageLayout'
import { UnknownInterface } from '@/components/ui/UnknownInterface'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { IS_PLATFORM } from '@/lib/constants'

export const AuthProvidersLayout = ({ children }: PropsWithChildren<{}>) => {
  const { ref } = useParams()
  const { authenticationSignInProviders, authenticationThirdPartyAuth } = useIsFeatureEnabled([
    'authentication:sign_in_providers',
    'authentication:third_party_auth',
  ])

  // Third-party Auth is configured through the platform API, which self-hosting lacks.
  const showThirdPartyAuth = IS_PLATFORM && authenticationThirdPartyAuth

  const navItems = [
    {
      label: 'Supabase Auth',
      href: `/project/${ref}/auth/providers`,
    },
    ...(showThirdPartyAuth
      ? [
          {
            label: 'Third-Party Auth',
            href: `/project/${ref}/auth/third-party`,
          },
        ]
      : []),
  ]

  return (
    <AuthLayout title="Sign In / Providers">
      {authenticationSignInProviders ? (
        <PageLayout
          title="Sign In / Providers"
          subtitle="Configure authentication providers and login methods for your users"
          navigationItems={navItems}
        >
          {children}
        </PageLayout>
      ) : (
        <UnknownInterface urlBack={`/project/${ref}/auth/users`} />
      )}
    </AuthLayout>
  )
}
