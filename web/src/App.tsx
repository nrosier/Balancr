/**
 * Session state, and the choice between the sign-in screen and the application.
 *
 * The session is asked for rather than inferred. A cookie that looks present in
 * `document.cookie` proves nothing — the session row may be gone, revoked or
 * expired — and the server is the only thing that knows, so `/auth/session` is the
 * first call and every transition (sign in, sign out) re-asks instead of patching a
 * local copy. Two half-answers stitched together is how a UI ends up showing an
 * account that no longer exists.
 *
 * The document title is set here because it depends on the route *and* the language,
 * and both live in this tree. It is the one piece of chrome outside the shell that a
 * language switch has to reach.
 *
 * The language itself is settled twice, and both are needed. `/bootstrap` resolved it
 * server-side before this component existed, which is what makes the very first paint
 * and `<html lang>` correct. But that request was answered before the sign-in, so an
 * account whose own setting differs from the browser's only becomes knowable when the
 * session lands — and that is the effect below.
 *
 * `CsrfProvider` is here for the pages rather than for this component: the settings
 * page writes, the route table hands pages no props, and the token config comes from
 * the same bootstrap payload this component already holds.
 *
 * `SessionExpiryProvider` is the other half of that rule. A page reading `/api/*` can
 * be told mid-session that the cookie is gone — revoked from another device, or simply
 * expired while a dashboard sat open — and the page has no business deciding what to
 * do about it. `useResource` hands the 401 up to `load`, which re-asks and lands on
 * the sign-in screen through exactly the same path as a first visit. Wired once here
 * rather than per page, so #30 onwards inherit it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, type CsrfConfig } from './api/client.ts'
import { CsrfProvider } from './api/csrf.tsx'
import { SessionExpiryProvider } from './api/resource.tsx'
import { fetchSession, type SessionResponse } from './auth/session.ts'
import { SignIn } from './auth/SignIn.tsx'
import './auth/signin.css'
import { setLanguage, useT } from './i18n.ts'
import { NotFound } from './pages/NotFound.tsx'
import { useRouter } from './router.tsx'
import { routeFor } from './routes.ts'
import type { BootstrapResponse } from './shared.ts'
import { AppShell } from './shell/AppShell.tsx'

export interface AppProps {
  bootstrap: BootstrapResponse
}

export function App({ bootstrap }: AppProps): ReactNode {
  const { t, language } = useT()
  const { path } = useRouter()
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  const load = useCallback((): void => {
    setError(null)
    void fetchSession()
      .then(setSession)
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError('network_error', 'Balancr could not be reached.', 0, null),
        )
      })
  }, [])

  useEffect(load, [load])

  const route = routeFor(path)

  const preferred = session?.user?.locale
  const supported = bootstrap.locales.supported
  /**
   * The account locale this component has already acted on.
   *
   * Compared against instead of against the current language, because the settings page
   * switches the language itself and the session payload it was read from is stale the
   * moment it does. An effect that compared with `language` would fire on that switch,
   * find the session still saying `en`, and put the UI straight back — the control would
   * appear to do nothing until the next reload.
   */
  const adopted = useRef<string | null>(null)
  useEffect(() => {
    if (preferred === undefined || preferred === adopted.current) return
    adopted.current = preferred
    // A locale the bundle has no catalogue for would leave i18next falling back
    // silently; better to keep the language the server already resolved.
    if (!supported.includes(preferred)) return
    void setLanguage(preferred)
  }, [preferred, supported])

  useEffect(() => {
    const page = route === undefined ? t('notFound.title') : t(route.labelKey)
    document.title = `${page} · ${t('app.name')}`
    // `language` is not read in the body; it is here because every string above
    // changes with it, and the title would otherwise keep the language it was first
    // rendered in.
  }, [route, t, language])

  const csrf: CsrfConfig = bootstrap.csrf

  if (error !== null) {
    return (
      <div className="signin">
        <div className="signin__card">
          <div className="notice notice--error" role="alert">
            {error.message}
            {error.requestId === null ? null : <p className="notice__meta">{error.requestId}</p>}
          </div>
          <button type="button" className="button signin__error" onClick={load}>
            {t('action.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (session === null) {
    // Blank on purpose: against a local server this lasts a few milliseconds, and a
    // spinner that flashes is worse than nothing. The live region is what a screen
    // reader needs in the case where it does take a moment.
    return (
      <div className="signin" aria-busy="true">
        <p className="sr-only" role="status">
          {t('shell.loading')}
        </p>
      </div>
    )
  }

  if (!session.authenticated || session.user === null) {
    return <SignIn methods={session.methods} csrf={csrf} onSignedIn={load} />
  }

  return (
    <SessionExpiryProvider onExpired={load}>
      <CsrfProvider csrf={csrf}>
        <AppShell user={session.user} csrf={csrf} version={bootstrap.version} onSignedOut={load}>
          {route === undefined ? <NotFound /> : <route.Page />}
        </AppShell>
      </CsrfProvider>
    </SessionExpiryProvider>
  )
}
