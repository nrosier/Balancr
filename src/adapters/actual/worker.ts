/**
 * The forked-process side of Actual: one child process per tenant, holding
 * `@actual-app/api`'s open budget for that tenant — see `client.ts`'s header
 * for why a worker-process-per-tenant exists at all (the package is a true
 * process-wide singleton, so real per-tenant concurrency needs real separate
 * processes, not just a serialised queue in one).
 *
 * Persistent (`process.on('message', ...)`, not `.once`) — contrast with
 * `test-worker.ts`, which solves the narrower "test connection" problem with
 * a scratch dataDir and a one-shot exit. This worker's dataDir is the
 * tenant's own subdirectory of `ACTUAL_DATA_DIR` (`client.ts` builds the
 * path), held open for the life of the process, exactly as the old
 * single-process `client.ts` held its one dataDir open for the life of
 * Balancr.
 *
 * Never imports `config.ts` for any Actual connection detail — everything
 * `open` needs arrives over IPC as an `ActualOpenConfig`, resolved by the
 * parent from the calling tenant's own row (`resolvedIntegrations`). The
 * shared `logger` is fine to import: its own `LOG_LEVEL` is a deployment-wide
 * setting, not a per-tenant credential.
 *
 * `handleRequest` is exported separately from the `process.on('message', ...)`
 * loop below so `test/unit/actual-worker.test.ts` can drive it in-process,
 * with `@actual-app/api` mocked, rather than through a real fork.
 */
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { api } from './api-source.ts'
import { logger } from '../../logger.ts'
import {
  ENVELOPE_BUDGET_TYPES,
  EXPECTED_API_VERSION,
  type ActualHealthFacts,
  type ActualOpenConfig,
  type ActualRequest,
  type ActualResponse,
} from './protocol.ts'

const log = logger.child({ module: 'actual-worker', pid: process.pid })

/** Log levels at which Actual's own console output is wanted rather than noise. */
const VERBOSE_LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'trace'])

/**
 * The methods a `call` or `batch` request may invoke against `@actual-app/api` —
 * the actual enforcement point for the read-only boundary now that a compile-time
 * "not re-exported" guarantee no longer applies: once a call crosses IPC as a bare
 * method-name string, nothing stops an unlisted mutating method except this list.
 * `test/unit/actual-adapter.test.ts`'s denylist test scans this file's source for
 * the same mutating names it scans `client.ts`/`queries.ts` for.
 *
 * `updateTransaction` and `setBudgetAmount` are the two mutating methods #45
 * needs (`queries.ts`'s `updateTransactionCategory`/`setCategoryBudgetAmount`),
 * reachable only from an approved, audited proposal. `getSchedules`/`getRules`
 * are batch-only in practice (`fetchSchedules`'s atomicity), but there is no
 * reason to keep a second list — a lone `call` for either is just as harmless.
 */
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'aqlQuery',
  'getBudgetMonth',
  'getBudgetMonths',
  'getAccountBalance',
  'updateTransaction',
  'setBudgetAmount',
  'getSchedules',
  'getRules',
])

let opened = false

const health: ActualHealthFacts = {
  opened: false,
  serverVersion: null,
  apiVersion: EXPECTED_API_VERSION,
  versionAligned: true,
  budgetType: null,
  currencyCode: null,
  lastSyncAt: null,
  lastError: null,
}

/** `YY.M` prefix — the part that has to agree between client and server. */
function majorMinor(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version)
  return match ? `${match[1]}.${match[2]}` : version
}

/**
 * What Actual's error codes about encryption mean, worded for the settings
 * form's own field name rather than an `.env` variable — this process is fed
 * an already-resolved `ActualOpenConfig`, so the message must point at "the
 * E2E password" someone typed into the settings UI. Same codes
 * `client.ts`'s old (tenant-1-only, `.env`-worded) version translated, and
 * the same ones `test-worker.ts`'s own `E2E_ERRORS` already translates for
 * this exact settings-form audience.
 */
