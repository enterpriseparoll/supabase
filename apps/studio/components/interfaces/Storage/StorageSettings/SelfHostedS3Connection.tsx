import { useQuery } from '@tanstack/react-query'
import { useParams } from 'common'
import { useState } from 'react'
import { Button, Card, CardContent } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { Input } from 'ui-patterns/DataInputs/Input'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { PageContainer } from 'ui-patterns/PageContainer'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { AlertError } from '@/components/ui/AlertError'
import { useProjectSettingsV2Query } from '@/data/config/project-settings-v2-query'
import { useProjectStorageConfigQuery } from '@/data/config/project-storage-config-query'
import { selfHostedS3CredentialsQueryOptions } from '@/data/storage/self-hosted-s3-credentials-query'

export const SelfHostedS3Connection = () => {
  const { ref: projectRef } = useParams()
  const { data: config, error, isPending } = useProjectStorageConfigQuery({ projectRef })
  const { data: settings } = useProjectSettingsV2Query({ projectRef })
  const credentials = useQuery(selfHostedS3CredentialsQueryOptions({ projectRef }))
  const [canShowCredentials, setCanShowCredentials] = useState(false)
  if (isPending) return <GenericSkeletonLoader />
  if (error) return <AlertError error={error} subject="Failed to retrieve storage configuration" />
  const protocol = settings?.app_config?.protocol ?? 'http'
  const host = settings?.app_config?.storage_endpoint || settings?.app_config?.endpoint
  const endpoint = host ? `${protocol}://${host}/storage/v1/s3` : ''
  const isConfigured = config.selfHosted?.canUpdate ?? false
  return (
    <PageContainer>
      <PageSection>
        <PageSectionContent className="space-y-6">
          <Admonition
            type="default"
            title={
              config.features.s3Protocol.enabled
                ? 'S3 protocol is enabled'
                : 'S3 protocol is disabled'
            }
            description="Use path-style addressing with your S3 client. The S3 protocol setting is available under Files → Settings."
          />
          <Card>
            <CardContent>
              <FormItemLayout isReactForm={false} layout="flex-row-reverse" label="Endpoint">
                <Input readOnly copy value={endpoint} />
              </FormItemLayout>
            </CardContent>
            <CardContent>
              <FormItemLayout isReactForm={false} layout="flex-row-reverse" label="Region">
                <Input readOnly copy value={settings?.region ?? 'local'} />
              </FormItemLayout>
            </CardContent>
            <CardContent className="space-y-4">
              <h3 className="text-sm">Host-managed access key</h3>
              <p className="text-sm text-foreground-light">
                This key grants full access to every file bucket in this project and bypasses RLS.
                Keep it on trusted servers. The host manages its creation and rotation.
              </p>
              {!isConfigured && (
                <p className="text-sm text-foreground-light">
                  Read S3_PROTOCOL_ACCESS_KEY_ID and S3_PROTOCOL_ACCESS_KEY_SECRET from your Storage
                  server environment.
                </p>
              )}
              {isConfigured && (
                <Button
                  variant="default"
                  loading={credentials.isFetching}
                  onClick={() => {
                    if (canShowCredentials) {
                      setCanShowCredentials(false)
                    } else {
                      setCanShowCredentials(true)
                      void credentials.refetch()
                    }
                  }}
                >
                  {canShowCredentials ? 'Hide credentials' : 'Show credentials'}
                </Button>
              )}
              {canShowCredentials && credentials.error && (
                <AlertError error={credentials.error} subject="Failed to retrieve S3 credentials" />
              )}
              {canShowCredentials && credentials.data && (
                <div className="space-y-4">
                  <FormItemLayout isReactForm={false} label="Access key ID">
                    <Input readOnly copy value={credentials.data.access_key} />
                  </FormItemLayout>
                  <FormItemLayout isReactForm={false} label="Secret access key">
                    <Input readOnly copy type="password" value={credentials.data.secret_key} />
                  </FormItemLayout>
                </div>
              )}
            </CardContent>
          </Card>
        </PageSectionContent>
      </PageSection>
    </PageContainer>
  )
}
