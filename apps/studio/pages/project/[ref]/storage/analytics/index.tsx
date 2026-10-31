import { IS_PLATFORM, useParams } from 'common'

import { AnalyticsBuckets } from '@/components/interfaces/Storage/AnalyticsBuckets'
import { BucketsUpgradePlan } from '@/components/interfaces/Storage/BucketsUpgradePlan'
import { SelfHostedStorageUnavailable } from '@/components/interfaces/Storage/SelfHostedStorageUnavailable'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { StorageBucketsLayout } from '@/components/layouts/StorageLayout/StorageBucketsLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import { useIsAnalyticsBucketsEnabled } from '@/data/config/project-storage-config-query'
import type { NextPageWithLayout } from '@/types'

const StorageAnalyticsPage: NextPageWithLayout = () => {
  const { ref: projectRef } = useParams()
  const isAnalyticsBucketsEnabled = useIsAnalyticsBucketsEnabled({ projectRef })

  if (!IS_PLATFORM) return <SelfHostedStorageUnavailable type="analytics" />

  if (!isAnalyticsBucketsEnabled) {
    return <BucketsUpgradePlan type="analytics" />
  } else {
    return <AnalyticsBuckets />
  }
}

StorageAnalyticsPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title="Analytics">
      <StorageBucketsLayout>{page}</StorageBucketsLayout>
    </StorageLayout>
  </DefaultLayout>
)

export default StorageAnalyticsPage
