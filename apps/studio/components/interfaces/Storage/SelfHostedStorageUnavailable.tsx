import { Admonition } from 'ui-patterns/Admonition'
import { PageContainer } from 'ui-patterns/PageContainer'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'

import { DocsButton } from '@/components/ui/DocsButton'

export const SelfHostedStorageUnavailable = ({ type }: { type: 'analytics' | 'vectors' }) => (
  <PageContainer>
    <PageSection>
      <PageSectionContent className="space-y-6">
        <Admonition
          type="default"
          title={
            type === 'analytics'
              ? 'An Iceberg catalog is required'
              : 'Vector storage is not configured'
          }
        >
          <p>
            {type === 'analytics'
              ? 'Analytics buckets store Apache Iceberg tables. This project currently uses local file storage and has no Iceberg catalog or S3 Tables service configured. File buckets remain available under Files.'
              : 'Enable VECTOR_ENABLED and configure the pgvector or S3 vector provider on the Storage server, then restart it.'}
          </p>
          {type === 'analytics' && (
            <p className="mt-3">
              The standard self-hosted stack does not include the catalog infrastructure used by
              hosted Analytics buckets. Adding a navigation item alone does not enable that service.
            </p>
          )}
        </Admonition>
        <DocsButton
          href={
            type === 'analytics'
              ? 'https://supabase.com/docs/guides/storage/analytics/introduction'
              : 'https://supabase.com/docs/guides/storage/vector/creating-vector-buckets'
          }
        />
      </PageSectionContent>
    </PageSection>
  </PageContainer>
)
