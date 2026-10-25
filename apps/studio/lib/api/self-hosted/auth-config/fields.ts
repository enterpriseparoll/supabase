import type { components } from 'api-types'

/**
 * How self-hosted Studio maps Auth settings (the platform API's field names) to the
 * Auth server's GOTRUE_* environment variables, plus the Auth server's own defaults
 * for anything not configured.
 */

export type AuthConfig = components['schemas']['GoTrueConfigResponse']
export type AuthConfigKey = keyof AuthConfig

export const AUTH_TEMPLATE_NAMES = [
  'CONFIRMATION',
  'EMAIL_CHANGE',
  'EMAIL_CHANGED_NOTIFICATION',
  'IDENTITY_LINKED_NOTIFICATION',
  'IDENTITY_UNLINKED_NOTIFICATION',
  'INVITE',
  'MAGIC_LINK',
  'MFA_FACTOR_ENROLLED_NOTIFICATION',
  'MFA_FACTOR_UNENROLLED_NOTIFICATION',
  'PASSWORD_CHANGED_NOTIFICATION',
  'PHONE_CHANGED_NOTIFICATION',
  'REAUTHENTICATION',
  'RECOVERY',
] as const
export type AuthTemplateName = (typeof AUTH_TEMPLATE_NAMES)[number]

// The Auth server's built-in email bodies, shown until a template is customized.
const DEFAULT_TEMPLATES: Record<AuthTemplateName, string> = {
  INVITE: `<h2>You've been invited</h2>

<p>You've been invited to create an account. Follow the link below to accept.</p>
<p><a href="{{ .ConfirmationURL }}">Accept invitation</a></p>`,
  CONFIRMATION: `<h2>Confirm your email address</h2>

<p>Follow the link below to confirm this email address and finish signing up.</p>
<p><a href="{{ .ConfirmationURL }}">Confirm email address</a></p>
`,
  RECOVERY: `<h2>Reset your password</h2>

<p>We received a request to reset your password. Follow the link below to choose a new one.</p>
<p><a href="{{ .ConfirmationURL }}">Reset password</a></p>
<p>If you didn't request this, you can safely ignore this email.</p>`,
  MAGIC_LINK: `<h2>Your sign-in link</h2>

<p>Follow the link below to sign in. This link expires shortly and can only be used once.</p>
<p><a href="{{ .ConfirmationURL }}">Sign in</a></p>`,
  EMAIL_CHANGE: `<h2>Confirm your new email address</h2>

<p>Follow the link below to confirm {{ .NewEmail }} as your new email address.</p>
<p><a href="{{ .ConfirmationURL }}">Confirm new email address</a></p>
<p>If you didn't request this change, you can safely ignore this email.</p>`,
  REAUTHENTICATION: `<h2>Your verification code</h2>

<p>Use the code below to verify your identity. It expires shortly.</p>
<p>{{ .Token }}</p>`,
  PASSWORD_CHANGED_NOTIFICATION: `<h2>Your password was changed</h2>

<p>The password for your account was recently changed.</p>
<p>If you didn't make this change, reset your password and contact support immediately.</p>
`,
  EMAIL_CHANGED_NOTIFICATION: `<h2>Your email address was changed</h2>

<p>The email address for your account was changed from {{ .OldEmail }} to {{ .Email }}.</p>
<p>If you didn't make this change, contact support immediately.</p>
`,
  PHONE_CHANGED_NOTIFICATION: `<h2>Your phone number was changed</h2>

<p>The phone number for your account was changed from {{ .OldPhone }} to {{ .Phone }}.</p>
<p>If you didn't make this change, contact support immediately.</p>
`,
  IDENTITY_LINKED_NOTIFICATION: `<h2>A new sign-in method was linked</h2>

<p>Your {{ .Provider }} account was linked as a new sign-in method for {{ .Email }}.</p>
<p>If you didn't make this change, contact support immediately.</p>
`,
  IDENTITY_UNLINKED_NOTIFICATION: `<h2>A sign-in method was removed</h2>

<p>Your {{ .Provider }} account was removed as a sign-in method for {{ .Email }}.</p>
<p>If you didn't make this change, contact support immediately.</p>
`,
  MFA_FACTOR_ENROLLED_NOTIFICATION: `<h2>A new verification method was added</h2>

<p>Sign-in verification method {{ .FactorType }} was added to your account.</p>
<p>If you didn't make this change, contact support immediately.</p>
`,
  MFA_FACTOR_UNENROLLED_NOTIFICATION: `<h2>A verification method was removed</h2>

<p>Sign-in verification method {{ .FactorType }} was removed from your account.</p>
<p>If you didn't make this change, contact support immediately.</p>
`,
}

