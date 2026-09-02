/**
 * The three authentication calls the SPA makes, and nothing else.
 *
 * The response types come from the server route that builds them (through
 * `shared.ts`), so this file is a set of paths and verbs rather than a second
 * description of the contract.
 */
import { apiGet, apiSend, type CsrfConfig } from '../api/client.ts'
import type { LocalLoginResponse, SessionResponse, SessionUserResponse } from '../shared.ts'

export type { LocalLoginResponse, SessionResponse, SessionUserResponse }

/**
 * Who is signed in, and what would work from here.
 *
 * Public, so it is also the first call the sign-in screen makes: `methods.local`
 * answers "would a password be entertained from this connection", which is a
 * property of the peer address and cannot be decided in the browser.
 */
export function fetchSession(): Promise<SessionResponse> {
  return apiGet<SessionResponse>('/auth/session')
}

export interface LocalCredentials {
  email: string
  password: string
  totp: string
}

/** The break-glass password login. 404s unless the peer is inside the allowed range. */
export function localSignIn(
  credentials: LocalCredentials,
  csrf: CsrfConfig,
): Promise<LocalLoginResponse> {
  return apiSend<LocalLoginResponse>('POST', '/auth/local/login', credentials, csrf)
}

/**
 * Ends the session server-side. A POST, so it carries the CSRF token — a logout
 * link on someone else's page is only a nuisance, but a cheap one to close.
 */
export async function signOut(csrf: CsrfConfig): Promise<void> {
  await apiSend<null>('POST', '/auth/logout', undefined, csrf)
}

/**
 * What to call the signed-in person.
 *
 * Both fields are nullable: an OIDC provider need not release a name or an email,
 * and a local account created without a display name has neither. `null` here means
 * "print nothing", which is better than the string `null` or a fabricated label.
 */
export function accountLabel(user: SessionUserResponse): string | null {
  return user.displayName ?? user.email
}
