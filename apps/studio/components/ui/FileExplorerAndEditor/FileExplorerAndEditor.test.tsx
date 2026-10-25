import { screen, waitFor } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { FileExplorerAndEditor } from './index'
import type { ProjectDetail } from '@/data/projects/project-detail-query'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock } from '@/tests/lib/msw'

const files = [
  {
    id: 1,
    name: 'index.ts',
    content: 'Deno.serve(() => new Response("hi"))',
    state: 'unchanged' as const,
  },
]

// The editor loads the selected project for its AI completions.
const PROJECT: ProjectDetail = {
  id: 1,
  ref: 'default',
  organization_id: 1,
  name: 'Test Project',
  status: 'ACTIVE_HEALTHY',
  cloud_provider: 'AWS',
  region: 'us-east-1',
  db_host: 'db.default.supabase.co',
  restUrl: 'https://default.supabase.co/rest/v1/',
  inserted_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  subscription_id: 'sub_123',
  is_branch_enabled: false,
  is_physical_backups_enabled: false,
  high_availability: false,
  integration_source: null,
  connectionString: 'postgresql://postgres@localhost:5432/postgres',
  is_hibernating: false,
}

let projectRequests = 0

describe('FileExplorerAndEditor', () => {
  beforeEach(() => {
    projectRequests = 0
    addAPIMock({
      method: 'get',
      path: '/platform/projects/:ref',
      response: () => {
        projectRequests++
        return HttpResponse.json<ProjectDetail>(PROJECT)
      },
    })
  })

  it('offers Add File when files can be edited', async () => {
    customRender(<FileExplorerAndEditor files={files} onFilesChange={() => {}} canEdit />)
    expect(screen.getByRole('button', { name: 'Add File' })).toBeInTheDocument()
    await waitFor(() => expect(projectRequests).toBeGreaterThan(0))
  })

  it('hides Add File for read-only viewers', async () => {
    customRender(<FileExplorerAndEditor files={files} onFilesChange={() => {}} canEdit={false} />)
    expect(screen.queryByRole('button', { name: 'Add File' })).not.toBeInTheDocument()
    await waitFor(() => expect(projectRequests).toBeGreaterThan(0))
  })
})
