/**
 * The frame every signed-in page renders inside.
 *
 * Two behaviours worth naming, both of them accessibility rather than decoration:
 *
 *  - **A skip link.** The first thing in the tab order, so a keyboard user is not
 *    made to walk past five navigation items on every page. It is visually parked
 *    off-screen and slides in on `:focus-visible`, which means it is never in the
 *    way and never hidden from the people who need it.
 *  - **Focus moves to `main` on navigation, but not on first load.** A client-side
 *    route change replaces the content without the browser's usual "new document"
 *    reset, so focus would stay on the link that was clicked and a screen reader
 *    would announce nothing. Moving it — and only after the first render, because on
 *    arrival the user has not navigated anywhere — restores what a normal page load
 *    does for free.
 *
 * The header and the navigation are the same markup at every width; only
 * `shell.css` differs. There is no viewport measurement in JavaScript anywhere in
 * the shell, so the two layouts cannot disagree about which page is current.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { CsrfConfig } from '../api/client.ts'
import mark from '../assets/favicon.svg'
import type { SessionUserResponse } from '../auth/session.ts'
import { useT } from '../i18n.ts'
import { Link, useRouter } from '../router.tsx'
import { Account } from './Account.tsx'
import { Nav } from './Nav.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'
import './shell.css'

export interface AppShellProps {
  user: SessionUserResponse
  csrf: CsrfConfig
  /** Null when the running build could not read its own `package.json`. */
  version: string | null
  onSignedOut: () => void
  children: ReactNode
}

export function AppShell({
  user,
  csrf,
  version,
  onSignedOut,
  children,
}: AppShellProps): ReactNode {
  const { t } = useT()
  const { path } = useRouter()
  const main = useRef<HTMLElement>(null)
  const navigated = useRef(false)

  useEffect(() => {
    if (!navigated.current) {
      navigated.current = true
      return
    }
    main.current?.focus()
    window.scrollTo({ top: 0 })
  }, [path])

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>

      <header className="header">
        <div className="header__lead">
          <Link to="/" className="brand">
            <img className="brand__mark" src={mark} alt="" width={20} height={20} />
            <span className="brand__name">{t('app.name')}</span>
            {version === null ? null : (
              // The number itself is not translated; the label around it is, which is
              // what the tooltip and the screen-reader text carry.
              <span className="brand__version num" title={t('app.version', { version })}>
                v{version}
              </span>
            )}
          </Link>
          <p className="brand__tagline">{t('app.tagline')}</p>
        </div>
        <ThemeToggle />
        <Account user={user} csrf={csrf} onSignedOut={onSignedOut} />
      </header>

      <Nav />

      <main id="main" className="main" ref={main} tabIndex={-1}>
        {children}
      </main>
    </div>
  )
}
