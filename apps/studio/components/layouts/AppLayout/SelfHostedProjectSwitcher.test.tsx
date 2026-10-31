import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, test } from 'vitest'

import { SelfHostedProjectSwitcher } from './SelfHostedProjectSwitcher'
import { customRender } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'

const current = 'p3dbc577e5912e819050d152a'
const other = 'p0123456789abcdef01234567'
const platform = { projectId: current, dashboardUrl: 'http://manage.localhost:8090' }

describe('SelfHostedProjectSwitcher', () => {
  test('lists platform projects and links to the dashboard', async () => {
    mswServer.use(
      http.get('*/_platform/api/projects', () =>
        HttpResponse.json({
          projects: [
            { id: current, name: 'theinvestmentbanker', status: 'ready' },
            { id: other, name: 'medicare360', status: 'ready' },
          ],
        })
      )
    )
    customRender(
      <SelfHostedProjectSwitcher projectName="theinvestmentbanker" platform={platform} />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Switch project' }))

    expect(await screen.findByText('medicare360')).toBeInTheDocument()
    expect(screen.getAllByText('theinvestmentbanker').length).toBeGreaterThan(1)
    expect(screen.getByText('All projects')).toBeInTheDocument()
    expect(screen.getByText('New project')).toBeInTheDocument()
  })

  test('explains how to recover when the project list cannot load', async () => {
    mswServer.use(
      http.get('*/_platform/api/projects', () =>
        HttpResponse.json({ error: 'Open Studio from the project dashboard' }, { status: 401 })
      )
    )
    customRender(
      <SelfHostedProjectSwitcher projectName="theinvestmentbanker" platform={platform} />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Switch project' }))

    expect(await screen.findByText(/Couldn’t load projects/)).toBeInTheDocument()
    expect(screen.getByText('All projects')).toBeInTheDocument()
  })
})
