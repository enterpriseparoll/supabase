import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  AUTH_CONFIG_DEFAULTS,
  AUTH_TEMPLATE_NAMES,
  AuthConfigError,
  environmentName,
  fieldKind,
  fromEnvironment,
  MASK,
  MASKED_FIELDS,
  sanitizePatch,
  toEnvironment,
  type AuthConfig,
  type AuthTemplateName,
  type StoredConfig,
} from './fields'

/**
 * Self-hosted Auth settings. Studio keeps what you changed in `studio/settings.json`
 * and writes the matching GOTRUE_* values to `settings.json` in the same folder.
 * The Auth server watches that folder (`--config-dir`) and reloads within seconds,
 * without a restart. Everything you haven't changed comes from the Auth server's own
 * environment, which Studio receives as the same GOTRUE_* variables.
 */
export const SERVER_FILE = 'settings.json'
export const STATE_FILE = path.join('studio', 'settings.json')

const MAX_STATE_BYTES = 20 * 1024 * 1024

export const templateNameFromSlug = (slug: string): AuthTemplateName | undefined =>
  AUTH_TEMPLATE_NAMES.find((name) => name.toLowerCase().replaceAll('_', '-') === slug)

const templateSlug = (name: AuthTemplateName) => name.toLowerCase().replaceAll('_', '-')

export type AuthConfigStoreOptions = {
  /** Folder shared with the Auth server; unset means settings are read-only. */
  root?: string
  env?: Record<string, string | undefined>
}

export class AuthConfigStore {
  private readonly root?: string
  private readonly env: Record<string, string | undefined>
  private queue: Promise<unknown> = Promise.resolve()

  constructor({ root, env = process.env }: AuthConfigStoreOptions) {
    this.root = root
    this.env = env
  }

  /** Current settings in the platform API's shape. */
  async read(): Promise<AuthConfig> {
    return this.present(await this.readState())
  }

  async update(body: unknown): Promise<AuthConfig> {
    const patch = sanitizePatch(body)
    return this.mutate((state) => ({ ...state, ...patch }))
  }

  /** Back to the Auth server's default subject and body for one email. */
  async resetTemplate(slug: string): Promise<AuthConfig> {
    const name = templateNameFromSlug(slug)
    if (!name) throw new AuthConfigError('Unknown email template.', 404)
    return this.mutate((state) => {
      const next = { ...state }
      delete next[`MAILER_TEMPLATES_${name}_CONTENT`]
      delete next[`MAILER_SUBJECTS_${name}`]
      return next
    })
  }

  /** The email body the Auth server fetches when it sends this email. */
  async templateContent(slug: string): Promise<string> {
    const name = templateNameFromSlug(slug)
    if (!name) throw new AuthConfigError('Unknown email template.', 404)
    const key = `MAILER_TEMPLATES_${name}_CONTENT` as const
    const stored = (await this.readState())[key]
    return typeof stored === 'string' && stored !== '' ? stored : AUTH_CONFIG_DEFAULTS[key]
  }

  private mutate(change: (state: StoredConfig) => StoredConfig): Promise<AuthConfig> {
    const run = this.queue.then(async () => {
      const root = this.writableRoot()
      const next = change(await this.readState())
      await atomicWrite(root, STATE_FILE, JSON.stringify(next, null, 2))
      await atomicWrite(root, SERVER_FILE, JSON.stringify(this.serverSettings(next), null, 2))
      return this.present(next)
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private writableRoot(): string {
    if (!this.root)
      throw new AuthConfigError(
        "Auth settings can't be saved: AUTH_CONFIG_MANAGEMENT_FOLDER isn't set for Studio.",
        501
      )
    return this.root
  }

  private serverSettings(state: StoredConfig) {
    const studioUrl = (this.env.STUDIO_INTERNAL_URL || 'http://studio:3000').replace(/\/+$/, '')
    const apiUrl =
      this.env.API_EXTERNAL_URL ||
      (this.env.SUPABASE_PUBLIC_URL ? `${this.env.SUPABASE_PUBLIC_URL}/auth/v1` : undefined)
    return toEnvironment(state, {
      // The version changes with the content, so the Auth server's template cache refreshes.
      templateUrl: (name) => {
        const content = state[`MAILER_TEMPLATES_${name}_CONTENT`]
        const version = createHash('sha256').update(String(content)).digest('hex').slice(0, 12)
        return `${studioUrl}/api/platform/auth/default/templates/${templateSlug(name)}/content?v=${version}`
      },
      callbackUrl: apiUrl ? `${apiUrl.replace(/\/+$/, '')}/callback` : undefined,
    })
  }

  private present(state: StoredConfig): AuthConfig {
    const values: Record<string, unknown> = { ...AUTH_CONFIG_DEFAULTS }
    for (const key of Object.keys(AUTH_CONFIG_DEFAULTS)) {
      const value = fromEnvironment(key, this.env[environmentName(key)])
      if (value !== undefined) values[key] = value
    }
    if (this.env.GOTRUE_DB_CONN_PERCENTAGE) {
      values.DB_MAX_POOL_SIZE = Number(this.env.GOTRUE_DB_CONN_PERCENTAGE)
      values.DB_MAX_POOL_SIZE_UNIT = 'percent'
    } else if (this.env.GOTRUE_DB_MAX_POOL_SIZE) values.DB_MAX_POOL_SIZE_UNIT = 'connections'
    for (const [key, value] of Object.entries(state))
      if (key === 'DB_MAX_POOL_SIZE_UNIT' || fieldKind(key)) values[key] = value
    values.MAILER_SUBJECTS_CUSTOM_CONTENTS = Object.fromEntries(
      AUTH_TEMPLATE_NAMES.map((name) => [
        `MAILER_SUBJECTS_${name}`,
        typeof state[`MAILER_SUBJECTS_${name}`] === 'string',
      ])
    )
    values.MAILER_TEMPLATES_CUSTOM_CONTENTS = Object.fromEntries(
      AUTH_TEMPLATE_NAMES.map((name) => [
        `MAILER_TEMPLATES_${name}_CONTENT`,
        !!state[`MAILER_TEMPLATES_${name}_CONTENT`],
      ])
    )
    for (const key of MASKED_FIELDS) if (values[key]) values[key] = MASK
    // Every key comes from AUTH_CONFIG_DEFAULTS, with values checked against its field types.
    return values as AuthConfig
  }

  private async readState(): Promise<StoredConfig> {
    if (!this.root) return {}
    const file = path.join(this.root, STATE_FILE)
    let text: string
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > MAX_STATE_BYTES)
        throw new AuthConfigError('The saved Auth settings file is not a regular file.', 500)
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) return {}
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new AuthConfigError('The saved Auth settings file is invalid.', 500)
    const state: StoredConfig = {}
    for (const [key, value] of Object.entries(parsed))
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      )
        state[key] = value
    return state
  }
}

const isMissing = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

// Write beside the target, then rename: readers (and the Auth server's file watcher)
// only ever see a complete file. The .tmp name is ignored by the Auth server.
async function atomicWrite(root: string, relative: string, content: string) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  const staging = `${target}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(staging, content, { mode: 0o644 })
  await rename(staging, target)
}
