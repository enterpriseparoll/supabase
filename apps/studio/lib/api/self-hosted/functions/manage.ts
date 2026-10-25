import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Deploys, deletes, and configures secrets for self-hosted Edge Functions by writing
 * to the functions folder that the edge runtime serves (EDGE_FUNCTIONS_MANAGEMENT_FOLDER).
 * The runtime's main router starts a fresh worker when a function folder or the
 * secrets file changes, so deploys take effect on the next request.
 */

export class FunctionsManagementError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message)
  }
}

// Same rule as the platform: letters first, then letters, numbers, - and _.
const SLUG = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const RESERVED_SLUGS = new Set(['main'])
const FILE_SEGMENT = /^[A-Za-z0-9_.@-]+$/
const IMPORT_MAP_FILES = new Set(['deno.json', 'deno.jsonc', 'import_map.json'])
const MAX_FILES = 200
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
export const SECRETS_FILE = '.secrets.json'
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/

export type DeployFile = { name: string; content: string }
export type DeployMetadata = {
  name?: string
  entrypoint_path?: string
  import_map_path?: string
  verify_jwt?: boolean
}

export function assertSlug(slug: unknown): asserts slug is string {
  if (typeof slug !== 'string' || !SLUG.test(slug))
    throw new FunctionsManagementError(
      'Function names start with a letter and use letters, numbers, hyphens, or underscores (up to 64).'
    )
  if (RESERVED_SLUGS.has(slug))
    throw new FunctionsManagementError(
      `"${slug}" is reserved by the platform. Choose another name.`
    )
}

/** Normalizes an uploaded file name to a safe path inside the function folder. */
export function normalizeFileName(name: string): string {
  const cleaned = name
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
  const parts = cleaned.split('/')
  if (
    !cleaned ||
    parts.length > 10 ||
    parts.some((part) => !FILE_SEGMENT.test(part) || part === '.' || part === '..')
  )
    throw new FunctionsManagementError(`Invalid file name: ${name}`)
  return cleaned
}

/** Converts a deploy entrypoint (path, file:// URL, or bare name) to a file name. */
export function entrypointName(entrypoint: string | undefined, files: DeployFile[]) {
  const names = files.map((file) => file.name)
  if (entrypoint) {
    const bare = entrypoint.replace(/^file:\/\//, '')
    const match = names.find((name) => bare === name || bare.endsWith(`/${name}`))
    if (match) return match
  }
  return (
    names.find((name) => /^index\.(ts|tsx|js|jsx|mjs)$/.test(name)) ??
    names.find((name) => /\.(ts|tsx|js|jsx|mjs)$/.test(name))
  )
}

/** Removes comments and trailing commas outside strings (JSONC → JSON). */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) break
      i++
    } else out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * The runtime reads one import map (functions/deno.jsonc) for every function, so a
 * function's own deno.json / import_map.json imports are merged into it. Existing
 * mappings win on conflict; conflicts are returned as warnings.
 */
export function mergeImportMaps(rootText: string, sources: { source: string; text: string }[]) {
  const warnings: string[] = []
  let root: Record<string, unknown> = {}
  try {
    root = asObject(parseJsonc(rootText))
  } catch {
    root = {}
  }
  const imports: Record<string, string> = {}
  for (const [specifier, target] of Object.entries(asObject(root.imports)))
    if (typeof target === 'string') imports[specifier] = target
  for (const { source, text } of sources) {
    let parsed: Record<string, unknown>
    try {
      parsed = asObject(parseJsonc(text))
    } catch {
      warnings.push(`${source} is not valid JSON; its imports were skipped`)
      continue
    }
    for (const [specifier, target] of Object.entries(asObject(parsed.imports))) {
      if (typeof target !== 'string') continue
      if (imports[specifier] !== undefined && imports[specifier] !== target)
        warnings.push(
          `${source} maps "${specifier}" to ${target}, but ${imports[specifier]} is already used by another function`
        )
      else imports[specifier] = target
    }
  }
  return { text: `${JSON.stringify({ ...root, imports }, null, 2)}\n`, warnings }
}

