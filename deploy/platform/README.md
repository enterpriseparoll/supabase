# Deploying the self-hosted platform

## Local mode (one developer machine)

`compose.local.yml` runs the same control plane on Docker Desktop (Windows or
macOS) or a Linux workstation so you can create and try multiple projects
locally. It is not a server deployment: it uses plain HTTP on `*.localhost`, a
generated sign-in token instead of OIDC and MFA, and skips the host firewall
helper. Traefik listens on `127.0.0.1` only.

From this directory:

```sh
docker compose -f compose.local.yml up -d --build
docker compose -f compose.local.yml logs local-init
```

The second command prints the dashboard URL (`http://manage.localhost:8090`) and
the sign-in token. Each project you create gets its own database, Auth, REST,
Storage, Realtime, and Studio, reachable at
`http://<project-id>.api.localhost:8090` and `http://<project-id>.studio.localhost:8090`.
Browsers resolve `*.localhost` to your machine without DNS changes.

Settings (set in the shell or a `.env` file next to `compose.local.yml`):

- `LOCAL_PORT` (default `8090`): published port for the dashboard and projects.
- `HOST_CAPACITY_MB` / `HOST_CAPACITY_CPUS` (defaults `8192` / `4`): budget for all
  projects together. Each project needs at least 2048 MiB; keep the total below
  the memory Docker Desktop is allowed to use.
- `PLATFORM_DATA_ROOT` (default `/var/lib/docker/supabase-platform`): where
  secrets, routes, backups, and project data live inside the Docker engine's
  filesystem, not in this repository. It must be on Docker's data disk: Docker
  Desktop recreates the rest of its VM, including `/srv`, every time it restarts,
  which deletes everything stored there.

### Backups, migrations, schema history, and performance

Each project drawer has **Backups**, **Migrations**, **Schema**, and **Performance**
tabs. The worker collects migration history, schema snapshots, and performance
statistics from each running project every `INSIGHTS_INTERVAL_MINUTES` (default 5);
the API only serves what was collected.

Backups run online (pg_dump plus Storage files) on each project's own schedule
(daily by default, keeping 7). Local mode stores them, encrypted and deduplicated,
in a restic repository at `<PLATFORM_DATA_ROOT>/backups/restic` on Docker's data
disk. That copy is lost if Docker Desktop's data is reset or uninstalled, so set `RESTIC_REPOSITORY` to an S3-compatible
bucket (for example `s3:https://s3.example.com/bucket/platform`, with
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) to keep copies off this machine. The
repository password is `secrets/restic_password`; without it backups cannot be
read.

Every backup also has a **Download** button (owners and operators). It gives the
same file as Supabase Cloud's backup download: `db_cluster-DD-MM-YYYY@HH-MM-SS.backup.gz`,
a gzipped `pg_dumpall` of all roles (without passwords) and databases, without
Storage files. Restore it anywhere with
`gunzip -c db_cluster-….backup.gz | psql "postgresql://postgres:…@host:port/postgres"`.
Downloads are audited and kept under `<PLATFORM_DATA_ROOT>/exports` until the
backup is removed by retention. Backups made before this feature have no download.

Restoring takes a safety backup, loads the chosen backup into a new database, and
swaps it in only after it loads completely. The previous database is kept as
`postgres_before_restore` until the next restore.

### Developer tools: GitHub, Supabase CLI, MCP, and one-click projects

Each project drawer has **GitHub** and **Developer** tabs, and the header has
**Access tokens**.

**GitHub.** Connect a repository, branch, and folder (default `supabase`). Every
new commit applies pending migrations from `<folder>/migrations` and deploys Edge
Functions from `<folder>/functions`:

- Migrations are recorded in `supabase_migrations.schema_migrations`, exactly as
  `supabase db push` records them, so the CLI and the platform agree on what is
  applied.
- Like `db push`, a migration older than the newest applied one is refused, not
  run out of order.
- Each migration runs in its own transaction. A failure stops the deployment; the
  migrations before it stay applied, and the error shows in the deployment history.
- Function folders replace the deployed ones. Their `deno.json` imports are merged
  into the shared import map, since the runtime reads one map for every function.
  `main` is reserved, and `.env` files are never deployed.

