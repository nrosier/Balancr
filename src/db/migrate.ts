/**
 * Applies pending migrations, then exits. Runs on container start before the
 * server boots, so the process never serves traffic against an old schema.
 */
import { config } from '../config.ts'
import { applyMigrations } from './apply-migrations.ts'
import { closeDatabase, db } from './index.ts'

try {
  applyMigrations(db as never)
  console.log(`migrations applied -> ${config.DATABASE_PATH}`)
} finally {
  closeDatabase()
}