export class FunctionsManager {
  constructor(private root: string) {}

  private folder(slug: string) {
    assertSlug(slug)
    const target = path.resolve(this.root, slug)
    if (!target.startsWith(path.resolve(this.root) + path.sep))
      throw new FunctionsManagementError('Invalid function name')
    return target
  }

  /** Creates or replaces a function. The folder is swapped in atomically. */
  async deploy(slug: string, metadata: DeployMetadata, uploaded: DeployFile[]) {
    const destination = this.folder(slug)
    if (!uploaded.length) throw new FunctionsManagementError('Add at least one file')
    if (uploaded.length > MAX_FILES)
      throw new FunctionsManagementError(`A function can have up to ${MAX_FILES} files`)
    const files = uploaded.map((file) => ({
      name: normalizeFileName(file.name),
      content: file.content,
    }))
    const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)
    if (total > MAX_TOTAL_BYTES)
      throw new FunctionsManagementError('Function files are larger than 10 MB in total', 413)
    if (new Set(files.map((file) => file.name)).size !== files.length)
      throw new FunctionsManagementError('Two files have the same name')
    const entrypoint = entrypointName(metadata.entrypoint_path, files)
    if (!entrypoint) throw new FunctionsManagementError('Add an entrypoint file such as index.ts')
    // The runtime starts index.ts; point it at another entrypoint when needed.
    if (!/^index\.(ts|tsx|js|jsx|mjs)$/.test(entrypoint)) {
      if (files.some((file) => file.name === 'index.ts'))
        throw new FunctionsManagementError('index.ts already exists; use it as the entrypoint')
      files.push({ name: 'index.ts', content: `import './${entrypoint}'\n` })
    }

