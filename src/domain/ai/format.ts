/**
 * Cents/basis-points → the display string an AI payload actually carries.
 *
 * `redact.ts` sends amounts and percentages as strings, not integers, so the model
 * never has to convert one itself — see #476/#478. This module exists apart from
 * `i18n/format.ts` on purpose: that module's formatters read a mutable
 * `formatSettings()` singleton, which would make `redact()`'s output depend on
 * global state at call time and break its documented purity (every call with the
 * same `AnalysisBundle` must produce the same payload). These take `currency` and
 * `formatLocale` as explicit arguments instead, both already carried on
 * `AnalysisBundle`.
 *
 * Two fraction digits throughout, matching the currency convention and giving a
 * percentage one digit more than the UI's own `formatBp` default — deliberately:
 * the model quoting an extra digit of precision it received is harmless, and it is
 * simpler than threading a second precision decision through the payload.
 */

export function formatCentsAsCurrency(cents: number, currency: string, formatLocale: string): string {
  return new Intl.NumberFormat(formatLocale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

export function formatBpAsPercent(bp: number, formatLocale: string): string {
  return new Intl.NumberFormat(formatLocale, {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(bp / 10_000)
}

export function formatBpAsPercentOrNull(bp: number | null, formatLocale: string): string | null {
  return bp === null ? null : formatBpAsPercent(bp, formatLocale)
}
