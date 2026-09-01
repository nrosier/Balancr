/**
 * Process entry point.
 *
 * Startup order is deliberate and each step is a hard failure:
 *  1. `config` validates the environment at import time — a half-configured
 *     advisor that silently skips auth is worse than one that refuses to boot.
 *  2. migrations run before anything serves, so traffic never meets an old schema.
 *  3. i18n initialises before the first render or cron digest, which have no
 *     request context to fall back on.
 *  4. the scheduler starts last, once everything it needs is up. It ticks
 *     immediately, so starting it before the migrations ran would mean a job
 *     writing to a schema that does not exist yet.
 *
 * The HTTP surface here is liveness only. Routes, auth and the SPA arrive with
 * the server module (v0.5.0); this file will then hand off to it instead of
 * building the instance itself.
 */
import { readFileSync } from 'node:fs'
import Fastify, { LogController } from 'fastify'
import { config } from './config.ts'
import { applyMigrations } from './db/apply-migrations.ts'
import { closeDatabase, db } from './db/index.ts'
import { initI18n } from './i18n/index.ts'
import { logger } from './logger.ts'
import { closeActual } from './adapters/actual/client.ts'
import { createScheduler, registry } from './jobs/index.ts'

const log = logger.child({ module: 'main' })

/**
 * Version reported by `/healthz`.
 *
 * Not `process.env.npm_package_version`: npm only sets that when the process is
 * started through an npm script, and the image runs `node dist/main.js` — so the
 * health endpoint answered `"version": null` in the container while looking
 * correct in development. package.json is copied next to `dist`, so read it.
 */
function appVersion(): string | null {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch (error) {
    log.warn({ err: error }, 'could not read package.json for the version')
    return null
  }
}

const VERSION = appVersion()

async function main(): Promise<void> {
  applyMigrations(db as never)
  log.info({ database: config.DATABASE_PATH }, 'migrations applied')

  await initI18n()

  const app = Fastify({
    loggerInstance: logger,
    // Honoured only for peers inside TRUSTED_PROXY_CIDRS: without this, anyone
    // reaching the container directly can forge X-Forwarded-For and, later,
    // the Authentik identity headers.
    trustProxy: config.TRUSTED_PROXY_CIDRS,
    // The top-level `disableRequestLogging` is deprecated in Fastify 5.12 and
    // goes away in 6; the controller is the supported route. Access logs are off
    // in production because Traefik already writes them, and duplicating them
    // here doubles the disk they occupy on the way to holding financial data.
    logController: new LogController({
      disableRequestLogging: config.NODE_ENV === 'production',
    }),
  })

  // Liveness: no database, no upstreams. The container health check must not
  // fail because Ghostfolio is restarting.
  app.get('/healthz', () => ({ status: 'ok', version: VERSION }))

  // The SPA is served from here once it exists (0.6.0). Until then this says so,
  // because a bare Fastify `Route GET:/ not found` on the root of a fresh
  // deployment reads as a broken container rather than as an unfinished one.
  app.get('/', () => ({
    name: 'balancr',
    version: VERSION,
    ui: 'not built yet — the web interface arrives in 0.6.0',
    health: '/healthz',
  }))

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
