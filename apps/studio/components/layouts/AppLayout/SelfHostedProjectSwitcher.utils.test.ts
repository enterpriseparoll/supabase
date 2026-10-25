import { describe, expect, it } from 'vitest'

import {
  getNewProjectUrl,
  getOpenProjectUrl,
  getSelfHostedPlatformContext,
} from './SelfHostedProjectSwitcher.utils'

const id = 'p3dbc577e5912e819050d152a'

describe('getSelfHostedPlatformContext', () => {
  it('derives the dashboard from a local platform Studio host, keeping the port', () => {
    expect(
      getSelfHostedPlatformContext({
        protocol: 'http:',
        hostname: `${id}.studio.localhost`,
        port: '8090',
      })
    ).toEqual({ projectId: id, dashboardUrl: 'http://manage.localhost:8090' })
  })

  it('derives the dashboard on a server domain without a port', () => {
    expect(
      getSelfHostedPlatformContext({
        protocol: 'https:',
        hostname: `${id}.studio.platform.example.com`,
        port: '',
      })
    ).toEqual({ projectId: id, dashboardUrl: 'https://manage.platform.example.com' })
  })

  it('returns undefined for ordinary self-hosted Studio hosts', () => {
    for (const hostname of ['localhost', 'studio.example.com', 'pabc.studio.localhost'])
      expect(getSelfHostedPlatformContext({ protocol: 'http:', hostname, port: '' })).toBe(
        undefined
      )
  })
})

describe('platform dashboard links', () => {
  it('builds open and new-project URLs', () => {
    expect(getOpenProjectUrl('http://manage.localhost:8090', id)).toBe(
      `http://manage.localhost:8090/open/${id}`
    )
    expect(getNewProjectUrl('http://manage.localhost:8090')).toBe(
      'http://manage.localhost:8090/#new'
    )
  })
})
