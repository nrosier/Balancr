/**
 * The session gate: what the application shows before it knows who you are, and what
 * it does when the answer changes.
 *
 * The rule under all of it is that **the session is asked for, never inferred**. A
 * cookie visible in `document.cookie` proves nothing — the row may be revoked, expired
 * or gone — so `/auth/session` is the first call and every transition re-asks instead
 * of patching a local copy. The failure this prevents is a UI showing an account that
 * no longer exists, and it only shows up in a test that changes the server's answer
 * between two renders, which is what the sign-in and sign-out cases here do.
 *
 * The unreachable-server case is tested because it is the one an operator meets first:
 * a container that is still starting, or a proxy pointed at nothing. It has to offer a
 * retry rather than an empty dashboard, and the retry has to actually re-ask.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { setLanguage } from '../src/i18n.ts'
import type { BootstrapResponse, SessionResponse } from '../src/shared.ts'
import {
  apiStub,
  clickLink,
  i18nReady,
  renderApp,
  resetLanguage,
  resetTheme,
} from './helpers.tsx'

/** What `/bootstrap` answered. The version is what the header prints. */
const BOOTSTRAP: BootstrapResponse = {
  version: '0.5.1',
  locales: { supported: ['en', 'nl'], default: 'en', active: 'en' },
  format: { locale: 'nl-BE', currency: 'EUR', timeZone: 'Europe/Brussels' },
  csrf: { cookie: 'balancr_csrf', header: 'x-csrf-token' },
}

const ANONYMOUS: SessionResponse = {
  authenticated: false,
  user: null,
  methods: { oidc: true, local: false },
}

const SIGNED_IN: SessionResponse = {
  authenticated: true,
  user: { email: 'nick@example.com', displayName: 'Nick', locale: 'en', role: 'owner' },
  methods: { oidc: true, local: false },
}

/** The same account, with a language `/bootstrap` could not have known about. */
const DUTCH_ACCOUNT: SessionResponse = {
  ...SIGNED_IN,
  user: { email: 'nick@example.com', displayName: 'Nick', locale: 'nl', role: 'owner' },
}

