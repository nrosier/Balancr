/**
 * The forked-process side of "test connection" (#369).
 *
 * `@actual-app/api` is a process-wide singleton — see the header comment on
 * `client.ts` — so a candidate credential cannot be tried through `api.init` /
 * `api.downloadBudget` in the main process without risking the real, already-open
 * client silently ending up pointed at whatever was just typed into a settings form.
 * A fork gets its own copy of every Node module, `@actual-app/api` included, so this
 * process's calls can never reach the one `withActual` serialises.
 *
 * Talks to its parent over the IPC channel `child_process.fork` sets up rather than
 * argv or env, so a candidate password never appears in `ps` or in the environment
 * of a process that outlives this one.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { config } from '../../config.ts'
import { installEgressGuard, withTestHost } from '../../egress.ts'

export interface ActualTestCandidate {
  serverUrl: string
  syncId: string
  password: string
  e2ePassword?: string | undefined
}

export interface ActualTestResult {
  ok: boolean
  message: string | null
}

/**
 * The same encryption error codes `client.ts`'s `E2E_ERRORS` translates, worded for
 * the settings form's own field name rather than `.env`'s — this process never reads
 * `.env`, so the message must point at "the E2E password" someone just typed rather
 * than a variable name that means nothing here.
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
  'old-key-style':
    'this budget uses an unsupported old encryption key style; recreate the key in ' +
    'Actual first',
}

function explain(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const { code } = error as { code?: unknown }
  const known = typeof code === 'string' ? E2E_ERRORS[code] : undefined
  return known === undefined ? error.message : `${known} (Actual said: ${error.message})`
}

/** Never touches `config.ACTUAL_DATA_DIR` — a scratch directory, removed however it ends. */
async function run(candidate: ActualTestCandidate): Promise<ActualTestResult> {
  // Loaded only after `testCandidate` installs the guard. A dependency that captures
  // global fetch during module initialisation must capture the guarded function too.
  const api = await import('@actual-app/api')
  const dataDir = await mkdtemp(join(tmpdir(), 'balancr-actual-test-'))
  let inited = false
  try {
    await api.init({
      serverURL: candidate.serverUrl,
      password: candidate.password,
      dataDir,
      verbose: false,
    })
    inited = true
    await api.downloadBudget(
      candidate.syncId,
      candidate.e2ePassword === undefined ? {} : { password: candidate.e2ePassword },
    )
    return { ok: true, message: null }
  } catch (error) {
    return { ok: false, message: explain(error) }
  } finally {
    // Best-effort: this process exits right after, so a failed shutdown here leaks
    // nothing that outlives it.
    if (inited) {
      try {
        await api.shutdown()
      } catch {
        // ignore
      }
    }
    await rm(dataDir, { recursive: true, force: true })
  }
}

/**
 * Installs the same process-local guard as the server, then permits only the
 * submitted candidate host for this one connection test. A redirect still has to
 * remain on that host or land on another explicitly configured host.
 */
export async function testCandidate(candidate: ActualTestCandidate): Promise<ActualTestResult> {
  installEgressGuard(config.EGRESS_MODE)
  return await withTestHost(candidate.serverUrl, async () => await run(candidate))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.once('message', (candidate: ActualTestCandidate) => {
    testCandidate(candidate)
      .then((result) => {
        process.send?.(result)
      })
      .catch((error: unknown) => {
        process.send?.({ ok: false, message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        process.exit(0)
      })
  })
}
