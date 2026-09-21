/**
 * A compact Month/Year chooser, replacing the calendar-library version this file used
 * to wrap (#345). One trigger button and a small popover: a sliding Month/Year pill
 * switch, a prev/next nav row, and a 4×3 grid of either months or years — ported from
 * the approved mockup rather than from any existing control in this codebase.
 *
 * `Period`'s `value` is always `YYYY` when `kind === 'year'` and `YYYY-MM` when
 * `kind === 'month'`, the same pair of shapes `endOfMonth`/plain year slicing already
 * read on the server — nothing here invents a third string format for a month or a
 * year.
 *
 * `availableMonths` greys out *and* disables a cell with no data, per #345's own text —
 * stricter than every native `<select>`-based picker in this app, which never disables
 * an option, but a deliberate difference for a grid where "nothing here" needs to be
 * seen without being clicked into.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatMonth } from '../shared.ts'
import './period-picker.css'

export type PeriodKind = 'month' | 'year'

export type Period = { kind: 'month'; value: string } | { kind: 'year'; value: string }

export interface PeriodPickerProps {
  period: Period
  onSelect: (period: Period) => void
  /** The accessible name for the trigger and the popover — there is no visible label. */
  id: string
  label: string
  /** Text for the two mode-switch buttons — the caller's own keys, so a switch here
   *  orphans no string a caller already translated for its own native `<select>`. */
  kindLabel: (kind: PeriodKind) => string
  /**
   * `YYYY-MM` keys with data — greys out and disables every other cell.
   *
   * Optional so this stays the drop-in replacement the build order asks for (#345):
   * existing callers built against the pre-rebuild props keep compiling with every
   * cell enabled, until each is wired to its own real availability set.
   */
  availableMonths?: ReadonlySet<string>
}

const KINDS: readonly PeriodKind[] = ['month', 'year']

/** How many cells the grid always has, months or years alike. */
const GRID_SIZE = 12

/**
 * The same value in the other kind's shape.
 *
 * Year to month keeps the reader on the month they are already looking at when the
 * year matches today's, and lands on January otherwise — a "12 months ago" jump would
 * be a stranger default than the first month of whatever year they just picked.
 */
export function switchKind(period: Period, kind: PeriodKind): Period {
  if (period.kind === kind) return period
  if (kind === 'year') return { kind: 'year', value: period.value.slice(0, 4) }
  const now = new Date()
  const month =
    period.value === String(now.getFullYear())
      ? String(now.getMonth() + 1).padStart(2, '0')
      : '01'
  return { kind: 'month', value: `${period.value}-${month}` }
}

export function PeriodPicker({
  period,
  onSelect,
  id,
  label,
  kindLabel,
  availableMonths,
}: PeriodPickerProps): ReactNode {
  const { t, language } = useT()
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverId = useId()

  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<PeriodKind>(period.kind)
  const [focusYear, setFocusYear] = useState(() => Number(period.value.slice(0, 4)))
  const [decadeStart, setDecadeStart] = useState(
    () => Math.floor(Number(period.value.slice(0, 4)) / GRID_SIZE) * GRID_SIZE,
  )

  // Bare, abbreviated month names shared across every year — `formatMonth` always
  // prints a year alongside the month and so is not reusable for the grid's own list.
  const monthNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(language, { month: 'short' })
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)))
  }, [language])

  const availableYears = useMemo(
    () =>
      availableMonths === undefined
        ? null
        : new Set(Array.from(availableMonths, (month) => month.slice(0, 4))),
    [availableMonths],
  )

  function openPopover(): void {
    setMode(period.kind)
    const year = Number(period.value.slice(0, 4))
    setFocusYear(year)
    setDecadeStart(Math.floor(year / GRID_SIZE) * GRID_SIZE)
    setOpen(true)
  }

  function closePopover(returnFocus: boolean): void {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  // Dismiss on outside click or Escape — no existing precedent in this codebase to
  // copy, designed fresh for this popover.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        closePopover(false)
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closePopover(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function select(next: Period): void {
    onSelect(next)
    closePopover(false)
  }

  function step(delta: number): void {
    if (mode === 'month') setFocusYear((year) => year + delta)
    else setDecadeStart((start) => start + delta * GRID_SIZE)
  }

  const now = new Date()
  const todayYear = now.getFullYear()
  const todayMonth = now.getMonth() + 1

  const value = period.kind === 'year' ? period.value : formatMonth(period.value, language)

  return (
    <span className="period-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="period-picker__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={label}
        onClick={() => (open ? closePopover(false) : openPopover())}
      >
        <svg className="period-picker__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <rect x="2.5" y="4" width="15" height="13.5" rx="1.5" />
          <path d="M2.5 8h15M6.5 2.5v3.5M13.5 2.5v3.5" />
        </svg>
        <span className="period-picker__value">{value}</span>
        <svg className="period-picker__chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M5 7.5 10 13l5-5.5" />
        </svg>
      </button>

      {open ? (
        <div id={popoverId} className="period-picker__popover" role="dialog" aria-label={label}>
          <div className={`period-picker__mode${mode === 'year' ? ' is-year' : ''}`}>
            <span className="period-picker__mode-thumb" />
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`period-picker__mode-btn${mode === kind ? ' active' : ''}`}
                onClick={() => {
                  setMode(kind)
                  onSelect(switchKind(period, kind))
                  if (kind === 'year') setDecadeStart(Math.floor(focusYear / GRID_SIZE) * GRID_SIZE)
                }}
              >
                {kindLabel(kind)}
              </button>
            ))}
          </div>

          <div className="period-picker__nav">
            <button
              type="button"
              className="period-picker__nav-btn"
              aria-label={t('periodPicker.previous')}
              onClick={() => step(-1)}
            >
              ‹
            </button>
            <span className="period-picker__nav-label">
              {mode === 'month' ? focusYear : `${decadeStart}–${decadeStart + GRID_SIZE - 1}`}
            </span>
            <button
              type="button"
              className="period-picker__nav-btn"
              aria-label={t('periodPicker.next')}
              onClick={() => step(1)}
            >
              ›
            </button>
          </div>

          <div className="period-picker__grid">
            {mode === 'month'
              ? Array.from({ length: 12 }, (_, i) => {
                  const m = i + 1
                  const key = `${focusYear}-${String(m).padStart(2, '0')}`
                  const disabled = availableMonths !== undefined && !availableMonths.has(key)
                  const isToday = focusYear === todayYear && m === todayMonth
                  const isSelected = period.kind === 'month' && period.value === key
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={disabled}
                      className={`period-picker__cell${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}${disabled ? ' is-outside' : ''}`}
                      onClick={() => select({ kind: 'month', value: key })}
                    >
                      {monthNames[i]}
                    </button>
                  )
                })
              : Array.from({ length: GRID_SIZE }, (_, i) => {
                  const y = decadeStart + i
                  const key = String(y)
                  const disabled = availableYears !== null && !availableYears.has(key)
                  const isToday = y === todayYear
                  const isSelected = period.kind === 'year' && period.value === key
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={disabled}
                      className={`period-picker__cell${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}${disabled ? ' is-outside' : ''}`}
                      onClick={() => select({ kind: 'year', value: key })}
                    >
                      {key}
                    </button>
                  )
                })}
          </div>
        </div>
      ) : null}
    </span>
  )
}
