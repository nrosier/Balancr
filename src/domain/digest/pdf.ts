/**
 * The monthly digest, rendered to a PDF (#52).
 *
 * `pdfkit` + `svg-to-pdfkit`: pure JS, no native binary and no headless browser —
 * the deciding constraint given the Wolfi-based, size-conscious production image.
 * Both ship the standard 14 PDF fonts (Helvetica, Courier and their bold/oblique
 * variants), which is what lets this file skip embedding a font file entirely:
 * `en`/`nl` — the only two `SUPPORTED_LOCALES` today — need nothing outside
 * WinAnsi, `€` included.
 *
 * The narrative is walked from `renderNarrativeBlocks`' `Token[]`, which is raw
 * markdown, not HTML — there is no DOM here for `util/markdown.ts`'s sanitiser to
 * protect, only a page pdfkit draws directly. `parseInlineRuns` below is this
 * file's own, much smaller, equivalent of that module's `inline()`: same three
 * span types (bold, italic, code), turned into font switches instead of tags.
 */
import { eq } from 'drizzle-orm'
import PDFDocument from 'pdfkit'
import SVGtoPDF from 'svg-to-pdfkit'
import type { Db } from '../../db/index.ts'
import { tenants } from '../../db/schema.ts'
import { formatDateTime, formatMonth } from '../../i18n/format.ts'
import { t } from '../../i18n/index.ts'
import { loadNarrative, renderNarrativeBlocks } from '../ai/narrative.ts'
import type { Token } from '../../util/markdown.ts'
import { budgetVsActualOption, netWorthTrendOption } from './charts.ts'
import { renderChartSvg } from './echarts-server.ts'

const PAGE_MARGIN = 48
const CHART_WIDTH = 500
const CHART_HEIGHT = 220

interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

/**
 * `**bold**`/`__bold__`, `*italic*`/`_italic_`, `` `code` `` — checked in that
 * order so `**text**` is never re-read as two single stars, the same ordering
 * problem `util/markdown.ts`'s `inline()` solves with a boundary lookaround
 * instead: here it falls out of alternation order.
 */
const INLINE_SPAN = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g

function parseInlineRuns(text: string): InlineRun[] {
  const runs: InlineRun[] = []
  let last = 0
  for (const match of text.matchAll(INLINE_SPAN)) {
    const index = match.index
    if (index > last) runs.push({ text: text.slice(last, index) })
    if (match[1] !== undefined) runs.push({ text: match[1], code: true })
    else if (match[2] !== undefined) runs.push({ text: match[2], bold: true })
    else if (match[3] !== undefined) runs.push({ text: match[3], bold: true })
    else if (match[4] !== undefined) runs.push({ text: match[4], italic: true })
    else if (match[5] !== undefined) runs.push({ text: match[5], italic: true })
    last = index + match[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last) })
  return runs.length === 0 ? [{ text: '' }] : runs
}

function fontFor(run: InlineRun): string {
  if (run.code) return 'Courier'
  if (run.bold) return 'Helvetica-Bold'
  if (run.italic) return 'Helvetica-Oblique'
  return 'Helvetica'
}

/** Writes one paragraph of mixed-style runs, switching font mid-line as pdfkit's own `continued` option intends. */
function writeInline(doc: PDFKit.PDFDocument, prefix: string, text: string): void {
  const runs = parseInlineRuns(text)
  doc.font('Helvetica').text(prefix, { continued: true })
  runs.forEach((run, index) => {
    doc.font(fontFor(run)).text(run.text, { continued: index < runs.length - 1 })
  })
  doc.font('Helvetica')
}

function writeBlock(doc: PDFKit.PDFDocument, token: Token): void {
  if (token.kind === 'h3') {
    doc.moveDown(0.5)
    doc.fontSize(13)
    writeInline(doc, '', token.text)
    doc.moveDown(0.25)
    return
  }

  doc.fontSize(10)
  if (token.kind === 'p') {
    writeInline(doc, '', token.parts.join(' ').trim())
    doc.moveDown(0.5)
    return
  }

  token.parts.forEach((part, index) => {
    const marker = token.kind === 'ol' ? `${index + 1}. ` : '•  '
    writeInline(doc, marker, part)
  })
  doc.moveDown(0.5)
}

function writeChart(doc: PDFKit.PDFDocument, caption: string, option: NonNullable<ReturnType<typeof netWorthTrendOption>>): void {
  if (doc.y + CHART_HEIGHT + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage()
  doc.fontSize(12).font('Helvetica-Bold').text(caption)
  doc.moveDown(0.5)
  const svg = renderChartSvg(option, CHART_WIDTH, CHART_HEIGHT)
  const x = doc.x
  const y = doc.y
  SVGtoPDF(doc, svg, x, y, { width: CHART_WIDTH, height: CHART_HEIGHT })
  doc.y = y + CHART_HEIGHT
  doc.moveDown(1)
}

/**
 * Builds the digest PDF for one tenant/period/locale, or `null` when there is no
 * stored narrative to build it from — the caller (`jobs/digest.ts`) reports that
 * as `no_narrative` rather than saving or mailing an empty document.
 */
export async function buildDigestPdf(
  db: Db,
  tenantId: string,
  period: string,
  locale: string,
): Promise<Buffer | null> {
  const narrative = loadNarrative(db, tenantId, period, locale)
  if (narrative === null) return null

  const tenant = db.select({ label: tenants.label }).from(tenants).where(eq(tenants.id, tenantId)).get()
  const blocks = renderNarrativeBlocks(db, tenantId, narrative)

  const doc = new PDFDocument({ margin: PAGE_MARGIN })
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const finished = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
  })

  doc
    .fontSize(18)
    .font('Helvetica-Bold')
    .text(t(locale, 'settings:digest.document.title', { month: formatMonth(period, locale) }))
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#666666')
    .text(
      tenant === undefined
        ? t(locale, 'settings:digest.document.generatedAt', { when: formatDateTime(new Date().toISOString()) })
        : `${tenant.label} — ${t(locale, 'settings:digest.document.generatedAt', { when: formatDateTime(new Date().toISOString()) })}`,
    )
  doc.fillColor('#000000')
  doc.moveDown(1)

  for (const block of blocks) writeBlock(doc, block)

  const netWorth = netWorthTrendOption(db, tenantId, locale)
  if (netWorth !== null) writeChart(doc, t(locale, 'settings:digest.document.netWorthChart'), netWorth)

  const budget = budgetVsActualOption(db, tenantId, period, locale)
  if (budget !== null) writeChart(doc, t(locale, 'settings:digest.document.budgetChart'), budget)

  doc.end()
  return finished
}