The platform checks for pushes every minute with a token (a fine-grained token with
read access to Contents, stored encrypted), or every 3 minutes without one; GitHub
allows 60 anonymous requests an hour. Servers with a public address can also add
the webhook shown in the tab for instant deploys. Locally, GitHub cannot reach your
machine, so checking is the only option. Set `GITHUB_POLL_SECONDS` on the worker to
change the interval.

**One-click projects.** **Create project** has an optional **Start from GitHub**
section. When the project is ready, it deploys the repository and runs `seed.sql`
once. A README link of the form
`http://manage.localhost:8090/#new?repo=owner/name&branch=main&dir=supabase` opens
the form pre-filled; the GitHub tab shows the link for each connected repository.

**Supabase CLI.** The Developer tab lists ready-to-run commands for this project
(`db push`, `migration list`, `db pull`, `gen types`, `db dump`, `inspect`), with
your terminal's syntax and, after **Show keys and password**, the database password
filled in. They use `--db-url` through the project's pooler, which works with every
CLI version. `supabase link` and `functions deploy` need Supabase's cloud
Management API; deploy functions with GitHub or MCP instead.

**MCP for AI coding agents.** The platform serves an MCP endpoint, with tools named
like Supabase's own MCP server: projects, tables, SQL, migrations, types, Edge
Functions, backups, and GitHub deploys.

- **Address:** locally it is `http://127.0.0.1:8090/mcp`; on Windows, only browsers
  resolve `*.localhost` names. On servers it is `https://manage.<domain>/mcp`.
- **Authentication:** create a token under **Access tokens** and send it as
  `Authorization: Bearer sbp_…`.
- **Setup:** the Developer tab has ready configuration for Claude Code, Cursor,
  VS Code, Windsurf, and stdio-only clients.
- **Limiting a connection:** add `?project_id=<id>` to restrict it to one project,
  and `&read_only=true` to forbid changes.

Tokens act as their creator with their current role, and removing someone's access
disables their tokens. Read-only tokens connect to the database as a role that can
read every table but write nothing. SQL and type generation run in the worker,
which joins each project's private network. The API still never connects to
project databases.

### Switching projects inside Studio

Each project runs its own Studio. To get a cloud-style project switcher in the
Studio header (other projects, **All projects**, **New project**), run projects
with the platform Studio image built from this repository. The
`Platform Studio image` workflow publishes it to
`ghcr.io/enterpriseparoll/supabase-studio-platform`; alternatively build it
locally from the repository root with
`docker build . -f apps/studio/Dockerfile --target production -t supabase-studio-platform:local`.

Set `PLATFORM_STUDIO_IMAGE` to that image before `up`, then **Restart** existing
projects from the dashboard so they pick it up. Without it, projects use the
stock Studio image and you switch projects from the dashboard instead.

Local mode refuses `PLATFORM_FIREWALL=skip` without `PLATFORM_MODE=local`, so the
server deployment below cannot be switched into it by a stray variable. To remove
everything, delete the projects in the dashboard, then run
`docker compose -f compose.local.yml down -v`.

## Deployment requirements

Use a dedicated Linux host with Docker Engine's iptables firewall backend,
Docker Compose v2, Node >=22.13 for bootstrap tools, sufficient SSD space, and an
OIDC provider. Host-level access and project administrators are trusted. Containers
share a kernel; provision separate VMs/hosts for hostile tenants. Do not run this
worker on an unrelated production Docker host.

Plan capacity from measured workloads. `HOST_CAPACITY_MB` and
`HOST_CAPACITY_CPUS` describe the budget available to project stacks after reserving
capacity for the OS and control services. They are resource budgets, not licensing
or project-count limits. Host expansion is manual in this version. Per-container
memory/CPU/PID limits and bounded logs are enforced; per-project disk filesystem
quotas and automatic multi-server placement are not implemented.

The worker applies scoped iptables rules before starting project services. Own
project subnets are allowed; private, host, metadata, and special-use addresses
are denied from project networks. Public internet egress is allowed for Auth and
Functions. Private SMTP/OAuth endpoints need an explicitly reviewed firewall
policy; do not simply disable isolation. Docker IPv6 project networking is not
enabled. Firewall rules must be reconciled after a host firewall reset by
restarting project stacks through the control plane.

