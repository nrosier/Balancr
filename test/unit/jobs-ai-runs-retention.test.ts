/**
 * The nightly sweep that nulls `ai_runs.requestText`/`responseText`/`payloadJson`
 * past `AI_RUNS_TEXT_RETENTION_DAYS` (#503, #539).
 */
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { config } from '../../src/config.ts'
import { registry } from '../../src/jobs/index.ts'
import { aiJob } from '../../src/jobs/ai.ts'
import { aiRunsRetentionJob } from '../../src/jobs/ai-runs-retention.ts'
import { backupJob } from '../../src/jobs/backup.ts'
import { digestJob } from '../../src/jobs/digest.ts'
import { loadRun, recordRun } from '../../src/domain/ai/runs.ts'
import type { Job, JobContext } from '../../src/jobs/runner.ts'
import { noopStep } from '../fixtures/job-context.ts'

const log = pino({ level: 'silent' })

let db: ReturnType<typeof createTestDb>['db']
let sqlite: ReturnType<typeof createTestDb>['sqlite']
let tenantId: string

beforeEach(() => {
  const test = createTestDb()
  db = test.db
  sqlite = test.sqlite
  applyMigrations(db as never)
  tenantId = getSoleTenantId(db)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const context = (now: Date): JobContext => ({ db, tenantId, log, now, step: noopStep })

function backdate(id: string, when: Date): void {
  sqlite.prepare('update ai_runs set created_at = ? where id = ?').run(when.getTime(), id)
}

const withText = (): string =>
  recordRun(db, tenantId, {
    kind: 'findings',
    provider: 'gemini-aistudio',
    model: 'gemini-3.7-flash',
    locale: 'en',
    payload: { month: '2026-03' },
    payloadHash: 'hash',
    status: 'ok',
    requestText: 'the request',
    responseText: 'the response',
  })

/** The job as a fresh env would produce it — `config` freezes at import (#503). */
async function freshJob(env: Record<string, string | undefined>): Promise<Job> {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return (await import('../../src/jobs/ai-runs-retention.ts')).aiRunsRetentionJob
}

describe('aiRunsRetentionJob', () => {
  it('sits between digest and backup in the registry', () => {
    const aiIndex = registry.indexOf(aiJob)
    const digestIndex = registry.indexOf(digestJob)
    const retentionIndex = registry.indexOf(aiRunsRetentionJob)
    const backupIndex = registry.indexOf(backupJob)
    expect(digestIndex).toBe(aiIndex + 1)
    expect(retentionIndex).toBe(digestIndex + 1)
    expect(backupIndex).toBe(retentionIndex + 1)
  })

  it('runs overnight, on the same hour as the other nightly jobs', () => {
    expect(aiRunsRetentionJob.schedule).toEqual({ kind: 'daily', hour: config.JOBS_NIGHTLY_HOUR })
  })

  it('clears text and payload past the retention window and leaves recent rows alone', async () => {
    const job = await freshJob({ AI_RUNS_TEXT_RETENTION_DAYS: '90' })
    const old = withText()
    backdate(old, new Date('2026-01-01T00:00:00Z'))
    const recent = withText()
    backdate(recent, new Date('2026-08-20T00:00:00Z'))

    const detail = await job.run(context(new Date('2026-09-01T00:00:00Z')))

    expect(detail).toEqual({ cleared: 1, cutoffDays: 90, cursor: '2026-06-03T00:00:00.000Z' })
    expect(loadRun(db, tenantId, old)?.requestText).toBeNull()
    expect(loadRun(db, tenantId, old)?.responseText).toBeNull()
    expect(loadRun(db, tenantId, old)?.payloadJson).toBeNull()
    expect(loadRun(db, tenantId, recent)?.requestText).toBe('the request')
    expect(loadRun(db, tenantId, recent)?.payloadJson).not.toBeNull()
  })

  it('reports zero cleared when nothing is old enough', async () => {
    const job = await freshJob({ AI_RUNS_TEXT_RETENTION_DAYS: '90' })
    const recent = withText()
    backdate(recent, new Date('2026-08-20T00:00:00Z'))

    const detail = await job.run(context(new Date('2026-09-01T00:00:00Z')))

    expect(detail).toEqual({ cleared: 0, cutoffDays: 90, cursor: '2026-06-03T00:00:00.000Z' })
  })

  it('honours a configured retention window narrower than the default', async () => {
    const job = await freshJob({ AI_RUNS_TEXT_RETENTION_DAYS: '7' })
    const id = withText()
    backdate(id, new Date('2026-08-20T00:00:00Z'))

    const detail = await job.run(context(new Date('2026-09-01T00:00:00Z')))

    expect(detail).toEqual({ cleared: 1, cutoffDays: 7, cursor: '2026-08-25T00:00:00.000Z' })
    expect(loadRun(db, tenantId, id)?.requestText).toBeNull()
  })

  it('only rescans the delta since its last cursor, not the whole table (#512)', async () => {
    const job = await freshJob({ AI_RUNS_TEXT_RETENTION_DAYS: '90' })
    // Older than a cursor set by a previous night's run — already swept, and
    // still has its text intact only because nothing re-clears an already-null
    // column; the point is this row must never be reached by the query at all
    // once a cursor bounds it from below, so leaving its text in place is what
    // proves the lower bound actually excluded it.
    const beforeCursor = withText()
    backdate(beforeCursor, new Date('2026-01-01T00:00:00Z'))
    // In the one-day delta window a cursor from last night's run newly covers.
    const inDelta = withText()
    backdate(inDelta, new Date('2026-03-02T12:00:00Z'))

    const ctx: JobContext = { ...context(new Date('2026-06-01T00:00:00Z')), cursor: '2026-03-02T00:00:00.000Z' }
    const detail = await job.run(ctx)

    expect(detail).toEqual({ cleared: 1, cutoffDays: 90, cursor: '2026-03-03T00:00:00.000Z' })
    expect(loadRun(db, tenantId, inDelta)?.requestText).toBeNull()
    expect(loadRun(db, tenantId, beforeCursor)?.requestText).toBe('the request')
  })

  it('does the first, full sweep when no cursor has ever been set', async () => {
    const job = await freshJob({ AI_RUNS_TEXT_RETENTION_DAYS: '90' })
    const old = withText()
    backdate(old, new Date('2026-01-01T00:00:00Z'))

    const detail = await job.run({ ...context(new Date('2026-06-01T00:00:00Z')), cursor: null })

    expect(detail).toEqual({ cleared: 1, cutoffDays: 90, cursor: '2026-03-03T00:00:00.000Z' })
    expect(loadRun(db, tenantId, old)?.requestText).toBeNull()
  })
})
