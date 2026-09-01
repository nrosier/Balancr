/**
 * The signal rows for a month, and the hygiene score behind them.
 *
 * Signals are facts, so a pass replaces a month wholesale rather than merging:
 * a finding that has stopped being true must disappear, and "yesterday it said
 * groceries were over" is not something to keep on the page. The delete and the
 * insert share a transaction, so a WAL reader sees one month or the other, never
 * neither.
 *
 * A row whose `code` is no longer in the vocabulary is dropped on read rather than
 * throwing. Removing a code should not make an old month unopenable, and the next
 * pass clears the row anyway.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { monthlyHygiene, monthlySignals } from '../../db/schema.ts'
import { FINDING_CODES, type FindingCode, type Severity } from '../ai/codes.ts'
import type { HygieneScore } from './hygiene.ts'
import type { Signal } from './overspend.ts'

/** `''` for a household signal — SQLite treats NULLs as distinct in a key. */
const subjectKey = (signal: Signal): string => signal.categoryId ?? ''

const KNOWN: ReadonlySet<string> = new Set(FINDING_CODES)

export interface SignalPersistResult {
  signals: number
}

export function persistSignals(
  db: Db,
  month: string,
  signals: readonly Signal[],
  hygiene: HygieneScore,
): SignalPersistResult {
  const computedAt = new Date()
  const rows = signals.map((signal) => ({
    month,
    code: signal.code,
    subjectKey: subjectKey(signal),
    subjectId: signal.categoryId,
    subjectName: signal.categoryName,
    severity: signal.severity,
    metricsJson: JSON.stringify(signal.metrics),
    computedAt,
  }))

  const deductionsJson = JSON.stringify(hygiene.deductions)

  db.transaction((tx) => {
    tx.delete(monthlySignals).where(eq(monthlySignals.month, month)).run()
    if (rows.length > 0) tx.insert(monthlySignals).values(rows).run()

    tx.insert(monthlyHygiene)
      .values({ month, scoreBp: hygiene.scoreBp, deductionsJson, computedAt })
      .onConflictDoUpdate({
        target: monthlyHygiene.month,
        set: { scoreBp: hygiene.scoreBp, deductionsJson, computedAt },
      })
      .run()
  })

  return { signals: rows.length }
}

/** Numbers only, so nothing that was stored as JSON can arrive as a string. */
function toMetrics(json: string): Record<string, number> | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null

  const metrics: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value
  }
  return metrics
}

/**
 * The stored signals for a month, in insertion order.
 *
 * Order is not relied on: `sortSignals` and `rankSignals` both re-sort, and both
 * break their ties deterministically, so the read order only has to be stable
 * enough to make a test readable.
 */
export function loadSignals(db: Db, month: string): Signal[] {
  const rows = db
    .select()
    .from(monthlySignals)
    .where(eq(monthlySignals.month, month))
    .orderBy(monthlySignals.code, monthlySignals.subjectKey)
    .all()

  const signals: Signal[] = []
  for (const row of rows) {
    if (!KNOWN.has(row.code)) continue
    const metrics = toMetrics(row.metricsJson)
    if (metrics === null) continue
    signals.push({
      code: row.code as FindingCode,
      categoryId: row.subjectId,
      categoryName: row.subjectName,
      severity: row.severity as Severity,
      metrics,
    })
  }
  return signals
}

/** Null before the month has ever been judged, which is not the same as 10 000. */
export function loadHygiene(db: Db, month: string): HygieneScore | null {
  const row = db
    .select()
    .from(monthlyHygiene)
    .where(eq(monthlyHygiene.month, month))
    .get()
  if (row === undefined) return null

  let deductions: HygieneScore['deductions'] = []
  try {
    const parsed: unknown = JSON.parse(row.deductionsJson)
    if (Array.isArray(parsed)) {
      deductions = parsed.filter(
        (entry): entry is { reason: string; bp: number } =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as { reason?: unknown }).reason === 'string' &&
          typeof (entry as { bp?: unknown }).bp === 'number',
      )
    }
  } catch {
    // A score with an unreadable breakdown is still the score that was computed.
    deductions = []
  }

  return { scoreBp: row.scoreBp, deductions }
}
