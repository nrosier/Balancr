/**
 * The frame: navigation, the header, and signing out.
 *
 * Most of this file is accessibility, because that is the part of a shell that is
 * invisible when it breaks:
 *
 *  - **One `<nav>`, five links, one of them marked current.** The stylesheet keys its
 *    highlight off `aria-current`, so "the announcement and the highlight cannot
 *    disagree" is only true while exactly one link carries it. Two hidden copies of
 *    the nav behind media queries — the obvious way to build a bottom bar and a
 *    sidebar — would double every tab stop and read the sections out twice, so the
 *    count is asserted rather than assumed.
 *  - **Focus moves to `main` on a route change, and not on arrival.** A client-side
 *    navigation replaces the content without the browser's document reset, so focus
 *    would stay on the link and a screen reader would announce nothing. Moving it on
 *    first render instead would steal focus from the skip link before anyone reached
 *    it.
 *
 * Sign-out is the one mutation the shell performs, and it is asserted to be a real
 * POST that carries the CSRF token, with the callback firing only after the server
 * accepts. Faking it would leave a browser showing the sign-in screen while the
 * session it claims to have ended stayed valid for anyone holding the cookie.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsrfConfig } from '../src/api/client.ts'
import type { SessionUserResponse } from '../src/auth/session.ts'
import { ROUTES } from '../src/routes.ts'
import { Account } from '../src/shell/Account.tsx'
import { AppShell } from '../src/shell/AppShell.tsx'
import { Nav } from '../src/shell/Nav.tsx'
import { clickLink, i18nReady, renderApp, resetTheme } from './helpers.tsx'

/** What `/bootstrap` reports, so the test does not invent header names. */
const CSRF: CsrfConfig = { cookie: 'balancr_csrf', header: 'x-csrf-token' }

const OWNER: SessionUserResponse = {
  email: 'nick@example.com',
  displayName: 'Nick',
  locale: 'en',
  role: 'owner',
}

const SECTIONS = ['Overview', 'Budget', 'Portfolio', 'Insights', 'Settings']

beforeAll(async () => {
  await i18nReady()
})

beforeEach(resetTheme)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Nav', () => {
  const links = (): HTMLAnchorElement[] => [
    ...screen.getByRole('navigation', { name: 'Sections' }).querySelectorAll('a'),
  ]

  it('shows every route once, in the order of the route table', () => {
    renderApp(<Nav />, { path: '/' })
    expect(links().map((a) => a.textContent)).toEqual(SECTIONS)
    expect(links()).toHaveLength(ROUTES.length)
  })

  it('links to the paths the router resolves', () => {
    renderApp(<Nav />, { path: '/' })
    expect(links().map((a) => a.getAttribute('href'))).toEqual(ROUTES.map((r) => r.path))
  })

  it('marks exactly one section as the current page', () => {
    renderApp(<Nav />, { path: '/budget' })
    const current = links().filter((a) => a.getAttribute('aria-current') === 'page')
    expect(current.map((a) => a.textContent)).toEqual(['Budget'])
  })

  it('moves the mark when the route changes', () => {
    renderApp(<Nav />, { path: '/' })
    expect(
      links()
        .filter((a) => a.getAttribute('aria-current') === 'page')
        .map((a) => a.textContent),
    ).toEqual(['Overview'])

    const portfolio = links().find((a) => a.textContent === 'Portfolio')
    clickLink(portfolio ?? document.createElement('a'))

    expect(
      links()
        .filter((a) => a.getAttribute('aria-current') === 'page')
        .map((a) => a.textContent),
    ).toEqual(['Portfolio'])
  })

  it('does not light up a section on a nested path belonging to another', () => {
    // `/` is the only route that must not match by prefix, and it is the one a naive
    // `startsWith` gets wrong for every path in the application.
    renderApp(<Nav />, { path: '/budget/2026-08' })
    expect(
      links()
        .filter((a) => a.getAttribute('aria-current') === 'page')
        .map((a) => a.textContent),
    ).toEqual(['Budget'])
  })
})

