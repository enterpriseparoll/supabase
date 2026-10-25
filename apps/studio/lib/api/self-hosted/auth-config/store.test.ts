import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseDuration, sanitizePatch, toEnvironment } from './fields'
import { AuthConfigStore, SERVER_FILE, STATE_FILE } from './store'

describe('self-hosted Auth settings', () => {
  let root: string
  const env = {
    GOTRUE_SITE_URL: 'http://localhost:3000',
    GOTRUE_DISABLE_SIGNUP: 'false',
    GOTRUE_JWT_EXP: '3600',
    GOTRUE_SMTP_HOST: 'mail.example.com',
    GOTRUE_SMTP_PASS: 'secret-from-env',
    GOTRUE_SMTP_MAX_FREQUENCY: '1m',
    GOTRUE_EXTERNAL_PHONE_ENABLED: 'false',
    GOTRUE_MAILER_AUTOCONFIRM: '',
    API_EXTERNAL_URL: 'http://abc.api.localhost:8090/auth/v1',
  }

  const serverFile = async () => JSON.parse(await readFile(path.join(root, SERVER_FILE), 'utf8'))

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'auth-config-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads the Auth server environment, falling back to its defaults', async () => {
    const config = await new AuthConfigStore({ root, env }).read()
    expect(config.SITE_URL).toBe('http://localhost:3000')
    expect(config.JWT_EXP).toBe(3600)
    expect(config.SMTP_MAX_FREQUENCY).toBe(60)
    expect(config.MAILER_AUTOCONFIRM).toBe(false)
    expect(config.EXTERNAL_EMAIL_ENABLED).toBe(true)
    expect(config.RATE_LIMIT_TOKEN_REFRESH).toBe(150)
    expect(config.MAILER_TEMPLATES_CONFIRMATION_CONTENT).toContain('{{ .ConfirmationURL }}')
    // Passwords are write-only.
    expect(config.SMTP_PASS).toBe('******')
  })

  it('saves changes for the Auth server to reload', async () => {
    const store = new AuthConfigStore({ root, env })
    const config = await store.update({
      DISABLE_SIGNUP: true,
      SESSIONS_TIMEBOX: 86400,
      SESSIONS_INACTIVITY_TIMEOUT: 0,
      SMTP_PASS: 'new-password',
      URI_ALLOW_LIST: 'http://localhost:3000/**,myapp://callback',
      EXTERNAL_GITHUB_ENABLED: true,
      EXTERNAL_GITHUB_CLIENT_ID: 'id',
      UNKNOWN_SETTING: 'ignored',
    })
    expect(config.DISABLE_SIGNUP).toBe(true)
    expect(config.SESSIONS_TIMEBOX).toBe(86400)
    expect(config.SMTP_PASS).toBe('******')

    expect(await serverFile()).toEqual({
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_SESSIONS_TIMEBOX: '86400s',
      GOTRUE_SMTP_PASS: 'new-password',
      GOTRUE_URI_ALLOW_LIST: 'http://localhost:3000/**,myapp://callback',
      GOTRUE_EXTERNAL_GITHUB_ENABLED: 'true',
      GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: 'id',
      GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI: 'http://abc.api.localhost:8090/auth/v1/callback',
    })

    // The masked placeholder never replaces the saved password.
    await store.update({ SMTP_PASS: '******', SMTP_HOST: null })
    expect(await serverFile()).toMatchObject({
      GOTRUE_SMTP_PASS: 'new-password',
      GOTRUE_SMTP_HOST: '',
    })
  })

  it('serves customized templates and resets them', async () => {
    const store = new AuthConfigStore({ root, env })
    const config = await store.update({
      MAILER_SUBJECTS_CONFIRMATION: 'Welcome!',
      MAILER_TEMPLATES_CONFIRMATION_CONTENT: '<p>{{ .ConfirmationURL }}</p>',
    })
    expect(config.MAILER_TEMPLATES_CUSTOM_CONTENTS.MAILER_TEMPLATES_CONFIRMATION_CONTENT).toBe(true)
    expect(config.MAILER_SUBJECTS_CUSTOM_CONTENTS.MAILER_SUBJECTS_CONFIRMATION).toBe(true)
    expect(await store.templateContent('confirmation')).toBe('<p>{{ .ConfirmationURL }}</p>')
    expect((await serverFile()).GOTRUE_MAILER_TEMPLATES_CONFIRMATION).toMatch(
      /^http:\/\/studio:3000\/api\/platform\/auth\/default\/templates\/confirmation\/content\?v=[a-f0-9]{12}$/
    )

    const reset = await store.resetTemplate('confirmation')
    expect(reset.MAILER_SUBJECTS_CONFIRMATION).toBe('Confirm your email address')
    expect(await store.templateContent('confirmation')).toContain('Confirm email address')
    expect(await serverFile()).toEqual({})
    await expect(store.resetTemplate('nope')).rejects.toThrow('Unknown email template')
  })

  it('keeps settings in Studio state and applies saves in order', async () => {
    const store = new AuthConfigStore({ root, env })
    await Promise.all([store.update({ JWT_EXP: 100 }), store.update({ JWT_EXP: 200 })])
    const state = JSON.parse(await readFile(path.join(root, STATE_FILE), 'utf8'))
    expect(state).toEqual({ JWT_EXP: 200 })
    expect((await store.read()).JWT_EXP).toBe(200)
  })

  it('is read-only without a settings folder', async () => {
    const store = new AuthConfigStore({ env })
    expect((await store.read()).SITE_URL).toBe('http://localhost:3000')
    await expect(store.update({ DISABLE_SIGNUP: true })).rejects.toThrow(
      'AUTH_CONFIG_MANAGEMENT_FOLDER'
    )
  })

  it('validates values', () => {
    expect(() => sanitizePatch([])).toThrow()
    expect(() => sanitizePatch({ DISABLE_SIGNUP: 'yes' })).toThrow('true or false')
    expect(() => sanitizePatch({ JWT_EXP: -1 })).toThrow('number')
    expect(() => sanitizePatch({ SITE_URL: 'not a url' })).toThrow('Site URL')
    expect(sanitizePatch({ JWT_EXP: '60', SAML_ENABLED: true })).toEqual({ JWT_EXP: 60 })
  })

  it('maps the database pool size and durations', () => {
    const templateUrl = () => ''
    expect(
      toEnvironment({ DB_MAX_POOL_SIZE: 20, DB_MAX_POOL_SIZE_UNIT: 'percent' }, { templateUrl })
    ).toEqual({ GOTRUE_DB_CONN_PERCENTAGE: '20' })
    expect(
      toEnvironment({ DB_MAX_POOL_SIZE: 10, API_MAX_REQUEST_DURATION: 15 }, { templateUrl })
    ).toEqual({ GOTRUE_DB_MAX_POOL_SIZE: '10', GOTRUE_API_MAX_REQUEST_DURATION: '15s' })
    expect(parseDuration('1h30m')).toBe(5400)
    expect(parseDuration('250ms')).toBe(0.25)
    expect(parseDuration('soon')).toBeUndefined()
  })
})
