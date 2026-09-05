/**
 * The horizontal tab strip that splits a page into sections (#200, generalized for
 * #228/#229/#230).
 *
 * Sits under the page heading rather than beside the primary nav, so it does not compete
 * with it for the same real estate — visually its own thing, but reusing the primary
 * nav's `Link` (and its `aria-current="page"` convention) rather than a new click-handling
 * path. `exact` matters here: every tab's path is a descendant of the page's own, and
 * without it the default tab would read as current no matter which one is actually open.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Link } from '../router.tsx'
import type { Section } from './sections.ts'

export function SectionNav<Id extends string>({
  sections,
  ariaLabel,
}: {
  sections: readonly Section<Id>[]
  ariaLabel: string
}): ReactNode {
  const { t } = useT()

  return (
    <nav className="section-nav" aria-label={ariaLabel}>
      {sections.map((section) => (
        <Link key={section.id} to={section.path} exact className="section-nav__link">
          {t(section.labelKey)}
        </Link>
      ))}
    </nav>
  )
}
