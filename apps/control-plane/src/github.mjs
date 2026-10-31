// GitHub integration: a project follows one branch of a repository. New commits
// apply pending migrations from <directory>/migrations (recorded exactly like
// `supabase db push`) and deploy Edge Functions from <directory>/functions.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { audit, transaction } from './database.mjs'
import { hash, HttpError, invariant, seal, unseal } from './core.mjs'
import { enqueue, projectAccess } from './service.mjs'
import { DeploymentError, FUNCTION_NAME } from './project-db.mjs'

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const SHA = /^[0-9a-f]{40}$/
const API = 'https://api.github.com'

export function githubLinkInput(input = {}) {
  invariant(input && typeof input === 'object', 400, 'Provide the repository details')
  let repository = typeof input.repository === 'string' ? input.repository.trim() : ''
  // Accept a pasted URL: https://github.com/owner/name(.git)
  repository = repository
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  invariant(
    REPOSITORY.test(repository) && !repository.endsWith('.'),
    400,
    'Enter the repository as owner/name'
  )
  const branch =
    typeof input.branch === 'string' && input.branch.trim() ? input.branch.trim() : 'main'
  invariant(
    branch.length <= 255 &&
      /^[A-Za-z0-9._\/-]+$/.test(branch) &&
      !branch.includes('..') &&
      !branch.includes('//') &&
      !branch.startsWith('/') &&
      !branch.endsWith('/') &&
      !branch.endsWith('.lock'),
    400,
    'Enter a valid branch name'
  )
  const directory = (typeof input.directory === 'string' ? input.directory : 'supabase')
    .trim()
    .replace(/^\.?\/+|\/+$/g, '')
  invariant(
    directory.length <= 200 &&
      (directory === '' ||
        directory
          .split('/')
          .every((part) => /^[A-Za-z0-9._-]+$/.test(part) && !/^\.\.?$/.test(part))),
    400,
    'Enter the folder that contains migrations/ and functions/, for example supabase'
  )
  const token =
    input.token === undefined || input.token === null || input.token === ''
      ? undefined
      : input.token
  invariant(
    token === undefined || (typeof token === 'string' && /^[A-Za-z0-9_]{20,255}$/.test(token)),
    400,
    'The GitHub token looks wrong. Paste a fine-grained token with read access to contents.'
  )
  invariant(
    input.autoDeploy === undefined || typeof input.autoDeploy === 'boolean',
    400,
    'autoDeploy must be true or false'
  )
  return {
    repository,
    branch,
    directory,
    token,
    clearToken: input.clearToken === true,
    autoDeploy: input.autoDeploy ?? true,
  }
}

export const webhookSecret = (config, projectId) =>
  createHmac('sha256', config.key).update(`github-webhook:${projectId}`).digest('hex')

export function verifyWebhookSignature(secret, body, signature) {
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
}

export const linkToken = (config, link) =>
  link.encrypted_token
    ? unseal(link.encrypted_token, config.key, `github:${link.project_id}`).token
    : null

export const publicLink = (link) =>
  link && {
    repository: link.repository,
    branch: link.branch,
    directory: link.directory,
    autoDeploy: link.auto_deploy,
    hasToken: Boolean(link.encrypted_token),
    headSha: link.head_sha,
    checkedAt: link.checked_at,
    checkError: link.check_error,
    createdAt: link.created_at,
  }

// ---- API side ----
export async function saveGithubLink(db, config, actor, id, input) {
  const values = githubLinkInput(input)
  return transaction(db, async (client) => {
    await projectAccess(client, actor, id, 'operate')
    const existing = (
      await client.query('SELECT * FROM control.github_links WHERE project_id=$1', [id])
    ).rows[0]
    const encryptedToken = values.token
      ? seal({ token: values.token }, config.key, `github:${id}`)
      : values.clearToken
        ? null
        : (existing?.encrypted_token ?? null)
    const changed =
      !existing ||
      existing.repository !== values.repository ||
      existing.branch !== values.branch ||
      existing.directory !== values.directory
    const row = (
      await client.query(
        `INSERT INTO control.github_links(project_id,repository,branch,directory,encrypted_token,auto_deploy,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (project_id) DO UPDATE SET repository=excluded.repository, branch=excluded.branch,
           directory=excluded.directory, encrypted_token=excluded.encrypted_token, auto_deploy=excluded.auto_deploy,
           etag=CASE WHEN $8 THEN NULL ELSE control.github_links.etag END,
           head_sha=CASE WHEN $8 THEN NULL ELSE control.github_links.head_sha END,
           checked_at=NULL, check_error=NULL
         RETURNING *`,
        [
          id,
          values.repository,
          values.branch,
          values.directory,
          encryptedToken,
          values.autoDeploy,
          actor,
          changed,
        ]
      )
    ).rows[0]
    await audit(client, actor, 'project.github.linked', id, {
      repository: values.repository,
      branch: values.branch,
    })
    return publicLink(row)
  })
}

