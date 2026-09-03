/**
 * Which language this request is answered in.
 *
 * The resolution order is the one in the plan, and each rung exists because the one
 * below it cannot answer the case above:
 *
 *  1. **The signed-in user's `locale` column.** The language is a property of the
 *     account, not of the browser, because the nightly analysis has no browser — the
 *     narrative is generated in the account's locale, and a UI that disagreed with it
 *     would show Dutch findings under English chrome.
 *  2. **The `balancr_locale` cookie.** What makes the *first byte* right rather than
 *     the first render: `<html lang>` and the bundle's starting language are decided
 *     before `/auth/session` has answered, so without a cookie a Dutch account would
 *     paint English and then switch. It is written by the server whenever a session
 *     starts or the setting changes, so it is a cache of rung 1 and never a competing
 *     source of truth.
 *  3. **`Accept-Language`.** The visitor nobody has met — the sign-in screen, mostly.
 *  4. **`DEFAULT_LOCALE`.** Configuration, because there is no request-shaped answer
 *     left and a hardcoded `en` would be wrong on a Dutch-only deployment.
 *
 * `SUPPORTED_LOCALES` filters every rung, including the user column: a locale that
 * was enabled when someone chose it and has since been removed from `.env` must not
 * come back out of the database as a language the catalogues cannot render.
 *
 * The q-weighted parse is not decoration. `nl;q=0.9, en;q=0.8` and `en, nl` carry
 * opposite preferences and differ only in the weights, so reading the header
 * positionally — which is what `navigator.languages` and most one-line
 * implementations do — gets the first one backwards.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.ts'
import { LOCALE_COOKIE, cookieAttributes } from './cookies.ts'

/**
 * A year. The cookie holds a preference, not a credential, and nothing about it is
 * sensitive — the language is visible in the rendered page. Re-set on every session
 * start and every change, so an active user's copy never expires.
 */
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60

/** One entry of an `Accept-Language` header, after parsing. */
interface Weighted {
  /** Lowercased tag, `*` included. */
  tag: string
  quality: number
}

/**
 * The tags in an `Accept-Language` header, most wanted first.
 *
 * Entries with `q=0` are dropped rather than ranked last: the grammar says `q=0`
 * means *not acceptable*, so ranking it would let a header that explicitly refuses
 * Dutch select Dutch. A malformed weight is treated as absent, which is the
 * forgiving direction — the header comes from a browser we do not control, and
 * refusing to read it at all would fall through to `DEFAULT_LOCALE` on a typo.
 *
 * Ties keep the order they were written in, because `Array.prototype.sort` is
 * required to be stable and the header's own order is the only remaining signal.
 */
export function parseAcceptLanguage(header: string | undefined): string[] {
  if (header === undefined) return []

  const weighted: Weighted[] = []
  for (const part of header.split(',')) {
    const [rawTag, ...params] = part.split(';')
    const tag = rawTag?.trim().toLowerCase()
    if (tag === undefined || tag.length === 0) continue

    let quality = 1
    for (const param of params) {
      const [name, value] = param.split('=')
      if (name?.trim().toLowerCase() !== 'q') continue
      const parsed = Number(value?.trim())
      if (Number.isFinite(parsed)) quality = parsed
    }

    if (quality > 0) weighted.push({ tag, quality })
  }

  return weighted.sort((a, b) => b.quality - a.quality).map((entry) => entry.tag)
}

/**
 * The first supported locale a list of tags asks for, or null.
 *
 * `nl-BE` selects `nl`: the catalogues are keyed by base language, and a region is a
 * formatting concern that `FORMAT_LOCALE` owns separately. `*` means "anything", so
 * it resolves to the configured default rather than to whichever locale happens to
 * be first in the list — a header of `nl;q=0.9, *;q=0.1` on an `en,nl` deployment
 * should still be Dutch, and it is the `*` rung that decides what happens after.
 */
export function negotiateLocale(
  tags: readonly string[],
  supported: readonly string[],
): string | null {
  for (const tag of tags) {
    if (tag === '*') {
      const fallback = supported.includes(config.DEFAULT_LOCALE)
        ? config.DEFAULT_LOCALE
        : supported[0]
      return fallback ?? null
    }
    if (supported.includes(tag)) return tag
    const base = tag.split('-')[0]
    if (base !== undefined && supported.includes(base)) return base
  }
  return null
}

/** True for a locale this deployment can actually render. */
export const isSupported = (value: unknown): value is string =>
  typeof value === 'string' && config.SUPPORTED_LOCALES.includes(value)

/**
 * The language for this request, by the order in the file header.
 *
 * Safe on a public route: `registerAuth` sets `request.user` for every request that
 * carries a valid session, exempt routes included, which is exactly why the shell
 * and `/bootstrap` can honour rung 1 at all.
 */
export function resolveLocale(request: FastifyRequest): string {
  if (isSupported(request.user?.locale)) return request.user.locale

  const cookie = request.cookies[LOCALE_COOKIE]
  if (isSupported(cookie)) return cookie

  const header = request.headers['accept-language']
  const negotiated = negotiateLocale(
    parseAcceptLanguage(typeof header === 'string' ? header : undefined),
    config.SUPPORTED_LOCALES,
  )
  return negotiated ?? config.DEFAULT_LOCALE
}

/**
 * Remembers `locale` in the cookie, so the next first paint needs no correction.
 *
 * Called where a session starts and where the setting changes — the two moments the
 * server learns something the browser could not have known. It is `httpOnly`: the
 * page never needs to read it, and one writer means the cookie cannot drift away
 * from the account column it caches.
 */
export function rememberLocale(reply: FastifyReply, locale: string): void {
  if (!isSupported(locale)) return
  reply.setCookie(LOCALE_COOKIE, locale, cookieAttributes(true, LOCALE_COOKIE_MAX_AGE))
}
