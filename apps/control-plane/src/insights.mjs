// Database insights for each project: migration history, schema snapshots, and
// performance statistics. Collection runs in the worker (the only process with
// access to project databases); the API serves what was collected.
import { createHash } from 'node:crypto'

// Schemas Supabase manages. Schema snapshots cover everything else, which is where
// application tables, views, functions, and policies live.
export const MANAGED_SCHEMAS = [
  '_analytics',
  '_realtime',
  '_supavisor',
  'auth',
  'cron',
  'extensions',
  'graphql',
  'graphql_public',
  'net',
  'pgbouncer',
  'pgsodium',
  'pgsodium_masks',
  'pgtle',
  'realtime',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'vault',
]

const quote = (value) => `'${value.replaceAll("'", "''")}'`

export const SQL = {
  hasMigrationTable:
    "SELECT (to_regclass('supabase_migrations.schema_migrations') IS NOT NULL)::text",
  // to_jsonb keeps this working across CLI versions with or without a name column.
  migrations: `SELECT coalesce(json_agg(json_build_object(
      'version', m.version,
      'name', to_jsonb(m)->>'name',
      'statements', CASE WHEN jsonb_typeof(to_jsonb(m)->'statements') = 'array'
        THEN jsonb_array_length(to_jsonb(m)->'statements') ELSE 0 END
    ) ORDER BY m.version), '[]'::json)::text
    FROM supabase_migrations.schema_migrations m`,
  userSchemas: `SELECT coalesce(json_agg(nspname ORDER BY nspname), '[]'::json)::text
    FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
      AND nspname NOT IN (${MANAGED_SCHEMAS.map(quote).join(', ')})`,
  statementsSchema:
    "SELECT coalesce((SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pg_stat_statements'), '')",
  performance: `WITH conn AS (
      SELECT count(*) AS total,
        count(*) FILTER (WHERE state = 'active') AS active,
        count(*) FILTER (WHERE state = 'idle') AS idle,
        count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_in_transaction,
        coalesce(max(extract(epoch FROM now() - query_start))
          FILTER (WHERE state = 'active' AND pid <> pg_backend_pid()), 0)::int AS longest_active_seconds
      FROM pg_stat_activity WHERE datname = current_database()
    ), db AS (
      SELECT xact_commit, xact_rollback, blks_hit, blks_read, deadlocks, temp_bytes,
        tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted
      FROM pg_stat_database WHERE datname = current_database()
    ), tables AS (
      SELECT n.nspname || '.' || c.relname AS name,
        pg_total_relation_size(c.oid) AS total_bytes,
        coalesce(s.n_live_tup, 0) AS live_rows,
        coalesce(s.n_dead_tup, 0) AS dead_rows,
        coalesce(s.seq_scan, 0) AS seq_scans,
        coalesce(s.idx_scan, 0) AS index_scans
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 10
    )
    SELECT json_build_object(
      'database_bytes', pg_database_size(current_database()),
      'max_connections', current_setting('max_connections')::int,
      'connections', (SELECT row_to_json(conn) FROM conn),
      'counters', (SELECT row_to_json(db) FROM db),
      'cache_hit_ratio', (SELECT CASE WHEN blks_hit + blks_read = 0 THEN NULL
        ELSE round(blks_hit::numeric / (blks_hit + blks_read), 4) END FROM db),
      'tables', (SELECT coalesce(json_agg(tables), '[]'::json) FROM tables)
    )::text`,
  topQueries: (schema) => `SELECT coalesce(json_agg(q), '[]'::json)::text FROM (
      SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 400) AS query, calls,
        round(total_exec_time::numeric, 1) AS total_ms,
        round(mean_exec_time::numeric, 2) AS mean_ms, rows
      FROM "${schema.replaceAll('"', '""')}".pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY total_exec_time DESC
      LIMIT 10
    ) q`,
}

