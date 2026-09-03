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
 *  2. the egress allowlist is installed before anything can open a socket, since
 *     it replaces a global and a reference taken before it lands is unguarded.
 *  3. migrations run before anything serves, so traffic never meets an old schema.
 *  4. the built-in prompts are seeded, so a fresh database has an active,
 *     inspectable prompt rather than a hidden constant. Idempotent, and it never
 *     touches a prompt someone has edited.
 *  5. i18n initialises before the first render or cron digest, which have no
 *     request context to fall back on.
 *  6. the scheduler starts last, once everything it needs is up. It ticks
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
import {
  oldestVerification,
  rulesInForceOn,
  taxRulesOrNull,
  transcribedRules,
} from './domain/tax/rules.ts'
import { staleFunds, universeOrEmpty } from './domain/universe/universe.ts'
import { installEgressGuard } from './egress.ts'
import { looseEnvFile, looseEnvFileMessage } from './env-file.ts'
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

  // Installed before anything can open a socket. It replaces `globalThis.fetch`
  // process-wide, and a dependency that captured a reference to the original at
  // import time would keep using it — so the only safe moment is one where nothing
  // has fetched yet. `egress.ts` states plainly what this does and does not cover.
  installEgressGuard()

  // The mode of `.env`, said once per start rather than trusted to stay right. Every
  // secret this process holds is in that file in plain text, and a `0644` copy of it
  // looks exactly like a `0600` one from inside the app (#39).
  const loose = looseEnvFile()
  if (loose !== undefined) log.warn(loose, looseEnvFileMessage(loose))

  // The fund universe, said out loud at boot. It is read per use rather than cached
  // here (#40) — an edit should not need a restart — so this line is not a load, it is
  // the answer to "why did advice suggest nothing", available before anyone asks.
  const universe = universeOrEmpty()
  if (universe.path === null) {
    log.info(
      { path: config.FUND_UNIVERSE_PATH },
      'no fund universe file; portfolio advice will propose nothing until there is one',
    )
  } else {
    const stale = staleFunds(universe)
    log.info(
      { path: universe.path, funds: universe.funds.length, stale: stale.length },
      stale.length === 0
        ? 'fund universe loaded'
        : `fund universe loaded; ${stale.length} entr${stale.length === 1 ? 'y is' : 'ies are'} ` +
          `past FUND_UNIVERSE_MAX_AGE_DAYS and cannot be proposed until re-verified`,
    )
  }

  // The tax rules, for the same reason and with a different emphasis. A missing or broken
  // file here is a mistake rather than a choice — one ships with the image — and the ages
  // and statuses are worth a line at boot because they are what every tax figure will be
  // qualified by (#42).
  const taxRules = taxRulesOrNull()
  const ruleset = taxRules === null ? null : rulesInForceOn(taxRules)
  if (taxRules !== null && ruleset === null) {
    log.warn(
      { path: taxRules.path },
      'the tax rules file has no ruleset in force today; tax estimates will be refused',
    )
  } else if (taxRules !== null && ruleset !== null) {
    const oldest = oldestVerification(ruleset)
    const unchecked = transcribedRules(ruleset)
    log.info(
      {
        path: taxRules.path,
        effectiveFrom: ruleset.effective_from,
        oldestVerified: oldest.date,
        oldestVerifiedRule: oldest.rule,
        transcribed: unchecked,
      },
      unchecked.length === 0
        ? 'tax rules loaded'
        : `tax rules loaded; ${unchecked.length} of 4 rules are transcribed rather than ` +
          'confirmed, and every estimate using one will say so',
    )
  }

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
