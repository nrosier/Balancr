/**
 * The single entry point for rendering numbers, money and dates.
 *
 * Language and formatting are deliberately separate concerns:
 *
 *  - **Amounts and numeric dates** use `FORMAT_LOCALE` (nl-BE) in EVERY UI
 *    language. This is not belt-and-braces: `Intl` with `en-BE` produces
 *    `€1,234.56` — English conventions despite the Belgian region — so deriving
 *    money format from the UI language would silently render amounts that no
 *    longer match the user's bank and broker statements.
 *  - **Month and weekday names** follow the UI language, via `<lang>-BE`, so
 *    they translate while keeping Belgian conventions (week starts Monday).
 *
 * Chart axis and tooltip formatters must call these too — that is the spot
 * where locale handling is usually forgotten.
 */
import { formatRevision, formatSettings } from './format-config.ts'

/** UI language code, e.g. `en` or `nl`. Not a full locale. */
export type UiLanguage = string

/** Language for names, region pinned to Belgium for calendar conventions. */
function namesLocale(lang: UiLanguage): string {
  return lang.includes('-') ? lang : `${lang}-BE`
}

// Intl formatters are expensive to construct; cache per distinct signature.
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>()
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat>(
  key: string,
  make: () => T,
): T {
  const versioned = `${formatRevision()}:${key}`
  const hit = cache.get(versioned)
  if (hit) return hit as T
  const made = make()
  cache.set(versioned, made)
  return made
}

// ---------------------------------------------------------------------------
//  Money — always integer cents in, never a float
// ---------------------------------------------------------------------------

export interface MoneyOptions {
  /** Drop the currency symbol. For chart axes, where the unit is in the title. */
  bare?: boolean
  /** Round to whole units. Cents are noise on a net-worth axis. */
  whole?: boolean
  /** Force a leading `+` on positives, for deltas. */
  signed?: boolean
}

export function formatMoney(cents: number, options: MoneyOptions = {}): string {
  const { bare = false, whole = false, signed = false } = options
  const fmt = cached(`money:${bare}:${whole}`, () =>
    new Intl.NumberFormat(formatSettings().formatLocale, {
      ...(bare
        ? { style: 'decimal' as const }
        : { style: 'currency' as const, currency: formatSettings().currency }),
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }),
  ) as Intl.NumberFormat

  const value = cents / 100
  const out = fmt.format(whole ? Math.round(value) : value)
  return signed && cents > 0 ? `+${out}` : out
}

/** Compact form for dense labels: `€ 12,3k`, `€ 1,2M`. */
export function formatMoneyCompact(cents: number): string {
  const fmt = cached('money:compact', () =>
    new Intl.NumberFormat(formatSettings().formatLocale, {
      style: 'currency',
      currency: formatSettings().currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }),
  ) as Intl.NumberFormat
  return fmt.format(cents / 100)
}

/**
 * Parses user-typed amounts to integer cents, accepting both Belgian
 * (`1.234,56`) and plain (`1234.56`) input. Returns null on anything
 * unparseable — never a silent 0, and never `parseFloat`, which turns
 * "1.234,56" into 1.234 (i.e. 123 cents instead of 123456).
 */
export function parseMoneyToCents(raw: string): number | null {
  const stripped = raw.replace(/[\s  €]/g, '')
  if (!stripped) return null

  const negative = stripped.startsWith('-') || /^\(.*\)$/.test(stripped)
  const digitsOnly = stripped.replace(/[-()]/g, '')
  if (!/^[\d.,]+$/.test(digitsOnly)) return null

  const lastComma = digitsOnly.lastIndexOf(',')
  const lastDot = digitsOnly.lastIndexOf('.')
  const sepIndex = Math.max(lastComma, lastDot)

  let normalised: string
  if (sepIndex === -1) {
    normalised = digitsOnly
  } else {
    const tail = digitsOnly.slice(sepIndex + 1)
    // Three trailing digits means a thousands separator (Belgian `1.234`),
    // one or two means a decimal separator (`1,50`).
    const isDecimal = tail.length > 0 && tail.length <= 2
    if (isDecimal) {
      const head = digitsOnly.slice(0, sepIndex).replace(/[.,]/g, '')
      normalised = `${head}.${tail}`
    } else {
      if (!/^\d{3}$/.test(tail)) return null
      normalised = digitsOnly.replace(/[.,]/g, '')
    }
  }

  const value = Number(normalised)
  if (!Number.isFinite(value)) return null
  return Math.round(value * 100) * (negative ? -1 : 1)
}

// ---------------------------------------------------------------------------
//  Plain numbers
// ---------------------------------------------------------------------------

/**
 * A count or a quantity, Belgian conventions: `1.234`, `2,4`.
 *
 * Exists because `i18next` interpolates a raw number with `String(value)`, which
 * writes `2.4 months` in a UI that spells every other number `2,4`. The
 * interpolation hook in `i18n/index.ts` routes numeric variables through here, so
 * a decimal separator cannot depend on which layer happened to render it.
 */
