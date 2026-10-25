# Self-hosted project platform

This standalone Node service adds a project registry, centralized dashboard,
OIDC sign-in with a required MFA assurance value, server-enforced roles, encrypted
credentials, durable lifecycle jobs, isolated Supabase Compose stacks, protected
Studio access, custom domains, monitoring, and restic backup/restore workflows.
There is no fixed project-count limit. Capacity admission uses the host budget;
this release provisions one Linux host, not an automatic multi-server fleet.

The control API and execution worker run as separate processes. Only the worker
has Docker access. Public API traffic goes directly through Traefik to a project
gateway and does not depend on the management service. Studio access is a
central-dashboard handoff to a per-project Studio; this does not replace all of
Supabase Cloud's management APIs or implement shared-runtime multi-project Studio.

## Development

This application intentionally uses its own pinned npm lockfile and is excluded
from the main pnpm workspace. Existing Studio dependencies and lockfiles do not
need to change to deploy it.

```sh
cd apps/control-plane
npm ci --ignore-scripts
npm run build
npm test
npm run lint
CONTROL_TEST_DATABASE_URL=postgresql://postgres:integration-only@127.0.0.1:5432/control_test npm run test:integration
```

Integration tests reset the `control` schema and migration table in the supplied
database. The database name must end with `_test`; never point them at live data.
The migration command requires the control database owner, while the deployed API
and worker use separate restricted PostgreSQL roles.

See [deployment and recovery](../../deploy/platform/README.md) for installation,
identity-provider configuration, operating procedures, and current validation limits.

## API

All management mutations require an authenticated host-only session cookie, an
exact matching `Origin`, JSON where a body is expected, and permission on the
target project. Project creation and lifecycle mutations require an
`Idempotency-Key` of 8–128 letters, digits, underscores, or hyphens.

Mutations are rate limited per signed-in identity (30 burst, 30/minute). Credential
retrieval, Studio tickets, and membership changes have a stricter extra budget
(5 burst, 10/minute) and return `429` when exhausted. Budgets live in process
memory, so each API replica enforces its own; run one API replica, or move the
limiter to a shared store, before scaling out.

- `GET /api/me`: current identity and platform role.
- `GET /api/projects?limit=30&cursor=...`: paginated authorized projects.
- `POST /api/projects`: `{name, siteUrl, memoryMb, cpus}`; returns an operation.
- `GET /api/projects/:id`: metadata, metrics, and effective project role.
- `POST /api/projects/:id/operations`: `{kind}` for start, stop, restart, backup;
  delete requires `confirmation: id`; restore requires `backupId` and confirmation;
  upgrade/rollback require a locally approved `release` identifier.
- `GET /api/projects/:id/operations`: recent operation progress and safe error codes.
- `POST /api/projects/:id/secrets`: privileged, audited credential retrieval.
- `POST /api/projects/:id/studio-ticket`: one-time, 30-second Studio handoff.
- `GET /api/projects/:id/backups`: completed backup records.
- `GET|POST|DELETE /api/projects/:id/domains`: inspect, reserve, or queue removal
  of a custom domain. POST/DELETE accept `{domain}`. Verify through an operation
  `{kind:"verify-domain", domain}` after adding the supplied TXT record.
- `GET|POST /api/projects/:id/members`: project owner membership management;
  POST accepts `{subject, role}` with owner/operator/viewer/revoked.
- `GET|POST /api/members`: platform owner membership management, same body.
- `GET /api/audit`: latest 200 audit records for platform owners.

Platform roles apply to all projects. An identity without a platform role sees
only explicit project memberships. Viewers can read metadata and backup records;
operators can manage project services, domains, credentials, and Studio; owners
can additionally delete, restore, approve release operations, and manage access.
Studio includes privileged SQL and administration, so viewers cannot open it.

Credentials must remain on the server side of consuming applications except for
the publishable/anon key. Project Auth users are unrelated to platform operators.