export async function removeGithubLink(db, actor, id) {
  return transaction(db, async (client) => {
    await projectAccess(client, actor, id, 'operate')
    await client.query('DELETE FROM control.github_links WHERE project_id=$1', [id])
    await audit(client, actor, 'project.github.unlinked', id)
    return { ok: true }
  })
}

export async function githubStatus(db, config, actor, id) {
  await projectAccess(db, actor, id, 'read')
  const link = (await db.query('SELECT * FROM control.github_links WHERE project_id=$1', [id]))
    .rows[0]
  const deployments = (
    await db.query(
      `SELECT id, source, repository, branch, commit_sha, state, migrations, functions, warnings, error, created_at, finished_at
       FROM control.deployments WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [id]
    )
  ).rows
  return {
    link: publicLink(link) ?? null,
    deployments,
    webhookUrl: `${config.origin}/hooks/github/${id}`,
  }
}

// GitHub push webhook (servers with a public address). Authenticated by signature.
export async function handleWebhook(pool, config, id, headers, body) {
  const link = (await pool.query('SELECT * FROM control.github_links WHERE project_id=$1', [id]))
    .rows[0]
  invariant(
    link && verifyWebhookSignature(webhookSecret(config, id), body, headers['x-hub-signature-256']),
    401,
    'Invalid webhook signature'
  )
  const event = headers['x-github-event']
  if (event === 'ping') return { ok: true }
  if (event !== 'push') return { ignored: true }
  let payload
  try {
    payload = JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
  if (
    payload.ref !== `refs/heads/${link.branch}` ||
    String(payload.repository?.full_name).toLowerCase() !== link.repository.toLowerCase() ||
    !SHA.test(payload.after ?? '') ||
    /^0+$/.test(payload.after) ||
    !link.auto_deploy
  )
    return { ignored: true }
  await queueDeployment(pool, link, payload.after, 'push')
  return { queued: true }
}

// Queues one deployment per commit; repeated notifications for a commit are ignored.
export async function queueDeployment(pool, link, sha, source, extra = {}) {
  return transaction(pool, async (db) => {
    const key = `github-${link.project_id}-${sha}`
    const already = (
      await db.query(
        `SELECT 1 FROM control.operations WHERE project_id=$1 AND kind='deploy' AND (state IN ('queued','running') OR idempotency_key=$2)
         UNION ALL SELECT 1 FROM control.deployments WHERE project_id=$1 AND commit_sha=$3`,
        [link.project_id, key, sha]
      )
    ).rowCount
    if (already) return null
    const payload = { sha, source, ...extra }
    return enqueue(db, {
      actor: '@github',
      project: link.project_id,
      kind: 'deploy',
      payload,
      key,
      requestHash: hash(JSON.stringify(payload)),
    })
  })
}

// ---- GitHub REST API ----
export class GithubError extends Error {
  constructor(code, message, retryAt) {
    super(message)
    this.code = code
    this.retryAt = retryAt
  }
}
async function github(
  path,
  { token, accept = 'application/vnd.github+json', etag, fetchImpl = fetch, timeout = 20000 }
) {
  const response = await fetchImpl(`${API}${path}`, {
    headers: {
      Accept: accept,
      'User-Agent': 'supabase-platform',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  })
  if (response.status === 304) return { notModified: true, response }
  if (response.ok) return { response }
  const remaining = response.headers.get('x-ratelimit-remaining')
  if ((response.status === 403 || response.status === 429) && remaining === '0')
    throw new GithubError(
      'RATE_LIMITED',
      'GitHub rate limit reached. Add a token to raise the limit.',
      Number(response.headers.get('x-ratelimit-reset')) * 1000 || Date.now() + 3600000
    )
  if (response.status === 401)
    throw new GithubError('TOKEN_INVALID', 'GitHub rejected the token. Paste a new one.')
  if (response.status === 404 || response.status === 403)
    throw new GithubError(
      'NOT_FOUND',
      token
        ? 'Repository or branch not found, or the token cannot read it.'
        : 'Repository or branch not found. For a private repository, add a token.'
    )
  throw new GithubError('GITHUB_UNAVAILABLE', `GitHub returned ${response.status}`)
}

export async function headCommit(link, token, { etag, fetchImpl } = {}) {
  const result = await github(
    `/repos/${link.repository}/commits/${encodeURIComponent(link.branch)}`,
    { token, accept: 'application/vnd.github.sha', etag, fetchImpl }
  )
  if (result.notModified) return { notModified: true }
  const sha = (await result.response.text()).trim()
  invariant(SHA.test(sha), 502, 'GitHub returned an unexpected commit')
  return { sha, etag: result.response.headers.get('etag') }
}

// ---- Repository contents ----
// Reads a GitHub tarball as a stream and keeps only migrations, the seed file, and
// Edge Functions under `directory`. Links and other entry types are never extracted.
export async function readRepository(stream, directory, limits = {}) {
  const maxArchive = limits.maxArchive ?? 500 * 1024 * 1024
  const maxFile = limits.maxFile ?? 5 * 1024 * 1024
  const maxKept = limits.maxKept ?? 50 * 1024 * 1024
  const prefix = directory ? `${directory}/` : ''
  const wanted = (path) =>
    path === `${prefix}seed.sql` ||
    (path.startsWith(`${prefix}migrations/`) &&
      /^[^/]+\.sql$/.test(path.slice(`${prefix}migrations/`.length))) ||
    path.startsWith(`${prefix}functions/`)
  const files = new Map()
  let buffer = Buffer.alloc(0)
  let total = 0
  let kept = 0
  let state = 'header'
  let entry = null
  let padding = 0
  let nextPath = null // from a pax ("x") or GNU long-name ("L") entry
  const finish = () => {
    if (!entry.keep) return
    const content = Buffer.concat(entry.chunks)
    if (entry.meta === 'L') nextPath = content.toString('utf8').replace(/\0+$/, '')
    else if (entry.meta === 'x') {
      for (const record of content.toString('utf8').split('\n')) {
        const match = record.match(/^\d+ path=(.*)$/)
        if (match) nextPath = match[1]
      }
    } else files.set(entry.path, content)
  }
  for await (const chunk of stream.pipe(createGunzip())) {
    total += chunk.length
    if (total > maxArchive)
      throw new DeploymentError('The repository archive is larger than 500 MB')
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      if (state === 'header') {
        if (buffer.length < 512) break
        const header = buffer.subarray(0, 512)
        buffer = buffer.subarray(512)
        if (header.every((byte) => byte === 0)) continue
        const field = (start, length) => {
          const raw = header.subarray(start, start + length)
          const end = raw.indexOf(0)
          return raw.subarray(0, end === -1 ? length : end).toString('utf8')
        }
        const size = parseInt(field(124, 12).trim() || '0', 8)
        if (!Number.isSafeInteger(size) || size < 0)
          throw new DeploymentError('The repository archive is damaged')
        const type = field(156, 1) || '0'
        if (['x', 'L', 'g'].includes(type)) {
          entry = { size, remaining: size, chunks: [], keep: type !== 'g', meta: type }
        } else {
          const ustarPrefix = field(345, 155)
          const name = nextPath ?? (ustarPrefix ? `${ustarPrefix}/${field(0, 100)}` : field(0, 100))
          nextPath = null
          // GitHub tarballs wrap everything in one top-level folder.
          const path = name.split('/').slice(1).join('/')
          // Regular files only: links and devices are never extracted.
          const keep = (type === '0' || type === '7') && wanted(path)
          if (keep && size > maxFile) throw new DeploymentError(`${path} is larger than 5 MB`)
          if (keep && (kept += size) > maxKept)
            throw new DeploymentError('Migrations and functions are larger than 50 MB')
          entry = { size, remaining: size, chunks: [], keep, path }
        }
        padding = (512 - (size % 512)) % 512
        state = 'body'
      }
      if (state === 'body') {
        const take = Math.min(entry.remaining, buffer.length)
        if (entry.keep && take) entry.chunks.push(Buffer.from(buffer.subarray(0, take)))
        entry.remaining -= take
        buffer = buffer.subarray(take)
        if (entry.remaining > 0) break
        state = 'padding'
      }
      if (state === 'padding') {
        const take = Math.min(padding, buffer.length)
        padding -= take
        buffer = buffer.subarray(take)
        if (padding > 0) break
        finish()
        entry = null
        state = 'header'
      }
    }
  }
  if (state !== 'header') throw new DeploymentError('The repository archive ended unexpectedly')
  return files
}

// Turns kept repository files into migrations, a seed, and function folders.
export function repositoryPlan(files, directory) {
  const prefix = directory ? `${directory}/` : ''
  const migrations = []
  const functions = new Map()
  const warnings = []
  for (const [path, content] of files) {
    const relative = path.slice(prefix.length)
    if (relative.startsWith('migrations/')) {
      const file = relative.slice('migrations/'.length)
      const match = file.match(/^([0-9]+)_(.*)\.sql$/)
      if (!match) {
        warnings.push(`Skipped migrations/${file}: names must look like 20240101000000_name.sql`)
        continue
      }
      migrations.push({ version: match[1], name: match[2], file, sql: content.toString('utf8') })
    } else if (relative.startsWith('functions/')) {
      const [name, ...rest] = relative.slice('functions/'.length).split('/')
      if (!rest.length) {
        if (!['.gitignore', '.env.example', 'README.md'].includes(name))
          warnings.push(`Skipped functions/${name}: put shared files in functions/_shared/`)
        continue
      }
      if (!FUNCTION_NAME.test(name) || name === 'main') {
        warnings.push(
          `Skipped functions/${name}: ${name === 'main' ? 'the name is reserved' : 'invalid folder name'}`
        )
        continue
      }
      if (rest.at(-1) === '.env' || rest.some((part) => part.startsWith('.env'))) continue
      if (!functions.has(name)) functions.set(name, [])
      functions.get(name).push({ name: rest.join('/'), content })
    }
  }
  const versions = new Map()
  for (const migration of migrations) {
    if (versions.has(migration.version))
      throw new DeploymentError(
        `Two migrations share version ${migration.version}: ${versions.get(migration.version)} and ${migration.file}`
      )
    versions.set(migration.version, migration.file)
  }
  migrations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const seedContent = files.get(`${prefix}seed.sql`)
  const seed = seedContent && {
    path: 'supabase/seed.sql',
    sql: seedContent.toString('utf8'),
    hash: createHash('sha256').update(seedContent).digest('hex'),
  }
  // Functions without index.ts would not start; report them instead.
  for (const [name, list] of functions)
    if (!name.startsWith('_') && !list.some((file) => file.name === 'index.ts')) {
      warnings.push(`Skipped functions/${name}: it has no index.ts`)
      functions.delete(name)
    }
  return { migrations, seed, functions, warnings }
}

export async function downloadRepository(link, sha, token, { fetchImpl } = {}) {
  const { response } = await github(`/repos/${link.repository}/tarball/${sha}`, {
    token,
    accept: 'application/vnd.github+json',
    fetchImpl,
    timeout: 300000,
  })
  return readRepository(Readable.fromWeb(response.body), link.directory)
}

// ---- Worker side ----
export async function runDeployment({ db, config, projectDb, project, operation, fetchImpl }) {
  const link = (
    await db.query('SELECT * FROM control.github_links WHERE project_id=$1', [project.id])
  ).rows[0]
  invariant(link, 409, 'GITHUB_NOT_LINKED')
  invariant(project.desired_state === 'running', 409, 'PROJECT_PAUSED')
  const source = operation.payload.source ?? 'manual'
  await db.query(
    `INSERT INTO control.deployments(id,project_id,operation_id,source,repository,branch,state)
     VALUES($1,$2,$1,$3,$4,$5,'running')
     ON CONFLICT (id) DO UPDATE SET state='running', error=NULL, finished_at=NULL`,
    [operation.id, project.id, source, link.repository, link.branch]
  )
  const record = (fields) =>
    db.query(
      `UPDATE control.deployments SET commit_sha=COALESCE($2,commit_sha), state=COALESCE($3,state),
         migrations=COALESCE($4,migrations), functions=COALESCE($5,functions), warnings=COALESCE($6,warnings),
         error=$7, finished_at=CASE WHEN $3 IN ('succeeded','failed') THEN now() ELSE finished_at END WHERE id=$1`,
      [
        operation.id,
        fields.sha ?? null,
        fields.state ?? null,
        fields.migrations ? JSON.stringify(fields.migrations) : null,
        fields.functions ? JSON.stringify(fields.functions) : null,
        fields.warnings ? JSON.stringify(fields.warnings) : null,
        fields.error ?? null,
      ]
    )
  let applied = []
  try {
    const token = linkToken(config, link)
    const sha = operation.payload.sha ?? (await headCommit(link, token, { fetchImpl })).sha
    await record({ sha })
    const files = await downloadRepository(link, sha, token, { fetchImpl })
    const plan = repositoryPlan(files, link.directory)
    const warnings = [...plan.warnings]
    if (!plan.migrations.length && !plan.functions.size)
      warnings.push(
        `No migrations or functions found in ${link.directory || 'the repository root'}/. Check the folder setting.`
      )
    const result = await projectDb.applyRepositoryMigrations(
      project,
      plan.migrations,
      operation.payload.seed ? plan.seed : null
    )
    applied = result.applied
    warnings.push(...result.warnings)
    if (result.seeded) warnings.push('Ran seed.sql (first deployment of a new project)')
    let deployed = []
    if (plan.functions.size) {
      const written = await projectDb.writeFunctions(project, [...plan.functions])
      deployed = written.written
      warnings.push(...written.warnings)
    }
    await record({
      state: 'succeeded',
      migrations: applied,
      functions: deployed,
      warnings: warnings.slice(0, 50),
    })
  } catch (error) {
    const message =
      error instanceof DeploymentError || error instanceof GithubError
        ? error.message
        : error.status
          ? error.message
          : 'Deployment failed. Check the worker logs.'
    await record({
      state: 'failed',
      migrations: error.applied ?? applied,
      error: message.slice(0, 4000),
    })
    if (!(error instanceof DeploymentError || error instanceof GithubError || error.status))
      console.error(JSON.stringify({ event: 'deployment.failed', project: project.id }))
    throw new HttpError(422, 'DEPLOYMENT_FAILED')
  }
}

// Checks each auto-deploying link and queues new commits: every `seconds` with a
// token, and three times less often without one (GitHub allows 60 anonymous
// requests an hour per address).
export async function pollGithub(
  pool,
  config,
  { fetchImpl, seconds = config.githubPollSeconds ?? 60 } = {}
) {
  const links = (
    await pool.query(
      `SELECT l.* FROM control.github_links l JOIN control.projects p ON p.id=l.project_id
       WHERE l.auto_deploy AND p.status IN ('ready','error') AND p.desired_state='running'
       AND (l.checked_at IS NULL OR l.checked_at < now() - make_interval(secs =>
         CASE WHEN l.encrypted_token IS NULL THEN greatest($1 * 3, 180) ELSE $1 END))
       ORDER BY l.checked_at NULLS FIRST LIMIT 20`,
      [seconds]
    )
  ).rows
  for (const link of links) {
    try {
      const head = await headCommit(link, linkToken(config, link), { etag: link.etag, fetchImpl })
      if (head.notModified) {
        await pool.query(
          'UPDATE control.github_links SET checked_at=now(), check_error=NULL WHERE project_id=$1',
          [link.project_id]
        )
        if (link.head_sha) await queueDeployment(pool, link, link.head_sha, 'push')
        continue
      }
      await pool.query(
        'UPDATE control.github_links SET etag=$2, head_sha=$3, checked_at=now(), check_error=NULL WHERE project_id=$1',
        [link.project_id, head.etag, head.sha]
      )
      await queueDeployment(pool, link, head.sha, 'push')
    } catch (error) {
      // Rate limits push the next check to the reset time.
      const delay = error.retryAt ? Math.max(0, error.retryAt - Date.now()) / 1000 : 0
      await pool.query(
        'UPDATE control.github_links SET checked_at=now() + make_interval(secs => $3), check_error=$2 WHERE project_id=$1',
        [
          link.project_id,
          error instanceof GithubError ? error.message : 'Could not reach GitHub',
          delay,
        ]
      )
    }
  }
}