export function formatDecimal(value: number, maxFractionDigits = 1): string {
  const fmt = cached(`decimal:${maxFractionDigits}`, () =>
    new Intl.NumberFormat(formatSettings().formatLocale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFractionDigits,
    }),
  ) as Intl.NumberFormat
  return fmt.format(value)
}

/** Interpolation variables for a catalogue key. */
export type Vars = Record<string, string | number>

/**
 * Supplies `{{value}}` for a pluralised key, formatted the Belgian way.
 *
 * `count` has to stay a number — it is what selects `_one` from `_other` — and
 * i18next writes an interpolated number with `String(value)`, so a catalogue
 * printing `{{count}}` renders `2.4 months` in a UI that spells every other number
 * `2,4`. Hence the split: `count` selects the form, `{{value}}` is what the sentence
 * prints. `scripts/check-i18n.ts` fails a plural key that reaches for `{{count}}`
 * instead.
 *
 * It lives here, next to the formatter it calls, because the server and the browser
 * both have to apply it — `web/src/i18n.ts` wires this same function into
 * react-i18next. A second copy on the browser side is how one screen ends up
 * spelling a number the other way.
 *
 * Not done through `interpolation.format`, which looks like the obvious place and is
 * not: i18next installs its own formatter during `init` and overwrites that option,
 * so a hook there is silently discarded.
 */
export function withFormattedCount(vars: Vars): Vars {
  if (typeof vars['count'] !== 'number' || vars['value'] !== undefined) return vars
  return { ...vars, value: formatDecimal(vars['count']) }
}

// ---------------------------------------------------------------------------
//  Percentages — stored as basis points, so no float drift in the database
// ---------------------------------------------------------------------------

export function formatBp(bp: number, options: { signed?: boolean } = {}): string {
  const fmt = cached('pct', () =>
    new Intl.NumberFormat(formatSettings().formatLocale, {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }),
  ) as Intl.NumberFormat
  const out = fmt.format(bp / 10_000)
  return options.signed && bp > 0 ? `+${out}` : out
}

// ---------------------------------------------------------------------------
//  Dates
// ---------------------------------------------------------------------------

/**
 * `dd/MM/yyyy`. Built from explicit parts rather than `dateStyle: 'short'`,
 * which yields a two-digit year under some locales.
 */
export function formatDate(iso: string): string {
  const fmt = cached('date:numeric', () =>
    new Intl.DateTimeFormat(formatSettings().formatLocale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: formatSettings().timeZone,
    }),
  ) as Intl.DateTimeFormat
  return fmt.format(parseIsoDate(iso))
}

/**
 * `dd/MM/yyyy, HH:mm` for a full timestamp — the separator `Intl` chooses for nl-BE.
 *
 * Separate from `formatDate`, which takes a `YYYY-MM-DD` day and would throw on a
 * timestamp — `parseIsoDate` appends its own `T00:00:00Z`. The caller that needs the
 * hour is the freshness note: "updated 02/09/2026" for something that last ran eight
 * hours ago reads as this morning's figure, and the difference between a sync that
 * ran at breakfast and one that stopped at midnight is the whole point of showing it.
 */
export function formatDateTime(iso: string): string {
  const fmt = cached('datetime', () =>
    new Intl.DateTimeFormat(formatSettings().formatLocale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: formatSettings().timeZone,
    }),
  ) as Intl.DateTimeFormat
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) throw new Error(`invalid timestamp: ${iso}`)
  return fmt.format(at)
}

/** `March 2026` / `maart 2026` — the name translates, the order does not. */
export function formatMonth(month: string, lang: UiLanguage): string {
  const fmt = cached(`month:long:${lang}`, () =>
    new Intl.DateTimeFormat(namesLocale(lang), {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  ) as Intl.DateTimeFormat
  return fmt.format(parseIsoDate(`${month}-01`))
}

/** `Mar` / `mrt` — for dense chart axes. */
export function formatMonthShort(month: string, lang: UiLanguage): string {
  const fmt = cached(`month:short:${lang}`, () =>
    new Intl.DateTimeFormat(namesLocale(lang), { month: 'short', timeZone: 'UTC' }),
  ) as Intl.DateTimeFormat
  return fmt.format(parseIsoDate(`${month}-01`))
}

/** Belgium starts the week on Monday; charts and calendars must agree. */
export function firstDayOfWeek(lang: UiLanguage): number {
  // getWeekInfo is not in the bundled Intl types yet; absent in older runtimes.
  const locale = new Intl.Locale(namesLocale(lang)) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number }
  }
  return locale.getWeekInfo?.().firstDay ?? 1
}

function parseIsoDate(iso: string): Date {
  // Explicit UTC midnight: a bare `new Date('2026-03-01')` is UTC but
  // `new Date('2026-3-1')` is local, and mixing them shifts month labels.
  const date = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${iso}`)
  return date
}
