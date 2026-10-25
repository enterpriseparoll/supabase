# Self-hosted multi-project platform: audit and implementation plan

Date: 2026-10-24

Baseline: `enterpriseparoll/supabase`, branch `master`, commit
`dfd1f588381699a626fdc1c52b752d19579ab848`.

Status: source audit and implementation proposal. No platform implementation,
deployment, or production readiness is claimed by this document.

## Scope and evidence limits

This audit covers the checked-out Studio authentication and permission entry
points, self-hosted project endpoints and database helpers, base Compose stack,
gateway configuration, optional logging stack, update scripts, and CI definitions.
It is not a comprehensive penetration test or dependency vulnerability scan.
The checkout has shallow history; divergence from upstream has not been measured.
No existing production deployment was inspected.

The host has Node 24.21.0 and pnpm 11.25.0 available. The repository requires
Node >=22.13 and declares pnpm 11.13.1. Use the declared package manager and
frozen lockfile for reproducible installation. Docker client 29.8.2 is present,
but access to the Docker Desktop Linux Engine was denied. No containers were
started and no unit, integration, build, or restore tests were run for this audit.

## Verified findings

### F1: Self-hosted authentication is delegated outside Studio

Evidence:

- `apps/studio/hooks/misc/withAuth.tsx` returns the wrapped component immediately
  when `IS_PLATFORM` is false.
- `apps/studio/lib/auth.tsx` sets `alwaysLoggedIn={!IS_PLATFORM}`.
- `apps/studio/lib/api/apiWrapper.ts` authenticates only when both `IS_PLATFORM`
  and the route's `withAuth` option are true.
- `apps/studio/hooks/misc/useCheckPermissions.ts` returns permission success in
  self-hosted mode without evaluating project membership.

These are existing single-project deployment assumptions, not proof that a
running deployment is exposed. They cannot serve as authorization boundaries for
a multi-project platform. UI permission checks alone will not protect backend
database, secret, file, or lifecycle operations.

### F2: Local project endpoints do not implement a project registry

Evidence:

- `apps/studio/lib/constants/api.ts` defines `DEFAULT_PROJECT` with ref `default`.
- `apps/studio/pages/api/platform/projects/index.ts` supports GET only and returns
  an array containing that project.
- `apps/studio/pages/api/platform/projects/[ref]/index.ts` returns the default
  project without resolving the requested ref.
- `apps/studio/data/projects/project-create-mutation.ts` calls POST
  `/platform/projects`; that operation is absent from the local projects handler.

Cloud-facing UI and generated API types are reusable contracts, not an included
cloud provisioning backend. Do not set `IS_PLATFORM=true` as a shortcut: it also
changes API URLs, auth behavior, connection handling, and cloud feature paths.

### F3: Database targeting is bound to process-wide configuration

`apps/studio/lib/api/self-hosted/util.ts` constructs a connection string from
process-wide PostgreSQL constants. `self-hosted/query.ts` executes through the
configured pg-meta URL. Project selection must resolve an authorized target on
the server before accessing database helpers. A project ref in the browser or
URL does not currently establish an isolated database target.

### F4: Compose is a single-project template

`docker/docker-compose.yml` declares `name: supabase`, explicit container names
such as `supabase-db`, `supabase-auth`, and `supabase-envoy`, host-published gateway
and pooler ports, and relative bind mounts. Merely supplying a different Compose
project name will not remove explicit container-name collisions. Reusing the
same deployment directory can also reuse data paths.

No CPU or memory limits were found in the base Compose file. The new deployment
profile needs namespaced resources, separate data directories, admission checks,
and verified container limits. Disk quotas require a storage/filesystem strategy;
Compose CPU and memory settings alone do not limit disk consumption.

### F5: Public API and administration need separate routing policies

The fork uses Envoy as its default gateway, with Kong as an optional override.
`docker/volumes/api/envoy/lds.template.yaml` includes `/pg/` routing to metadata
and a catch-all route to Studio. Dashboard Basic Auth is configured at the gateway.

Placing this unchanged gateway behind a public project domain would retain those
administrative routes. Build a project API route profile exposing only approved
Auth, REST, Storage, Realtime, Functions, and required discovery endpoints. Route
Studio and privileged metadata requests through authenticated management paths.
Traefik handles ingress TLS; Envoy continues handling Supabase API semantics.

### F6: Optional logs introduce Docker socket access

`docker/docker-compose.logs.yml` mounts the Docker socket into Vector, including
with a read-only filesystem mount. That mount does not make Docker API operations
read-only. Do not copy this into every project stack. Prefer a restricted host
collector with per-project log attribution and authorization on log reads.

### F7: Existing upgrade backups are configuration backups

`docker/update.sh:take_backup` excludes `volumes/db/data` and `volumes/storage`
and explicitly warns that it does not back up the database. Retain its useful
versioning and merge logic, but implement separate encrypted database and object
backup/restore workflows. Configuration archives may themselves contain secrets.

### F8: Useful regression infrastructure exists