    try {
      await mkdir(this.root, { recursive: true })
    } catch {
      throw new FunctionsManagementError('The functions folder is not writable', 500)
    }
    const staging = path.join(this.root, `.deploy-${slug}-${randomBytes(4).toString('hex')}`)
    try {
      for (const file of files) {
        const target = path.resolve(staging, file.name)
        if (!target.startsWith(staging + path.sep))
          throw new FunctionsManagementError(`Invalid file name: ${file.name}`)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, file.content, { mode: 0o644 })
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      if (error instanceof FunctionsManagementError) throw error
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'EROFS' || code === 'EACCES')
        throw new FunctionsManagementError(
          'The functions folder is read-only for Studio. Mount it writable to deploy from Studio.',
          500
        )
      throw error
    }
    const previous = path.join(this.root, `.previous-${slug}-${randomBytes(4).toString('hex')}`)
    const exists = await lstat(destination).then(
      () => true,
      () => false
    )
    if (exists) await rename(destination, previous)
    await rename(staging, destination)
    if (exists) await rm(previous, { recursive: true, force: true })

    const importMaps = files
      .filter((file) => IMPORT_MAP_FILES.has(file.name))
      .map((file) => ({ source: `${slug}/${file.name}`, text: file.content }))
    let warnings: string[] = []
    if (importMaps.length) {
      const rootFile = path.join(this.root, 'deno.jsonc')
      const current = await readFile(rootFile, 'utf8').catch(() => '{}')
      const merged = mergeImportMaps(current, importMaps)
      warnings = merged.warnings
      if (merged.text !== current) await writeFile(rootFile, merged.text, { mode: 0o644 })
    }
    const info = await stat(path.join(destination, 'index.ts')).catch(() =>
      stat(path.join(destination, entrypoint))
    )
    return {
      slug,
      entrypoint_path: `file://${path.join(destination, entrypoint)}`,
      updated_at: info.mtimeMs,
      created_at: info.birthtimeMs || info.mtimeMs,
      warnings,
    }
  }

  async remove(slug: string) {
    const folder = this.folder(slug)
    const exists = await lstat(folder).then(
      (info) => info.isDirectory(),
      () => false
    )
    if (!exists) throw new FunctionsManagementError('Function not found', 404)
    await rm(folder, { recursive: true, force: true })
  }

  // ---- Secrets: environment variables given to every function ----
  private async readSecrets(): Promise<Record<string, { value: string; updated_at: string }>> {
    try {
      const parsed = asObject(
        JSON.parse(await readFile(path.join(this.root, SECRETS_FILE), 'utf8'))
      )
      const secrets: Record<string, { value: string; updated_at: string }> = {}
      for (const [name, entry] of Object.entries(parsed)) {
        const { value, updated_at } = asObject(entry)
        if (typeof value === 'string')
          secrets[name] = { value, updated_at: typeof updated_at === 'string' ? updated_at : '' }
      }
      return secrets
    } catch {
      return {}
    }
  }
  private async writeSecrets(secrets: Record<string, { value: string; updated_at: string }>) {
    const target = path.join(this.root, SECRETS_FILE)
    const staging = `${target}.${randomBytes(4).toString('hex')}`
    await writeFile(staging, JSON.stringify(secrets, null, 2), { mode: 0o644 })
    await rename(staging, target)
  }

  /** Names with a SHA-256 digest of each value, like the Management API. */
  async listSecrets() {
    const secrets = await this.readSecrets()
    return Object.entries(secrets)
      .map(([name, entry]) => ({
        name,
        value: createHash('sha256').update(entry.value).digest('hex'),
        updated_at: entry.updated_at,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async setSecrets(input: unknown) {
    if (!Array.isArray(input) || !input.length || input.length > 100)
      throw new FunctionsManagementError('Send 1–100 secrets as [{ name, value }]')
    const secrets = await this.readSecrets()
    const now = new Date().toISOString()
    for (const item of input) {
      const { name, value } = asObject(item)
      if (typeof name !== 'string' || !SECRET_NAME.test(name))
        throw new FunctionsManagementError(
          `Invalid secret name: ${String(name)}. Use letters, numbers, and underscores, not starting with a number.`
        )
      if (name.toUpperCase().startsWith('SUPABASE_'))
        throw new FunctionsManagementError(`Secret names cannot start with SUPABASE_ (${name})`)
      if (typeof value !== 'string' || Buffer.byteLength(value) > 24576)
        throw new FunctionsManagementError(`The value of ${name} must be text up to 24 KB`)
      secrets[name] = { value, updated_at: now }
    }
    await this.writeSecrets(secrets)
  }

  async deleteSecrets(input: unknown) {
    if (!Array.isArray(input) || !input.length || !input.every((name) => typeof name === 'string'))
      throw new FunctionsManagementError('Send the secret names to delete as an array')
    const secrets = await this.readSecrets()
    for (const name of input) delete secrets[name]
    await this.writeSecrets(secrets)
  }
}

/** Reads a multipart deploy body (metadata JSON plus `file` parts). */
export async function readDeployForm(form: FormData) {
  let raw: Record<string, unknown> = {}
  const rawMetadata = form.get('metadata')
  if (typeof rawMetadata === 'string') {
    try {
      raw = asObject(JSON.parse(rawMetadata))
    } catch {
      throw new FunctionsManagementError('metadata must be JSON')
    }
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const metadata: DeployMetadata = {
    name: text(raw.name),
    entrypoint_path: text(raw.entrypoint_path),
    import_map_path: text(raw.import_map_path),
    verify_jwt: typeof raw.verify_jwt === 'boolean' ? raw.verify_jwt : undefined,
  }
  const files: DeployFile[] = []
  for (const entry of form.getAll('file')) {
    if (typeof entry === 'string') continue
    files.push({ name: entry.name, content: await entry.text() })
  }
  return { metadata, files }
}