// pg_dump adds per-run lines (random \restrict keys, client versions) that would
// make every snapshot differ. Drop them so identical schemas hash identically.
export function normalizeSchemaDump(text) {
  return text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('\\restrict') &&
        !line.startsWith('\\unrestrict') &&
        !line.startsWith('-- Dumped from database version') &&
        !line.startsWith('-- Dumped by pg_dump version')
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const schemaHash = (content) => createHash('sha256').update(content).digest('hex')

// A compact sample for trend charts; cumulative counters become rates client-side.
export function statsSample(performance) {
  const counters = performance.counters ?? {}
  return {
    database_bytes: performance.database_bytes,
    connections: performance.connections?.total ?? 0,
    active: performance.connections?.active ?? 0,
    cache_hit_ratio: performance.cache_hit_ratio,
    xact_commit: counters.xact_commit ?? 0,
    xact_rollback: counters.xact_rollback ?? 0,
    deadlocks: counters.deadlocks ?? 0,
  }
}

/**
 * Collects insights through two callbacks so the logic is testable without Docker:
 * `query(sql)` returns psql's unaligned single-value output; `dumpSchema(schemas)`
 * returns pg_dump --schema-only text for the given schemas.
 */
export async function collectInsights({ query, dumpSchema }) {
  const json = async (sql) => JSON.parse((await query(sql)).trim())
  const migrations =
    (await query(SQL.hasMigrationTable)).trim() === 'true' ? await json(SQL.migrations) : []
  const performance = await json(SQL.performance)
  const statementsSchema = (await query(SQL.statementsSchema)).trim()
  performance.top_queries = statementsSchema ? await json(SQL.topQueries(statementsSchema)) : null
  const schemas = await json(SQL.userSchemas)
  const schema = schemas.length ? normalizeSchemaDump(await dumpSchema(schemas)) : ''
  return { migrations, performance, schemas, schema }
}

/**
 * Line diff (Myers) grouped into unified hunks with `context` lines around changes.
 * Returns { hunks: [{ fromLine, toLine, lines: [{ type: ' '|'+'|'-', text }] }],
 * added, removed }.
 */
export function diffLines(before, after, context = 3) {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  const n = a.length,
    m = b.length,
    max = n + m
  const v = new Map([[1, 0]])
  const trace = []
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
          ? (v.get(k + 1) ?? 0)
          : (v.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) (x++, y++)
      v.set(k, x)
      if (x >= n && y >= m) break outer
    }
  }
  // Backtrack to an edit script.
  const script = []
  let x = n,
    y = m
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]
    const k = x - y
    const prevK =
      k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1
    const prevX = vd.get(prevK) ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) script.push({ type: ' ', text: a[--x], ai: x, bi: --y })
    if (d === 0) break
    if (x === prevX) script.push({ type: '+', text: b[--y], ai: x, bi: y })
    else script.push({ type: '-', text: a[--x], ai: x, bi: y })
  }
  script.reverse()
  let added = 0,
    removed = 0
  for (const row of script) {
    if (row.type === '+') added++
    if (row.type === '-') removed++
  }
  // Group changed lines with surrounding context into hunks.
  const hunks = []
  let current = null,
    lastChange = -Infinity
  script.forEach((row, index) => {
    if (row.type === ' ') return
    if (current && index - lastChange <= context * 2) {
      for (let i = lastChange + 1; i <= index; i++) current.lines.push(script[i])
    } else {
      if (current) {
        for (let i = lastChange + 1; i <= Math.min(lastChange + context, script.length - 1); i++)
          if (script[i].type === ' ') current.lines.push(script[i])
        hunks.push(current)
      }
      const start = Math.max(0, index - context)
      current = { fromLine: script[start].ai + 1, toLine: script[start].bi + 1, lines: [] }
      for (let i = start; i <= index; i++) current.lines.push(script[i])
    }
    lastChange = index
  })
  if (current) {
    for (let i = lastChange + 1; i <= Math.min(lastChange + context, script.length - 1); i++)
      if (script[i].type === ' ') current.lines.push(script[i])
    hunks.push(current)
  }
  return {
    added,
    removed,
    hunks: hunks.map((hunk) => ({
      fromLine: hunk.fromLine,
      toLine: hunk.toLine,
      lines: hunk.lines.map(({ type, text }) => ({ type, text })),
    })),
  }
}

// Restore swaps databases from template1 so the live database is replaced only after
// the backup has loaded completely. The previous database is kept as
// postgres_before_restore until the next restore. CREATE/DROP DATABASE must each run
// as their own command, so these are lists of separate statements.
export const RESTORE_SQL = {
  prepare: [
    'DROP DATABASE IF EXISTS postgres_restoring WITH (FORCE)',
    'CREATE DATABASE postgres_restoring TEMPLATE template0 OWNER postgres',
  ],
  discard: ['DROP DATABASE IF EXISTS postgres_restoring WITH (FORCE)'],
  // ALTER DATABASE ... SET values (e.g. app.settings.*) belong to the database, not
  // the dump, so carry them over, including per-role settings in that database.
  copySettings: [
    `DO $$
    DECLARE setting record; item text;
    BEGIN
      FOR setting IN
        SELECT s.setrole, s.setconfig FROM pg_db_role_setting s
        JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = 'postgres'
      LOOP
        FOREACH item IN ARRAY setting.setconfig LOOP
          IF setting.setrole = 0 THEN
            EXECUTE format('ALTER DATABASE postgres_restoring SET %I = %L',
              split_part(item, '=', 1), substr(item, strpos(item, '=') + 1));
          ELSE
            EXECUTE format('ALTER ROLE %I IN DATABASE postgres_restoring SET %I = %L',
              setting.setrole::regrole::text, split_part(item, '=', 1),
              substr(item, strpos(item, '=') + 1));
          END IF;
        END LOOP;
      END LOOP;
    END $$`,
  ],
  existing: `SELECT coalesce(string_agg(datname, ',' ORDER BY datname), '') FROM pg_database
    WHERE datname IN ('postgres', 'postgres_restoring', 'postgres_before_restore')`,
  terminate: `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
    WHERE datname IN ('postgres', 'postgres_restoring') AND pid <> pg_backend_pid()`,
}

/**
 * Remaining swap steps for the databases that exist now. Safe to call again after a
 * partial failure: once the live database has been renamed, its copy is never dropped.
 */
export function restoreSwapPlan(existing) {
  const has = new Set(existing)
  if (!has.has('postgres_restoring')) return []
  const steps = []
  if (has.has('postgres')) {
    if (has.has('postgres_before_restore'))
      steps.push('DROP DATABASE postgres_before_restore WITH (FORCE)')
    steps.push('ALTER DATABASE postgres RENAME TO postgres_before_restore')
  }
  steps.push('ALTER DATABASE postgres_restoring RENAME TO postgres')
  return steps
}
