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
 * `SessionExpiryProvider` is the other half of that rule. A page reading `/api/*` can
 * be told mid-session that the cookie is gone — revoked from another device, or simply
 * expired while a dashboard sat open — and the page has no business deciding what to
 * do about it. `useResource` hands the 401 up to `load`, which re-asks and lands on
 * the sign-in screen through exactly the same path as a first visit. Wired once here
 * rather than per page, so #30 onwards inherit it.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApiError, type CsrfConfig } from './api/client.ts'
import { SessionExpiryProvider } from './api/resource.tsx'
import { fetchSession, type SessionResponse } from './auth/session.ts'
import { SignIn } from './auth/SignIn.tsx'
import './auth/signin.css'
import { useT } from './i18n.ts'
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
      <AppShell user={session.user} csrf={csrf} version={bootstrap.version} onSignedOut={load}>
        {route === undefined ? <NotFound /> : <route.Page />}
      </AppShell>
    </SessionExpiryProvider>
  )
}
