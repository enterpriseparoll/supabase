CREATE SCHEMA IF NOT EXISTS control;
REVOKE ALL ON SCHEMA control FROM PUBLIC;
CREATE TABLE control.members (
  subject text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('owner','operator','viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.projects (
  id text PRIMARY KEY CHECK (id ~ '^p[a-f0-9]{24}$'),
  name text NOT NULL,
  site_url text NOT NULL,
  memory_mb integer NOT NULL CHECK (memory_mb >= 2048),
  cpus numeric NOT NULL CHECK (cpus >= 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','stopped','error','deleted')),
  desired_state text NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running','stopped','deleted')),
  encrypted_secrets text NOT NULL,
  release text NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}',
  last_observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.project_members (
  project_id text REFERENCES control.projects(id),
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','operator','viewer')),
  PRIMARY KEY (project_id, subject)
);
CREATE TABLE control.operations (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES control.projects(id),
  actor text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create','start','stop','restart','delete','recover','backup','restore','verify-domain','remove-domain','upgrade','rollback')),
  payload jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor, idempotency_key)
);
CREATE INDEX operations_queue ON control.operations(state, retry_at, created_at);
CREATE UNIQUE INDEX one_active_operation ON control.operations(project_id) WHERE state = 'running';
CREATE TABLE control.sessions (
  token_hash text PRIMARY KEY,
  subject text NOT NULL,
  project_id text REFERENCES control.projects(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.studio_tickets (
  token_hash text PRIMARY KEY,
  subject text NOT NULL,
  project_id text NOT NULL REFERENCES control.projects(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE control.login_flows (
  state_hash text PRIMARY KEY,
  encrypted_flow text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE control.domains (
  domain text PRIMARY KEY,
  project_id text NOT NULL REFERENCES control.projects(id),
  verification_token text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.backups (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES control.projects(id),
  snapshot text NOT NULL,
  source_path text NOT NULL,
  release text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  project_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ALL TABLES IN SCHEMA control FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control FROM PUBLIC;