export const AUTH_CONFIG_DEFAULTS: AuthConfig = {
  API_MAX_REQUEST_DURATION: 10,
  AUDIT_LOG_DISABLE_POSTGRES: false,
  CUSTOM_OAUTH_ENABLED: true,
  CUSTOM_OAUTH_MAX_PROVIDERS: 0,
  DB_MAX_POOL_SIZE: null,
  DB_MAX_POOL_SIZE_UNIT: null,
  DISABLE_SIGNUP: false,
  EXTERNAL_ANONYMOUS_USERS_ENABLED: false,
  EXTERNAL_APPLE_ADDITIONAL_CLIENT_IDS: '',
  EXTERNAL_APPLE_CLIENT_ID: '',
  EXTERNAL_APPLE_EMAIL_OPTIONAL: false,
  EXTERNAL_APPLE_ENABLED: false,
  EXTERNAL_APPLE_SECRET: '',
  EXTERNAL_AZURE_CLIENT_ID: '',
  EXTERNAL_AZURE_EMAIL_OPTIONAL: false,
  EXTERNAL_AZURE_ENABLED: false,
  EXTERNAL_AZURE_SECRET: '',
  EXTERNAL_AZURE_URL: '',
  EXTERNAL_BITBUCKET_CLIENT_ID: '',
  EXTERNAL_BITBUCKET_EMAIL_OPTIONAL: false,
  EXTERNAL_BITBUCKET_ENABLED: false,
  EXTERNAL_BITBUCKET_SECRET: '',
  EXTERNAL_DISCORD_CLIENT_ID: '',
  EXTERNAL_DISCORD_EMAIL_OPTIONAL: false,
  EXTERNAL_DISCORD_ENABLED: false,
  EXTERNAL_DISCORD_SECRET: '',
  EXTERNAL_EMAIL_ENABLED: true,
  EXTERNAL_FACEBOOK_CLIENT_ID: '',
  EXTERNAL_FACEBOOK_EMAIL_OPTIONAL: false,
  EXTERNAL_FACEBOOK_ENABLED: false,
  EXTERNAL_FACEBOOK_SECRET: '',
  EXTERNAL_FIGMA_CLIENT_ID: '',
  EXTERNAL_FIGMA_EMAIL_OPTIONAL: false,
  EXTERNAL_FIGMA_ENABLED: false,
  EXTERNAL_FIGMA_SECRET: '',
  EXTERNAL_GITHUB_CLIENT_ID: '',
  EXTERNAL_GITHUB_EMAIL_OPTIONAL: false,
  EXTERNAL_GITHUB_ENABLED: false,
  EXTERNAL_GITHUB_SECRET: '',
  EXTERNAL_GITLAB_CLIENT_ID: '',
  EXTERNAL_GITLAB_EMAIL_OPTIONAL: false,
  EXTERNAL_GITLAB_ENABLED: false,
  EXTERNAL_GITLAB_SECRET: '',
  EXTERNAL_GITLAB_URL: '',
  EXTERNAL_GOOGLE_ADDITIONAL_CLIENT_IDS: '',
  EXTERNAL_GOOGLE_CLIENT_ID: '',
  EXTERNAL_GOOGLE_EMAIL_OPTIONAL: false,
  EXTERNAL_GOOGLE_ENABLED: false,
  EXTERNAL_GOOGLE_SECRET: '',
  EXTERNAL_GOOGLE_SKIP_NONCE_CHECK: false,
  EXTERNAL_KAKAO_CLIENT_ID: '',
  EXTERNAL_KAKAO_EMAIL_OPTIONAL: false,
  EXTERNAL_KAKAO_ENABLED: false,
  EXTERNAL_KAKAO_SECRET: '',
  EXTERNAL_KEYCLOAK_CLIENT_ID: '',
  EXTERNAL_KEYCLOAK_EMAIL_OPTIONAL: false,
  EXTERNAL_KEYCLOAK_ENABLED: false,
  EXTERNAL_KEYCLOAK_SECRET: '',
  EXTERNAL_KEYCLOAK_URL: '',
  EXTERNAL_LINKEDIN_OIDC_CLIENT_ID: '',
  EXTERNAL_LINKEDIN_OIDC_EMAIL_OPTIONAL: false,
  EXTERNAL_LINKEDIN_OIDC_ENABLED: false,
  EXTERNAL_LINKEDIN_OIDC_SECRET: '',
  EXTERNAL_NOTION_CLIENT_ID: '',
  EXTERNAL_NOTION_EMAIL_OPTIONAL: false,
  EXTERNAL_NOTION_ENABLED: false,
  EXTERNAL_NOTION_SECRET: '',
  EXTERNAL_PHONE_ENABLED: false,
  EXTERNAL_SLACK_CLIENT_ID: '',
  EXTERNAL_SLACK_EMAIL_OPTIONAL: false,
  EXTERNAL_SLACK_ENABLED: false,
  EXTERNAL_SLACK_OIDC_CLIENT_ID: '',
  EXTERNAL_SLACK_OIDC_EMAIL_OPTIONAL: false,
  EXTERNAL_SLACK_OIDC_ENABLED: false,
  EXTERNAL_SLACK_OIDC_SECRET: '',
  EXTERNAL_SLACK_SECRET: '',
  EXTERNAL_SPOTIFY_CLIENT_ID: '',
  EXTERNAL_SPOTIFY_EMAIL_OPTIONAL: false,
  EXTERNAL_SPOTIFY_ENABLED: false,
  EXTERNAL_SPOTIFY_SECRET: '',
  EXTERNAL_TWITCH_CLIENT_ID: '',
  EXTERNAL_TWITCH_EMAIL_OPTIONAL: false,
  EXTERNAL_TWITCH_ENABLED: false,
  EXTERNAL_TWITCH_SECRET: '',
  EXTERNAL_TWITTER_CLIENT_ID: '',
  EXTERNAL_TWITTER_EMAIL_OPTIONAL: false,
  EXTERNAL_TWITTER_ENABLED: false,
  EXTERNAL_TWITTER_SECRET: '',
  EXTERNAL_WEB3_ETHEREUM_ENABLED: false,
  EXTERNAL_WEB3_SOLANA_ENABLED: false,
  EXTERNAL_WORKOS_CLIENT_ID: '',
  EXTERNAL_WORKOS_SECRET: '',
  EXTERNAL_WORKOS_URL: '',
  EXTERNAL_ZOOM_CLIENT_ID: '',
  EXTERNAL_ZOOM_EMAIL_OPTIONAL: false,
  EXTERNAL_ZOOM_ENABLED: false,
  EXTERNAL_ZOOM_SECRET: '',
  HOOK_AFTER_USER_CREATED_ENABLED: false,
  HOOK_AFTER_USER_CREATED_SECRETS: '',
  HOOK_AFTER_USER_CREATED_URI: '',
  HOOK_BEFORE_USER_CREATED_ENABLED: false,
  HOOK_BEFORE_USER_CREATED_SECRETS: '',
  HOOK_BEFORE_USER_CREATED_URI: '',
  HOOK_CUSTOM_ACCESS_TOKEN_ENABLED: false,
  HOOK_CUSTOM_ACCESS_TOKEN_SECRETS: '',
  HOOK_CUSTOM_ACCESS_TOKEN_URI: '',
  HOOK_MFA_VERIFICATION_ATTEMPT_ENABLED: false,
  HOOK_MFA_VERIFICATION_ATTEMPT_SECRETS: '',
  HOOK_MFA_VERIFICATION_ATTEMPT_URI: '',
  HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED: false,
  HOOK_PASSWORD_VERIFICATION_ATTEMPT_SECRETS: '',
  HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI: '',
  HOOK_SEND_EMAIL_ENABLED: false,
  HOOK_SEND_EMAIL_SECRETS: '',
  HOOK_SEND_EMAIL_URI: '',
  HOOK_SEND_SMS_ENABLED: false,
  HOOK_SEND_SMS_SECRETS: '',
  HOOK_SEND_SMS_URI: '',
  INDEX_WORKER_ENSURE_USER_SEARCH_INDEXES_EXIST: null,
  JWT_EXP: 3600,
  MAILER_ALLOW_UNVERIFIED_EMAIL_SIGN_INS: false,
  MAILER_AUTOCONFIRM: false,
  MAILER_NOTIFICATIONS_EMAIL_CHANGED_ENABLED: false,
  MAILER_NOTIFICATIONS_IDENTITY_LINKED_ENABLED: false,
  MAILER_NOTIFICATIONS_IDENTITY_UNLINKED_ENABLED: false,
  MAILER_NOTIFICATIONS_MFA_FACTOR_ENROLLED_ENABLED: false,
  MAILER_NOTIFICATIONS_MFA_FACTOR_UNENROLLED_ENABLED: false,
  MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED: false,
  MAILER_NOTIFICATIONS_PHONE_CHANGED_ENABLED: false,
  MAILER_OTP_EXP: 86400,
  MAILER_OTP_LENGTH: 6,
  MAILER_SECURE_EMAIL_CHANGE_ENABLED: true,
  MAILER_SUBJECTS_CONFIRMATION: 'Confirm your email address',
  MAILER_SUBJECTS_CUSTOM_CONTENTS: {
    MAILER_SUBJECTS_CONFIRMATION: false,
    MAILER_SUBJECTS_EMAIL_CHANGE: false,
    MAILER_SUBJECTS_EMAIL_CHANGED_NOTIFICATION: false,
    MAILER_SUBJECTS_IDENTITY_LINKED_NOTIFICATION: false,
    MAILER_SUBJECTS_IDENTITY_UNLINKED_NOTIFICATION: false,
    MAILER_SUBJECTS_INVITE: false,
    MAILER_SUBJECTS_MAGIC_LINK: false,
    MAILER_SUBJECTS_MFA_FACTOR_ENROLLED_NOTIFICATION: false,
    MAILER_SUBJECTS_MFA_FACTOR_UNENROLLED_NOTIFICATION: false,
    MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION: false,
    MAILER_SUBJECTS_PHONE_CHANGED_NOTIFICATION: false,
    MAILER_SUBJECTS_REAUTHENTICATION: false,
    MAILER_SUBJECTS_RECOVERY: false,
  },
  MAILER_SUBJECTS_EMAIL_CHANGE: 'Confirm your new email address',
  MAILER_SUBJECTS_EMAIL_CHANGED_NOTIFICATION: 'Your email address was changed',
  MAILER_SUBJECTS_IDENTITY_LINKED_NOTIFICATION: 'A new sign-in method was linked to your account',
  MAILER_SUBJECTS_IDENTITY_UNLINKED_NOTIFICATION: 'A sign-in method was removed from your account',
  MAILER_SUBJECTS_INVITE: "You've been invited",
  MAILER_SUBJECTS_MAGIC_LINK: 'Your sign-in link',
  MAILER_SUBJECTS_MFA_FACTOR_ENROLLED_NOTIFICATION:
    'A new verification method was added to your account',
  MAILER_SUBJECTS_MFA_FACTOR_UNENROLLED_NOTIFICATION:
    'A verification method was removed from your account',
  MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION: 'Your password was changed',
  MAILER_SUBJECTS_PHONE_CHANGED_NOTIFICATION: 'Your phone number was changed',
  MAILER_SUBJECTS_REAUTHENTICATION: '{{ .Token }} is your verification code',
  MAILER_SUBJECTS_RECOVERY: 'Reset your password',
  MAILER_TEMPLATES_CONFIRMATION_CONTENT: DEFAULT_TEMPLATES.CONFIRMATION,
  MAILER_TEMPLATES_CUSTOM_CONTENTS: {
    MAILER_TEMPLATES_CONFIRMATION_CONTENT: false,
    MAILER_TEMPLATES_EMAIL_CHANGE_CONTENT: false,
    MAILER_TEMPLATES_EMAIL_CHANGED_NOTIFICATION_CONTENT: false,
    MAILER_TEMPLATES_IDENTITY_LINKED_NOTIFICATION_CONTENT: false,
    MAILER_TEMPLATES_IDENTITY_UNLINKED_NOTIFICATION_CONTENT: false,
    MAILER_TEMPLATES_INVITE_CONTENT: false,
    MAILER_TEMPLATES_MAGIC_LINK_CONTENT: false,
    MAILER_TEMPLATES_MFA_FACTOR_ENROLLED_NOTIFICATION_CONTENT: false,
    MAILER_TEMPLATES_MFA_FACTOR_UNENROLLED_NOTIFICATION_CONTENT: false,
    MAILER_TEMPLATES_PASSWORD_CHANGED_NOTIFICATION_CONTENT: false,
    MAILER_TEMPLATES_PHONE_CHANGED_NOTIFICATION_CONTENT: false,
    MAILER_TEMPLATES_REAUTHENTICATION_CONTENT: false,
    MAILER_TEMPLATES_RECOVERY_CONTENT: false,
  },
  MAILER_TEMPLATES_EMAIL_CHANGE_CONTENT: DEFAULT_TEMPLATES.EMAIL_CHANGE,
  MAILER_TEMPLATES_EMAIL_CHANGED_NOTIFICATION_CONTENT: DEFAULT_TEMPLATES.EMAIL_CHANGED_NOTIFICATION,
  MAILER_TEMPLATES_IDENTITY_LINKED_NOTIFICATION_CONTENT:
    DEFAULT_TEMPLATES.IDENTITY_LINKED_NOTIFICATION,
  MAILER_TEMPLATES_IDENTITY_UNLINKED_NOTIFICATION_CONTENT:
    DEFAULT_TEMPLATES.IDENTITY_UNLINKED_NOTIFICATION,
  MAILER_TEMPLATES_INVITE_CONTENT: DEFAULT_TEMPLATES.INVITE,
  MAILER_TEMPLATES_MAGIC_LINK_CONTENT: DEFAULT_TEMPLATES.MAGIC_LINK,
  MAILER_TEMPLATES_MFA_FACTOR_ENROLLED_NOTIFICATION_CONTENT:
    DEFAULT_TEMPLATES.MFA_FACTOR_ENROLLED_NOTIFICATION,
  MAILER_TEMPLATES_MFA_FACTOR_UNENROLLED_NOTIFICATION_CONTENT:
    DEFAULT_TEMPLATES.MFA_FACTOR_UNENROLLED_NOTIFICATION,
  MAILER_TEMPLATES_PASSWORD_CHANGED_NOTIFICATION_CONTENT:
    DEFAULT_TEMPLATES.PASSWORD_CHANGED_NOTIFICATION,
  MAILER_TEMPLATES_PHONE_CHANGED_NOTIFICATION_CONTENT: DEFAULT_TEMPLATES.PHONE_CHANGED_NOTIFICATION,
  MAILER_TEMPLATES_REAUTHENTICATION_CONTENT: DEFAULT_TEMPLATES.REAUTHENTICATION,
  MAILER_TEMPLATES_RECOVERY_CONTENT: DEFAULT_TEMPLATES.RECOVERY,
  MFA_ALLOW_LOW_AAL: false,
  MFA_MAX_ENROLLED_FACTORS: 10,
  MFA_PHONE_ENROLL_ENABLED: false,
  MFA_PHONE_MAX_FREQUENCY: 60,
  MFA_PHONE_OTP_LENGTH: 6,
  MFA_PHONE_TEMPLATE: 'Your code is {{ .Code }}',
  MFA_PHONE_VERIFY_ENABLED: false,
  MFA_TOTP_ENROLL_ENABLED: true,
  MFA_TOTP_VERIFY_ENABLED: true,
  MFA_WEB_AUTHN_ENROLL_ENABLED: false,
  MFA_WEB_AUTHN_VERIFY_ENABLED: false,
  NIMBUS_OAUTH_CLIENT_ID: null,
  NIMBUS_OAUTH_CLIENT_SECRET: null,
  OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION: false,
  OAUTH_SERVER_AUTHORIZATION_PATH: null,
  OAUTH_SERVER_ENABLED: false,
  PASSKEY_ENABLED: false,
  PASSWORD_HIBP_ENABLED: false,
  PASSWORD_MIN_LENGTH: 6,
  PASSWORD_REQUIRED_CHARACTERS: '',
  RATE_LIMIT_ANONYMOUS_USERS: 30,
  RATE_LIMIT_EMAIL_SENT: 30,
  RATE_LIMIT_OTP: 30,
  RATE_LIMIT_SMS_SENT: 30,
  RATE_LIMIT_TOKEN_REFRESH: 150,
  RATE_LIMIT_VERIFY: 30,
  RATE_LIMIT_WEB3: 30,
  REFRESH_TOKEN_ROTATION_ENABLED: true,
  SAML_ALLOW_ENCRYPTED_ASSERTIONS: false,
  SAML_ENABLED: false,
  SAML_EXTERNAL_URL: '',
  SECURITY_CAPTCHA_ENABLED: false,
  SECURITY_CAPTCHA_PROVIDER: 'hcaptcha',
  SECURITY_CAPTCHA_SECRET: '',
  SECURITY_MANUAL_LINKING_ENABLED: false,
  SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: 0,
  SECURITY_SB_FORWARDED_FOR_ENABLED: false,
  SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD: false,
  SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION: false,
  SESSIONS_INACTIVITY_TIMEOUT: 0,
  SESSIONS_SINGLE_PER_USER: false,
  SESSIONS_TAGS: '',
  SESSIONS_TIMEBOX: 0,
  SITE_URL: '',
  SMS_AUTOCONFIRM: false,
  SMS_MAX_FREQUENCY: 60,
  SMS_MESSAGEBIRD_ACCESS_KEY: '',
  SMS_MESSAGEBIRD_ORIGINATOR: '',
  SMS_OTP_EXP: 60,
  SMS_OTP_LENGTH: 6,
  SMS_PROVIDER: '',
  SMS_TEMPLATE: 'Your code is {{ .Code }}',
  SMS_TEST_OTP: '',
  SMS_TEST_OTP_VALID_UNTIL: '',
  SMS_TEXTLOCAL_API_KEY: '',
  SMS_TEXTLOCAL_SENDER: '',
  SMS_TWILIO_ACCOUNT_SID: '',
  SMS_TWILIO_AUTH_TOKEN: '',
  SMS_TWILIO_CONTENT_SID: '',
  SMS_TWILIO_MESSAGE_SERVICE_SID: '',
  SMS_TWILIO_VERIFY_ACCOUNT_SID: '',
  SMS_TWILIO_VERIFY_AUTH_TOKEN: '',
  SMS_TWILIO_VERIFY_MESSAGE_SERVICE_SID: '',
  SMS_VONAGE_API_KEY: '',
  SMS_VONAGE_API_SECRET: '',
  SMS_VONAGE_FROM: '',
  SMTP_ADMIN_EMAIL: '',
  SMTP_HOST: '',
  SMTP_MAX_FREQUENCY: 60,
  SMTP_PASS: '',
  SMTP_PORT: '',
  SMTP_SENDER_NAME: '',
  SMTP_USER: '',
  URI_ALLOW_LIST: '',
  WEBAUTHN_RP_DISPLAY_NAME: null,
  WEBAUTHN_RP_ID: null,
  WEBAUTHN_RP_ORIGINS: null,
}

