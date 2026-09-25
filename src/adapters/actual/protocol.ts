/**
 * Shared IPC message shapes between `client.ts` (the parent process, one
 * `TenantWorker` per tenant) and `worker.ts` (the child process that actually
 * holds `@actual-app/api`'s open budget for that tenant).
 *
 * Forked with `serialization: 'advanced'` rather than the default JSON mode —
 * see `worker.ts`'s header for why, and `test/unit/actual-protocol.test.ts`
 * for the round-trip proof that a `Date` argument (`fetchAccountBalances`'s
 * `asOf`) survives the trip as a `Date` rather than an ISO string.
 */
import type { EgressMode } from '../../egress.ts'

/**
 * What the worker needs to open a budget, resolved from the calling tenant's
 * own row (`resolvedIntegrations`) rather than read from `.env` — the worker
 * process never imports `config.ts` for any of these.
 */
/**
 * Must match the `@actual-app/api` version in package.json.
 *
 * The package is versioned `YY.M` to track Actual server releases, and a
 * mismatch surfaces as `out-of-sync-migrations` rather than anything legible.
 * `test/unit/actual-version.test.ts` asserts this equals the installed version,
 * so bumping the dependency without revisiting the guard fails CI.
 *
 * Lives here rather than in `worker.ts` so `client.ts` can import it without
 * loading `worker.ts`'s module — which would register its top-level
 * `process.on('message', ...)` dispatch loop on whatever process does the
 * importing, including a real Vitest worker process.
 */
export const EXPECTED_API_VERSION = '26.9.0'

/**
 * What Actual calls envelope budgeting, in every spelling it has used.
 *
 * `rollover` is the original name and `envelope` is the current one — Actual renamed
 * its two budget styles (the other went from `report` to `tracking`), and a check
 * against only the old name would warn that an envelope budget is not an envelope
 * budget, on precisely the configuration it exists to endorse, and stay silent on
 * `tracking`, the one case where the carryover figures really are not what this
 * application assumes.
 *
 * Both spellings stay accepted rather than the set being migrated to the new one: a
 * deployment running an older Actual still reports `rollover`, and there is no
 * version at which a warning about it would be correct.
 *
 * Exported so a test can pin the spellings. They come out of someone else's release
 * notes, which is the kind of value that is only ever wrong in production.
 */
export const ENVELOPE_BUDGET_TYPES: ReadonlySet<string> = new Set(['envelope', 'rollover'])

export interface ActualOpenConfig {
  serverUrl: string
  password: string
  /** Per-tenant subdirectory; the worker creates it if missing. */
  dataDir: string
  syncId: string
  e2ePassword: string | null
  /** `config.LOG_LEVEL` — stays global, so it is passed rather than resolved. */
  logLevel: string
  /** `config.BASE_CURRENCY` — same reasoning as `logLevel`. */
  baseCurrency: string
  /**
   * `config.EGRESS_MODE` — same reasoning as `logLevel`: a deployment-wide setting,
   * not a per-tenant credential, so it travels over IPC rather than through an
   * import of `config.ts` (#536).
   */
  egressMode: EgressMode
}

export type ActualRequest =
  | { id: number; kind: 'open'; config: ActualOpenConfig }
  | { id: number; kind: 'call'; method: string; args: unknown[] }
  /**
   * Runs every op in order with no other request interleaved — the atomicity
   * `fetchSchedules` needs (see `queries.ts`'s comment on that function for why).
   */
  | { id: number; kind: 'batch'; ops: readonly { method: string; args: unknown[] }[] }
  | { id: number; kind: 'sync' }
  | { id: number; kind: 'shutdown' }

/** Same fields as `client.ts`'s `ActualHealth`; that name is kept as an alias there. */
export interface ActualHealthFacts {
  opened: boolean
  serverVersion: string | null
  apiVersion: string
  versionAligned: boolean
  budgetType: string | null
  currencyCode: string | null
  lastSyncAt: Date | null
  lastError: string | null
}

export type ActualResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } }
  /** Unsolicited: sent once, right after a successful `open`. */
  | { type: 'health'; health: ActualHealthFacts }
