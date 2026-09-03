/**
 * One figure, large, with the smaller figures it is made of underneath.
 *
 * Every value arrives already formatted, and that is deliberate for the same reason
 * `PageHeader` takes finished strings: a component that took cents and a catalogue
 * key would be a second formatting layer, and the first thing that goes wrong in a
 * second formatting layer is that it forgets `format.ts` and prints `1,234.56`.
 * `value: null` is the exception it does have to know about — "not known yet" is a
 * state, and the alternative is a page full of zeroes that read as facts.
 *
 * The breakdown is a `<dl>` rather than a table because it is label-and-value pairs
 * with no columns to align across rows, and `.num` on the values is what keeps the
 * digits in a straight line.
 */
import type { ReactNode } from 'react'

export type Tone = 'positive' | 'negative'

export interface MetricRow {
  label: string
  /** Already formatted. */
  value: string
  tone?: Tone
}

export interface MetricProps {
  label: string
  /** Already formatted, or null for "the jobs have not produced this yet". */
  value: string | null
  /** What null prints. Passed in, so the placeholder is translated by the page. */
  unknown: string
  /** One line under the figure: the month it covers, the date it was taken. */
  note?: string
  tone?: Tone
  rows?: readonly MetricRow[]
}

const toneClass = (tone: Tone | undefined): string =>
  tone === undefined ? '' : ` metric__value--${tone}`

export function Metric({ label, value, unknown, note, tone, rows }: MetricProps): ReactNode {
  const known = value !== null
  return (
    <div className="card metric">
      <h2 className="card__title">{label}</h2>
      <p className={`metric__value num${known ? toneClass(tone) : ' metric__value--unknown'}`}>
        {known ? value : unknown}
      </p>
      {note === undefined ? null : <p className="metric__note muted">{note}</p>}
      {rows === undefined || rows.length === 0 ? null : (
        <dl className="metric__rows">
          {rows.map((row) => (
            <div className="metric__row" key={row.label}>
              <dt>{row.label}</dt>
              <dd className={`num${toneClass(row.tone)}`}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
