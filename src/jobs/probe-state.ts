/**
 * Reading and writing the last upstream probe.
 *
 * Its own module, separate from the job that fills it, for one structural reason: the
 * read-only API in `server/routes/api/` may not import an adapter — a test scans the
 * directory for exactly that — and the probe *report* type is declared next to the
 * code that calls Ghostfolio. So the stored shape is declared here, in terms of
 * nothing but Zod and the database, and the job converts the adapter's report into it.
 * The API imports this file; the adapter never appears in its dependency graph.
 *
 * The status vocabulary is the adapter's, repeated rather than imported, and the
 * distinction it carries is the reason this table exists:
 *
 *  - `unreachable` — Ghostfolio is down, restarting, or the token was rejected.
 *    Transient. It resolves itself, and the next probe says so.
 *  - `shape-mismatch` — Ghostfolio answered with something we do not parse. Nothing
 *    resolves that except a code change, so it has to read differently on the status
 *    panel from an outage that will be over in a minute.
 *
 * `test/unit/jobs-probe.test.ts` asserts the two vocabularies against each other, so
 * the repetition cannot drift.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/index.ts'
import { upstreamProbes } from '../db/schema.ts'

/** The sources that get a row. Actual is absent on purpose — see the table's comment. */
export const PROBE_SOURCES = ['ghostfolio'] as const
export type ProbeSource = (typeof PROBE_SOURCES)[number]

export const probeStatuses = ['ok', 'unreachable', 'shape-mismatch'] as const
export type StoredProbeStatus = (typeof probeStatuses)[number]

/**
 * What is kept in `report_json`.
 *
 * `.catch` on nothing and no `.passthrough()`: a report written by a newer build with
 * extra fields loses them here, which is the correct loss — this is a status panel's
 * input, not an audit record.
 */
const storedReportSchema = z.object({
  checks: z.array(
    z.object({
      path: z.string(),
      status: z.enum(probeStatuses),
      /** Shape-level facts: counts, field presence. Never a value, never an amount. */
      detail: z.string(),
      error: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()),
})

export type StoredReport = z.infer<typeof storedReportSchema>

export interface ProbeState {
  source: string
  status: StoredProbeStatus
  checkedAt: Date
  /** Null when the stored JSON could not be read. The status above still stands. */
  report: StoredReport | null
}

/** Replaces the row for `source`. One row per source, latest wins. */
export function saveProbe(
  db: Db,
  source: ProbeSource,
  status: StoredProbeStatus,
  report: StoredReport,
  checkedAt: Date,
): void {
  const set = { status, checkedAt, reportJson: JSON.stringify(report) }
  db.insert(upstreamProbes)
    .values({ source, ...set })
    .onConflictDoUpdate({ target: upstreamProbes.source, set })
    .run()
}

/**
 * Every stored probe, oldest source name first.
 *
 * A row whose `report_json` will not parse yields `report: null` rather than throwing.
 * The callers are `/readyz` and the status panel, and both would rather say "Ghostfolio
 * reported a shape mismatch, details unavailable" than fail to answer at all — the
 * failure this avoids is a readiness endpoint that 500s because of a schema change in
 * its own diagnostics.
 */
export function loadProbes(db: Db): ProbeState[] {
  return db
    .select()
    .from(upstreamProbes)
    .orderBy(upstreamProbes.source)
    .all()
    .map((row) => {
      const parsed = storedReportSchema.safeParse(safeJson(row.reportJson))
      return {
        source: row.source,
        status: row.status,
        checkedAt: row.checkedAt,
        report: parsed.success ? parsed.data : null,
      }
    })
}

export function loadProbe(db: Db, source: ProbeSource): ProbeState | null {
  return loadProbes(db).find((state) => state.source === source) ?? null
}

/** Deletes the row for `source`. For a test, and for a source this build dropped. */
export function forgetProbe(db: Db, source: string): void {
  db.delete(upstreamProbes).where(eq(upstreamProbes.source, source)).run()
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