Reuse Studio Vitest/MSW tests and Playwright E2E infrastructure. Docker tests
already cover service smoke checks, auth keys, S3, update behavior, and upgrades.
`.github/workflows/self-host-tests-smoke.yml` tests multiple stack profiles on a
custom Blacksmith runner. Confirm that runner availability in this fork or add
an appropriate standard Linux runner for new platform jobs. Existing suites do
not establish multi-project isolation or control-plane recovery guarantees.

Studio is migrating between Next.js and TanStack Start. Follow
`apps/studio/AGENTS.md`: preserve page files, mirror required route behavior,
and do not hand-edit generated route trees or generated API types.

## Target architecture and trust boundaries

1. Public ingress: Traefik exposes HTTPS management and project API domains.
   ACME HTTP-01 can additionally require port 80; wildcard certificates require
   DNS-01. Use ACME staging during tests. No public Docker or worker listener.
2. Management: Studio and a separate control API use a dedicated identity source
   and metadata PostgreSQL database. Customer project identities cannot authorize
   platform operations. Bootstrap the first administrator through a local,
   one-time flow; disable open platform registration.
3. Execution: a private worker claims durable jobs, renders approved templates,
   and uses the local Docker socket. The web application has no Docker mount.
   Treat the worker as host-privileged even when its API is narrow.
4. Project infrastructure: each project owns a PostgreSQL container, Auth, REST,
   Storage, Realtime, gateway, keys, data paths, and private networks. Functions,
   pooling, and logs are explicit profiles with compatibility tests.
5. Recovery: encrypted backups leave the VPS. Recovery keys and infrastructure
   reconstruction instructions survive loss of the host and control database.

Generate immutable project IDs independently of display names. Resolve project
IDs, resource ownership, backend addresses, and credentials from trusted metadata,
never from caller-supplied connection strings, URLs, paths, or Docker names.
Use a dedicated ingress network per project rather than one bridge joining all
project services. Internal networks need explicit, tested egress policies: Auth
SMTP/OAuth, webhooks, and Functions can require outbound access. Protect host,
metadata, link-local/cloud metadata, and other project destinations.

Traefik uses worker-generated file-provider configuration, atomically published
after validation. Only intended gateways join ingress networks. Publish no project
database or pooler ports by default; provide VPN/private access when required.
Project APIs remain operational during control-plane outages.

Shared-kernel containers are an initial boundary for trusted organization-owned
projects, not a guarantee against hostile tenants or container escape. Separate
VMs/hosts are required when the tenant threat model requires that stronger boundary.
A single VPS is also a shared failure domain, not a highly available deployment.

## Proposed source boundaries

- `apps/control-plane/`: authenticated control API and private worker entrypoints,
  built and deployed as separate processes with different privileges.
- `packages/control-plane/`: validated contracts, authorization actions, domain
  models, job transitions, and secret-provider interfaces.
- `deploy/platform/`: control stack, Traefik, approved project templates, bootstrap
  scripts, and configuration validation. Keep upstream `docker/` as reference.
- `apps/control-plane/migrations/`: versioned control database migrations, applied
  by a dedicated release task rather than concurrently by web replicas.
- `apps/studio/`: explicit opt-in self-hosted platform integration and a narrow
  compatibility adapter. Preserve ordinary single-project self-hosting.

Avoid importing orchestration code into browser bundles. Maintain a capability
inventory so unsupported cloud features are hidden or explicitly rejected rather
than pointed at Supabase Cloud endpoints.

## Delivery phases and acceptance gates

### Phase 0: Architecture and reproducible baseline

Record the baseline, service/image inventory, supported Studio features, identity
provider, deployment assumptions, and upstream update strategy. Establish Linux
CI with the pinned package manager, frozen installs, existing relevant tests, and
review of generated configuration. Agree RPO/RTO and backup retention before
production data is admitted. Benchmark capacity rather than promising project
counts from RAM alone.

Gate: existing relevant checks are reproducible; threat model, API contracts,
roles, and release compatibility matrix are documented.

### Phase 1: Control database, identity, authorization, and jobs

Implement organizations, memberships, projects, project roles, domains, hosts,
operations, resource inventory, secret references, backup records, and audit
events. Start with owner, operator, and viewer roles; distinguish permission to
read metadata, execute SQL, reveal secrets, restore, upgrade, and delete.

Validate sessions, issuer/audience, MFA, and current membership server-side.
Protect cookie-authenticated mutations against CSRF; validate trusted origins
and proxy headers. Rate-limit sensitive endpoints. Deny access by default.
Use authenticated encryption with versioned keys; bind ciphertext to project and
secret identity. Never put plaintext secrets into job payloads or audit records.

Use a PostgreSQL-backed job queue initially: transactional enqueue and audit,
idempotency keys, per-project serialization, worker leases and heartbeats,
bounded retries, operation progress, and reconciliation after crashes. Recheck
authorization before executing queued destructive actions.

