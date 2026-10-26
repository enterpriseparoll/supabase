-- Studio Observability without a logs analytics service: a resource sample per
-- project per minute, and per-minute log line counts per service and outcome.
CREATE TABLE control.project_metric_samples (
  project_id text NOT NULL REFERENCES control.projects(id),
  sampled_at timestamptz NOT NULL DEFAULT now(),
  sample jsonb NOT NULL,
  PRIMARY KEY (project_id, sampled_at)
);

CREATE TABLE control.project_log_counts (
  project_id text NOT NULL REFERENCES control.projects(id),
  bucket timestamptz NOT NULL,
  service text NOT NULL,
  ok integer NOT NULL DEFAULT 0,
  warning integer NOT NULL DEFAULT 0,
  error integer NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, bucket, service)
);

-- Where each service's last count ended, so lines are counted once.
CREATE TABLE control.project_log_cursors (
  project_id text NOT NULL REFERENCES control.projects(id),
  service text NOT NULL,
  counted_until timestamptz NOT NULL,
  PRIMARY KEY (project_id, service)
);

REVOKE ALL ON control.project_metric_samples, control.project_log_counts, control.project_log_cursors FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_api') THEN
    GRANT SELECT ON control.project_metric_samples, control.project_log_counts TO control_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON control.project_metric_samples,
      control.project_log_counts, control.project_log_cursors TO control_worker;
  END IF;
END $$;
