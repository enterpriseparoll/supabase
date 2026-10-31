import { useQuery } from '@tanstack/react-query'
import { useParams } from 'common'
import { Button, Card, CardContent } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { SelfHostedDatabaseConfiguration } from './SelfHostedDatabaseConfiguration'
import { SelfHostedDatabasePassword } from './SelfHostedDatabasePassword'
import { AlertError } from '@/components/ui/AlertError'
import {
  selfHostedDatabaseSettingsQueryOptions,
  useSelfHostedClearBansMutation,
  type SelfHostedDatabaseSettingsData,
} from '@/data/config/self-hosted-database-settings'
import { formatBytes } from '@/lib/helpers'

const NetworkBans = ({ data }: { data: SelfHostedDatabaseSettingsData }) => {
  const { ref } = useParams()
  const clear = useSelfHostedClearBansMutation(ref)
  return (
    <PageSection>
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>Network bans</PageSectionTitle>
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent>
        <Card>
          <CardContent className="space-y-3">
            {!data.networkBans.available && (
              <p className="text-sm text-foreground-light">
                The installed pooler version does not expose network bans.
              </p>
            )}
            {data.networkBans.available && data.networkBans.items.length === 0 && (
              <p className="text-sm">There are no banned IP addresses for your project.</p>
            )}
            {data.networkBans.items.map((item) => (
              <div key={item.address} className="flex items-center justify-between gap-4">
                <code>{item.address}</code>
                <Button loading={clear.isPending} onClick={() => clear.mutate([item.address])}>
                  Unblock
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </PageSectionContent>
    </PageSection>
  )
}

export const SelfHostedDatabaseSettings = () => {
  const { ref } = useParams()
  const query = useQuery(selfHostedDatabaseSettingsQueryOptions({ projectRef: ref }))
  if (query.isPending) return <GenericSkeletonLoader />
  if (query.isError)
    return <AlertError error={query.error} subject="Failed to retrieve local database settings" />
  const data = query.data
  return (
    <PageContainer size="small" className="space-y-8 pb-12">
      {data.localOnly && (
        <Admonition
          type="default"
          title="Local database access"
          description={`The pooler listens on 127.0.0.1:${data.databasePort} and 127.0.0.1:${(data.databasePort ?? 0) + 1}. Changing network restrictions does not expose the database to the public internet.`}
        />
      )}
      <SelfHostedDatabasePassword />
      <SelfHostedDatabaseConfiguration data={data} />
      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>Disk management</PageSectionTitle>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          <Card>
            <CardContent className="space-y-3">
              <p className="text-sm text-foreground-light">
                Project data uses the Docker host's disk. Resize the host disk in Docker Desktop or
                your server's storage settings.
              </p>
              {data.disk.projectBytes !== undefined && (
                <p className="text-sm">Project data: {formatBytes(data.disk.projectBytes)}</p>
              )}
              {data.disk.hostAvailableBytes !== undefined && (
                <p className="text-sm">
                  Host space available: {formatBytes(data.disk.hostAvailableBytes)}
                </p>
              )}
              <Button asChild>
                <a href={data.managementUrl} target="_blank" rel="noreferrer">
                  Go to Infrastructure
                </a>
              </Button>
            </CardContent>
          </Card>
        </PageSectionContent>
      </PageSection>
      <NetworkBans data={data} />
    </PageContainer>
  )
}