type FieldKind = 'boolean' | 'number' | 'string' | 'seconds' | 'optional-seconds'

// Values the Auth server reads as Go durations; the API uses whole seconds.
const DURATION_FIELDS: Partial<Record<AuthConfigKey, FieldKind>> = {
  API_MAX_REQUEST_DURATION: 'seconds',
  MFA_PHONE_MAX_FREQUENCY: 'seconds',
  SMS_MAX_FREQUENCY: 'seconds',
  SMTP_MAX_FREQUENCY: 'seconds',
  // Unset means "never"; zero is rejected by the Auth server.
  SESSIONS_INACTIVITY_TIMEOUT: 'optional-seconds',
  SESSIONS_TIMEBOX: 'optional-seconds',
}

// Fields whose default is null still have a type.
const NULLABLE_FIELDS: Partial<Record<AuthConfigKey, FieldKind>> = {
  DB_MAX_POOL_SIZE: 'number',
  INDEX_WORKER_ENSURE_USER_SEARCH_INDEXES_EXIST: 'boolean',
  OAUTH_SERVER_AUTHORIZATION_PATH: 'string',
  WEBAUTHN_RP_DISPLAY_NAME: 'string',
  WEBAUTHN_RP_ID: 'string',
  WEBAUTHN_RP_ORIGINS: 'string',
}

