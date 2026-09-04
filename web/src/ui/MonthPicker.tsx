/**
 * The month being viewed, and every month there is one.
 *
 * Shared by the budget page and the insights page, which is the whole point: both take
 * `?month=` on their endpoint and both offer `months` from the same `storedMonths`, so a
 * reader who picks August on one and switches pages should find the same list and the same
 * names. Two copies of this select drifted apart in exactly one way that mattered — one of
 * them prepending the month on screen and the other not — and that is the case the comment
 * below is about (#158).
 *
 * The month on screen is prepended when the server did not list it, which happens for
 * exactly one reason: it was asked for and never computed. Without that the select would
 * show a different month's name above that month's empty state.
 *
 * Renders nothing when there is only one month to choose between. A select with a single
 * option is a control that cannot do anything, and on a fresh deployment that is every
 * page — better an empty toolbar than a widget that looks broken.
 *
 * `id` is a prop rather than a constant because two pickers can be on screen at once in a
 * test file, and a duplicated `htmlFor` points the label at whichever came first.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatMonth } from '../shared.ts'

export interface MonthPickerProps {
  month: string
  months: readonly string[]
  onSelect: (month: string) => void
  /** The `id`/`htmlFor` pair, unique on the page. */
  id: string
  /** The label, already translated. Both pages say "Month"; neither hardcodes it here. */
  label: string
}

export function MonthPicker({ month, months, onSelect, id, label }: MonthPickerProps): ReactNode {
  const { language } = useT()
  const options = months.includes(month) ? months : [month, ...months]

  if (options.length < 2) return null

  return (
    <div className="field field--inline">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field__input"
        value={month}
        onChange={(event) => onSelect(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {formatMonth(option, language)}
          </option>
        ))}
      </select>
    </div>
  )
}
