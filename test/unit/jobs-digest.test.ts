/**
 * The monthly digest job (#52).
 *
 * Mirrors `jobs-ai.test.ts`'s shape for the same reason: `off`/`no_narrative`/
 * `smtp_not_configured` are all "did not run" states that must not throw and must
 * not touch storage or the mail transport, and the two "did run" states — `pdf`
 * and `email` — are checked against what they actually leave behind (a stored row,
 * a call to the fake transport) rather than just the returned detail.
 *
 * `setMailTransport` stands in for the SMTP relay, the same way `setGeminiClient`
 * stands in for Google elsewhere: a test that reached a real relay would need
 * credentials and fail offline.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { config } from '../../src/config.ts'
import { storeNarrative } from '../../src/domain/ai/narrative.ts'
import { recordRun } from '../../src/domain/ai/runs.ts'
import { loadDigestPdf } from '../../src/domain/digest/storage.ts'
import { saveDigestPreference } from '../../src/domain/digest/preference.ts'
import { digestJob, DIGEST_DAY } from '../../src/jobs/digest.ts'
import { CATCHUP_NIGHTS, narrativePeriod } from '../../src/jobs/ai.ts'
import type { JobDetail } from '../../src/jobs/runner.ts'
import { logger } from '../../src/logger.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { noopStep } from '../fixtures/job-context.ts'

let ctx: ReturnType<typeof createTestDb>
let db: Db
let tenantId: string

/** Day `DIGEST_DAY`, 03:00 UTC — inside `JOBS_NIGHTLY_HOUR`'s window regardless of host TZ. */
const NOW = new Date(`2026-04-${String(DIGEST_DAY).padStart(2, '0')}T03:00:00Z`)
const PERIOD = narrativePeriod(NOW)

const someRun = (): string =>
  recordRun(db, tenantId, {
    kind: 'narrative',
    provider: 'gemini-aistudio',
    model: config.GEMINI_MODEL_DEEP,
    locale: 'en',
    payload: {},
    payloadHash: 'unrelated-hash',
    status: 'ok',
  })

function storeSomeNarrative(): void {
  storeNarrative(db, tenantId, { runId: someRun(), period: PERIOD, locale: 'en', bodyMd: 'text' })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  ctx = createTestDb()
  db = ctx.db
  applyMigrations(db as never)
  tenantId = getSoleTenantId(db)
})

const run = (): Promise<JobDetail | void> =>
  digestJob.run({ db, tenantId, now: NOW, log: logger, step: noopStep })

describe('DIGEST_DAY', () => {
  it('is one day after the catch-up window closes', () => {
    expect(DIGEST_DAY).toBe(CATCHUP_NIGHTS + 1)
  })
})

describe('mode "off"', () => {
  it('does nothing, whether or not a narrative exists', async () => {
    storeSomeNarrative()
    saveDigestPreference(db, tenantId, { mode: 'off' })

    expect(await run()).toEqual({ mode: 'off', sent: false, reason: null })
    expect(loadDigestPdf(db, tenantId)).toBeNull()
  })
})

describe('mode "pdf"', () => {
  it('stores the rendered PDF once a narrative exists', async () => {
    storeSomeNarrative()
    saveDigestPreference(db, tenantId, { mode: 'pdf' })

    expect(await run()).toEqual({ mode: 'pdf', sent: true, reason: null })
    const stored = loadDigestPdf(db, tenantId)
    expect(stored?.period).toBe(PERIOD)
    expect(stored?.pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('reports no_narrative and stores nothing without one', async () => {
    saveDigestPreference(db, tenantId, { mode: 'pdf' })

    expect(await run()).toEqual({ mode: 'pdf', sent: false, reason: 'no_narrative' })
    expect(loadDigestPdf(db, tenantId)).toBeNull()
  })
})

describe('mode "email"', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('is smtp_not_configured when no relay is set up, and sends nothing', async () => {
    // Default test config has no SMTP_HOST, so the module-level `digestJob` is
    // already the right fixture here — no fresh module graph needed.
    storeSomeNarrative()
    saveDigestPreference(db, tenantId, { mode: 'email', recipientEmails: ['a@example.test'] })

    expect(config.smtpConfigured).toBe(false)
    expect(await run()).toEqual({ mode: 'email', sent: false, reason: 'smtp_not_configured' })
  })

  it('reports no_narrative rather than mailing an empty digest', async () => {
    vi.resetModules()
    vi.stubEnv('SMTP_HOST', 'smtp.example.test')
    vi.stubEnv('SMTP_FROM', 'digest@example.test')
    await (await import('../../src/i18n/index.ts')).initI18n()
    const freshEmail = await import('../../src/domain/digest/email.ts')
    const sendMail = vi.fn().mockResolvedValue({})
    freshEmail.setMailTransport({ sendMail } as never)
    const freshDigest = await import('../../src/jobs/digest.ts')

    saveDigestPreference(db, tenantId, { mode: 'email', recipientEmails: ['a@example.test'] })

    const detail = await freshDigest.digestJob.run({ db, tenantId, now: NOW, log: logger, step: noopStep })

    expect(detail).toEqual({ mode: 'email', sent: false, reason: 'no_narrative' })
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('mails the PDF to every recipient once a narrative exists', async () => {
    vi.resetModules()
    vi.stubEnv('SMTP_HOST', 'smtp.example.test')
    vi.stubEnv('SMTP_FROM', 'digest@example.test')
    await (await import('../../src/i18n/index.ts')).initI18n()
    const freshEmail = await import('../../src/domain/digest/email.ts')
    const sendMail = vi.fn().mockResolvedValue({})
    freshEmail.setMailTransport({ sendMail } as never)
    const freshDigest = await import('../../src/jobs/digest.ts')

    storeSomeNarrative()
    saveDigestPreference(db, tenantId, {
      mode: 'email',
      recipientEmails: ['a@example.test', 'b@example.test'],
    })

    const detail = await freshDigest.digestJob.run({ db, tenantId, now: NOW, log: logger, step: noopStep })

    expect(detail).toEqual({ mode: 'email', sent: true, reason: null })
    expect(sendMail).toHaveBeenCalledTimes(1)
    const call = sendMail.mock.calls[0]?.[0]
    // Recipients are bcc'd (#584), not put in a shared To: header.
    expect(call.bcc).toEqual(['a@example.test', 'b@example.test'])
    expect(call.to).toBe('digest@example.test')
    expect(call.from).toBe('digest@example.test')
    expect(call.attachments[0].content.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(loadDigestPdf(db, tenantId)).toBeNull()
  })
})
