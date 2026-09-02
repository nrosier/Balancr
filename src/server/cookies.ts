/**
 * Cookie names and attributes, decided once.
 *
 * The `__Host-` prefix is the load-bearing part. A browser accepts a cookie with
 * that prefix only when it is `Secure`, has `Path=/`, and carries no `Domain` —
 * which means it cannot be set by a sibling host. That is what makes two things
 * in this application sound rather than merely conventional:
 *
 *  - the session cookie cannot be planted by anything else under the parent
 *    domain, so an unrelated app on `*.example.com` cannot fix a session id; and
 *  - the CSRF cookie cannot be planted either, which is the one assumption that
 *    double-submit rests on. Without the prefix, double-submit degrades to
 *    "attacker sets both halves".
 *
 * The prefix requires HTTPS, and development runs on `http://localhost`, where a
 * browser rejects the cookie outright — so the name adapts to the deployment
 * rather than the code pretending the two cases are the same. `PUBLIC_BASE_URL`
 * decides, and `config` already refuses a non-HTTPS base URL in production, so
 * the unprefixed name cannot be what a real deployment uses.
 */
import { config } from '../config.ts'

/** True when the deployment is HTTPS, which is what `__Host-` and `Secure` need. */
export const secureCookies = config.PUBLIC_BASE_URL.startsWith('https://')

const named = (name: string): string => (secureCookies ? `__Host-${name}` : name)

/** Opaque session id. Read by the server only. */
export const SESSION_COOKIE = named('balancr_sid')

/**
 * The CSRF token. Deliberately readable by scripts — the SPA has to echo it in a
 * header, which is the whole mechanism. It is not a credential: on its own it
 * authenticates nothing.
 */
export const CSRF_COOKIE = named('balancr_csrf')

export interface CookieAttributes {
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax' | 'strict' | 'none'
}

/**
 * `SameSite=Lax` rather than `Strict`: the OIDC provider redirects the browser
 * back to Balancr with a cross-site GET, and `Strict` would withhold the cookie
 * on exactly that navigation, so the callback would arrive with no state and the
 * login would fail on the last step. `Lax` still withholds it from cross-site
 * POSTs, which is the case that matters.
 */
export function cookieAttributes(httpOnly: boolean): CookieAttributes {
  return { path: '/', httpOnly, secure: secureCookies, sameSite: 'lax' }
}
