import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  open,
  stat,
  lstat,
  statfs,
  chown,
  chmod,
  copyFile,
} from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { dirname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { parse, stringify } from 'yaml'
import { applyStorageSettings } from './storage.mjs'
import { applyDatabaseSettings, managedPoolerScript } from './database-settings.mjs'
import { backupDownloadPath, clusterDumpArgs } from './backup-files.mjs'
import { hash, invariant, projectId, unseal } from './core.mjs'
import {
  collectInsights,
  RESTORE_SQL,
  restoreSwapPlan,
  schemaHash,
  statsSample,
} from './insights.mjs'
import { command } from './process.mjs'
import {
  projectEnvironment,
  projectName,
  publicGateway,
  readinessProbe,
  renderCompose,
  renderEnv,
  routeConfiguration,
} from './templates.mjs'

export class Infrastructure {
  constructor(config, db) {
    this.config = config
    this.db = db
  }
  directory(id) {
    const root = resolve(this.config.dataRoot, 'projects')
    const result = resolve(root, projectId(id))
    invariant(result.startsWith(`${root}${sep}`), 500, 'Invalid project directory')
    return result
  }
  async safeDirectory(id) {
    const path = this.directory(id)
    await mkdir(path, { recursive: true, mode: 0o700 })
    invariant(
      !(await lstat(path)).isSymbolicLink(),
      500,
      'Project directory cannot be a symbolic link'
    )
    return path
  }
  compose(project, args, options = {}) {
    return command(
      'docker',
      [
        'compose',
        '--project-name',
        projectName(project.id),
        '--project-directory',
        this.directory(project.id),
        '--file',
        `${this.directory(project.id)}/docker-compose.yml`,
        ...args,
      ],
      options
    )
  }
  // Forces the next start to re-render the stack (server mode caches renders).
  async invalidate(project) {
    await rm(`${this.directory(project.id)}/.prepared`, { force: true })
  }
  async prepare(project) {
    const directory = await this.safeDirectory(project.id)
    const marker = `${directory}/.prepared`
    // Local mode re-renders on every start so template and Studio image changes reach
    // existing projects on Restart. Data directories and secrets are never replaced.
    if (!this.config.local)
      try {
        await stat(marker)
        return
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    // No upstream scripts execute here. Only approved, immutable template assets are copied.
    await cp(`${this.config.templateRoot}/volumes`, `${directory}/volumes`, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (path) =>
        !path.replaceAll('\\', '/').endsWith('/db/data') &&
        !path.replaceAll('\\', '/').endsWith('/storage'),
    })
    // The functions router (main) belongs to the platform: refresh it on every start so
    // existing projects get fixes. User functions and secrets are never replaced.
    await cp(
      `${this.config.templateRoot}/volumes/functions/main`,
      `${directory}/volumes/functions/main`,
      { recursive: true, force: true }
    )
    // Shared by Studio (writes Auth settings) and the Auth server (reads them as user 1000).
    await mkdir(`${directory}/volumes/auth-config`, { recursive: true, mode: 0o755 })
    await mkdir(`${directory}/volumes/storage`, { recursive: true, mode: 0o700 })
    await mkdir(`${directory}/volumes/db/data`, { recursive: true, mode: 0o700 })
    const secrets = unseal(project.encrypted_secrets, this.config.key, project.id)
    await writeFile(
      `${directory}/.env`,
      renderEnv(
        await readFile(`${this.config.templateRoot}/.env.example`, 'utf8'),
        projectEnvironment(project, secrets, this.config)
      ),
      { mode: 0o600 }
    )
    const compose = parse(
      renderCompose(
        await readFile(`${this.config.templateRoot}/docker-compose.yml`, 'utf8'),
        project,
        { local: this.config.local }
      )
    )
    try {
      applyStorageSettings(
        compose,
        JSON.parse(await readFile(`${directory}/storage-settings.json`, 'utf8'))
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    // A platform Studio build adds the cross-project switcher; stock Studio still works.
    try {
      const settings = JSON.parse(await readFile(`${directory}/database-settings.json`, 'utf8'))
      applyDatabaseSettings(compose, settings)
      await writeFile(
        `${directory}/volumes/pooler/pooler.exs`,
        managedPoolerScript(
          await readFile(`${this.config.templateRoot}/volumes/pooler/pooler.exs`, 'utf8'),
          settings
        )
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (this.config.studioImage) compose.services.studio.image = this.config.studioImage
    for (const service of Object.values(compose.services)) {
      if (service.image.includes('@sha256:')) continue
      let digests
      try {
        digests = JSON.parse(
          await command('docker', [
            'image',
            'inspect',
            '--format',
            '{{json .RepoDigests}}',
            service.image,
          ])
        )
      } catch {
        await command('docker', ['pull', service.image])
        digests = JSON.parse(
          await command('docker', [
            'image',
            'inspect',
            '--format',
            '{{json .RepoDigests}}',
            service.image,
          ])
        )
      }
      // Images built on this machine have no registry digest. Local mode keeps the tag;
      // servers still require a pinned digest.
      if (!(digests?.length > 0) && this.config.local) continue
      invariant(digests?.length > 0, 409, 'IMAGE_DIGEST_UNAVAILABLE')
      service.image = digests[0]
    }
    await writeFile(`${directory}/docker-compose.yml`, stringify(compose), { mode: 0o600 })
    await writeFile(
      `${directory}/volumes/api/envoy/lds.template.yaml`,
      publicGateway(
        await readFile(`${this.config.templateRoot}/volumes/api/envoy/lds.template.yaml`, 'utf8')
      )
    )
    await this.compose(project, ['config', '--quiet'])
    await writeFile(marker, project.release, { mode: 0o600 })
  }
  async route(project) {
    const domains = (
      await this.db.query(
        'SELECT domain FROM control.domains WHERE project_id=$1 AND verified_at IS NOT NULL',
        [project.id]
      )
    ).rows.map((r) => r.domain)
    await mkdir(this.config.routeRoot, { recursive: true, mode: 0o700 })
    const destination = resolve(this.config.routeRoot, `${project.id}.yml`)
    const temporary = `${destination}.${randomUUID()}.tmp`
    await writeFile(temporary, stringify(routeConfiguration(project, domains, this.config)), {
      mode: 0o600,
    })
    await rename(temporary, destination)
  }
  async unroute(project) {
    await rm(resolve(this.config.routeRoot, `${projectId(project.id)}.yml`), { force: true })
  }
  async attachIngress(project) {
    const name = `${projectName(project.id)}-ingress`
    const networks = JSON.parse(
      await command('docker', [
        'inspect',
        '--format',
        '{{json .NetworkSettings.Networks}}',
        this.config.traefikContainer,
      ])
    )
    if (!networks[name])
      await command('docker', ['network', 'connect', name, this.config.traefikContainer])
  }
  async up(project) {
    await this.prepare(project)
    await this.compose(project, ['create'])
    const subnets = []
    for (const network of [
      `${projectName(project.id)}_private`,
      `${projectName(project.id)}-ingress`,
      `${projectName(project.id)}-egress`,
    ]) {
      const ipam = JSON.parse(
        await command('docker', [
          'network',
          'inspect',
          '--format',
          '{{json .IPAM.Config}}',
          network,
        ])
      )
      subnets.push(...ipam.map((row) => row.Subnet))
    }
    // Run only this approved firewall helper with host network administration.
    // It has no host filesystem or Docker socket mounts and no public listener.
    // Local mode skips it: Docker Desktop's VM firewall is not the host's, and
    // project networks stay internal either way.
    if (this.config.firewall !== 'skip')
      await command('docker', [
        'run',
        '--rm',
        '--network',
        'host',
        '--user',
        '0:0',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'NET_ADMIN',
        '--security-opt',
        'no-new-privileges:true',
        '--entrypoint',
        'node',
        this.config.executionImage,
        '/app/src/firewall.mjs',
        project.id,
        ...subnets,
      ])
    await this.compose(project, ['up', '-d', '--wait', '--wait-timeout', '300'])
    await this.compose(project, [
      'exec',
      '-T',
      'studio',
      'node',
      '--input-type=module',
      '-e',
      readinessProbe,
    ])
    await this.attachIngress(project)
    await this.route(project)
  }
  async stop(project) {
    await this.unroute(project)
    await this.compose(project, ['stop', '--timeout', '60'])
  }
  async destroy(project) {
    await this.unroute(project)
    // Disconnect only this project's ingress; retain database/storage volumes for recovery.
    try {
      await command('docker', [
        'network',
        'disconnect',
        `${projectName(project.id)}-ingress`,
        this.config.traefikContainer,
      ])
    } catch {
      /* compose verifies remaining resources */
    }
    await this.compose(project, ['down', '--timeout', '60'])
  }
  async verifyDomain(project, domain) {
    const row = (
      await this.db.query('SELECT * FROM control.domains WHERE domain=$1 AND project_id=$2', [
        domain,
        project.id,
      ])
    ).rows[0]
    invariant(row, 404, 'DOMAIN_NOT_FOUND')
    const resolver = new Resolver({ timeout: 5000, tries: 2 })
    const records = await resolver.resolveTxt(`_supabase-platform.${row.domain}`)
    invariant(
      records.some((parts) => parts.join('') === row.verification_token),
      409,
      'DOMAIN_NOT_VERIFIED'
    )
    await this.db.query(
      'UPDATE control.domains SET verified_at=now() WHERE domain=$1 AND project_id=$2',
      [domain, project.id]
    )
    if (project.status === 'ready') await this.route(project)
  }
  async removeDomain(project, domain) {
    // Withdraw all routes first so an old host rule cannot outlive its reservation.
    await this.unroute(project)
    await this.db.query('DELETE FROM control.domains WHERE domain=$1 AND project_id=$2', [
      domain,
      project.id,
    ])
    if (project.status === 'ready') await this.route(project)
  }
  async changeRelease(project, release, rollback = false) {
    invariant(/^[a-z0-9][a-z0-9-]{2,63}$/.test(release), 400, 'INVALID_RELEASE')
    if (project.release === release) return
    const releaseRoot = resolve(this.config.dataRoot, 'releases', release)
    const manifest = JSON.parse(await readFile(`${releaseRoot}/manifest.json`, 'utf8'))
    invariant(
      manifest.version === 1 && manifest.release === release,
      409,
      'INVALID_RELEASE_MANIFEST'
    )
    const composeSource = await readFile(`${releaseRoot}/docker-compose.yml`, 'utf8')
    const gatewaySource = await readFile(`${releaseRoot}/lds.template.yaml`, 'utf8')
    invariant(
      manifest.composeHash === hash(composeSource) && manifest.gatewayHash === hash(gatewaySource),
      409,
      'RELEASE_CHECKSUM_MISMATCH'
    )
    const current = parse(
      await readFile(`${this.directory(project.id)}/docker-compose.yml`, 'utf8')
    )
    const target = parse(composeSource)
    invariant(
      Object.values(target.services).every(
        (service) => typeof service.image === 'string' && service.image.includes('@sha256:')
      ),
      409,
      'IMAGE_DIGEST_REQUIRED'
    )
    invariant(
      current.services.db.image === target.services.db.image,
      409,
      'DATABASE_UPGRADE_REQUIRES_MIGRATION_RUNBOOK'
    )
    invariant(manifest.compatibleFrom.includes(project.release), 409, 'RELEASE_NOT_COMPATIBLE')
    if (rollback) invariant(manifest.rollbackCompatible === true, 409, 'ROLLBACK_NOT_APPROVED')
    await this.backup(project)
    await this.stop(project)
    await cp(
      `${this.directory(project.id)}/docker-compose.yml`,
      `${this.directory(project.id)}/compose.before-${project.release}.yml`
    )
    await writeFile(
      `${this.directory(project.id)}/docker-compose.yml`,
      renderCompose(composeSource, { ...project, release }, { local: this.config.local }),
      { mode: 0o600 }
    )
    await writeFile(
      `${this.directory(project.id)}/volumes/api/envoy/lds.template.yaml`,
      publicGateway(gatewaySource)
    )
    await this.compose(project, ['config', '--quiet'])
    await this.up({ ...project, release })
    await this.db.query('UPDATE control.projects SET release=$2 WHERE id=$1', [project.id, release])
  }
  async metrics(project) {
    const filesystem = await statfs(this.directory(project.id))
    const diskUsage = await command('du', ['-sk', this.directory(project.id)], { timeout: 30000 })
    const disk = {
      projectBytes: Number(diskUsage.split(/\s+/)[0]) * 1024,
      hostAvailableBytes: filesystem.bavail * filesystem.bsize,
    }
    const containers = (await this.compose(project, ['ps', '--all', '--format', 'json']))
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => JSON.parse(line))
    const ids = containers.map((row) => row.ID)
    if (!ids.length) return { containers: [], disk, healthy: false }
    const stats = (
      await command('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids])
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    return {
      disk,
      containers: containers.map((row) => ({
        service: row.Service,
        state: row.State,
        health: row.Health,
      })),
      stats: stats.map((row) => ({
        name: row.Name,
        cpu: row.CPUPerc,
        memory: row.MemUsage,
        memoryPercent: row.MemPerc,
        blockIO: row.BlockIO,
        net: row.NetIO,
      })),
      healthy: containers.every(
        (row) => row.State === 'running' && (!row.Health || row.Health === 'healthy')
      ),
    }
  }
  // Runs a command inside the project's database container as supabase_admin over
  // loopback. The password travels in the environment, never in argv.
  dbExec(project, args, options = {}) {
    const secrets = unseal(project.encrypted_secrets, this.config.key, project.id)
    return this.compose(
      project,
      ['exec', '-T', '-e', 'PGPASSWORD', '-e', 'PGOPTIONS', 'db', ...args],
      {
        timeout: 120000,
        ...options,
        env: {
          ...process.env,
          PGPASSWORD: secrets.POSTGRES_PASSWORD,
          PGOPTIONS: options.pgOptions ?? '-c statement_timeout=30000',
        },
      }
    )
  }
  psql(project, sql, database = 'postgres') {
    return this.dbExec(project, [
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'supabase_admin',
      '-d',
      database,
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      ...(Array.isArray(sql) ? sql : [sql]).flatMap((statement) => ['-c', statement]),
    ])
  }
  // Migration history, schema snapshot, and performance statistics. Only the worker
  // reaches project databases; the API serves what is stored here.
  async inspect(project) {
    const insights = await collectInsights({
      query: (sql) => this.psql(project, sql),
      dumpSchema: (schemas) =>
        this.dbExec(project, [
          'pg_dump',
          '-h',
          '127.0.0.1',
          '-U',
          'supabase_admin',
          '-d',
          'postgres',
          '--schema-only',
          '--no-owner',
          ...schemas.flatMap((name) => ['-n', `"${name.replaceAll('"', '""')}"`]),
        ]),
    })
    const hash = schemaHash(insights.schema)
    const latest = (
      await this.db.query(
        'SELECT hash FROM control.schema_snapshots WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1',
        [project.id]
      )
    ).rows[0]
    if (latest?.hash !== hash)
      await this.db.query(
        'INSERT INTO control.schema_snapshots(id,project_id,content,hash,size_bytes) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), project.id, insights.schema, hash, Buffer.byteLength(insights.schema)]
      )
    await this.db.query(
      `INSERT INTO control.project_insights(project_id,migrations,performance,collected_at,error_code)
       VALUES($1,$2,$3,now(),NULL)
       ON CONFLICT (project_id) DO UPDATE SET migrations=excluded.migrations,
         performance=excluded.performance, collected_at=excluded.collected_at, error_code=NULL`,
      [project.id, JSON.stringify(insights.migrations), JSON.stringify(insights.performance)]
    )
    await this.db.query('INSERT INTO control.project_stats(project_id,sample) VALUES($1,$2)', [
      project.id,
      statsSample(insights.performance),
    ])
    await this.db.query(
      "DELETE FROM control.project_stats WHERE project_id=$1 AND collected_at < now() - interval '7 days'",
      [project.id]
    )
    return insights
  }
  async ensureRepository() {
    invariant(
      process.env.RESTIC_REPOSITORY && process.env.RESTIC_PASSWORD_FILE,
      503,
      'BACKUPS_NOT_CONFIGURED'
    )
    try {
      await command('restic', ['cat', 'config'], { timeout: 60000 })
    } catch {
      // A missing local repository is created on first use; remote ones must exist.
      invariant(
        !/^[a-z0-9]+:/i.test(process.env.RESTIC_REPOSITORY),
        503,
        'BACKUP_REPOSITORY_UNAVAILABLE'
      )
      await mkdir(process.env.RESTIC_REPOSITORY, { recursive: true, mode: 0o700 })
      await command('restic', ['init'], { timeout: 120000 })
    }
  }
  // Online backup: pg_dump takes a consistent snapshot while the project runs, so
  // scheduled backups cause no downtime. Storage files are copied alongside.
  async backup(project, trigger = 'manual') {
    await this.ensureRepository()
    const id = randomUUID()
    const staging = resolve(this.config.dataRoot, 'backup-staging', `${project.id}-${id}`)
    await mkdir(staging, { recursive: true, mode: 0o700 })
    const stopped = project.desired_state !== 'running'
    try {
      if (stopped) await this.compose(project, ['up', '-d', '--wait', 'db'])
      for (const [file, args] of [
        [
          'database.dump',
          ['pg_dump', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres', '-Fc'],
        ],
        [
          'globals.sql',
          ['pg_dumpall', '-h', '127.0.0.1', '-U', 'supabase_admin', '--globals-only'],
        ],
        // Same format as Supabase Cloud's backup download; offered as a download.
        ['db_cluster.backup', clusterDumpArgs()],
      ]) {
        const handle = await open(`${staging}/${file}`, 'w', 0o600)
        try {
          await this.dbExec(project, args, {
            stdout: handle.fd,
            timeout: 1800000,
            pgOptions: '-c statement_timeout=0',
          })
        } finally {
          await handle.close()
        }
      }
      await pipeline(
        createReadStream(`${staging}/db_cluster.backup`),
        createGzip(),
        createWriteStream(`${staging}/db_cluster.backup.gz`, { mode: 0o600 })
      )
      await rm(`${staging}/db_cluster.backup`)
      await cp(`${this.directory(project.id)}/volumes/storage`, `${staging}/storage`, {
        recursive: true,
      })
      await writeFile(
        `${staging}/manifest.json`,
        JSON.stringify({
          version: 2,
          project: project.id,
          release: project.release,
          createdAt: new Date().toISOString(),
          consistent: 'pg_dump-snapshot',
          trigger,
        }),
        { mode: 0o600 }
      )
      // restic encrypts and deduplicates; repeated backups store only changed data.
      const output = await command(
        'restic',
        ['backup', staging, '--json', '--tag', project.id, '--tag', id],
        { timeout: 3600000 }
      )
      const summary = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((row) => row.message_type === 'summary')
      invariant(summary?.snapshot_id, 500, 'BACKUP_SNAPSHOT_MISSING')
      // The download copy is a convenience; the backup stays valid without it.
      const download = await this.publishDownload(
        project,
        id,
        `${staging}/db_cluster.backup.gz`
      ).catch((error) => {
        console.error(
          JSON.stringify({ event: 'backup.download.failed', project: project.id, backup: id })
        )
        if (this.config.local) console.error(error)
        return null
      })
      try {
        await this.db.query(
          'INSERT INTO control.backups(id,project_id,snapshot,source_path,release,size_bytes,trigger,download_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            id,
            project.id,
            summary.snapshot_id,
            staging,
            project.release,
            summary.total_bytes_processed ?? null,
            trigger,
            download,
          ]
        )
      } catch (error) {
        await rm(backupDownloadPath(this.config.dataRoot, project.id, id), { force: true })
        throw error
      }
      await this.applyRetention(project)
    } finally {
      await rm(staging, { recursive: true, force: true })
      if (stopped) await this.compose(project, ['stop', 'db'])
    }
  }
  // Copies the cluster dump to where the API (a different, unprivileged user) can
  // serve it read-only. Returns its size in bytes.
  async publishDownload(project, backupId, source) {
    const target = backupDownloadPath(this.config.dataRoot, project.id, backupId)
    const uid = this.config.apiUid ?? 1000
    for (const directory of [dirname(dirname(target)), dirname(target)]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chown(directory, uid, uid)
      await chmod(directory, 0o700)
    }
    await copyFile(source, `${target}.partial`)
    await chown(`${target}.partial`, uid, uid)
    await chmod(`${target}.partial`, 0o400)
    await rename(`${target}.partial`, target)
    return (await stat(target)).size
  }
  // Keeps the newest `backup_retention` backups (pre-restore safety copies count too).
  async applyRetention(
    project,
    forget = (snapshots) =>
      command('restic', ['forget', '--prune', ...snapshots], { timeout: 3600000 })
  ) {
    const expired = (
      await this.db.query(
        'SELECT id, snapshot FROM control.backups WHERE project_id=$1 ORDER BY created_at DESC OFFSET $2',
        [project.id, project.backup_retention ?? 7]
      )
    ).rows
    if (!expired.length) return
    await forget(expired.map((row) => row.snapshot))
    await this.db.query('DELETE FROM control.backups WHERE id = ANY($1::uuid[])', [
      expired.map((row) => row.id),
    ])
    for (const row of expired)
      await rm(backupDownloadPath(this.config.dataRoot, project.id, row.id), { force: true })
  }
  // Rebuilds the project database from a backup. A safety backup is taken first, and
  // the Storage directory being replaced is kept beside the restored one.
  async restore(project, backupId) {
    const backup = (
      await this.db.query('SELECT * FROM control.backups WHERE id=$1 AND project_id=$2', [
        backupId,
        project.id,
      ])
    ).rows[0]
    invariant(backup && backup.release === project.release, 409, 'BACKUP_RELEASE_MISMATCH')
    await this.backup(project, 'pre-restore')
    const staging = resolve(
      this.config.dataRoot,
      'restore-staging',
      `${project.id}-${randomUUID()}`
    )
    await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      await command(
        'restic',
        ['restore', `${backup.snapshot}:${backup.source_path}`, '--target', staging, '--verify'],
        { timeout: 3600000 }
      )
      const manifest = JSON.parse(await readFile(`${staging}/manifest.json`, 'utf8'))
      invariant(
        manifest.project === project.id && manifest.release === project.release,
        409,
        'RESTORE_MANIFEST_MISMATCH'
      )
      await this.stop(project)
      await this.compose(project, ['up', '-d', '--wait', 'db'])
      await this.compose(project, [
        'cp',
        `${staging}/database.dump`,
        'db:/tmp/platform-restore.dump',
      ])
      try {
        // Restore into a new database and swap it in only after it fully succeeds, so
        // a failed restore leaves the live database untouched. Supabase's own schemas
        // (auth, storage, ...) cannot be cleaned in place, and roles live outside it.
        await this.psql(project, RESTORE_SQL.prepare, 'template1')
        try {
          await this.dbExec(
            project,
            [
              'pg_restore',
              '-h',
              '127.0.0.1',
              '-U',
              'supabase_admin',
              '-d',
              'postgres_restoring',
              '--exit-on-error',
              '/tmp/platform-restore.dump',
            ],
            { timeout: 3600000, pgOptions: '-c statement_timeout=0' }
          )
        } catch (error) {
          await this.psql(project, RESTORE_SQL.discard, 'template1')
          throw error
        }
        await this.psql(project, RESTORE_SQL.copySettings, 'template1')
        // Background workers (pg_cron, pg_net) reconnect briefly; retry the swap. Each
        // attempt plans only the steps still needed, so retries never drop the original.
        for (let attempt = 1; ; attempt++) {
          try {
            await this.psql(project, RESTORE_SQL.terminate, 'template1')
            const existing = (await this.psql(project, RESTORE_SQL.existing, 'template1'))
              .trim()
              .split(',')
              .filter(Boolean)
            const steps = restoreSwapPlan(existing)
            if (steps.length) await this.psql(project, steps, 'template1')
            break
          } catch (error) {
            if (attempt >= 5) throw error
            await new Promise((done) => setTimeout(done, 2000))
          }
        }
      } finally {
        await this.compose(project, ['exec', '-T', 'db', 'rm', '-f', '/tmp/platform-restore.dump'])
      }
      const storage = `${this.directory(project.id)}/volumes/storage`
      await rename(
        storage,
        `${storage}.before-restore-${new Date().toISOString().replaceAll(':', '-')}`
      )
      await cp(`${staging}/storage`, storage, { recursive: true })
      if (project.desired_state === 'running') await this.up(project)
      else await this.compose(project, ['stop', 'db'])
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
