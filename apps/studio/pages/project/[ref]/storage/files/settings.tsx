import { IS_PLATFORM } from 'common'

import { SelfHostedStorageSettings } from '@/components/interfaces/Storage/StorageSettings/SelfHostedStorageSettings'
import { StorageSettings } from '@/components/interfaces/Storage/StorageSettings/StorageSettings'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { StorageBucketsLayout } from '@/components/layouts/StorageLayout/StorageBucketsLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import type { NextPageWithLayout } from '@/types'

const FilesSettingsPage: NextPageWithLayout = () => {
  return IS_PLATFORM ? <StorageSettings /> : <SelfHostedStorageSettings />
}

FilesSettingsPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title="Settings">
      <StorageBucketsLayout>{page}</StorageBucketsLayout>
    </StorageLayout>
  </DefaultLayout>
)

export default FilesSettingsPage
