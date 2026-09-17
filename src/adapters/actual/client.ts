/**
 * Worker-process manager for Actual: one forked child per tenant, each
 * holding its own open budget.
 *
 * `@actual-app/api` is not a REST client — it is a local sync engine over a
 * SQLite cache, its documentation makes no concurrency guarantees, and it is
 * a true process-wide singleton (one open budget per Node process, ever).
 * Real per-tenant concurrency therefore needs real separate processes, not
 * just a serialised queue in this one — which is what `worker.ts` is:
 * `getOrSpawnWorker` forks it once per tenant, on first use, and every call
 * for that tenant is routed to that one child over IPC for the rest of the
 * process's life.
 *
 * **`withActual` itself grants the full `@actual-app/api` surface, forwarded
 * by method name** — it builds a `Proxy` that turns any `actual.methodName(...)`
 * the callback makes into a `{kind:'call', method, args}` message, because
 * serialising and routing access is a concurrency concern independent of
 * what the call does. The read-only boundary lives in two places now: mostly
 * in `queries.ts` (no function there calls a write method except the two #45
 * needs), and, since a bare method name loses the compile-time
 * "not re-exported" guarantee that used to be the whole enforcement, in
 * `worker.ts`'s `ALLOWED_METHODS` — the actual backstop. See
 * `test/unit/actual-adapter.test.ts`'s denylist for what both are checked
 * against.
 *
 * Forked with `serialization: 'advanced'` rather than the default JSON mode:
 * `fetchAccountBalances`'s `asOf` argument is a `Date`, and V8-serialize mode
 * round-trips it as one rather than silently turning it into an ISO string on
 * the wire. See `test/unit/actual-protocol.test.ts` for the proof.
 *
 * **Crash policy:** no auto-restart loop and no idle-timeout shutdown. A
 * worker that exits unexpectedly is removed from `workers`; the *next* call
 * for that tenant lazily respawns it via `getOrSpawnWorker`. A worker that
 * opened successfully stays alive indefinitely, mirroring the old
 * single-process "open once, hold until process exit" — one resident child
 * per tenant forever has a real memory/FD cost at real multi-tenant scale,
 * flagged for #372/#373 rather than addressed here.
 */
import { type ChildProcess, fork } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as api from '@actual-app/api'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { resolvedIntegrations } from '../../db/tenant-integrations.ts'
import { logger } from '../../logger.ts'
import { createSerialiser, type Serialiser } from '../../util/serialise.ts'
import {
  ENVELOPE_BUDGET_TYPES,
  EXPECTED_API_VERSION,
  type ActualHealthFacts,
  type ActualOpenConfig,
  type ActualRequest,
  type ActualResponse,
} from './protocol.ts'

const log = logger.child({ module: 'actual' })

export { ENVELOPE_BUDGET_TYPES, EXPECTED_API_VERSION }

/** Kept as its own name for existing test imports; the shape lives in `protocol.ts` now. */
export type ActualHealth = ActualHealthFacts

const here = fileURLToPath(import.meta.url)

/**
 * The worker's own extension, not a hardcoded one — same reasoning as
 * `test-connection.ts`'s `WORKER_PATH`: under `tsx` (dev) this module runs as
 * `.ts` and `fork` inherits tsx's loader automatically, so a sibling `.ts`
 * file just works; in the compiled build both are `.js` and plain Node needs
 * no loader.
 */
const WORKER_PATH = join(here.slice(0, here.lastIndexOf('/')), `worker${here.slice(here.lastIndexOf('.'))}`)

/** Longer than `test-connection.ts`'s 30s: `open` also downloads the whole budget. */
const OPEN_TIMEOUT_MS = 120_000
const CALL_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 10_000

function neverOpenedHealth(): ActualHealth {
  return {
    opened: false,
    serverVersion: null,
    apiVersion: EXPECTED_API_VERSION,
    versionAligned: true,
    budgetType: null,
    currencyCode: null,
    lastSyncAt: null,
    lastError: null,
  }
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface TenantWorker {
  readonly child: ChildProcess
  /** Per tenant, not global — two tenants' calls never wait on each other. */
  readonly serialise: Serialiser
  health: ActualHealth
  nextId: number
  readonly pending: Map<number, PendingCall>
}

const workers = new Map<string, TenantWorker>()

function withLastError(worker: TenantWorker, error: unknown): void {
  worker.health = {
    ...worker.health,
    lastError: error instanceof Error ? error.message : String(error),
  }
}

function attachChild(tenantId: string, worker: TenantWorker): void {
  worker.child.on('message', (message: ActualResponse) => {
    if ('type' in message) {
      worker.health = message.health
      return
    }
    const pending = worker.pending.get(message.id)
    if (pending === undefined) return
    worker.pending.delete(message.id)
    if (message.ok) {
      pending.resolve(message.result)
    } else {
      const error = new Error(message.error.message)
      if (message.error.code !== undefined) (error as Error & { code?: string }).code = message.error.code
      pending.reject(error)
    }
  })

  worker.child.on('exit', (code) => {
    workers.delete(tenantId)
    for (const call of worker.pending.values()) {
      call.reject(new Error(`Actual worker for tenant ${tenantId} exited unexpectedly (code ${code})`))
    }
    worker.pending.clear()
    if (worker.health.opened) {
      log.warn({ tenantId, code }, 'Actual worker exited unexpectedly; it will respawn on next use')
    }
  })

  worker.child.stderr?.on('data', (chunk: Buffer) => {
    log.debug({ tenantId, line: chunk.toString() }, 'Actual worker stderr')
  })
}

function sendRequest<T>(worker: TenantWorker, request: ActualRequest, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(request.id)
      reject(new Error(`Actual worker did not reply to ${request.kind} within ${timeoutMs}ms`))
    }, timeoutMs)
    worker.pending.set(request.id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value as T)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    worker.child.send(request)
  })
}

