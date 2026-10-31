-- Each project reserves two consecutive host ports for its Supavisor pooler
-- (session, then transaction). Local mode publishes them on 127.0.0.1.
ALTER TABLE control.projects ADD COLUMN db_port integer UNIQUE CHECK (db_port BETWEEN 1024 AND 65534);
UPDATE control.projects p SET db_port = 55432 + 2 * (n.rn - 1)
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM control.projects) n
WHERE p.id = n.id;
