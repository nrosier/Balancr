/**
 * Process entry point.
 *
 * The version and commit are logged first, before any startup step, so the logs
 * always identify the running build. Nothing can precede it: the logger's own
 * level comes from `config`, so a process that cannot read its environment dies
 * before it has anywhere to say so.
 *
 * Startup order is deliberate and each step is a hard failure:
 *  1. `config` validates the environment at import time — a half-configured
 *     advisor that silently skips auth is worse than one that refuses to boot.
 *  2. migrations run before anything serves, so traffic never meets an old schema.
 *  3. the built-in prompts are seeded, so a fresh database has an active,
 *     inspectable prompt rather than a hidden constant. Idempotent, and it never
 *     touches a prompt someone has edited.
 *  4. i18n initialises before the first render or cron digest, which have no
 *     request context to fall back on.
 *  5. the scheduler starts last, once everything it needs is up. It ticks
 *     immediately, so starting it before the migrations ran would mean a job
 *     writing to a schema that does not exist yet.
 *
 * The HTTP surface itself lives in `server/app.ts`. This file owns the lifecycle —
 * what must be true before the port opens, and what must be released before the
 * process exits — and nothing else.
 */
import { closeActual } from './adapters/actual/client.ts'
import { config, configSummary } from './config.ts'
import { applyMigrations } from './db/apply-migrations.ts'
import { closeDatabase, db } from './db/index.ts'
import { seedPrompts } from './domain/ai/prompts.ts'
import { initI18n } from './i18n/index.ts'
import { createScheduler, registry } from './jobs/index.ts'
import { logger } from './logger.ts'
import { buildApp } from './server/app.ts'
import { APP_REVISION, APP_VERSION } from './server/version.ts'

const log = logger.child({ module: 'main' })

async function main(): Promise<void> {
  // The first line out of the process. When a container is misbehaving the first
  // question is which build it is, and an answer that only arrives once the
  // migrations have run is no answer at all — a crash during startup is exactly
  // the case where the version matters most. `revision` is null outside an image.
  log.info(
    { version: APP_VERSION, revision: APP_REVISION, node: process.version, env: config.NODE_ENV },
    'balancr starting',
  )

  // The effective configuration, once, right after the version. `configSummary`
  // exists precisely to be loggable — it names every variable and masks every
  // secret — and until now nothing called it, so a value that was wrong could only
  // be found by reading the container's environment. That is one `docker` command
  // too many for the question "is PUBLIC_BASE_URL what I think it is", which is
  // the question behind a rejected OIDC redirect URI (#110).
  log.info(configSummary(), 'configuration')

  applyMigrations(db as never)
  log.info({ database: config.DATABASE_PATH }, 'migrations applied')

  const seeded = seedPrompts(db)
  if (seeded > 0) log.info({ prompts: seeded }, 'seeded built-in prompts')

  await initI18n()

  const app = await buildApp({ db })

  await app.listen({ host: '0.0.0.0', port: config.PORT })
  log.info({ port: config.PORT, env: config.NODE_ENV }, 'balancr listening')

  // Off is a supported state, not a degraded one: a second instance, or a look at
  // a copy of the database, must not reach out to Actual and Ghostfolio.
  const scheduler = createScheduler(db, registry)
  if (config.JOBS_ENABLED) {
    scheduler.start()
  } else {
    log.warn('JOBS_ENABLED=false — nothing is scheduled; data will not refresh')
  }

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'shutting down')
    void (async () => {
      try {
        // Stopped first so no new job starts while the process is closing. A job
        // already mid-flight finishes; `closeActual` waits behind it on the same
        // queue, which is what keeps the dataDir lock from being released early.
        scheduler.stop()
        await app.close()
        // Actual holds a lock on its dataDir; leaving it held makes the next
        // start fail with a file already in use.
        await closeActual()
        closeDatabase()
      } finally {
        process.exit(0)
      }
    })()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

await main()
