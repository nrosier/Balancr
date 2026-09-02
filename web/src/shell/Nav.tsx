/**
 * The section navigation — one `<nav>`, styled into a bottom tab bar or a sidebar by
 * the viewport (see `shell.css`).
 *
 * One element in one place in the DOM, not two hidden behind media queries: a second
 * copy doubles the tab stops on the wide layout and reads the five links twice to a
 * screen reader. The active link is marked with `aria-current="page"` by `Link`,
 * which is also what the stylesheet keys off — so the highlight and the announcement
 * can never disagree.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Link } from '../router.tsx'
import { ROUTES } from '../routes.ts'

export function Nav(): ReactNode {
  const { t } = useT()

  return (
    <nav className="nav" aria-label={t('nav.label')}>
      {ROUTES.map(({ path, labelKey, Icon }) => (
        <Link key={path} to={path} className="nav__link">
          <Icon />
          <span className="nav__label">{t(labelKey)}</span>
        </Link>
      ))}
    </nav>
  )
}
