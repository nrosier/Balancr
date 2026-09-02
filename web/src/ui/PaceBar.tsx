/**
 * Spending against the month, as one line.
 *
 * "Groceries is at 80% of its envelope" means nothing on its own — on the 28th it is
 * fine and on the 8th it is not. So the bar carries two things: how much of the
 * envelope is gone, and a tick where the month itself has got to. Spend to the left of
 * the tick is ahead of the calendar; to the right of it is behind.
 *
 * Not a chart, on purpose. This is two rectangles and a line, and an ECharts instance
 * per row — twelve observers, twelve SVG trees, twelve tooltips — would cost more than
 * the whole page for a shape CSS draws exactly.
 *
 * **The only arithmetic here is the width of a rectangle.** Every number printed
 * anywhere near this bar — the projection, the overrun, the month's progress — was
 * computed by `overspend.ts` and arrives on the wire, because a projection the browser
 * derived would drift from the sentence the server wrote about it. Percentages below
 * are geometry, and nothing reads them out.
 *
 * The widths are inline styles because they are data. `Chart.tsx` records why that is
 * safe under a CSP with no `'unsafe-inline'`: React assigns through `node.style`, which
 * is CSSOM, and CSP polices the `style` *attribute*.
 */
import type { ReactNode } from 'react'

export interface PaceBarProps {
  spentCents: number
  assignedCents: number
  /** How far through the month, in basis points, as the server measured it. */
  monthProgressBp: number
  /** What the bar says, in words. It has no text of its own. */
  label: string
}

const clampPercent = (fraction: number): number =>
  Math.min(100, Math.max(0, Math.round(fraction * 100)))

export function PaceBar({
  spentCents,
  assignedCents,
  monthProgressBp,
  label,
}: PaceBarProps): ReactNode {
  // Nothing assigned and something spent is not a division, it is a full bar: every
  // euro of it is over. Nothing spent is an empty one, whatever was assigned.
  const fraction =
    assignedCents > 0 ? spentCents / assignedCents : spentCents > 0 ? 1 : 0
  const spent = clampPercent(fraction)
  const over = fraction > 1

  return (
    <div className="pace__track" role="img" aria-label={label}>
      <div
        className={`pace__fill${over ? ' pace__fill--over' : ''}`}
        style={{ width: `${spent}%` }}
      />
      <div className="pace__mark" style={{ left: `${clampPercent(monthProgressBp / 10_000)}%` }} />
    </div>
  )
}
