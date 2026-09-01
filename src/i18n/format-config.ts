/**
 * Formatting settings, injected rather than read from the environment.
 *
 * `format.ts` is shared verbatim with the browser bundle, and `src/config.ts`
 * cannot run there — it validates `process.env` at import time and would abort
 * the bundle. So the three values the formatters need live here and are set
 * once at startup: from `config` on the server (see `src/i18n/index.ts`), from
 * the bootstrap payload in the SPA.
 *
 * The defaults are the Belgian production values, so a forgotten
 * `configureFormatting` call still renders correct amounts rather than
 * silently switching to US conventions — the failure mode that would be
 * hardest to notice.
 */

export interface FormatSettings {
  /** Locale for amounts and numeric dates. Never the UI language. */
  readonly formatLocale: string
  /** ISO 4217 code for `style: 'currency'`. */
  readonly currency: string
  /** IANA zone for absolute dates. */
  readonly timeZone: string
}

let current: FormatSettings = {
  formatLocale: 'nl-BE',
  currency: 'EUR',
  timeZone: 'Europe/Brussels',
}

/**
 * Bumped on every change so `format.ts` can key its `Intl` cache by it.
 * Cached formatters bake in the locale they were constructed with; without
 * this, reconfiguring would keep returning the old format.
 */
let revision = 0

export function configureFormatting(next: Partial<FormatSettings>): void {
  current = { ...current, ...next }
  revision += 1
}

export function formatSettings(): FormatSettings {
  return current
}

export function formatRevision(): number {
  return revision
}
