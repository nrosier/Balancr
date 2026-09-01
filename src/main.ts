/**
 * Process entry point.
 *
 * Startup order is deliberate and each step is a hard failure:
 *  1. `config` validates the environment at import time — a half-configured
 *     advisor that silently skips auth is worse than one that refuses to boot.
 *  2. migrations run before anything serves, so traffic never meets an old schema.
 *  3. i18n initialises before the first render or cron digest, which have no
 *     request context to fall back on.
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

  await app.listen({ host: '0.0.0.0', port: config.PORT })
  log.info({ port: config.PORT, env: config.NODE_ENV }, 'balancr listening')

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'shutting down')
    void (async () => {
      try {
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