/** Spawns a tenant's worker on first use and opens its budget; reuses it after. */
async function getOrSpawnWorker(db: Db, tenantId: string): Promise<TenantWorker> {
  const existing = workers.get(tenantId)
  if (existing !== undefined) return existing

  const child = fork(WORKER_PATH, [], { stdio: 'pipe', serialization: 'advanced' })
  const worker: TenantWorker = {
    child,
    serialise: createSerialiser(),
    health: neverOpenedHealth(),
    nextId: 1,
    pending: new Map(),
  }
  workers.set(tenantId, worker)
  attachChild(tenantId, worker)

  const integrations = resolvedIntegrations(db, tenantId)
  const openConfig: ActualOpenConfig = {
    serverUrl: integrations.actual.serverUrl,
    password: integrations.actual.password,
    dataDir: join(config.ACTUAL_DATA_DIR, tenantId),
    syncId: integrations.actual.syncId,
    e2ePassword: integrations.actual.e2ePassword,
    logLevel: config.LOG_LEVEL,
    baseCurrency: config.BASE_CURRENCY,
  }

  const id = worker.nextId++
  try {
    await sendRequest<null>(worker, { id, kind: 'open', config: openConfig }, OPEN_TIMEOUT_MS)
  } catch (error) {
    workers.delete(tenantId)
    if (child.exitCode === null && !child.killed) child.kill()
    throw error
  }
  return worker
}

function actualProxy(worker: TenantWorker): typeof api {
  return new Proxy({} as typeof api, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      return (...args: unknown[]) => {
        const id = worker.nextId++
        return sendRequest(worker, { id, kind: 'call', method: prop, args }, CALL_TIMEOUT_MS)
      }
    },
  })
}

/**
 * The only way to touch Actual for one tenant. Spawns/opens on first use and
 * serialises every caller for that tenant — see this file's header for why
 * both of those now happen in a separate child process rather than in-line.
 */
export function withActual<T>(
  db: Db,
  tenantId: string,
  fn: (actual: typeof api) => Promise<T>,
): Promise<T> {
  return getOrSpawnWorker(db, tenantId).then((worker) =>
    worker.serialise(async () => {
      try {
        return await fn(actualProxy(worker))
      } catch (error) {
        withLastError(worker, error)
        throw error
      }
    }),
  )
}

/**
 * Runs several ops as one IPC round trip with no other request interleaved —
 * the atomicity `fetchSchedules` needs (see `queries.ts`'s own comment on
 * that function for why a rule list and a schedule list have to agree). The
 * one call site that cannot stay proxy-transparent, because `withActual`'s
 * per-tenant `serialise` only guarantees no *other caller's* request lands in
 * between; it says nothing about two of *this* caller's own `withActual`
 * calls, which is exactly the gap `fetchSchedules` cannot afford.
 */
export function withActualBatch(
  db: Db,
  tenantId: string,
  ops: readonly { method: string; args: unknown[] }[],
): Promise<unknown[]> {
  return getOrSpawnWorker(db, tenantId).then((worker) =>
    worker.serialise(async () => {
      const id = worker.nextId++
      try {
        return await sendRequest<unknown[]>(worker, { id, kind: 'batch', ops }, CALL_TIMEOUT_MS)
      } catch (error) {
        withLastError(worker, error)
        throw error
      }
    }),
  )
}

/** Pulls remote changes. Run before each aggregation pass, never during one. */
export function syncActual(db: Db, tenantId: string): Promise<void> {
  return getOrSpawnWorker(db, tenantId).then((worker) =>
    worker.serialise(async () => {
      const id = worker.nextId++
      try {
        await sendRequest<null>(worker, { id, kind: 'sync' }, CALL_TIMEOUT_MS)
        worker.health = { ...worker.health, lastSyncAt: new Date() }
      } catch (error) {
        withLastError(worker, error)
        throw error
      }
    }),
  )
}

/** The tenant's own health snapshot, or the "never opened" default if it has none yet. */
export function actualHealth(tenantId: string): Readonly<ActualHealth> {
  const worker = workers.get(tenantId)
  return worker === undefined ? neverOpenedHealth() : { ...worker.health }
}

/**
 * Flushes and releases one tenant's dataDir, then kills its worker. Queued
 * naturally behind that tenant's own in-flight calls via `serialise` — the
 * same reason `dataDir`'s lock used to be held safely across a single
 * process's queue, just scoped per tenant now.
 */
export async function closeActual(tenantId: string): Promise<void> {
  const worker = workers.get(tenantId)
  if (worker === undefined) return
  try {
    await worker.serialise(async () => {
      const id = worker.nextId++
      await sendRequest<null>(worker, { id, kind: 'shutdown' }, SHUTDOWN_TIMEOUT_MS)
    })
  } catch (error) {
    log.warn({ tenantId, error }, 'Actual worker did not confirm shutdown in time; killing it')
  } finally {
    if (worker.child.exitCode === null && !worker.child.killed) worker.child.kill()
    workers.delete(tenantId)
  }
}

/**
 * Shuts down every live tenant worker, for process shutdown. `allSettled`,
 * not `all`: one tenant stuck mid-shutdown must not keep the others' dataDirs
 * locked past this process's own exit.
 */
export async function closeAllActual(): Promise<void> {
  await Promise.allSettled([...workers.keys()].map((tenantId) => closeActual(tenantId)))
}
