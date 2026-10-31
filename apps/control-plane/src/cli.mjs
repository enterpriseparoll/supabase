import { configuration } from './config.mjs'
import { database, migrate, transaction, audit } from './database.mjs'
import { invariant } from './core.mjs'

const config = await configuration()
const pool = database(config.databaseUrl)
try {
  if (process.argv[2] === 'migrate') await migrate(pool)
  else if (process.argv[2] === 'bootstrap-owner') {
    const subject = process.argv[3]
    invariant(
      subject && subject.length <= 255,
      400,
      'Provide the exact OIDC subject of the first owner'
    )
    await transaction(pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(8734143)')
      invariant(
        !(await db.query('SELECT 1 FROM control.members LIMIT 1')).rowCount,
        409,
        'Platform is already bootstrapped. Use the authenticated members API.'
      )
      await db.query("INSERT INTO control.members(subject,role) VALUES($1,'owner')", [subject])
      await audit(db, '@bootstrap', 'owner.created', null, { subject })
    })
  } else throw new Error('Usage: node src/cli.mjs migrate | bootstrap-owner <OIDC-subject>')
  console.log('Completed')
} catch (error) {
  // The control database keeps the passwords it was created with. New secrets mean
  // the data folder was replaced (for example, Docker Desktop cleared it).
  if (error.code === '28P01')
    console.error(
      'The control database rejected the platform password. The secrets folder was recreated, so it no longer matches the existing database (and project data stored beside it is likely gone). See README "Local mode" to reset.'
    )
  throw error
} finally {
  await pool.end()
}