Gate: direct API tests reject missing/revoked sessions, insufficient roles, and
cross-project requests. Duplicate requests do not duplicate resources. Restarting
the worker recovers pending jobs without executing arbitrary commands.

### Phase 2: Isolated provisioning and lifecycle

Render versioned Compose templates without fixed container names or public DB
ports. Generate independent credentials/signing material, networks, volumes/data
paths, and API URLs. Pin tested images by digest. Invoke tools using fixed
arguments; do not interpolate user text into shell commands. Reject arbitrary
mounts, images, Compose overrides, and host paths.

Preflight capacity, reserve resources transactionally, start dependencies, check
service readiness, and publish routes only after success. Track desired state
separately from observed health. Handle partial failure through resource inventory
and reconciliation. Deletion first disables access, then follows a documented
retention/purge policy; never use a global prune or unscoped volume deletion.

Gate: provision two projects; prove credential, SQL, Storage, filesystem, and
network isolation. Kill the worker at provisioning checkpoints. Exercise concurrent
create/restart/delete requests and prove unrelated resources survive.

### Phase 3: Traefik, domains, and private administration

Add default subdomains, domain normalization, uniqueness reservations, verified
custom-domain ownership, certificate issuance and renewal, and safe route removal.
Mitigate DNS rebinding/SSRF by using registry-owned backends, not arbitrary URLs.
Handle domain changes in Auth callback, issuer, and public URL configuration as
versioned operations. Do not silently invalidate existing tokens or clients.

Gate: external port scan shows only approved ingress; public project domains
cannot reach Studio, pg-meta, Docker, or workers. Test Realtime WebSocket upgrades,
Storage uploads, Auth callbacks, failed DNS validation, and certificate recovery.

### Phase 4: Central Studio and project management

Add project listing/creation, project switching, health/resource summaries, job
progress, and role-appropriate actions. Build a server-authorized project context
for all supported Studio endpoints, including SQL, Auth administration, Storage,
keys, snippets, Functions, and logs. Do not trust a client-selected backend.

Prototype shared Studio against two projects before committing to full support.
An authenticated per-project Studio can be a staged fallback, but the final shared
interface must pass the same project authorization contract. Handle cache and
subscription cleanup when switching projects. Support the declared framework
matrix and preserve existing single-project behavior.

Gate: E2E switching cannot show cached data, use credentials, execute SQL, or
subscribe to logs/events from the previous project. Viewer and operator actions
match the server permission model in both applicable Studio runtimes.

### Phase 5: Backups, restore, monitoring, and quotas

Implement scheduled encrypted off-server database and Storage backups with a
consistency protocol, manifests, checksums, retention, and failure alerts. Include
global roles, required configuration, extension versions, and recoverable key
material. Distinguish logical backups from WAL/PITR; add PITR only with tested WAL
archiving and compatible physical recovery procedures.

Restore into a new isolated stack first, verify data and authentication, then
perform an explicit cutover. Restrict restored Auth redirect/SMTP/webhook behavior
to avoid unintended external effects during drills. Separately back up the control
database and test reconstruction when its project registry is unavailable.

Collect CPU/memory, disk/inodes, database health/connections, service readiness,
certificate expiry, backup age, and job failures. Enforce memory/CPU/process limits,
log rotation, capacity admission, and documented disk quota behavior. Restrict and
redact logs; project administrators must not see another project's logs.

Gate: restore onto a clean Linux host using off-server material, measure RPO/RTO,
and test disk pressure, OOM, stale backups, lost keys, and control-plane outages.

### Phase 6: Release, upgrades, rollback, and production qualification

Publish signed/versioned platform and project release manifests, migration
compatibility rules, install/preflight/upgrade scripts, operator runbooks, and
staged rollout procedures. Snapshot/backup before changes and test representative
projects before fleet upgrades. Never update all projects implicitly on worker boot.

Rollback application images only when schema compatibility permits it. PostgreSQL
major-version changes and irreversible schema migrations require tested restore
or forward-repair paths. Retain prior release manifests and encrypted configuration.
Run dependency/image scanning and independent security review before public use.

Gate: repeat clean install, upgrade, rollback where supported, and disaster recovery
on Linux; all isolation and authorization gates pass; an operator can follow the
runbooks without undocumented local state.

## First implementation increment

After this audit/plan delivery, implement Phase 0 and the Phase 1 foundation:
contracts, control schema, permission matrix, durable operation transitions, and
Linux CI. Keep Docker execution disabled until the authorization and job recovery
tests pass. The first infrastructure milestone is two independently provisioned
projects plus successful off-server restore of one project.

## Deployment decisions still needed

- Hosting provider, region, DNS zone, and DNS provider; these select firewall,
  DNS automation, ACME, and secret/key integration specifics.
- Identity provider and authorized initial administrators.
- Whether all projects are trusted internal applications or independent customers.
- RPO/RTO, retention, expected workloads, and off-server backup destination.

These decisions do not block contracts or local tests. They do block claiming a
validated production deployment, final capacity, or a tested recovery objective.
