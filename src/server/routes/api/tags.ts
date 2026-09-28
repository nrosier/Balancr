/**
 * `GET /api/tags` — per-tag net cost/gain totals (#663 spike).
 *
 * Read-only, like every other route in this directory: the figures come from
 * `tag_meta`/`tag_monthly_facts`, written by the nightly sync, never from a live
 * Actual call. See `domain/aggregate/tags.ts` for how the three views (all-time,
 * rolling 12 months, this year) are derived from the stored monthly series.
 *
 * Anchored on `latestStoredMonth`, not the wall-clock month (#752) — same as
 * `overview.ts`/`budget.ts`. Before the first sync it is `null`, and there is no
 * month to anchor a window on, so `tags` is empty rather than calling
 * `loadTagTotals` with a month nothing has been synced for.
 */
import type { Db } from '../../../db/index.ts'
import { latestStoredMonth } from '../../../domain/aggregate/month-store.ts'
import { loadTagTotals } from '../../../domain/aggregate/tags.ts'
import { freshness } from './freshness.ts'
import { tagTotalsSchema, type TagTotals } from './schemas.ts'

export function buildTagTotals(db: Db, tenantId: string, isOwner: boolean): TagTotals {
  const month = latestStoredMonth(db, tenantId)
  return tagTotalsSchema.parse({
    freshness: freshness(db, tenantId, isOwner),
    tags: month === null ? [] : loadTagTotals(db, tenantId, month),
  })
}
