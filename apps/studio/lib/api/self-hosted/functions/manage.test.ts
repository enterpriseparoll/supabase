import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  entrypointName,
  FunctionsManagementError,
  FunctionsManager,
  mergeImportMaps,
  normalizeFileName,
  readDeployForm,
} from './manage'

describe('self-hosted functions management', () => {
  let root: string
  let manager: FunctionsManager

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'functions-'))
    manager = new FunctionsManager(root)
    await writeFile(
      path.join(root, 'deno.jsonc'),
      '{\n  // platform imports\n  "imports": { "@supabase/functions-js": "jsr:@supabase/functions-js@^2" }\n}\n'
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('deploys a function and replaces it on redeploy', async () => {
    await manager.deploy('hello-world', {}, [
      { name: 'index.ts', content: 'Deno.serve(() => new Response("v1"))' },
      { name: './lib/util.ts', content: 'export const x = 1' },
    ])
    expect(await readFile(path.join(root, 'hello-world', 'index.ts'), 'utf8')).toContain('v1')
    expect(await readFile(path.join(root, 'hello-world', 'lib', 'util.ts'), 'utf8')).toBe(
      'export const x = 1'
    )

    await manager.deploy('hello-world', {}, [
      { name: 'index.ts', content: 'Deno.serve(() => new Response("v2"))' },
    ])
    expect(await readFile(path.join(root, 'hello-world', 'index.ts'), 'utf8')).toContain('v2')
    // The old folder is gone entirely, and no staging folders are left behind.
    await expect(readFile(path.join(root, 'hello-world', 'lib', 'util.ts'))).rejects.toThrow()
    expect((await readdir(root)).sort()).toEqual(['deno.jsonc', 'hello-world'])
  })

  it('points index.ts at another entrypoint', async () => {
    await manager.deploy('worker', { entrypoint_path: 'file:///tmp/x/worker/main.ts' }, [
      { name: 'main.ts', content: 'Deno.serve(() => new Response("ok"))' },
    ])
    expect(await readFile(path.join(root, 'worker', 'index.ts'), 'utf8')).toBe(
      "import './main.ts'\n"
    )
  })

  it('merges function import maps into the shared one', async () => {
    const result = await manager.deploy('zod-user', {}, [
      { name: 'index.ts', content: "import { z } from 'zod'" },
      { name: 'deno.json', content: '{ "imports": { "zod": "npm:zod@3" } }' },
    ])
    const shared = JSON.parse(await readFile(path.join(root, 'deno.jsonc'), 'utf8'))
    expect(shared.imports).toEqual({
      '@supabase/functions-js': 'jsr:@supabase/functions-js@^2',
      zod: 'npm:zod@3',
    })
    expect(result.warnings).toEqual([])
  })

  it.each([
    ['main', 'reserved'],
    ['../escape', 'Function names'],
    ['1starts-with-digit', 'Function names'],
    ['', 'Function names'],
  ])('rejects the function name %j', async (slug, message) => {
    await expect(manager.deploy(slug, {}, [{ name: 'index.ts', content: '' }])).rejects.toThrow(
      message
    )
  })

  it.each(['../x.ts', 'a/../../b.ts', 'bad name.ts', ''])('rejects the file name %j', (name) => {
    expect(() => normalizeFileName(name)).toThrow(FunctionsManagementError)
  })

  it('keeps absolute-looking names inside the function folder', () => {
    expect(normalizeFileName('/etc/passwd')).toBe('etc/passwd')
    expect(normalizeFileName('./src\\index.ts')).toBe('src/index.ts')
  })

  it('requires an entrypoint and unique file names', async () => {
    await expect(manager.deploy('x', {}, [{ name: 'README.md', content: '' }])).rejects.toThrow(
      'entrypoint'
    )
    await expect(
      manager.deploy('x', {}, [
        { name: 'index.ts', content: '' },
        { name: './index.ts', content: '' },
      ])
    ).rejects.toThrow('same name')
    expect(entrypointName(undefined, [{ name: 'handler.js', content: '' }])).toBe('handler.js')
  })

  it('deletes functions but never the platform router', async () => {
    await manager.deploy('bye', {}, [{ name: 'index.ts', content: '' }])
    await manager.remove('bye')
    await expect(readdir(path.join(root, 'bye'))).rejects.toThrow()
    await expect(manager.remove('bye')).rejects.toThrow('not found')
    await expect(manager.remove('main')).rejects.toThrow('reserved')
  })

  it('stores secrets and lists only their digests', async () => {
    await manager.setSecrets([
      { name: 'STRIPE_KEY', value: 'sk_test_1' },
      { name: 'RESEND_KEY', value: 're_1' },
    ])
    const listed = await manager.listSecrets()
    expect(listed.map((secret) => secret.name)).toEqual(['RESEND_KEY', 'STRIPE_KEY'])
    expect(JSON.stringify(listed)).not.toContain('sk_test_1')
    expect(listed[1].value).toMatch(/^[a-f0-9]{64}$/)

    await manager.deleteSecrets(['RESEND_KEY'])
    expect((await manager.listSecrets()).map((secret) => secret.name)).toEqual(['STRIPE_KEY'])

    await expect(manager.setSecrets([{ name: 'SUPABASE_URL', value: 'x' }])).rejects.toThrow(
      'SUPABASE_'
    )
    await expect(manager.setSecrets([{ name: '1BAD', value: 'x' }])).rejects.toThrow(
      'Invalid secret name'
    )
  })

  it('reads the multipart deploy body Studio sends', async () => {
    const form = new FormData()
    form.append('metadata', JSON.stringify({ name: 'hello', entrypoint_path: 'index.ts' }))
    form.append('file', new Blob(['Deno.serve(() => new Response("hi"))']), 'index.ts')
    const { metadata, files } = await readDeployForm(form)
    expect(metadata).toMatchObject({ name: 'hello', entrypoint_path: 'index.ts' })
    expect(files).toEqual([{ name: 'index.ts', content: 'Deno.serve(() => new Response("hi"))' }])
  })

  it('keeps existing import mappings on conflict', () => {
    const merged = mergeImportMaps('{ "imports": { "a": "1" } }', [
      { source: 'f/deno.json', text: '{ "imports": { "a": "2" } }' },
    ])
    expect(JSON.parse(merged.text).imports.a).toBe('1')
    expect(merged.warnings).toHaveLength(1)
  })
})