// Platform-only settings, or settings that need files Studio can't provide (SAML keys).
const READ_ONLY_FIELDS = new Set<string>([
  'CUSTOM_OAUTH_MAX_PROVIDERS',
  'MAILER_SUBJECTS_CUSTOM_CONTENTS',
  'MAILER_TEMPLATES_CUSTOM_CONTENTS',
  'NIMBUS_OAUTH_CLIENT_ID',
  'NIMBUS_OAUTH_CLIENT_SECRET',
  'SAML_ALLOW_ENCRYPTED_ASSERTIONS',
  'SAML_ENABLED',
  'SAML_EXTERNAL_URL',
])

// List-like values that fail to parse when empty, so an empty value is left out.
const OMIT_WHEN_EMPTY = new Set<string>([
  'SESSIONS_TAGS',
  'SMS_TEST_OTP',
  'SMS_TEST_OTP_VALID_UNTIL',
  'WEBAUTHN_RP_ORIGINS',
])

// Write-only: never returned once saved.
export const MASKED_FIELDS = new Set<string>(['SMTP_PASS'])
export const MASK = '******'

const TEMPLATE_FIELD = /^MAILER_TEMPLATES_([A-Z_]+)_CONTENT$/
const PROVIDER_FIELD = /^EXTERNAL_([A-Z0-9_]+)_(CLIENT_ID|SECRET|ENABLED|URL|EMAIL_OPTIONAL)$/

