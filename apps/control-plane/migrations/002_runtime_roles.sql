DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_api') THEN
    GRANT USAGE ON SCHEMA control TO control_api;
    GRANT SELECT,INSERT,UPDATE,DELETE ON control.projects,control.members,control.project_members,
      control.operations,control.sessions,control.login_flows,control.studio_tickets,control.domains TO control_api;
    GRANT SELECT ON control.backups,control.audit TO control_api;
    GRANT INSERT ON control.audit TO control_api;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA control TO control_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_worker') THEN
    GRANT USAGE ON SCHEMA control TO control_worker;
    GRANT SELECT ON ALL TABLES IN SCHEMA control TO control_worker;
    GRANT UPDATE ON control.projects,control.operations,control.domains TO control_worker;
    GRANT INSERT ON control.operations,control.backups,control.audit TO control_worker;
    GRANT DELETE ON control.sessions,control.login_flows,control.studio_tickets,control.domains TO control_worker;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA control TO control_worker;
  END IF;
END $$;
