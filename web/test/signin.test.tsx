/**
 * The sign-in screen, whose whole design is that it does not decide anything.
 *
 * `methods` comes from `/auth/session`, and `methods.local` is a judgement about the
 * TCP peer address — "would a password be entertained from this connection" — which a
 * browser cannot make. So the password form appears only when the server says it would
 * work: drawing one that is guaranteed to 404 is worse than drawing none. Both halves
 * of that are asserted, including the case where neither method is offered, which is a
 * real deployment state (OIDC unconfigured, local login off) and must say so rather
 * than present an empty card.
 *
 * Failures are shown verbatim. The server deliberately answers every way a login can
 * fail with the same sentence — distinguishing "no such account" from "wrong password"
 * confirms a guess to whoever is guessing — so there is nothing here to interpret, and
 * a test that expected a friendlier message would be asking for that leak back.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CsrfConfig } from '../src/api/client.ts'
import { SignIn } from '../src/auth/SignIn.tsx'
import { i18nReady } from './helpers.tsx'

const CSRF: CsrfConfig = { cookie: 'balancr_csrf', header: 'x-csrf-token' }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serve(...replies: Response[]): ReturnType<typeof vi.fn> {
  let call = 0
  const mock = vi.fn(() => {
    const reply = replies[Math.min(call, replies.length - 1)]
    call += 1
    return Promise.resolve(reply?.clone() ?? json(null, 204))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function signIn(
  methods: { oidc: boolean; local: boolean },
  onSignedIn: () => void = () => undefined,
): void {
  render(<SignIn methods={methods} csrf={CSRF} onSignedIn={onSignedIn} />)
}

/** Fills the three fields the server requires. */
function fill(): void {
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: 'nick@example.com' },
  })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } })
  fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } })
}

beforeAll(async () => {
  await i18nReady()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what it offers', () => {
  it('shows only the provider when that is all the server allows', () => {
    signIn({ oidc: true, local: false })
    expect(screen.getByRole('link', { name: 'Sign in with Authentik' })).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('shows only the password form when there is no provider', () => {
    signIn({ oidc: false, local: true })
    expect(screen.queryByRole('link', { name: 'Sign in with Authentik' })).toBeNull()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.queryByText('or')).toBeNull()
  })

  it('separates the two when both are available', () => {
    signIn({ oidc: true, local: true })
    expect(screen.getByRole('link', { name: 'Sign in with Authentik' })).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.getByText('or')).toBeTruthy()
  })

  it('says so plainly when nothing would work from here', () => {
    // A real state: OIDC unconfigured and local login off, or local login on but this
    // address outside `AUTH_LOCAL_ALLOWED_CIDRS`.
    signIn({ oidc: false, local: false })
    expect(screen.getByText('No sign-in method is available from this network.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('asks for the authenticator code alongside the password, never after it', () => {
    // TOTP is mandatory for a local account; a second step would be a second screen
    // to get wrong, and this is the break-glass path.
    signIn({ oidc: false, local: true })
    expect(screen.getByLabelText('Authenticator code').getAttribute('autocomplete')).toBe(
      'one-time-code',
    )
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe(
      'current-password',
    )
  })
})

describe('the provider link', () => {
  it('carries the page the visitor was trying to reach', () => {
    window.history.pushState(null, '', '/portfolio?month=2026-08')
    signIn({ oidc: true, local: false })

    const href = screen.getByRole('link', { name: 'Sign in with Authentik' }).getAttribute('href')
    expect(href).toBe(`/auth/login?return_to=${encodeURIComponent('/portfolio?month=2026-08')}`)
    window.history.pushState(null, '', '/')
  })

  it('is a real navigation, not a fetch', () => {
    // The code flow needs the browser to visit Authentik and come back; an XHR cannot
    // do that.
    signIn({ oidc: true, local: false })
    expect(screen.getByRole('link', { name: 'Sign in with Authentik' }).tagName).toBe('A')
  })
})

describe('the password form', () => {
  it('posts the three fields and reports success once', async () => {
    const fetchMock = serve(json({ authenticated: true, user: null }))
    let signedIn = 0
    signIn({ oidc: false, local: true }, () => {
      signedIn += 1
    })

    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(signedIn).toBe(1)
    })
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/auth/local/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'nick@example.com',
      password: 'correct horse',
      totp: '123456',
    })
  })

  it('shows the server’s one message for a refused login, with the request id', async () => {
    serve(
      json(
        {
          error: {
            code: 'unauthenticated',
            message: 'Those details are not correct.',
            requestId: 'req-7',
          },
        },
        401,
      ),
    )
    signIn({ oidc: false, local: true })

    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Those details are not correct.')
    expect(alert.textContent).toContain('req-7')
  })

  it('lets the visitor try again after a refusal', async () => {
    serve(json({ error: { code: 'unauthenticated', message: 'Those details are not correct.' } }, 401))
    signIn({ oidc: false, local: true })

    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('alert')

    const button = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  it('says it is working while the request is in flight, and blocks a second submit', () => {
    serve(json({ authenticated: true, user: null }))
    signIn({ oidc: false, local: true })

    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    const button = screen.getByRole('button', { name: 'Signing in…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('never lets the browser submit the form itself', () => {
    // A form the browser submits with no `method` sends a GET, which puts the password
    // and the one-time code in a URL — and therefore in history, in the referrer of
    // whatever loads next, and in any log along the way. The handler has to claim the
    // event, and `defaultPrevented` is the only place that is visible.
    serve(json({ authenticated: true, user: null }))
    signIn({ oidc: false, local: true })
    fill()

    const form = document.querySelector('form')
    expect(form).toBeTruthy()
    const submit = new Event('submit', { bubbles: true, cancelable: true })
    fireEvent(form as HTMLFormElement, submit)
    expect(submit.defaultPrevented).toBe(true)
  })
})
