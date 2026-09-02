/**
 * The state of a login between the redirect out and the callback back.
 *
 * Three secrets have to survive that round trip — the PKCE verifier, the expected
 * `state` and the expected `nonce` — and none of them may travel through the
 * browser, because each one exists to defend against something the browser may be
 * carrying. So they live in `login_flows` and the browser gets only the `state`,
 * which is public by design (it is in the redirect URL either way).
 *
 * Two properties are what make this worth a table rather than a signed cookie:
 *
 *  - **Single use.** Consuming a flow deletes the row and reports whether a row
 *    was actually deleted, so replaying a captured callback URL fails the second
 *    time. A cookie-based flow has no equivalent — the same cookie verifies twice.
 *  - **A deadline.** A flow left open is a code-exchange window left open; ten
 *    minutes is long enough for a password and an MFA push, short enough that an
 *    abandoned tab is not still usable tomorrow.
 *
 * `state` is also set as a short-lived cookie, and the callback looks the flow up
 * by the *cookie*, then lets the library compare it against the query parameter.
 * That ordering is deliberate: it means a callback URL alone is not enough, so an
 * attacker cannot start a flow of their own and hand the victim the resulting
 * link to be logged in as the attacker.
 */
import { eq, lt } from 'drizzle-orm'
import { randomNonce, randomPKCECodeVerifier, randomState } from 'openid-client'
import type { Db } from '../../db/index.ts'
import { loginFlows } from '../../db/schema.ts'
import type { FlowSecrets } from './oidc.ts'

/** How long a started login stays usable. Long enough for an MFA push. */
export const LOGIN_FLOW_TTL_MS = 10 * 60 * 1000

export interface LoginFlow extends FlowSecrets {
  returnTo: string
}

/**
 * Starts a flow and returns its secrets.
 *
 * Expired rows are swept on the way in. There is at most a handful of them and
 * the alternative is a scheduled job for a table that is empty most of the time —
 * and unlike the rate-limit counters, a start is rare enough that sweeping on
 * every one costs nothing.
 */
export function startLoginFlow(db: Db, returnTo: string): LoginFlow {
  const now = Date.now()
  db.delete(loginFlows).where(lt(loginFlows.expiresAt, new Date(now))).run()

  const flow: LoginFlow = {
    state: randomState(),
    nonce: randomNonce(),
    codeVerifier: randomPKCECodeVerifier(),
    returnTo,
  }

  db.insert(loginFlows)
    .values({
      state: flow.state,
      nonce: flow.nonce,
      codeVerifier: flow.codeVerifier,
      returnTo: flow.returnTo,
      expiresAt: new Date(now + LOGIN_FLOW_TTL_MS),
    })
    .run()

  return flow
}

/**
 * Takes a flow and removes it, or returns null.
 *
 * Null covers three cases that all mean the same thing to the caller — no such
 * flow, already used, expired — and they are deliberately not distinguished in
 * what the client is told. An error that says "that state has already been used"
 * confirms a guess.
 *
 * The delete happens first and its result decides the answer, so two concurrent
 * callbacks with the same state cannot both succeed.
 */
export function consumeLoginFlow(db: Db, state: string): LoginFlow | null {
  const rows = db.delete(loginFlows).where(eq(loginFlows.state, state)).returning().all()
  const row = rows[0]
  if (row === undefined) return null
  if (row.expiresAt.getTime() <= Date.now()) return null

  return {
    state: row.state,
    nonce: row.nonce,
    codeVerifier: row.codeVerifier,
    returnTo: row.returnTo,
  }
}

/**
 * A control character anywhere in the path, including the newline that would let
 * a crafted value split the `Location` header into a second one.
 *
 * Written as a scan rather than a regexp because the character class for it is a
 * literal range of unprintables in the source, which is exactly the kind of thing
 * an editor or a copy and paste silently mangles.
 */
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })

/**
 * Whether a `return_to` may be used, and what to use instead.
 *
 * Only a local path is accepted, and `//host` is rejected as well as
 * `https://host` — a protocol-relative URL is a redirect off-site that looks like
 * a path. An open redirect on a login endpoint is how a convincing phishing link
 * gets a real domain in front of it, and it is cheap to refuse.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  // A backslash is treated as a slash by some browsers when resolving a URL, so
  // `/\evil.example` would leave the site.
  if (raw.includes('\\')) return '/'
  if (hasControlCharacter(raw)) return '/'
  return raw
}
