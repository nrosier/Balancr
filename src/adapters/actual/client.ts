/**
 * Sole owner of Actual's `dataDir`.
 *
 * `@actual-app/api` is not a REST client — it is a local sync engine over a
 * SQLite cache, and its documentation makes no concurrency guarantees. Two
 * consequences shape this file:
 *
 *  1. **One process.** This is why Balancr is a single container rather than a
 *     web/worker split; an internal RPC layer would exist only to serialise
 *     access to this directory.
 *  2. **One operation at a time.** Even inside one process, the cron pipeline
 *     and an operator pressing "Sync now" can overlap. Every call goes through
 *     `withActual`, which serialises on a promise queue.
 *
 * **This module exposes reads only.** v1 never writes to Actual, and the way
 * that is enforced is that no write method is re-exported here — so an
 * accidental `setBudgetAmount` is a compile error, not a code-review catch.
 */
import { mkdir } from 'node:fs/promises'
import * as api from '@actual-app/api'
import { config } from '../../config.ts'
import { logger } from '../../logger.ts'
import { createSerialiser } from '../../util/serialise.ts'

const log = logger.child({ module: 'actual' })

/**
 * Must match the `@actual-app/api` version in package.json.
 *
 * The package is versioned `YY.M` to track Actual server releases, and a
 * mismatch surfaces as `out-of-sync-migrations` rather than anything legible.
 * `test/unit/actual-version.test.ts` asserts this equals the installed version,
 * so bumping the dependency without revisiting the guard fails CI.
 */
export const EXPECTED_API_VERSION = '26.9.0'

export interface ActualHealth {
  opened: boolean
  /** Version reported by the Actual server, or null when unreachable. */
  serverVersion: string | null
  apiVersion: string
  /** False when server and client disagree on `YY.M`. Surfaced in the UI. */
  versionAligned: boolean
  /** Actual's own budget type. Carryover logic assumes envelope budgeting. */
  budgetType: string | null
  /** The budget's own currency, for comparison against `BASE_CURRENCY`. */
  currencyCode: string | null
  lastSyncAt: Date | null
  lastError: string | null
}

const health: ActualHealth = {
  opened: false,
  serverVersion: null,
  apiVersion: EXPECTED_API_VERSION,
  versionAligned: true,
  budgetType: null,
  currencyCode: null,
  lastSyncAt: null,
  lastError: null,
}

export function actualHealth(): Readonly<ActualHealth> {
  return { ...health }
}

/** Every Actual operation queues here; see src/util/serialise.ts for why. */
const serialise = createSerialiser()

// ---------------------------------------------------------------------------
//  Lifecycle
// ---------------------------------------------------------------------------

let opened = false

/** `YY.M` prefix — the part that has to agree between client and server. */
function majorMinor(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version)
  return match ? `${match[1]}.${match[2]}` : version
}

async function open(): Promise<void> {
  if (opened) return

  // Actual requires dataDir to exist already; it does not create it.
  await mkdir(config.ACTUAL_DATA_DIR, { recursive: true })

  await api.init({
    serverURL: config.ACTUAL_SERVER_URL,
    password: config.ACTUAL_PASSWORD,
    dataDir: config.ACTUAL_DATA_DIR,
  })

  // Pulls the budget into the local cache. Every read below is invalid until
  // this has run at least once.
  await api.downloadBudget(
    config.ACTUAL_SYNC_ID,
    config.ACTUAL_E2E_PASSWORD ? { password: config.ACTUAL_E2E_PASSWORD } : {},
  )

  opened = true
  health.opened = true
  health.lastError = null
  health.lastSyncAt = new Date()

  await recordServerFacts()
}

/**
 * Records version and budget facts for the health panel.
 *
 * A version mismatch is reported, not fatal: failing to start on every Actual
 * upgrade would take Balancr down until someone bumps a dependency, while
 * silently producing wrong numbers is worse than either. So it is loud and
 * visible in the UI instead.
 */
async function recordServerFacts(): Promise<void> {
  const version = await api.getServerVersion()
  if ('version' in version) {
    health.serverVersion = version.version
    health.versionAligned =
      majorMinor(version.version) === majorMinor(EXPECTED_API_VERSION)
    if (!health.versionAligned) {
      log.warn(
        { serverVersion: version.version, apiVersion: EXPECTED_API_VERSION },
        'Actual server and @actual-app/api disagree on version — expect ' +
          'out-of-sync-migrations errors until the package is pinned to the server',
      )
    }
  } else {
    health.serverVersion = null
    log.warn({ reason: version.error }, 'could not read Actual server version')
  }

  const prefs = await api.getPreferences()
  health.budgetType = prefs.budgetType ?? null
  health.currencyCode = prefs.defaultCurrencyCode ?? null

  if (health.budgetType && health.budgetType !== 'rollover') {
    log.warn(
      { budgetType: health.budgetType },
      'budget is not envelope-style; carryover and available figures assume rollover budgeting',
    )
  }
  if (health.currencyCode && health.currencyCode !== config.BASE_CURRENCY) {
    log.warn(
      { budget: health.currencyCode, configured: config.BASE_CURRENCY },
      'budget currency differs from BASE_CURRENCY — amounts would be mislabelled',
    )
  }
}

/**
 * The only way to touch Actual. Opens on first use and serialises every caller.
 */
export function withActual<T>(fn: (actual: typeof api) => Promise<T>): Promise<T> {
  return serialise(async () => {
    try {
      await open()
      return await fn(api)
    } catch (error) {
      health.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  })
}

/** Pulls remote changes. Run before each aggregation pass, never during one. */
export function syncActual(): Promise<void> {
  return withActual(async (actual) => {
    await actual.sync()
    health.lastSyncAt = new Date()
  })
}

/** Flushes and releases the dataDir. Call on shutdown so the cache is clean. */
export async function closeActual(): Promise<void> {
  if (!opened) return
  await serialise(async () => {
    await api.shutdown()
    opened = false
    health.opened = false
  })
}
