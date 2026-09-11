/**
 * `JobContext['step']` for a test that calls `job.run(...)` directly rather than
 * going through `runJob`, which is the only place a real one is built. Runs `fn`
 * with no recording — these tests assert on what the job returns, not on the
 * history table `runJob` writes to.
 */
import type { JobContext } from '../../src/jobs/runner.ts'

export const noopStep: JobContext['step'] = (_name, fn) => fn()