const E2E_ERRORS: Readonly<Record<string, string>> = {
  'missing-key':
    'this budget is end-to-end encrypted; the E2E password must be its encryption ' +
    'password, which is not the server password above',
  'decrypt-failure':
    "the E2E password does not decrypt this budget; it is the budget's encryption " +
    'password, not the server password',
  'file-has-new-key':
    "this budget's encryption key has changed in Actual since; use the current E2E password",
  // Not fixable through configuration, so it must not suggest one: the key itself
  // has to be recreated in Actual, on a device that still has the file.
  'old-key-style':
    'this budget uses an unsupported old encryption key style; recreate the key in ' +
    'Actual first',
}

/**
 * `downloadBudget`, with encryption failures rephrased.
 *
 * Deliberately no pre-flight check for whether the budget is encrypted. That would
 * be a second round trip to learn something this call is about to tell us, and the
 * answer would go stale the moment encryption is switched on. Every other error —
 * `budget-not-found`, `out-of-sync-migrations`, a network failure — passes through
 * untouched, because blaming encryption for a wrong sync id would point at the
 * wrong field.
 */
async function download(cfg: ActualOpenConfig): Promise<void> {
  try {
    await api.downloadBudget(
      cfg.syncId,
      // Spread rather than `{ password: undefined }`: Actual tests the property for
      // truthiness, and an explicitly-undefined key is a claim we did not mean to make.
      cfg.e2ePassword ? { password: cfg.e2ePassword } : {},
    )
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const { code } = error as { code?: unknown }
    const explanation = typeof code === 'string' ? E2E_ERRORS[code] : undefined
    if (explanation === undefined) throw error

    // The original message is kept: it names the budget file, which identifies
    // *which* budget is encrypted.
    throw new Error(`Cannot open the Actual budget: ${explanation}. Actual said: ${error.message}`, {
      cause: error,
    })
  }
}

/**
 * Records version and budget facts for the health panel.
 *
 * A version mismatch is reported, not fatal: failing to open on every Actual
 * upgrade would take that tenant's budget down until someone bumps a dependency,
 * while silently producing wrong numbers is worse than either. So it is loud in
 * the logs instead, and surfaced in `health` for the UI.
 */
