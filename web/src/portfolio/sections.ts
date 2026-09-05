/**
 * Portfolio's own sub-navigation (#229), the same mechanism Settings settled on (#200),
 * Insights reused (#228) and Budget reused again (#230): `../ui/sections.ts`'s generic
 * `Section`/`sectionFor` over the page's own tab order.
 *
 * Three tabs, following the issue's own grouping and the page's pre-#229 top-to-bottom
 * order: Overview answers "what is it worth and of what" (the value series and the
 * allocation chart), Advice is the argument about that shape (drift and the rebalance
 * suggestions), and Holdings is the rows behind both — narrowest last, same as the page
 * always read before this split.
 */
import { sectionFor as sectionForGeneric, type Section } from '../ui/sections.ts'

export type PortfolioSectionId = 'overview' | 'advice' | 'holdings'

export const PORTFOLIO_SECTIONS: readonly Section<PortfolioSectionId>[] = [
  { id: 'overview', path: '/portfolio', labelKey: 'portfolio:nav.overview' },
  { id: 'advice', path: '/portfolio/advice', labelKey: 'portfolio:nav.advice' },
  { id: 'holdings', path: '/portfolio/holdings', labelKey: 'portfolio:nav.holdings' },
]

/** The section an arbitrary `/portfolio*` path belongs to; an unknown one lands on Overview. */
export function sectionFor(pathname: string): PortfolioSectionId {
  return sectionForGeneric(PORTFOLIO_SECTIONS, pathname, 'overview')
}
