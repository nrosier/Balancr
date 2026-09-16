/**
 * Runs a candidate Actual credential through a forked child process (#369).
 *
 * `@actual-app/api` is a process-wide singleton — `client.ts`'s own header says so
 * — so a "test connection" click cannot call `api.init`/`api.downloadBudget` in
 * this process without risking the real, already-open client. Forking gets the
 * candidate its own copy of every Node module, so `test-worker.ts`'s calls can
 * never reach the one `withActual` serialises in this process.
 */
import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../../logger.ts'
import type { ActualTestCandidate, ActualTestResult } from './test-worker.ts'

export type { ActualTestCandidate, ActualTestResult }

const log = logger.child({ module: 'actual-test-connection' })

const here = fileURLToPath(import.meta.url)

/**
 * The worker's own extension, not a hardcoded one: under `tsx` (dev) this module
 * runs as `.ts` and `fork` inherits tsx's `--import` loader from
 * `process.execArgv` automatically, so a sibling `.ts` file just works. In the
 * compiled build this module is `.js`, and so is its sibling — plain Node runs it
 * with no loader needed.
 */
const WORKER_PATH = path.join(path.dirname(here), `test-worker${path.extname(here)}`)

const TEST_TIMEOUT_MS = 30_000

/** `{ ok, message }`, never a throw — a failed test is an expected outcome, not an error. */
export function testActualConnection(candidate: ActualTestCandidate): Promise<ActualTestResult> {
  return new Promise((resolve) => {
    const child = fork(WORKER_PATH, [], { stdio: 'pipe' })
    let settled = false

    const finish = (result: ActualTestResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeAllListeners()
      if (child.exitCode === null && !child.killed) child.kill()
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({ ok: false, message: 'The test took too long and was cancelled.' })
    }, TEST_TIMEOUT_MS)

    child.on('message', (result: ActualTestResult) => finish(result))
    child.on('error', (error: Error) => {
      log.error({ error }, 'Actual test worker failed to start')
      finish({ ok: false, message: 'Could not start the connection test.' })
    })
    child.on('exit', (code) => {
      if (!settled) {
        log.warn({ code }, 'Actual test worker exited without reporting a result')
        finish({ ok: false, message: 'The connection test exited unexpectedly.' })
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      log.debug({ line: chunk.toString() }, 'Actual test worker stderr')
    })

    child.send(candidate)
  })
}
