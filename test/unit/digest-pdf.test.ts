/**
 * The digest PDF (#52): `buildDigestPdf` and the `renderNarrativeBlocks` step it
 * walks. `pdf.test.ts`'s job is proving the two things a binary document cannot be
 * asserted on any other way — that a real PDF comes out, and that the narrative's
 * markdown survives into structured blocks with the household's own names
 * substituted in, same as `renderNarrative` does for the HTML page.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { config } from '../../src/config.ts'
import { renderNarrativeBlocks, storeNarrative } from '../../src/domain/ai/narrative.ts'
import { recordRun } from '../../src/domain/ai/runs.ts'
import { buildDigestPdf } from '../../src/domain/digest/pdf.ts'
import { initI18n } from '../../src/i18n/index.ts'

let ctx: ReturnType<typeof createTestDb>
let db: Db
let tenantId: string

const MONTH = '2026-08'

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

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  ctx = createTestDb()
  db = ctx.db
  applyMigrations(db as never)
  tenantId = getSoleTenantId(db)
})

describe('renderNarrativeBlocks', () => {
  it('maps stored markdown to structured blocks', () => {
    const narrative = storeNarrative(db, tenantId, {
      runId: someRun(),
      period: MONTH,
      locale: 'en',
      bodyMd: '### Overview\n\nSpending was **steady** this month.\n\n- one\n- two',
    })

    expect(renderNarrativeBlocks(db, tenantId, narrative)).toEqual([
      { kind: 'h3', text: 'Overview' },
      { kind: 'p', parts: ['Spending was **steady** this month.'] },
      { kind: 'ul', parts: ['one', 'two'] },
    ])
  })
})

describe('buildDigestPdf', () => {
  it('is null when there is no stored narrative for the period/locale', async () => {
    expect(await buildDigestPdf(db, tenantId, MONTH, 'en')).toBeNull()
  })

  it('renders a real PDF once a narrative exists', async () => {
    storeNarrative(db, tenantId, {
      runId: someRun(),
      period: MONTH,
      locale: 'en',
      bodyMd: '### Overview\n\nNothing unusual this month.',
    })

    const pdf = await buildDigestPdf(db, tenantId, MONTH, 'en')

    expect(pdf).not.toBeNull()
    expect(pdf!.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf!.subarray(-6).toString('latin1').trim()).toBe('%%EOF')
  })

  it('is null for a locale the narrative was never written in', async () => {
    storeNarrative(db, tenantId, { runId: someRun(), period: MONTH, locale: 'en', bodyMd: 'text' })
    expect(await buildDigestPdf(db, tenantId, MONTH, 'nl')).toBeNull()
  })

  it('rejects instead of hanging forever when the underlying stream errors (#583)', async () => {
    // Before the fix, `finished` only ever listened for `'end'` — an `'error'` from
    // pdfkit's internal stream (a bad SVG, a font problem, disk pressure on whatever
    // buffers it) left the promise permanently unsettled, and `runJob`'s `await`
    // waited on it for ever.
    storeNarrative(db, tenantId, {
      runId: someRun(),
      period: MONTH,
      locale: 'en',
      bodyMd: '### Overview\n\nNothing unusual this month.',
    })

    const PDFDocument = (await import('pdfkit')).default
    const emitError = vi.spyOn(PDFDocument.prototype, 'end').mockImplementation(function (this: {
      emit: (event: string, error: Error) => void
    }) {
      this.emit('error', new Error('stream exploded'))
    })

    await expect(buildDigestPdf(db, tenantId, MONTH, 'en')).rejects.toThrow('stream exploded')

    emitError.mockRestore()
  })
})
