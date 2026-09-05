/**
 * Insights' own sub-navigation (#228), the same mechanism Settings settled on (#200):
 * `../ui/sections.ts`'s generic `Section`/`sectionFor` over the page's own tab order.
 *
 * The grouping follows the page's pre-#228 top-to-bottom order: findings first because
 * they are the reason to open the page, then the narrative and the review control, then
 * the two queues the analysis is waiting on an answer to, then the ledger that lets a
 * reader check every claim above against the calls that produced it.
 */
import { sectionFor as sectionForGeneric, type Section } from '../ui/sections.ts'

export type InsightsSectionId = 'findings' | 'narrative' | 'pending' | 'ledger'

export const INSIGHTS_SECTIONS: readonly Section<InsightsSectionId>[] = [
  { id: 'findings', path: '/insights', labelKey: 'insights:nav.findings' },
  { id: 'narrative', path: '/insights/narrative', labelKey: 'insights:nav.narrative' },
  { id: 'pending', path: '/insights/pending', labelKey: 'insights:nav.pending' },
  { id: 'ledger', path: '/insights/ledger', labelKey: 'insights:nav.ledger' },
]

/** The section an arbitrary `/insights*` path belongs to; an unknown one lands on Findings. */
export function sectionFor(pathname: string): InsightsSectionId {
  return sectionForGeneric(INSIGHTS_SECTIONS, pathname, 'findings')
}
