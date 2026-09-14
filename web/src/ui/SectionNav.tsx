/**
 * The horizontal tab strip that splits a page (or a page's own section) into pieces
 * (#200, generalized for #228/#229/#230; reworked into a "shelf" shape per #347).
 *
 * Sits under the page heading rather than beside the primary nav, so it does not compete
 * with it for the same real estate — visually its own thing, but reusing the primary
 * nav's `Link` (and its `aria-current="page"` convention) rather than a new click-handling
 * path.
 *
 * `variant="sub"` renders the same shelf shape, smaller and a step quieter, for a
 * section's own nested subsections (Thresholds' parameter groups, General's
 * status/language split, Benchmark's household/mapping) — it sits one level inside a
 * page that already has its own primary shelf above it, so this tier stays lighter
 * rather than stacking two equally heavy shelves.
 *
 * Which tab is current is decided once, here, with `sectionFor`'s longest-prefix match
 * (the same rule `Settings.tsx` itself uses to pick a panel) rather than each `Link`
 * judging only its own path against the URL: General's own path (`/settings`) is a
 * literal prefix of every sibling, so on a nested URL like `/settings/thresholds/baseline`
 * only comparing each link to itself would either light up General too (prefix match)
 * or light up nothing at all (exact match, the bug this fixed) — picking the *longest*
 * matching sibling picks Thresholds and only Thresholds.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Link, useRouter } from '../router.tsx'
import { sectionFor, type Section } from './sections.ts'

export function SectionNav<Id extends string>({
  sections,
  ariaLabel,
  variant,
  children,
}: {
  sections: readonly Section<Id>[]
  ariaLabel: string
  /** `'sub'` renders the smaller, second-tier shelf a section's own subsections use. */
  variant?: 'sub'
  /** The panel the active tab visually fuses into. */
  children?: ReactNode
}): ReactNode {
  const { t } = useT()
  const { path } = useRouter()
  const sub = variant === 'sub'
  const first = sections[0]
  const activeId = first === undefined ? undefined : sectionFor(sections, path, first.id)

  return (
    <div className={sub ? 'section-shelf section-shelf--sub' : 'section-shelf'}>
      <nav
        className={sub ? 'section-shelf__tabs section-shelf__tabs--sub' : 'section-shelf__tabs'}
        aria-label={ariaLabel}
      >
        {sections.map((section) => (
          <Link
            key={section.id}
            to={section.path}
            active={section.id === activeId}
            className={sub ? 'section-shelf__tab section-shelf__tab--sub' : 'section-shelf__tab'}
          >
            {t(section.labelKey)}
          </Link>
        ))}
      </nav>
      <div className={sub ? 'section-shelf__content section-shelf__content--sub' : 'section-shelf__content'}>
        {children}
      </div>
    </div>
  )
}