## Identity and DNS

Create an OIDC confidential client using authorization code + PKCE. Register
`https://manage.PLATFORM_DOMAIN/auth/callback` as its exact redirect URI. Require
MFA at the identity provider and configure a documented `acr` value emitted in
the ID token. The platform rejects tokens lacking exactly `OIDC_REQUIRED_ACR`;
do not use an arbitrary value that the provider emits for password-only logins.
RS256, ES256, and PS256 ID tokens are accepted against the discovered HTTPS JWKS.
Only explicitly granted subjects can sign in.

Create DNS records for `manage.PLATFORM_DOMAIN`, `*.api.PLATFORM_DOMAIN`, and
`*.studio.PLATFORM_DOMAIN` pointing to the VPS. Wildcard DNS does not require
wildcard certificates: Traefik requests individual host certificates via HTTP-01.
Allow inbound 80/443 and restrict SSH to your administrative network. No database,
worker, Docker, or control API container port is published separately.

## Bootstrap and start

From the repository root on Linux, set these environment variables using your
secret manager or a protected interactive shell. Keep values out of shell history:

```sh
export PLATFORM_DOMAIN=platform.example.com
export OIDC_ISSUER=https://identity.example.com/realms/platform
export OIDC_CLIENT_ID=supabase-platform
export OIDC_REQUIRED_ACR=your-providers-mfa-assurance-value
export ACME_EMAIL=operations@example.com
# Supply OIDC_CLIENT_SECRET without placing the literal value in shell history.
read -r -s OIDC_CLIENT_SECRET; export OIDC_CLIENT_SECRET; echo
sudo --preserve-env=PLATFORM_DOMAIN,OIDC_ISSUER,OIDC_CLIENT_ID,OIDC_REQUIRED_ACR,OIDC_CLIENT_SECRET,ACME_EMAIL node deploy/platform/bootstrap.mjs
```

Bootstrap refuses to overwrite existing files. It generates independent database
credentials, the secret-encryption key, and the backup encryption password under
`/srv/supabase-platform/secrets`. Files are readable by runtime UID 1000 and root;
the parent directory is root-only. Compose bind-mounts individual secret files.
Keep an encrypted off-server copy and an offline recovery copy of this material.
Never commit the generated deployment `.env`, keys, project directories, or dumps.

```sh
cd deploy/platform
docker compose -f compose.yml build
docker compose -f compose.yml up -d
docker compose -f compose.yml run --rm bootstrap-owner 'exact-oidc-subject'
```

The one-time bootstrap-owner command works only before the first platform member
exists. Subsequent access changes use the authenticated dashboard/API. Bootstrap
defaults to the Let's Encrypt staging endpoint. Verify DNS/routing, change
`ACME_SERVER` in the protected `.env` to
`https://acme-v02.api.letsencrypt.org/directory`, then recreate Traefik. Remove the
staging ACME volume only on a new installation before production certificates are
issued, or follow Traefik's certificate-store migration procedures. Do not delete
the database volume.

Open `https://manage.PLATFORM_DOMAIN`, sign in, and create a project. Startup jobs
generate fresh database passwords, HS256 compatibility keys, EC signing keys,
publishable/secret API keys, encryption keys, networks, and persistent data paths.
No project database or pooler port is published. Connect administration tools over
a separately configured private network or use Studio.

Images use explicit upstream tags in the initial template. Before production,
review/scan the selected images and replace tags with approved digest references
in a reviewed template release. The platform runtime's base image and OS packages
also need routine security rebuilding. Dependency and image scans do not replace
isolation, identity-provider, and restore validation.

## Backups and recovery

The worker uses restic for encrypted off-server backups. Configure
`RESTIC_REPOSITORY` (for example an S3-compatible repository URL),
`BACKUP_ACCESS_KEY_ID`, and the protected `secrets/backup_secret` file. The generated
`secrets/restic_password` is required for recovery; do not rotate it by replacing
the file without updating the repository's keys. Restrict the remote credentials
to the backup repository and use provider retention/object-lock policies.

