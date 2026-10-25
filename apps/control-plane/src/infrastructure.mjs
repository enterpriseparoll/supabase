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
} from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { parse, stringify } from 'yaml'
import { hash, invariant, projectId, unseal } from './core.mjs'
import { command } from './process.mjs'
import {
  projectEnvironment,
  projectName,
  publicGateway,
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
        project
      )
    )
    // A platform Studio build adds the cross-project switcher; stock Studio still works.
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
    const probe = `const targets=[['/auth/v1/health',{}],['/rest/v1/',{apikey:process.env.SUPABASE_ANON_KEY,Authorization:'Bearer '+process.env.SUPABASE_ANON_KEY}]];for(const [path,headers] of targets){const response=await fetch('http://api-gw:8000'+path,{headers,signal:AbortSignal.timeout(10000)});if(!response.ok)process.exit(1)}`
    await this.compose(project, [
      'exec',
      '-T',
      'studio',
      'node',
      '--input-type=module',
      '-e',
      probe,
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
      renderCompose(composeSource, { ...project, release }),
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
      })),
      healthy: containers.every(
        (row) => row.State === 'running' && (!row.Health || row.Health === 'healthy')
      ),
    }
  }
  async backup(project) {
    invariant(
      process.env.RESTIC_REPOSITORY && process.env.RESTIC_PASSWORD_FILE,
      503,
      'BACKUPS_NOT_CONFIGURED'
    )
    const id = randomUUID()
    const staging = resolve(this.config.dataRoot, 'backup-staging', `${project.id}-${id}`)
    await mkdir(staging, { recursive: true, mode: 0o700 })
    const wasRunning = project.desired_state === 'running'
    await this.stop(project)
    try {
      // PostgreSQL alone runs while application writes and webhooks are quiesced.
      await this.compose(project, ['up', '-d', '--wait', 'db'])
      for (const [file, args] of [
        ['database.dump', ['pg_dump', '-U', 'postgres', '-d', 'postgres', '-Fc']],
        ['globals.sql', ['pg_dumpall', '-U', 'postgres', '--globals-only']],
      ]) {
        const handle = await open(`${staging}/${file}`, 'w', 0o600)
        try {
          await this.compose(project, ['exec', '-T', 'db', ...args], {
            stdout: handle.fd,
            timeout: 1800000,
          })
        } finally {
          await handle.close()
        }
      }
      await cp(`${this.directory(project.id)}/volumes/storage`, `${staging}/storage`, {
        recursive: true,
      })
      await cp(`${this.directory(project.id)}/.env`, `${staging}/project.env`)
      await writeFile(
        `${staging}/manifest.json`,
        JSON.stringify({
          version: 1,
          project: project.id,
          release: project.release,
          createdAt: new Date().toISOString(),
          consistent: 'application-services-stopped',
        }),
        { mode: 0o600 }
      )
      // stdin-from-command is avoided; restic encrypts the files before remote upload.
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
      await this.db.query(
        'INSERT INTO control.backups(id,project_id,snapshot,source_path,release) VALUES($1,$2,$3,$4,$5)',
        [id, project.id, summary.snapshot_id, staging, project.release]
      )
    } finally {
      await rm(staging, { recursive: true, force: true })
      if (wasRunning) await this.up(project)
      else await this.compose(project, ['stop', 'db'])
    }
  }
  async restore(project, backupId) {
    const backup = (
      await this.db.query('SELECT * FROM control.backups WHERE id=$1 AND project_id=$2', [
        backupId,
        project.id,
      ])
    ).rows[0]
    invariant(backup && backup.release === project.release, 409, 'BACKUP_RELEASE_MISMATCH')
    await this.backup(project)
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
        await this.compose(
          project,
          [
            'exec',
            '-T',
            'db',
            'pg_restore',
            '-U',
            'postgres',
            '-d',
            'postgres',
            '--clean',
            '--if-exists',
            '--no-owner',
            '--exit-on-error',
            '/tmp/platform-restore.dump',
          ],
          { timeout: 1800000 }
        )
      } finally {
        await this.compose(project, ['exec', '-T', 'db', 'rm', '-f', '/tmp/platform-restore.dump'])
      }
      const storage = `${this.directory(project.id)}/volumes/storage`
      // Keep a local previous copy if restore or application verification fails.
      await rename(storage, `${storage}.before-${randomUUID()}`)
      await cp(`${staging}/storage`, storage, { recursive: true })
      if (project.desired_state === 'running') await this.up(project)
      else await this.compose(project, ['stop', 'db'])
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
