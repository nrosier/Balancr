/**
 * The job that finally calls the capability probe.
 *
 * `src/adapters/ghostfolio/probe.ts` shipped in 0.2.0 with a Zod schema per endpoint
 * and no caller at all, which made the capability check a function rather than a
 * guarantee. This job is the caller, and three of its properties are the ones worth
 * holding onto:
 *
 *  - **The report is stored before the failure is raised.** A failing probe throws so
 *    that `lastSuccessAt` means "the upstream was healthy", not "the probe ran" — but
 *    the whole value of the probe is knowing *which path* broke, and a throw that
 *    happened first would leave the settings panel with a red badge and nothing under
 *    it. This is the one ordering in the job that a reader cannot infer from the type.
 *  - **A bad verdict is a job failure.** The alternative — store it, return normally —
 *    reads as a green job beside a broken upstream.
 *  - **The two status vocabularies agree.** The adapter's `ProbeStatus` is a union in
 *    TypeScript; `probeStatuses` in `probe-state.ts` is a runtime array feeding a Zod
 *    enum and a database column, deliberately repeated rather than imported so the
 *    persistence layer names no adapter. Repeated means they can drift, so they are
 *    asserted against each other here rather than trusted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import type { ProbeReport, ProbeStatus } from '../../src/adapters/ghostfolio/probe.ts'
import { loadProbe, loadProbes, probeStatuses } from '../../src/jobs/probe-state.ts'
import { probeJob } from '../../src/jobs/probe.ts'
import { registry } from '../../src/jobs/index.ts'
import { upstreamProbes } from '../../src/db/schema.ts'

const log = pino({ level: 'silent' })

/** What the mocked adapter will answer with, and how many times it was asked. */
const gave = {
  report: null as ProbeReport | null,
  throws: null as Error | null,
  calls: 0,
}

vi.mock('../../src/adapters/ghostfolio/probe.ts', async (importOriginal) => ({
  // `describeProbeFailure` stays real: the sentence it composes is what the job
  // throws, and a stub of it would leave the message assertion below testing a stub.
  ...(await importOriginal<typeof import('../../src/adapters/ghostfolio/probe.ts')>()),
  probeGhostfolio: () => {
    gave.calls += 1
    if (gave.throws !== null) return Promise.reject(gave.throws)
    if (gave.report === null) throw new Error('the test set no report')
    return Promise.resolve(gave.report)
  },
}))

const AT = new Date('2026-09-03T02:00:00.000Z')

const report = (over: Partial<ProbeReport> = {}): ProbeReport => ({
  status: 'ok',
  checks: [
    { path: '/api/v1/health', status: 'ok', detail: 'reachable' },
    { path: '/api/v1/portfolio/details', status: 'ok', detail: '7 holdings' },
  ],
  warnings: [],
  at: AT,
  ...over,
})

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  gave.report = report()
  gave.throws = null
  gave.calls = 0
})

const run = () => probeJob.run({ db: ctx.db, now: AT, log })

describe('a healthy upstream', () => {
  it('stores the report and reports the counts', async () => {
    gave.report = report({ warnings: ['portfolio/details returned no currency'] })

    const detail = await run()

    expect(detail).toEqual({ status: 'ok', checks: 2, warnings: 1 })
    const stored = loadProbe(ctx.db, 'ghostfolio')
    expect(stored?.status).toBe('ok')
    expect(stored?.checkedAt).toEqual(AT)
    expect(stored?.report?.checks.map((check) => check.path)).toEqual([
      '/api/v1/health',
      '/api/v1/portfolio/details',
    ])
    expect(stored?.report?.warnings).toEqual(['portfolio/details returned no currency'])
  })

  it('keeps one row per source, latest wins', async () => {
    await run()
    const later = new Date(AT.getTime() + 3_600_000)
    gave.report = report({ at: later })
    await run()

    expect(loadProbes(ctx.db)).toHaveLength(1)
    expect(loadProbe(ctx.db, 'ghostfolio')?.checkedAt).toEqual(later)
    expect(gave.calls).toBe(2)
  })
})

describe('a broken upstream', () => {
  it('stores the failing report before it throws', async () => {
    // The ordering this whole file exists for: the panel needs the path, and it only
    // gets one if the write happened before the throw.
    gave.report = report({
      status: 'shape-mismatch',
      checks: [
        { path: '/api/v1/health', status: 'ok', detail: 'reachable' },
        {
          path: '/api/v1/portfolio/holdings',
          status: 'shape-mismatch',
          detail: 'unparseable',
          error: 'holdings.0.valueInBaseCurrency: expected number',
        },
      ],
    })

    await expect(run()).rejects.toThrow(/shape-mismatch/)

    const stored = loadProbe(ctx.db, 'ghostfolio')
    expect(stored?.status).toBe('shape-mismatch')
    const failed = stored?.report?.checks.find((check) => check.status !== 'ok')
    expect(failed?.path).toBe('/api/v1/portfolio/holdings')
    expect(failed?.error).toContain('expected number')
  })

  it('names the failing path in the error, so the log says it too', async () => {
    gave.report = report({
      status: 'unreachable',
      checks: [
        { path: '/api/v1/health', status: 'unreachable', detail: 'failed', error: 'ECONNREFUSED' },
      ],
    })

    await expect(run()).rejects.toThrow(/\/api\/v1\/health/)
  })

  it('lets an adapter that threw outright fail the job with nothing stored', async () => {
    // Not a verdict but a bug — a URL that will not parse, a mock that broke. There is
    // no report to write, and inventing a status for it would be claiming a probe ran.
    gave.throws = new Error('Invalid URL')

    await expect(run()).rejects.toThrow('Invalid URL')
    expect(loadProbes(ctx.db)).toEqual([])
  })
})

describe('the stored vocabulary', () => {
  it('matches the adapter’s, in both directions', () => {
    // Assigning each way is the assertion: a status the adapter gained would fail the
    // first line, one the table gained would fail the second, and both would otherwise
    // surface as a Zod rejection at read time on a row this build wrote itself.
    const fromAdapter: readonly ProbeStatus[] = probeStatuses
    const toColumn: readonly (typeof probeStatuses)[number][] = [
      'ok',
      'unreachable',
      'shape-mismatch',
    ] satisfies readonly ProbeStatus[]

    expect([...fromAdapter].sort()).toEqual([...toColumn].sort())
  })

  it('survives a row whose stored report cannot be parsed', async () => {
    // A build that changed the report shape, reading a row an older build wrote. The
    // verdict is still a column, so readiness keeps its answer and loses the detail —
    // and nothing throws, because a readiness endpoint that threw on a JSON parse
    // would be reporting on itself.
    await run()
    ctx.db.update(upstreamProbes).set({ reportJson: '{"checks":"nope"}' }).run()

    const stored = loadProbe(ctx.db, 'ghostfolio')
    expect(stored?.status).toBe('ok')
    expect(stored?.report).toBeNull()
  })
})

describe('the registry', () => {
  it('runs the probe before the jobs that depend on the upstream', () => {
    // So the log reads diagnosis-then-symptom rather than four failures and a reason.
    expect(registry[0]?.name).toBe('probe')
  })
})