Initialize a new repository once:

```sh
docker compose -f compose.yml run --rm worker restic init
```

When using S3 credentials, run commands through `node src/backup-tool.mjs` instead
of directly invoking restic so the secret file is loaded into the process:

```sh
docker compose -f compose.yml run --rm worker node src/backup-tool.mjs init
docker compose -f compose.yml run --rm worker node src/backup-tool.mjs check
```

Configured workers schedule backups at `BACKUP_INTERVAL_HOURS` (default 24).
Backups stop application services to create a consistent database/Storage copy;
this introduces downtime. PostgreSQL remains running only for the dump. Restic
uploads the database dump, global roles, Storage files, project environment, and
manifest encrypted. Local staging is removed after upload, and previously
running services restart. A backup failure is recorded in the operations/audit
views; monitor these and backup age with an external system.

Restore requires owner permission and an exact project-ID confirmation. It first
backs up current state, restores a matching-release backup, replaces database
contents and Storage, retains the previous Storage directory, and restarts the
project if it was running. On failure, treat the stack as unavailable and inspect
the operation; never assume a partial restore is ready. Restore currently targets
the same project and release, not an automatic clone or PITR workflow.

For total host loss, restore the control database and protected secrets, restore
project data directories and Docker named volumes (including PostgreSQL custom
configuration), rebuild the platform from its recorded release, and restore each
project's database and Storage from restic before publishing its routes. The
`globals.sql` file is for clean-host role reconstruction under an administrator;
do not blindly apply it to an existing database with current roles/passwords.
Back up the control database with `pg_dump -Fc` and preserve the ACME store and
deployment files independently; project backups do not contain the registry.

RPO/RTO are not promised by the code. Record them after a timed restore drill on
your target host. Test lost-host and lost-control-database recovery before storing
production data. Retention/pruning is an explicit administrator operation; this
version never automatically prunes the only remaining backup.

## Upgrades and rollback

Build and test the new control-plane image, save its previous digest, back up the
control database and keys, then recreate the migrate/API/worker services. Migrations
are serialized and checksummed. Do not edit an applied migration. Roll an app
image back only if its schema compatibility is established; otherwise restore the
control database alongside the previous release.

To approve a project service release locally:

```sh
mkdir -p /srv/supabase-platform/releases
node deploy/platform/stage-release.mjs release-2026-11 /path/to/reviewed/docker baseline-dfd1f588
```

Queue `{kind:"upgrade",release:"release-2026-11"}` through the project operations
API. The worker validates checksums and compatibility, takes a backup, replaces
Compose/gateway configuration, and waits for health before publishing routes.
Database image changes are rejected: major-version upgrades require a separate
data migration and recovery runbook. Releases changing init SQL, Functions files,
secret formats, or other mounted assets also require a separate migration.

Rollback uses a separately staged release whose `compatibleFrom` includes the
current release and whose local staging command included `--rollback-compatible`.
This is an administrator assertion that service schema migrations are compatible,
not automatic proof. If a service performed an irreversible data migration, restore
the pre-upgrade backup with the appropriate release rather than only changing
image tags. Failed upgrades retain the prior Compose file in the project directory.

## Operational limitations and release gates

This is an initial implementation, not certification of production readiness.
Keep one worker per host. PostgreSQL advisory locks serialize project operations
and recover after worker exit; they are not distributed fencing for a partitioned
multi-host Docker fleet. A single VPS remains a shared failure domain.

The dashboard centralizes project selection and lifecycle operations while each
project retains its own unmodified Studio. Cloud billing, branching, automatic
multi-server placement, shared-runtime Studio, PITR, online backups, SMTP-provider
configuration UI, key rotation UI, disk quotas, and automatic alert delivery are
outside the current implemented surface. Use private administration to configure
SMTP and other advanced project environment settings, with reviewed restart jobs.

Before exposing a deployment: validate the chosen OIDC provider's MFA claims,
test two real project stacks and cross-project network denial on Linux, exercise
Auth/Storage/Realtime/Functions through HTTPS, check renewal, run a clean-host
restore, scan images, and have the privileged worker independently reviewed.