async function recordServerFacts(baseCurrency: string): Promise<void> {
  const version = await api.getServerVersion()
  if ('version' in version) {
    health.serverVersion = version.version
    health.versionAligned = majorMinor(version.version) === majorMinor(EXPECTED_API_VERSION)
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
  if (health.currencyCode && health.currencyCode !== baseCurrency) {
    log.warn(
      { budget: health.currencyCode, configured: baseCurrency },
      'budget currency differs from BASE_CURRENCY — amounts would be mislabelled',
    )
  }
}

async function open(cfg: ActualOpenConfig): Promise<void> {
  if (opened) return

  // Actual requires dataDir to exist already; it does not create it.
  await mkdir(cfg.dataDir, { recursive: true })

  await api.init({
    serverURL: cfg.serverUrl,
    password: cfg.password,
    dataDir: cfg.dataDir,
    // Actual's engine logs breadcrumbs and sync progress through `console.log`, and
    // its `verboseMode` defaults to on — ten unparseable lines per sync landing in
    // the middle of pino's JSON stream (#123). Off by default, but not silenced:
    // when a budget will not load, that chatter is the only view into why.
    verbose: VERBOSE_LOG_LEVELS.has(cfg.logLevel),
  })

  // Pulls the budget into the local cache. Every read below is invalid until
  // this has run at least once.
  await download(cfg)

  opened = true
  health.opened = true
  health.lastError = null
  health.lastSyncAt = new Date()

  await recordServerFacts(cfg.baseCurrency)
}

function errorResponse(id: number, error: unknown): ActualResponse {
  const message = error instanceof Error ? error.message : String(error)
  health.lastError = message
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  return { id, ok: false, error: typeof code === 'string' ? { message, code } : { message } }
}

/**
 * `@actual-app/api`'s public `aqlQuery(query)` unconditionally calls
 * `query.serialize()` on its argument — but `runAql` (`queries.ts`) already
 * serialized the query in the main process before sending it over IPC, since
 * a live `Query`'s methods can't survive structured cloning across a fork.
 * Re-wrapping the already-serialized state in something `.serialize()`-able
 * is what makes the two ends agree on what crosses the wire (#381).
 */
function argsForCall(method: string, args: readonly unknown[]): readonly unknown[] {
  if (method !== 'aqlQuery') return args
  const [state, ...rest] = args
  return [{ serialize: () => state }, ...rest]
}

async function runCall(method: string, args: readonly unknown[]): Promise<unknown> {
  if (!ALLOWED_METHODS.has(method)) throw new Error(`method not allowed: ${method}`)
  const fn = (api as unknown as Record<string, (...callArgs: unknown[]) => unknown>)[method]
  if (typeof fn !== 'function') throw new Error(`@actual-app/api has no method ${method}`)
  return await fn(...argsForCall(method, args))
}

/**
 * Handles one request and returns its reply. Exported (rather than inlined in
 * the `process.on('message', ...)` loop below) so a test can drive it
 * in-process with `@actual-app/api` mocked, and so the unsolicited health
 * push after a successful `open` is something a test can observe too — it
 * goes through `send`, the same channel a `call`/`batch`/`sync`/`shutdown`
 * reply never uses more than once.
 */
export async function handleRequest(
  request: ActualRequest,
  send: (message: ActualResponse) => void,
): Promise<ActualResponse> {
  switch (request.kind) {
    case 'open': {
      try {
        await open(request.config)
        send({ type: 'health', health: { ...health } })
        return { id: request.id, ok: true, result: null }
      } catch (error) {
        return errorResponse(request.id, error)
      }
    }

    case 'call': {
      try {
        const result = await runCall(request.method, request.args)
        return { id: request.id, ok: true, result }
      } catch (error) {
        return errorResponse(request.id, error)
      }
    }

    case 'batch': {
      try {
        const results: unknown[] = []
        for (const op of request.ops) results.push(await runCall(op.method, op.args))
        return { id: request.id, ok: true, result: results }
      } catch (error) {
        return errorResponse(request.id, error)
      }
    }

    case 'sync': {
      try {
        await api.sync()
        health.lastSyncAt = new Date()
        return { id: request.id, ok: true, result: null }
      } catch (error) {
        return errorResponse(request.id, error)
      }
    }

    case 'shutdown': {
      try {
        if (opened) await api.shutdown()
        opened = false
        health.opened = false
        return { id: request.id, ok: true, result: null }
      } catch (error) {
        return errorResponse(request.id, error)
      }
    }
  }
}

/**
 * Only when this file is the process's own entry point — i.e. it was really
 * forked as `WORKER_PATH` by `client.ts` — not when it is merely `import`ed,
 * as `test/unit/actual-worker.test.ts`'s `freshWorker()` does deliberately to
 * drive `handleRequest` in-process. Without this guard, that import (or any
 * other real load of this module, such as the transitive one `client.ts`
 * used to do for its two re-exported constants) would register this listener
 * on whatever process did the importing — including a real Vitest worker
 * process, which already talks to its own orchestrator over this exact
 * `process.send`/`process.on('message', ...)` IPC channel. This listener
 * would then intercept Vitest's own coordination messages, mishandle them as
 * `ActualRequest`s, and crash on `process.send?.(response)` with `response`
 * `undefined` — reproducibly, once per intercepted message.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('message', (request: ActualRequest) => {
    void handleRequest(request, (message) => {
      process.send?.(message)
    }).then((response) => {
      if (request.kind === 'shutdown') {
        // `process.send`'s callback fires once the reply is actually written to
        // the IPC pipe — exiting from inside it, not right after the call,
        // avoids a race where `exit(0)` tears down the channel before the
        // reply reaches the parent's `serialise` queue, which is waiting on
        // exactly this message to know shutdown finished.
        if (process.send) process.send(response, () => process.exit(0))
        else process.exit(0)
      } else {
        process.send?.(response)
      }
    })
  })
}
