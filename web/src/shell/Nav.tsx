/**
 * The section navigation — one `<nav>`, styled into a bottom tab bar or a sidebar by
 * the viewport (see `shell.css`).
 *
 * One element in one place in the DOM, not two hidden behind media queries: a second
 * copy doubles the tab stops on the wide layout and reads the five links twice to a
 * screen reader. The active link is marked with `aria-current="page"` by `Link`,
 * which is also what the stylesheet keys off — so the highlight and the announcement
 * can never disagree.
 *
 * Sign-out lives here too, at the end of the same list (#231), for the same reason:
 * one `<Account>` rather than a copy anchored in the header for narrow and another
 * anchored here for wide. `shell.css` styles it as the trailing item of the tab bar
 * on narrow and pushes it to the bottom of the sidebar on wide, but it is always the
 * same button in the same place in the DOM.
 */
import type { ReactNode } from 'react'
import type { CsrfConfig } from '../api/client.ts'
import type { SessionUserResponse } from '../auth/session.ts'
import { useT } from '../i18n.ts'
import { Link } from '../router.tsx'
import { ROUTES } from '../routes.ts'
import { Account } from './Account.tsx'

export interface NavProps {
  /** Omitted in tests that only care about the section links. */
  account?: {
    user: SessionUserResponse
    csrf: CsrfConfig
    onSignedOut: () => void
  }
}

export function Nav({ account }: NavProps): ReactNode {
  const { t } = useT()

  return (
    <nav className="nav" aria-label={t('nav.label')}>
      {ROUTES.map(({ path, labelKey, Icon }) => (
        <Link key={path} to={path} className="nav__link">
          <Icon />
          <span className="nav__label">{t(labelKey)}</span>
        </Link>
      ))}
      {account === undefined ? null : (
        <Account
          user={account.user}
          csrf={account.csrf}
          onSignedOut={account.onSignedOut}
        />
      )}
    </nav>
  )
}
