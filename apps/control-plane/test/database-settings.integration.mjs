import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { ProjectDatabaseSettings } from '../src/database-settings.mjs'
import { seal, unseal } from '../src/core.mjs'

const url = process.env.DATABASE_SETTINGS_TEST_URL
test(
  'password rotation changes real role credentials and recovers after an interrupted restart',
  { skip: !url },
  async () => {
    assert.equal(
      new URL(url).hostname,
      'supabase-settings-test-db',
      'Use the isolated settings test container; this test changes database roles'
    )
    const key = 'ab'.repeat(32),
      id = 'p0123456789abcdef01234567'
    const oldPassword = new URL(url).password,
      newPassword = 'new-disposable-settings-password-2026'
    const root = await mkdtemp(join(tmpdir(), 'password-rotation-'))
    const initial = new pg.Client({ connectionString: url })
    await initial.connect()
    await initial.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin SUPERUSER LOGIN; END IF; END $$"
    )
    const command = (
      await initial.query(
        "SELECT format('ALTER ROLE supabase_admin PASSWORD %L', $1::text) AS sql",
        [oldPassword]
      )
    ).rows[0].sql
    await initial.query(command)
    await initial.end()
    let stored,
      starts = 0,
      fallback = 0
    const project = {
      id,
      encrypted_secrets: seal({ POSTGRES_PASSWORD: oldPassword, JWT_SECRET: 'unchanged' }, key, id),
    }
    const infra = {
      directory: () => root,
      db: {
        query: async (_sql, values) => {
          stored = values[1]
        },
      },
      projectDb: {
        connect: async (p) => {
          const password = unseal(p.encrypted_secrets, key, id).POSTGRES_PASSWORD
          if (password === newPassword) fallback++
          const connection = new URL(url)
          connection.username = 'supabase_admin'
          connection.password = password
          const client = new pg.Client({ connectionString: connection.href })
          await client.connect()
          return client
        },
      },
      invalidate: async () => {},
      up: async () => {
        starts++
        if (starts === 1) throw new Error('simulated interrupted restart')
      },
    }
    const settings = new ProjectDatabaseSettings(infra, { key })
    const encrypted = seal({ password: newPassword }, key, id)
    try {
      await assert.rejects(settings.rotatePassword(project, encrypted), /interrupted restart/)
      assert.equal(unseal(stored, key, id).POSTGRES_PASSWORD, newPassword)
      await settings.rotatePassword(project, encrypted)
      assert.equal(fallback, 1)
      assert.equal(starts, 2)
      assert.equal(unseal(stored, key, id).JWT_SECRET, 'unchanged')
    } finally {
      const connection = new URL(url)
      connection.password = newPassword
      const cleanup = new pg.Client({ connectionString: connection.href })
      await cleanup.connect()
      for (const role of ['postgres', 'supabase_admin'])
        await cleanup.query(
          (
            await cleanup.query(
              "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
              [role, oldPassword]
            )
          ).rows[0].sql
        )
      await cleanup.end()
      await rm(root, { recursive: true, force: true })
    }
  }
)
