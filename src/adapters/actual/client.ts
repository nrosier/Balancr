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
 * **`withActual` itself grants the full `@actual-app/api` surface** — it hands
 * the callback the whole module, reads and writes alike, because serialising
 * access is a concurrency concern independent of what the call does. The
 * read-only boundary lives one level up, in `queries.ts`: until #45, no
 * function there called a write method, so an accidental `setBudgetAmount`
 * would have been a code-review catch rather than a compile error. #45 adds
 * exactly two — `updateTransactionCategory`, `setCategoryBudgetAmount` — and
 * both are reachable only from an approved, audited proposal
 * (`domain/ai/proposals.ts`'s `applyRemote`), never from a read path. See
 * `test/unit/actual-adapter.test.ts`'s denylist for what is still refused.
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

/** Log levels at which Actual's own console output is wanted rather than noise. */
const VERBOSE_LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'trace'])

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

/**
 * What Actual's error codes about encryption mean in terms of Balancr's `.env`.
 *
 * `ACTUAL_E2E_PASSWORD` is a different password from `ACTUAL_PASSWORD` two lines
 * above it in `.env`, and it is only consulted when the budget is end-to-end
 * encrypted — Actual's own handler reads it inside `if (activeFile.encryptKeyId)`
 * and ignores it entirely otherwise. So a blank value on an unencrypted budget is
 * a complete, correct configuration, and this maps the cases where it is not.
 *
 * The reason for translating at all is that Actual's messages are written for
 * someone standing in front of its own UI: "File Household is encrypted. Please
 * provide a password." names neither the variable to set nor the file to set it in,
 * and the person reading it has no way to know that Balancr spells that password
 * `ACTUAL_E2E_PASSWORD`.
 */
const E2E_ERRORS: Readonly<Record<string, string>> = {
  'missing-key':
    'this budget is end-to-end encrypted; set ACTUAL_E2E_PASSWORD in .env to its ' +
    'encryption password (which is not ACTUAL_PASSWORD)',
  'decrypt-failure':
    'ACTUAL_E2E_PASSWORD does not decrypt this budget; it is the budget\'s ' +
    'encryption password, not the Actual server password',
  'file-has-new-key':
    'this budget\'s encryption key has been changed in Actual since ' +
    'ACTUAL_E2E_PASSWORD was set; update it to the current password',
  // Not fixable through configuration, so it must not suggest one: the key itself
  // has to be recreated in Actual, on a device that still has the file.
  'old-key-style':
    'this budget uses an unsupported old encryption key style; recreate the key in ' +
    'Actual on a device where the budget is available, then set ACTUAL_E2E_PASSWORD',
}

/**
 * `downloadBudget`, with encryption failures rephrased.
 *
 * Deliberately no pre-flight check for whether the budget is encrypted. That would
 * be a second round trip to learn something this call is about to tell us, and the
 * answer would go stale the moment encryption is switched on. Every other error —
 * `budget-not-found`, `out-of-sync-migrations`, a network failure — passes through
 * untouched, because blaming encryption for a wrong sync id would send someone to
 * the wrong line of `.env`.
 */
async function download(): Promise<void> {
  try {
    await api.downloadBudget(
      config.ACTUAL_SYNC_ID,
      // Spread rather than `{ password: undefined }`: Actual tests the property for
      // truthiness, and an explicitly-undefined key is a claim we did not mean to make.
      config.ACTUAL_E2E_PASSWORD ? { password: config.ACTUAL_E2E_PASSWORD } : {},
    )
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const { code } = error as { code?: unknown }
    const explanation = typeof code === 'string' ? E2E_ERRORS[code] : undefined
    if (explanation === undefined) throw error

    // The original message is kept: it names the budget file, which is the one
    // detail Balancr cannot supply and which identifies *which* budget is encrypted.
    throw new Error(`Cannot open the Actual budget: ${explanation}. Actual said: ${error.message}`, {
      cause: error,
    })
  }
}

async function open(): Promise<void> {
  if (opened) return

  // Actual requires dataDir to exist already; it does not create it.
  await mkdir(config.ACTUAL_DATA_DIR, { recursive: true })

  await api.init({
    serverURL: config.ACTUAL_SERVER_URL,
    password: config.ACTUAL_PASSWORD,
    dataDir: config.ACTUAL_DATA_DIR,
    // Actual's engine logs breadcrumbs and sync progress through `console.log`, and
    // its `verboseMode` defaults to on — ten unparseable lines per sync landing in
    // the middle of pino's JSON stream (#123). Off by default, but not silenced:
    // when a budget will not load, that chatter is the only view into why, and
    // asking for it is what LOG_LEVEL=debug means.
    verbose: VERBOSE_LOG_LEVELS.has(config.LOG_LEVEL),
  })

  // Pulls the budget into the local cache. Every read below is invalid until
  // this has run at least once.
  await download()

  opened = true
  health.opened = true
  health.lastError = null
  health.lastSyncAt = new Date()

  await recordServerFacts()
}

/**
 * What Actual calls envelope budgeting, in every spelling it has used.
 *
 * `rollover` is the original name and `envelope` is the current one — Actual renamed
 * its two budget styles (the other went from `report` to `tracking`), and the check
 * below tested only the old name. So it warned that an envelope budget was not an
 * envelope budget, on precisely the configuration it exists to endorse, and would
 * have stayed silent on `tracking`, the one case where the carryover figures really
 * are not what this application assumes.
 *
 * Both spellings stay accepted rather than the set being migrated to the new one: a
 * deployment running an older Actual still reports `rollover`, and there is no
 * version at which a warning about it would be correct.
 *
 * Exported so a test can pin the spellings. They come out of someone else's release
 * notes, which is the kind of value that is only ever wrong in production.
 */
export const ENVELOPE_BUDGET_TYPES: ReadonlySet<string> = new Set(['envelope', 'rollover'])

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

  if (health.budgetType && !ENVELOPE_BUDGET_TYPES.has(health.budgetType)) {
    log.warn(
      { budgetType: health.budgetType, expected: [...ENVELOPE_BUDGET_TYPES].join(' or ') },
      'budget is not envelope-style; carryover and available figures assume envelope budgeting',
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
