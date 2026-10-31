-- Per-project backup policy, backup metadata, and database insights collected by
-- the worker (migration history, schema snapshots, performance samples). The API
-- reads these tables; only the worker connects to project databases.
ALTER TABLE control.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE control.operations ADD CONSTRAINT operations_kind_check CHECK (kind IN ('create','start','stop','restart','delete','recover','backup','restore','verify-domain','remove-domain','upgrade','rollback','resize','inspect'));

ALTER TABLE control.projects
  ADD COLUMN backup_interval_hours integer NOT NULL DEFAULT 24 CHECK (backup_interval_hours BETWEEN 0 AND 720),
  ADD COLUMN backup_retention integer NOT NULL DEFAULT 7 CHECK (backup_retention BETWEEN 1 AND 365);

ALTER TABLE control.backups
  ADD COLUMN size_bytes bigint,
  ADD COLUMN trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','scheduled','pre-restore'));

CREATE TABLE control.project_insights (
  project_id text PRIMARY KEY REFERENCES control.projects(id),
  migrations jsonb,
  performance jsonb,
  collected_at timestamptz,
  error_code text
);

CREATE TABLE control.project_stats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL REFERENCES control.projects(id),
  collected_at timestamptz NOT NULL DEFAULT now(),
  sample jsonb NOT NULL
);
CREATE INDEX project_stats_series ON control.project_stats(project_id, collected_at);

CREATE TABLE control.schema_snapshots (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES control.projects(id),
  content text NOT NULL,
  hash text NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schema_snapshots_history ON control.schema_snapshots(project_id, created_at DESC);

REVOKE ALL ON control.project_insights, control.project_stats, control.schema_snapshots FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_api') THEN
    GRANT SELECT ON control.project_insights, control.project_stats, control.schema_snapshots TO control_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON control.project_insights TO control_worker;
    GRANT SELECT, INSERT, DELETE ON control.project_stats, control.schema_snapshots TO control_worker;
    GRANT DELETE, UPDATE ON control.backups TO control_worker;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA control TO control_worker;
  END IF;
END $$;