export function templateNameOf(key: string): AuthTemplateName | undefined {
  const name = key.match(TEMPLATE_FIELD)?.[1]
  return AUTH_TEMPLATE_NAMES.find((template) => template === name)
}

export function fieldKind(key: string): FieldKind | undefined {
  if (!(key in AUTH_CONFIG_DEFAULTS) || READ_ONLY_FIELDS.has(key)) return undefined
  const typedKey = key as AuthConfigKey
  const explicit = DURATION_FIELDS[typedKey] ?? NULLABLE_FIELDS[typedKey]
  if (explicit) return explicit
  const value = AUTH_CONFIG_DEFAULTS[typedKey]
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  return undefined
}

export class AuthConfigError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message)
  }
}

export type StoredValue = string | number | boolean | null
export type StoredConfig = Record<string, StoredValue>

const MAX_STRING = 1_000_000

/**
 * Checks a PATCH body against the known fields. Unknown and read-only fields are
 * skipped, like the platform API does for fields a project can't change.
 */
export function sanitizePatch(body: unknown): StoredConfig {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new AuthConfigError('Send the settings to change as a JSON object.')
  const result: StoredConfig = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'DB_MAX_POOL_SIZE_UNIT') {
      if (value !== null && value !== 'connections' && value !== 'percent')
        throw new AuthConfigError('DB_MAX_POOL_SIZE_UNIT must be "connections" or "percent".')
      result[key] = value
      continue
    }
    const kind = fieldKind(key)
    if (!kind || value === undefined) continue
    if (value === null) {
      result[key] = null
      continue
    }
    if (kind === 'boolean') {
      if (typeof value !== 'boolean') throw new AuthConfigError(`${key} must be true or false.`)
    } else if (kind === 'string') {
      if (typeof value !== 'string') throw new AuthConfigError(`${key} must be text.`)
      if (value.length > MAX_STRING || value.includes('\u0000'))
        throw new AuthConfigError(`${key} is too long or contains invalid characters.`)
    } else {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0)
        throw new AuthConfigError(`${key} must be a number of 0 or more.`)
      result[key] = number
      continue
    }
    if (MASKED_FIELDS.has(key) && value === MASK) continue
    result[key] = value
  }
  if (typeof result.SITE_URL === 'string' && !/^https?:\/\/\S+$/.test(result.SITE_URL))
    throw new AuthConfigError('Site URL must be a full http:// or https:// address.')
  return result
}

