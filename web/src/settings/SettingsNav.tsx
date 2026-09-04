/**
 * The horizontal tab strip that splits the settings page into sections (#200).
 *
 * A second sidebar next to the primary one would compete for the same real estate, so
 * this sits under the page heading instead — visually its own thing, but reusing the
 * primary nav's `Link` (and its `aria-current="page"` convention) rather than a new
 * click-handling path. `exact` matters here: every tab's path is a descendant of
 * `/settings`, and without it the General tab would read as current no matter which
 * one is actually open.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Link } from '../router.tsx'
import { SETTINGS_SECTIONS } from './sections.ts'

export function SettingsNav(): ReactNode {
  const { t } = useT()

  return (
    <nav className="settings-nav" aria-label={t('nav.settings')}>
      {SETTINGS_SECTIONS.map((section) => (
        <Link key={section.id} to={section.path} exact className="settings-nav__link">
          {t(section.labelKey)}
        </Link>
      ))}
    </nav>
  )
}
