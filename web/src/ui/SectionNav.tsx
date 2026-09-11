/**
 * The horizontal tab strip that splits a page into sections (#200, generalized for
 * #228/#229/#230).
 *
 * Sits under the page heading rather than beside the primary nav, so it does not compete
 * with it for the same real estate — visually its own thing, but reusing the primary
 * nav's `Link` (and its `aria-current="page"` convention) rather than a new click-handling
 * path. Exact matching matters here: every tab's path is a descendant of the page's own,
 * and without it the default tab would read as current no matter which one is actually
 * open. A `nested` tab is the exception — it owns a further `useSubsection` strip of its
 * own (Portfolio, Budget, AI, System) and is never itself the current path, so it needs
 * prefix matching instead: without that, opening one of its subsections leaves the sub-tab
 * underlined but no top-level tab, and there is nothing on screen answering "which of the
 * six main tabs is this actually under".
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Link } from '../router.tsx'
import type { Section } from './sections.ts'

export function SectionNav<Id extends string>({
  sections,
  ariaLabel,
  variant,
}: {
  sections: readonly Section<Id>[]
  ariaLabel: string
  /** `'sub'` renders the smaller, second-tier strip a section's own subsections use. */
  variant?: 'sub'
}): ReactNode {
  const { t } = useT()
  const className = variant === 'sub' ? 'section-nav section-nav--sub' : 'section-nav'

  return (
    <nav className={className} aria-label={ariaLabel}>
      {sections.map((section) => (
        <Link
          key={section.id}
          to={section.path}
          exact={section.nested !== true}
          className="section-nav__link"
        >
          {t(section.labelKey)}
        </Link>
      ))}
    </nav>
  )
}