// Go duration strings ("1m30s", "3600s", "24h") to seconds.
export function parseDuration(value: string): number | undefined {
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const units: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    µs: 1e-6,
    ms: 1e-3,
    s: 1,
    m: 60,
    h: 3600,
  }
  const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)]
  if (!parts.length || parts.map((part) => part[0]).join('') !== trimmed) return undefined
  return parts.reduce((total, [, amount, unit]) => total + Number(amount) * units[unit], 0)
}

/** Reads one field from the Auth server's environment, in API form. */
export function fromEnvironment(key: string, raw: string | undefined): StoredValue | undefined {
  const kind = fieldKind(key)
  if (!kind || raw === undefined) return undefined
  if (kind === 'string') return raw
  if (raw.trim() === '') return undefined
  if (kind === 'boolean') {
    const lowered = raw.trim().toLowerCase()
    if (['1', 't', 'true'].includes(lowered)) return true
    if (['0', 'f', 'false'].includes(lowered)) return false
    return undefined
  }
  if (kind === 'number') {
    const number = Number(raw)
    return Number.isFinite(number) ? number : undefined
  }
  return parseDuration(raw)
}

export const environmentName = (key: string) => `GOTRUE_${key}`

/**
 * The Auth server's settings file (GOTRUE_* names to string values) for the stored
 * settings. Templates point at Studio, which serves their content.
 */
