/**
 * The screen a brand-new OIDC identity lands on, once signed in but not yet
 * a member of any tenant (#373).
 *
 * Two modes, one form each, both posting to their own endpoint — this test
 * asserts each posts the right body to the right path, and that a rejected
 * request shows the server's message verbatim. A wrong, expired, revoked or
 * already-used invite code all come back from the server as the same generic
 * failure on purpose (distinguishing them would confirm a guess to whoever is
 * guessing), so there is nothing here to interpret beyond showing it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CsrfConfig } from '../src/api/client.ts'
import { Onboarding } from '../src/auth/Onboarding.tsx'
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

function onboard(
  pending: { email: string | null; displayName: string | null } = { email: 'nick@example.com', displayName: null },
  onProvisioned: () => void = () => undefined,
): void {
  render(<Onboarding pending={pending} csrf={CSRF} onProvisioned={onProvisioned} />)
}

beforeAll(async () => {
  await i18nReady()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('creating a household', () => {
  it('posts the label and reports success once', async () => {
    const fetchMock = serve(json({ authenticated: true, user: null }))
    let provisioned = 0
    onboard(undefined, () => {
      provisioned += 1
    })

    fireEvent.change(screen.getByLabelText('Household name'), { target: { value: 'The Rosiers' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(provisioned).toBe(1)
    })
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/auth/onboarding/create-tenant')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ label: 'The Rosiers' })
  })

  it('shows the server’s message for a refused create, with the request id', async () => {
    serve(
      json(
        { error: { code: 'conflict', message: 'Something went wrong.', requestId: 'req-9' } },
        409,
      ),
    )
    onboard()

    fireEvent.change(screen.getByLabelText('Household name'), { target: { value: 'The Rosiers' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Something went wrong.')
    expect(alert.textContent).toContain('req-9')
  })
})

describe('redeeming an invite', () => {
  it('posts the code and reports success once', async () => {
    const fetchMock = serve(json({ authenticated: true, user: null }))
    let provisioned = 0
    onboard(undefined, () => {
      provisioned += 1
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Redeem an invite code' }))
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'A1B2-C3D4-E5F6-A7B8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(provisioned).toBe(1)
    })
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/auth/onboarding/redeem-invite')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ code: 'A1B2-C3D4-E5F6-A7B8' })
  })

  it('shows the same generic failure for a wrong, expired or used code', async () => {
    serve(json({ error: { code: 'bad_request', message: 'Those details are not correct.' } }, 400))
    onboard()

    fireEvent.click(screen.getByRole('tab', { name: 'Redeem an invite code' }))
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'WRONGCODE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Those details are not correct.')
  })

  it('lets the visitor try again after a refusal', async () => {
    serve(json({ error: { code: 'bad_request', message: 'Those details are not correct.' } }, 400))
    onboard()

    fireEvent.click(screen.getByRole('tab', { name: 'Redeem an invite code' }))
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'WRONGCODE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('alert')

    const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })
})

describe('the greeting', () => {
  it('greets by display name when the server has one', () => {
    onboard({ email: 'nick@example.com', displayName: 'Nick' })
    expect(screen.getByText("Welcome, Nick. There's no household waiting for you yet.")).toBeTruthy()
  })

  it('falls back to the email when there is no display name', () => {
    onboard({ email: 'nick@example.com', displayName: null })
    expect(
      screen.getByText("Welcome, nick@example.com. There's no household waiting for you yet."),
    ).toBeTruthy()
  })
})

describe('mode switching', () => {
  it('starts on create and switches to redeem without a router', () => {
    onboard()
    expect(screen.getByLabelText('Household name')).toBeTruthy()
    expect(screen.queryByLabelText('Invite code')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Redeem an invite code' }))
    expect(screen.queryByLabelText('Household name')).toBeNull()
    expect(screen.getByLabelText('Invite code')).toBeTruthy()
  })
})