describe('AppShell', () => {
  const shell = (path = '/'): ReturnType<typeof renderApp> =>
    renderApp(
      <AppShell user={OWNER} csrf={CSRF} version="0.5.1" onSignedOut={() => undefined}>
        <h1>Overview</h1>
      </AppShell>,
      { path },
    )

  it('offers a skip link as the first thing in the tab order', () => {
    shell()
    const focusable = [...document.querySelectorAll('a[href], button, input')]
    expect(focusable[0]?.getAttribute('href')).toBe('#main')
    expect(focusable[0]?.textContent).toBe('Skip to content')
  })

  it('gives that link somewhere to land', () => {
    shell()
    const main = screen.getByRole('main')
    expect(main.id).toBe('main')
    // Programmatically focusable without becoming a tab stop of its own.
    expect(main.getAttribute('tabindex')).toBe('-1')
  })

  it('shows the running version, labelled', () => {
    shell()
    expect(screen.getByText('v0.5.1').getAttribute('title')).toBe('Version 0.5.1')
  })

  it('prints nothing where the version would be when the build could not read it', () => {
    renderApp(
      <AppShell user={OWNER} csrf={CSRF} version={null} onSignedOut={() => undefined}>
        <h1>Overview</h1>
      </AppShell>,
      { path: '/' },
    )
    expect(screen.queryByText(/^v\d/)).toBeNull()
    // The brand itself is still there — a missing version is not a missing header.
    expect(screen.getByRole('link', { name: /Balancr/ })).toBeTruthy()
  })

  it('leaves focus alone on arrival', () => {
    shell()
    // Whatever the browser focused, not `main`: nobody has navigated yet, and moving
    // focus here would jump the skip link.
    expect(document.activeElement).not.toBe(screen.getByRole('main'))
  })

  it('moves focus to the content on a navigation', () => {
    shell()
    const budget = [...screen.getByRole('navigation').querySelectorAll('a')].find(
      (a) => a.textContent === 'Budget',
    )
    clickLink(budget ?? document.createElement('a'))
    expect(document.activeElement).toBe(screen.getByRole('main'))
  })

  it('carries the theme control and the account in the header', () => {
    shell()
    expect(screen.getByRole('group', { name: 'Colour theme' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  })
})

describe('ChangelogDialog', () => {
  const shell = (): ReturnType<typeof renderApp> =>
    renderApp(
      <AppShell user={OWNER} csrf={CSRF} version="0.5.1" onSignedOut={() => undefined}>
        <h1>Overview</h1>
      </AppShell>,
      { path: '/' },
    )

  const changelogFetchMock = (
    body: unknown = { available: true, entries: [] },
  ): ReturnType<typeof vi.fn> => {
    const mock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', mock)
    return mock
  }

  const openButton = (): HTMLElement => screen.getByRole('button', { name: 'v0.5.1' })

  it('is closed until the version button is clicked', () => {
    changelogFetchMock()
    shell()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens on the version button, naming the running version, and loads the changelog', async () => {
    changelogFetchMock()
    shell()
    fireEvent.click(openButton())

    const dialog = screen.getByRole('dialog')
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(document.getElementById('changelog-title')?.textContent).toContain('0.5.1')

    await waitFor(() => {
      expect(screen.getByText('This build shipped without its changelog.')).toBeTruthy()
    })
  })

  it('returns focus to the button and closes on Escape', async () => {
    changelogFetchMock()
    shell()
    fireEvent.click(openButton())
    const dialog = screen.getByRole('dialog')

    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(document.activeElement).toBe(openButton())
  })
})

describe('Account', () => {
  const fetchMock = (response: Response | Error): ReturnType<typeof vi.fn> => {
    const mock = vi.fn(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    )
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('prefers the display name and falls back to the email', () => {
    const { unmount } = render(
      <Account user={OWNER} csrf={CSRF} onSignedOut={() => undefined} />,
    )
    expect(screen.getByText('Nick')).toBeTruthy()
    unmount()

    render(
      <Account
        user={{ ...OWNER, displayName: null }}
        csrf={CSRF}
        onSignedOut={() => undefined}
      />,
    )
    expect(screen.getByText('nick@example.com')).toBeTruthy()
  })

  it('prints nothing rather than a placeholder when the provider released neither', () => {
    render(
      <Account
        user={{ email: null, displayName: null, locale: 'en', role: 'owner' }}
        csrf={CSRF}
        onSignedOut={() => undefined}
      />,
    )
    expect(screen.queryByText(/null|undefined/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  })

  it('posts the logout with the CSRF token and only then reports it', async () => {
    document.cookie = `${CSRF.cookie}=token-from-the-cookie`
    const mock = fetchMock(new Response(null, { status: 204 }))
    let signedOut = 0

    render(
      <Account
        user={OWNER}
        csrf={CSRF}
        onSignedOut={() => {
          signedOut += 1
        }}
      />,
    )
    clickLink(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(signedOut).toBe(1)
    })
    expect(mock).toHaveBeenCalledTimes(1)
    const [path, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/auth/logout')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)[CSRF.header]).toBe('token-from-the-cookie')
    // No body, and therefore no `content-type`: Fastify rejects a POST that announces
    // JSON and sends nothing.
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined()
  })

  it('leaves the button usable when the server refuses, rather than faking a sign-out', async () => {
    fetchMock(new Response(JSON.stringify({ error: { code: 'forbidden' } }), { status: 403 }))
    let signedOut = 0

    render(
      <Account
        user={OWNER}
        csrf={CSRF}
        onSignedOut={() => {
          signedOut += 1
        }}
      />,
    )
    const button = (): HTMLButtonElement =>
      screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement
    clickLink(button())
    // Disabled while the request is in flight, so a second click cannot race it.
    expect(button().disabled).toBe(true)

    await waitFor(() => {
      expect(button().disabled).toBe(false)
    })
    expect(signedOut).toBe(0)
  })
})
