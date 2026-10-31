-- Developer tools: personal access tokens (CLI, MCP, automation), fast requests the
-- worker answers outside the operation queue (SQL, type generation, Edge Functions),
-- and GitHub repositories that deploy migrations and functions to a project.
ALTER TABLE control.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE control.operations ADD CONSTRAINT operations_kind_check CHECK (kind IN ('create','start','stop','restart','delete','recover','backup','restore','verify-domain','remove-domain','upgrade','rollback','resize','inspect','deploy'));

CREATE TABLE control.access_tokens (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE,
  read_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX access_tokens_subject ON control.access_tokens(subject, created_at DESC);

CREATE TABLE control.live_requests (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES control.projects(id),
  subject text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sql','types','functions','deploy-function','migrations','apply-migration')),
  payload jsonb NOT NULL,
  read_only boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed')),
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX live_requests_queue ON control.live_requests(state, created_at);

CREATE TABLE control.github_links (
  project_id text PRIMARY KEY REFERENCES control.projects(id),
  repository text NOT NULL,
  branch text NOT NULL,
  directory text NOT NULL DEFAULT 'supabase',
  encrypted_token text,
  auto_deploy boolean NOT NULL DEFAULT true,
  etag text,
  head_sha text,
  checked_at timestamptz,
  check_error text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control.deployments (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES control.projects(id),
  operation_id uuid,
  source text NOT NULL CHECK (source IN ('push','manual','provision')),
  repository text NOT NULL,
  branch text NOT NULL,
  commit_sha text,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','failed')),
  migrations jsonb NOT NULL DEFAULT '[]',
  functions jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX deployments_history ON control.deployments(project_id, created_at DESC);

REVOKE ALL ON control.access_tokens, control.live_requests, control.github_links, control.deployments FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_api') THEN
    GRANT SELECT, INSERT, UPDATE ON control.access_tokens TO control_api;
    GRANT SELECT, INSERT ON control.live_requests TO control_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON control.github_links TO control_api;
    GRANT SELECT ON control.deployments TO control_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_worker') THEN
    GRANT SELECT, UPDATE, DELETE ON control.live_requests TO control_worker;
    GRANT SELECT, UPDATE ON control.github_links TO control_worker;
    GRANT SELECT, INSERT, UPDATE ON control.deployments TO control_worker;
  END IF;
END $$;
