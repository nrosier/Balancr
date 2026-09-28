/**
 * `GET /api/tags` — per-tag net cost/gain totals (#663 spike).
 *
 * Read-only, like every other route in this directory: the figures come from
 * `tag_meta`/`tag_monthly_facts`, written by the nightly sync, never from a live
 * Actual call. See `domain/aggregate/tags.ts` for how the three views (all-time,
 * rolling 12 months, this year) are derived from the stored monthly series.
 */
import type { Db } from '../../../db/index.ts'
import { loadTagTotals } from '../../../domain/aggregate/tags.ts'
import { currentMonthIn } from '../../../util/month.ts'
import { config } from '../../../config.ts'
import { freshness } from './freshness.ts'
import { tagTotalsSchema, type TagTotals } from './schemas.ts'

export function buildTagTotals(db: Db, tenantId: string, isOwner: boolean): TagTotals {
  return tagTotalsSchema.parse({
    freshness: freshness(db, tenantId, isOwner),
    tags: loadTagTotals(db, tenantId, currentMonthIn(config.TZ)),
  })
}