/** A locale the deployment does not serve — `SUPPORTED_LOCALES` is `en,nl`. */
const FRENCH_ACCOUNT: SessionResponse = {
  ...SIGNED_IN,
  user: { email: 'nick@example.com', displayName: 'Nick', locale: 'fr', role: 'owner' },
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Answers `/auth/session` with each queued reply in turn, repeating the last.
 *
 * `/api/*` is answered out of `apiStub` instead, and never consumes the queue: the page
 * inside the shell fetches its own endpoint the moment it mounts, and a session payload
 * handed back to it would leave these tests failing on the page rather than on the
 * session they are about.
 */
function serveSessions(
  first: Response | Error,
  ...rest: (Response | Error)[]
): ReturnType<typeof vi.fn> {
  const replies = [first, ...rest]
  let call = 0
  const mock = vi.fn((path: string) => {
    const stub = apiStub(path)
    if (stub !== null) return Promise.resolve(stub)
    // Repeating the last reply rather than running out: a component that asks twice
    // where the test expected once should show up as a wrong assertion, not as an
    // unhandled rejection from somewhere inside React.
    const reply = replies[Math.min(call, replies.length - 1)] ?? first
    call += 1
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** The paths asked of the auth endpoints, in order. What these tests assert on. */
const authCalls = (mock: ReturnType<typeof vi.fn>): string[] =>
  mock.mock.calls
    .map((call) => String(call[0]))
    .filter((path) => !path.startsWith('/api/'))

beforeAll(async () => {
  await i18nReady()
})

beforeEach(resetTheme)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('before the server has answered', () => {
  it('shows a live region rather than a spinner that flashes', () => {
    serveSessions(json(SIGNED_IN))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/' })

    // Against a local server this lasts milliseconds; what a screen reader needs is
    // the status, not an animation.
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })
})

describe('when nobody is signed in', () => {
  it('offers the sign-in screen the server said would work', async () => {
    serveSessions(json(ANONYMOUS))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/' })

    const oidc = await screen.findByRole('link', { name: 'Sign in with Authentik' })
    expect(oidc.getAttribute('href')).toContain('/auth/login?return_to=')
    // No shell: the sign-in screen is not a page inside the application.
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('re-asks the server rather than trusting the login response', async () => {
    // The login response carries a user, and assembling a session out of it would
    // work — right up to the point where the two answers disagree.
    const fetchMock = serveSessions(
      json({ ...ANONYMOUS, methods: { oidc: false, local: true } }),
      json({ authenticated: true, user: SIGNED_IN.user }),
      json(SIGNED_IN),
    )
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/' })

    const form = await screen.findByRole('button', { name: 'Sign in' })
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'nick@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } })
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } })
    fireEvent.click(form)

    await screen.findByRole('navigation', { name: 'Sections' })
    expect(authCalls(fetchMock)).toEqual([
      '/auth/session',
      '/auth/local/login',
      '/auth/session',
    ])
  })
})

describe('when someone is signed in', () => {
  const signedIn = async (path = '/'): Promise<void> => {
    serveSessions(json(SIGNED_IN))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path })
    await screen.findByRole('navigation', { name: 'Sections' })
  }

  it('renders the page inside the shell', async () => {
    await signedIn('/portfolio')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Portfolio')
    expect(screen.getByText('Nick')).toBeTruthy()
    expect(screen.getByText('v0.5.1')).toBeTruthy()
  })

  it('titles the document with the page and the application', async () => {
    await signedIn('/budget')
    await waitFor(() => {
      expect(document.title).toBe('Budget · Balancr')
    })
  })

  it('retitles on a navigation', async () => {
    await signedIn('/')
    await waitFor(() => {
      expect(document.title).toBe('Overview · Balancr')
    })

    const insights = [...screen.getByRole('navigation').querySelectorAll('a')].find(
      (a) => a.textContent === 'Insights',
    )
    clickLink(insights ?? document.createElement('a'))
    await waitFor(() => {
      expect(document.title).toBe('Insights · Balancr')
    })
  })

  it('shows the not-found page inside the shell for a path no route owns', async () => {
    // The server hands any navigation the same `index.html`, so a mistyped address
    // arrives here rather than at a Fastify 404 — and it should still have a nav.
    await signedIn('/nope')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Page not found')
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy()
    await waitFor(() => {
      expect(document.title).toBe('Page not found · Balancr')
    })
  })

  it('returns to the sign-in screen once the server says the session is gone', async () => {
    serveSessions(json(SIGNED_IN), json(ANONYMOUS))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/' })
    await screen.findByRole('navigation', { name: 'Sections' })

    clickLink(screen.getByRole('button', { name: 'Sign out' }))
    // The sign-out POST is answered by the same queue, and the re-ask after it is what
    // decides the screen — not the button that was pressed.
    await screen.findByRole('link', { name: 'Sign in with Authentik' })
  })
})

describe('the language', () => {
  // i18next is a singleton per test file, so a case that proves the switch works would
  // otherwise leave every test after it reading Dutch.
  afterEach(resetLanguage)

  it('follows the account once the session says what it is', async () => {
    // `/bootstrap` was answered before anyone signed in, so it could only resolve the
    // language from the cookie and the browser's header. The account's own setting
    // arrives with the session, and both the strings and `<html lang>` have to move to
    // it — the attribute included, because no document was reloaded to carry it.
    serveSessions(json(DUTCH_ACCOUNT))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/portfolio' })

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Portefeuille')
    })
    expect(document.documentElement.lang).toBe('nl')
  })

  it('leaves the resolved language alone when the account agrees with it', async () => {
    serveSessions(json(SIGNED_IN))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/portfolio' })
    await screen.findByRole('navigation', { name: 'Sections' })
    expect(document.documentElement.lang).toBe('en')
  })

  it('does not undo a switch made after the session landed', async () => {
    // What the settings page does: change the language, then answer with a payload the
    // session state here knows nothing about. Adopting the session locale on every
    // language change would put the UI back where it started, and the control on the
    // settings page would look broken until the next full reload.
    serveSessions(json(SIGNED_IN))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/portfolio' })
    await screen.findByRole('navigation', { name: 'Sections' })

    await act(async () => {
      await setLanguage('nl')
    })
    // Waited for rather than asserted straight away: the switch loads a catalogue, so
    // the Dutch heading is one or more microtasks out and a single flush is a race.
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Portefeuille')
    })
    // Then a flush, because the effect that would undo it runs on the render the switch
    // itself caused — and it is the *absence* of that revert this test is about, so the
    // assertion has to come after it would have happened.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Portefeuille')
  })

  it('ignores a locale this bundle has no catalogue for', async () => {
    // A row written when the deployment served French, or `SUPPORTED_LOCALES` narrowed
    // since. i18next would fall back on its own and say nothing; keeping the language
    // the server resolved is the better of the two silences.
    serveSessions(json(FRENCH_ACCOUNT))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/portfolio' })
    await screen.findByRole('navigation', { name: 'Sections' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Portfolio')
  })
})

describe('when the server cannot be reached', () => {
  it('says so, quotes nothing it does not know, and offers a retry', async () => {
    serveSessions(new TypeError('fetch failed'))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/' })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Balancr could not be reached.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('actually re-asks on retry', async () => {
    const fetchMock = serveSessions(new TypeError('fetch failed'), json(SIGNED_IN))
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/' })
    await screen.findByRole('alert')

    clickLink(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('navigation', { name: 'Sections' })
    expect(authCalls(fetchMock)).toEqual(['/auth/session', '/auth/session'])
  })

  it('shows the request id when the server gave one, since it is the only way to look it up', async () => {
    serveSessions(
      json(
        { error: { code: 'internal_error', message: 'Something went wrong.', requestId: 'req-42' } },
        500,
      ),
    )
    renderApp(<App bootstrap={BOOTSTRAP} />, { path: '/' })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Something went wrong.')
    expect(alert.textContent).toContain('req-42')
  })
})
