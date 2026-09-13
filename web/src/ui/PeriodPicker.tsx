/**
 * A calendar-backed Month/Year chooser, for the two cards that let a reader widen or
 * narrow a window rather than only step through one (#337).
 *
 * Deliberately not a third "period" concept. `PeriodKind` is `BenchmarkPeriodKind`
 * itself, not a lookalike redeclared here — the same reason `BENCHMARK_PERIODS` is
 * defined once and re-exported rather than copied per consumer. `Period`'s `value` is
 * always `YYYY` when `kind === 'year'` and `YYYY-MM` when `kind === 'month'`, which is
 * the same pair of shapes `endOfMonth`/plain year slicing already read on the server —
 * nothing here invents a third string format for a month or a year.
 *
 * `react-multi-date-picker` ships no stylesheet of its own; `period-picker.css` paints
 * its structural classes from the app's own tokens, in both themes.
 */
import { useId, useMemo, type ReactNode } from 'react'
import RawDatePicker, { type DateObject } from 'react-multi-date-picker'
import { useT } from '../i18n.ts'
import { BENCHMARK_PERIODS, type BenchmarkPeriodKind } from '../shared.ts'
import './period-picker.css'

/**
 * `react-multi-date-picker` ships CJS only, with a `DateObject` export written as an
 * `Object.defineProperty` getter rather than a plain assignment. That defeats esbuild's
 * static named-export scan, so Vite's dependency optimizer falls back to a default-only
 * reexport and hands the *whole* CJS module object here instead of the component —
 * recognisable by its own nested `default` key, which the real component (a
 * `forwardRef` object) never has. Vitest's transform does not hit this fallback, so the
 * import already arrives correct there; unwrapping is a no-op in that environment.
 */
const DatePicker =
  RawDatePicker !== null &&
  typeof RawDatePicker === 'object' &&
  'default' in RawDatePicker
    ? (RawDatePicker as unknown as { default: typeof RawDatePicker }).default
    : RawDatePicker

export type PeriodKind = BenchmarkPeriodKind

export type Period = { kind: 'month'; value: string } | { kind: 'year'; value: string }

export interface PeriodPickerProps {
  period: Period
  onSelect: (period: Period) => void
  /** The `id`/`htmlFor` pair, unique on the page. */
  id: string
  /** The label, already translated. */
  label: string
  /** Text for the two toggle buttons — the caller's own keys, so a switch here orphans
   *  no string a caller already translated for its own native `<select>`. */
  kindLabel: (kind: PeriodKind) => string
}

const FORMAT: Record<PeriodKind, string> = { month: 'YYYY-MM', year: 'YYYY' }

/**
 * The same value in the other kind's shape.
 *
 * Year to month keeps the reader on the month they are already looking at when the
 * year matches today's, and lands on January otherwise — a "12 months ago" jump would
 * be a stranger default than the first month of whatever year they just picked.
 */
function switchKind(period: Period, kind: PeriodKind): Period {
  if (period.kind === kind) return period
  if (kind === 'year') return { kind: 'year', value: period.value.slice(0, 4) }
  const now = new Date()
  const month =
    period.value === String(now.getFullYear())
      ? String(now.getMonth() + 1).padStart(2, '0')
      : '01'
  return { kind: 'month', value: `${period.value}-${month}` }
}

export function PeriodPicker({ period, onSelect, id, label, kindLabel }: PeriodPickerProps): ReactNode {
  const { language } = useT()
  const toggleId = useId()

  // Bare month names, shared across every year — `formatMonth` always prints a year
  // alongside the month and so is not reusable for the calendar's own 12-name list.
  const monthNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(language, { month: 'long' })
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)))
  }, [language])

  return (
    <div className="field field--inline period-picker">
      <span className="field__label" id={toggleId}>
        {label}
      </span>
      <div className="period-picker__toggle" role="group" aria-labelledby={toggleId}>
        {BENCHMARK_PERIODS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="period-picker__toggle-btn"
            aria-pressed={period.kind === kind}
            onClick={() => onSelect(switchKind(period, kind))}
          >
            {kindLabel(kind)}
          </button>
        ))}
      </div>
      <DatePicker
        id={id}
        value={period.value}
        onlyMonthPicker={period.kind === 'month'}
        onlyYearPicker={period.kind === 'year'}
        format={FORMAT[period.kind]}
        months={monthNames}
        inputClass="field__input period-picker__input"
        containerClassName="period-picker__container"
        onChange={(date: DateObject | null) => {
          if (date === null) return
          onSelect({ kind: period.kind, value: date.format(FORMAT[period.kind]) })
        }}
      />
    </div>
  )
}
