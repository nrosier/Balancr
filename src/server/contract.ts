/**
 * The HTTP response shapes the browser is allowed to know about.
 *
 * These types live here rather than next to the handlers that build them, for one
 * mechanical reason: `web/src/shared.ts` imports them, and TypeScript compiles every
 * file it can reach. Importing a type out of `routes/auth.ts` pulls that whole
 * module into the frontend program — `db`, `argon2`, `otpauth`, and the
 * `declare module 'fastify'` augmentations that give `request.user` its type. The
 * augmentations live in `app.ts`, `csrf.ts` and `auth/guard.ts`, none of which the
 * browser has any business importing, so the frontend typecheck failed on
 * `request.user` in a file it never runs.
 *
 * A module with no imports at all cannot have that problem. It also keeps the
 * guarantee that mattered: the handlers annotate their return types with these
 * interfaces, so renaming a field breaks the server build, and the browser reads the
 * same declaration, so it breaks the frontend build too.
 *
 * The `/api/*` payloads are *not* here — `routes/api/schemas.ts` derives them from
 * the Zod schemas that validate them, which is a stronger guarantee than a hand-
 * written interface and is already imported the same way.
 */

/** The signed-in person, as `/auth/session` and `/auth/local/login` report them. */
export interface SessionUserResponse {
  /** Nullable: an OIDC provider need not release an email, and a local account may have none. */
  email: string | null
  displayName: string | null
  locale: string
  role: 'owner' | 'viewer'
}

/** `GET /auth/session`. */
export interface SessionResponse {
  authenticated: boolean
  user: SessionUserResponse | null
  /**
   * What would work from *this* connection. `local` answers "would a password be
   * entertained from your address", which is a property of the peer and cannot be
   * decided in the browser.
   */
  methods: { oidc: boolean; local: boolean }
}

/** `POST /auth/local/login`, on success. */
export interface LocalLoginResponse {
  authenticated: true
  user: SessionUserResponse
}

/** `GET /bootstrap` — the handful of facts the SPA needs before it can render. */
export interface BootstrapResponse {
  /** Null when the build could not read its own `package.json`; see `version.ts`. */
  version: string | null
  locales: {
    /** `SUPPORTED_LOCALES`. The UI may offer no language outside this list. */
    supported: string[]
    /** `DEFAULT_LOCALE`, used when nothing better is known about the visitor. */
    default: string
    /**
     * The language this request resolved to — the account's setting, the cookie,
     * `Accept-Language`, or the default, in that order. Always one of `supported`.
     *
     * The bundle starts in this language rather than reading `navigator.languages`
     * itself: the server has already answered the same question to decide `<html
     * lang>`, and two implementations of one resolution order is how the attribute and
     * the strings end up disagreeing. See `src/server/locale.ts`.
     */
    active: string
  }
  /**
   * Number and date formatting, which is a separate setting from the UI language on
   * purpose: choosing English must not turn `€ 1.234,56` into `€1,234.56`.
   */
  format: {
    locale: string
    currency: string
    timeZone: string
  }
  /** Where to read the double-submit token, and which header to echo it in. */
  csrf: {
    cookie: string
    header: string
  }
}