export function toEnvironment(
  stored: StoredConfig,
  {
    templateUrl,
    callbackUrl,
  }: { templateUrl: (name: AuthTemplateName) => string; callbackUrl?: string }
): Record<string, string> {
  const env: Record<string, string> = {}
  const providers = new Set<string>()
  for (const [key, value] of Object.entries(stored)) {
    const template = templateNameOf(key)
    if (template) {
      if (typeof value === 'string' && value !== '')
        env[`GOTRUE_MAILER_TEMPLATES_${template}`] = templateUrl(template)
      continue
    }
    const provider = key.match(PROVIDER_FIELD)?.[1]
    if (provider && `EXTERNAL_${provider}_CLIENT_ID` in AUTH_CONFIG_DEFAULTS)
      providers.add(provider)
    if (key === 'DB_MAX_POOL_SIZE' || key === 'DB_MAX_POOL_SIZE_UNIT') continue
    const kind = fieldKind(key)
    if (!kind) continue
    // Clearing text (turning off custom SMTP, say) must override the starting value.
    if (value === null) {
      if (kind === 'string' && !OMIT_WHEN_EMPTY.has(key)) env[environmentName(key)] = ''
      continue
    }
    if (kind === 'optional-seconds' || kind === 'seconds') {
      if (kind === 'optional-seconds' && !value) continue
      env[environmentName(key)] = `${Number(value)}s`
      continue
    }
    const text = String(value)
    if (text === '' && OMIT_WHEN_EMPTY.has(key)) continue
    env[environmentName(key)] = text
  }
  const poolSize = stored.DB_MAX_POOL_SIZE
  if (typeof poolSize === 'number') {
    if (stored.DB_MAX_POOL_SIZE_UNIT === 'percent') env.GOTRUE_DB_CONN_PERCENTAGE = String(poolSize)
    else env.GOTRUE_DB_MAX_POOL_SIZE = String(poolSize)
  }
  // OAuth providers need a callback address; the platform fills it in for you.
  if (callbackUrl)
    for (const provider of providers) env[`GOTRUE_EXTERNAL_${provider}_REDIRECT_URI`] = callbackUrl
  return env
}
