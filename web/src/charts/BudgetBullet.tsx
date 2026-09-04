/**
 * What was assigned to each envelope against what left it, and the norm behind both.
 *
 * A bullet chart rather than a pair of bars per category, because the question is not
 * "which is bigger" but "how far along this envelope is". So the assigned amount is
 * drawn as the track, the spend sits inside it at half the width, and the twelve-month
 * norm is a tick across both:
 *
 *  - spend short of the tick and short of the track — a quiet month
 *  - spend past the tick but inside the track — assigned generously, spending normally
 *  - spend past the track — overspent, whatever the norm says
 *
 * The tick is a scatter point with a rectangular symbol, for the reason `echarts.ts`
 * records: a bar cannot start anywhere but zero, and a `markLine` crosses every
 * category at once. A category with too little history to state a norm gets no tick
 * rather than a tick at zero, which would read as "you have never spent this".
 *
 * **Horizontal, and inverted.** Envelope names are words, and words on a vertical axis
 * need no rotation to be legible. `inverse` puts the first row at the top, because the
 * data arrives largest-first and a chart that silently flipped that order would have the
 * reader looking at the smallest envelope where they expected the biggest.
 */
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { useT } from '../i18n.ts'
import { formatMoney, formatMoneyCompact } from '../shared.ts'
import { Chart } from './Chart.tsx'
import type { EChartsCoreOption } from './echarts.ts'
import { privateText } from './tooltip.ts'

export interface BulletCategory {
  name: string
  spentCents: number
  assignedCents: number
  /** The EWMA norm, or null when there is not enough history to state one. */
  baselineCents: number | null
}

export interface BudgetBulletProps {
  categories: readonly BulletCategory[]
  height?: string
}

/** Row height. Two rem is a comfortable target on a phone and keeps the labels apart. */
const ROW_REM = 2.1
/**
 * The axis, the legend and the top and bottom padding around the rows.
 *
 * Sized for two rows of legend, because in Dutch that is what it takes. The three
 * labels run `Toegewezen`, `Uitgegeven` and `12-maandsgemiddelde` — 39 characters
 * against English's 26 — and at the width this card has on a phone ECharts wraps them
 * onto a second row. The space is reserved whether the wrap happens or not: ECharts
 * lays the legend out over the grid, not beside it, so a row that appears without
 * room for it lands on top of the axis labels.
 */
const CHROME_REM = 5.5
/** Matches `CHROME_REM`'s legend allowance, in the pixels `grid` is given in. */
const LEGEND_PX = 56

export function BudgetBullet({ categories, height }: BudgetBulletProps): ReactNode {
  const { t } = useT()

  const option = useMemo<EChartsCoreOption>(() => {
    const assigned = t('budget:metric.assigned')
    const spent = t('budget:metric.spent')
    const baseline = t('budget:metric.baseline')
    const names = categories.map((category) => category.name)

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value: unknown) =>
          typeof value === 'number' ? privateText(formatMoney(value, { whole: true })) : '',
      },
      legend: { data: [assigned, spent, baseline], bottom: 0 },
      grid: { left: 8, right: 16, top: 8, bottom: LEGEND_PX, containLabel: true },
      // No axis title: the card is already headed "budget versus actual" and every
      // label on this axis begins with a euro sign, so "Euro" underneath it would cost
      // a line of height to repeat what two other things on screen already say.
      xAxis: {
        type: 'value',
        axisLabel: { formatter: (value: number) => formatMoneyCompact(value) },
      },
      yAxis: {
        type: 'category',
        data: names,
        inverse: true,
        // Long envelope names are truncated rather than allowed to eat the plot: the
        // full name is in the tooltip and in the summary this chart is read out as.
        axisLabel: { width: 104, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          name: assigned,
          data: categories.map((category) => category.assignedCents),
          barWidth: 14,
          itemStyle: { opacity: 0.35 },
          z: 1,
        },
        {
          // `barGap: '-100%'` puts this bar in the same slot as the one above rather
          // than beside it. That overlap is what makes it a bullet chart.
          type: 'bar',
          name: spent,
          data: categories.map((category) => category.spentCents),
          barGap: '-100%',
          barWidth: 7,
          z: 2,
        },
        {
          type: 'scatter',
          name: baseline,
          symbol: 'rect',
          symbolSize: [3, 18],
          data: categories.flatMap((category) =>
            category.baselineCents === null ? [] : [[category.baselineCents, category.name]],
          ),
          z: 3,
        },
      ],
    }
  }, [categories, t])

  const money = (cents: number): string => formatMoney(cents, { whole: true })
  const summary = t('budget:chart.bulletSummary', {
    list: categories
      .map((category) =>
        t('budget:chart.bulletItem', {
          category: category.name,
          spent: money(category.spentCents),
          assigned: money(category.assignedCents),
        }),
      )
      .join('; '),
  })

  return (
    <Chart
      option={option}
      summary={summary}
      blurWhenPrivate
      height={height ?? `${categories.length * ROW_REM + CHROME_REM}rem`}
    />
  )
}
