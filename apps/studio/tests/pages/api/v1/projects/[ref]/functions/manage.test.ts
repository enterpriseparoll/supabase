import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NextApiRequest, NextApiResponse } from 'next'
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import functionHandler from '@/pages/api/v1/projects/[ref]/functions/[slug]'
import deployHandler from '@/pages/api/v1/projects/[ref]/functions/deploy'
import secretsHandler from '@/pages/api/v1/projects/[ref]/secrets'

vi.mock('@/lib/constants', () => ({ IS_PLATFORM: false }))

describe('self-hosted function deploys, deletes, and secrets', () => {
  let root: string
  let server: Server
  let base: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-functions-'))
    vi.stubEnv('EDGE_FUNCTIONS_MANAGEMENT_FOLDER', root)
    // A real HTTP server: the deploy route reads the multipart body as a stream.
    server = createServer((req, res) => {
      const response = Object.assign(res, {
        status(code: number) {
          res.statusCode = code
          return response
        },
        json(body: unknown) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
          return response
        },
      })
      void deployHandler(req as NextApiRequest, response as unknown as NextApiResponse)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  // Node's http client: the test setup's MSW intercepts fetch.
  const post = async (url: string, body: BodyInit, contentType?: string) => {
    const encoded = new Response(body)
    const bytes = Buffer.from(await encoded.arrayBuffer())
    const type = contentType ?? encoded.headers.get('content-type') ?? ''
    return new Promise<{ status: number; json: () => unknown }>((resolve, reject) => {
      const outgoing = request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': type, 'Content-Length': bytes.length },
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              json: () => JSON.parse(Buffer.concat(chunks).toString()),
            })
          )
        }
      )
      outgoing.on('error', reject)
      outgoing.end(bytes)
    })
  }

  const deploy = (slug: string, files: Record<string, string>) => {
    const form = new FormData()
    form.append('metadata', JSON.stringify({ name: slug, entrypoint_path: 'index.ts' }))
    for (const [name, content] of Object.entries(files))
      form.append('file', new Blob([content]), name)
    return post(`${base}/api/v1/projects/default/functions/deploy?slug=${slug}`, form)
  }

  it('deploys an uploaded function through the multipart endpoint', async () => {
    const response = await deploy('hello-world', {
      'index.ts': 'Deno.serve(() => new Response("hello"))',
    })
    expect(response.status).toBe(201)
    expect(response.json()).toMatchObject({ slug: 'hello-world', status: 'ACTIVE' })
    expect(await readFile(path.join(root, 'hello-world', 'index.ts'), 'utf8')).toBe(
      'Deno.serve(() => new Response("hello"))'
    )
  })

  it('reports invalid deploys as client errors', async () => {
    const reserved = await deploy('main', { 'index.ts': '' })
    expect(reserved.status).toBe(400)
    expect(reserved.json()).toMatchObject({ message: expect.stringMatching(/reserved/) })
    const json = await post(
      `${base}/api/v1/projects/default/functions/deploy?slug=x`,
      '{}',
      'application/json'
    )
    expect(json.status).toBe(415)
  })

  it('deletes a function', async () => {
    await deploy('bye', { 'index.ts': '' })
    const { req, res } = createMocks({ method: 'DELETE', query: { ref: 'default', slug: 'bye' } })
    await functionHandler(req, res)
    expect(res._getStatusCode()).toBe(200)
    await expect(readFile(path.join(root, 'bye', 'index.ts'))).rejects.toThrow()
  })

  it('creates, lists, and deletes secrets', async () => {
    const create = createMocks({
      method: 'POST',
      query: { ref: 'default' },
      body: [{ name: 'STRIPE_KEY', value: 'sk_test_1' }],
    })
    await secretsHandler(create.req, create.res)
    expect(create.res._getStatusCode()).toBe(201)

    const list = createMocks({ method: 'GET', query: { ref: 'default' } })
    await secretsHandler(list.req, list.res)
    expect(list.res._getJSONData()).toEqual([
      expect.objectContaining({
        name: 'STRIPE_KEY',
        value: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ])

    const reserved = createMocks({
      method: 'POST',
      query: { ref: 'default' },
      body: [{ name: 'SUPABASE_URL', value: 'x' }],
    })
    await secretsHandler(reserved.req, reserved.res)
    expect(reserved.res._getStatusCode()).toBe(400)

    const remove = createMocks({
      method: 'DELETE',
      query: { ref: 'default' },
      body: ['STRIPE_KEY'],
    })
    await secretsHandler(remove.req, remove.res)
    const after = createMocks({ method: 'GET', query: { ref: 'default' } })
    await secretsHandler(after.req, after.res)
    expect(after.res._getJSONData()).toEqual([])
  })
})
