/**
 * Net worth over time, and the one thing about it that is easy to get wrong.
 *
 * The plan calls the chart formatters "the most commonly missed spot", and it is
 * right: ECharts writes its own axis labels and tooltips, so a chart that does not
 * call `format.ts` renders `48200` next to a card that says `€ 48.200` — on the same
 * screen, from the same number. Every string this option produces goes through the
 * shared formatters, which is why the series carries **cents** all the way in and the
 * conversion happens only at the point of printing.
 *
 * Two smaller decisions, both about a year of daily snapshots:
 *
 *  - **The category values are the formatted dates**, not the ISO ones. The tooltip
 *    header is the axis value verbatim, so making the value `31/08/2026` is what gets
 *    a Belgian date into the tooltip without a custom formatter — and category values
 *    have to be unique, which formatted days are.
 *  - **One axis label per month.** Three hundred labels reading "Aug Aug Aug" is
 *    worse than none, so a label is emitted only where the month changes and every
 *    other position is an empty string. `interval: 0` is required for that: the
 *    default skips positions rather than asking, and would drop exactly the ones
 *    carrying the text.
 *
 * The y axis keeps ECharts' default zero baseline. For money that is the honest
 * choice — a 45k–50k range on a 45k baseline makes a 10% year look like a doubling.
 */
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { useT } from '../i18n.ts'
import { formatDate, formatMoney, formatMoneyCompact, formatMonthShort } from '../shared.ts'
import { Chart } from './Chart.tsx'
import type { EChartsCoreOption } from './echarts.ts'

export interface NetWorthPoint {
  date: string
  totalCents: number
}

export interface NetWorthChartProps {
  history: readonly NetWorthPoint[]
  height?: string
}

/** A month label where the month changes, an empty string everywhere else. */
function monthLabels(history: readonly NetWorthPoint[], language: string): string[] {
  return history.map((point, index) => {
    const month = point.date.slice(0, 7)
    const previous = index === 0 ? null : (history[index - 1]?.date.slice(0, 7) ?? null)
    return month === previous ? '' : formatMonthShort(month, language)
  })
}

export function NetWorthChart({ history, height }: NetWorthChartProps): ReactNode {
  const { t, language } = useT()

  const option = useMemo<EChartsCoreOption>(() => {
    const labels = monthLabels(history, language)
    return {
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value: unknown) =>
          typeof value === 'number' ? formatMoney(value, { whole: true }) : '',
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: history.map((point) => formatDate(point.date)),
        axisLabel: {
          interval: 0,
          formatter: (_value: string, index: number) => labels[index] ?? '',
        },
      },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: (value: number) => formatMoneyCompact(value) },
      },
      series: [
        {
          type: 'line',
          name: t('portfolio:metric.netWorth'),
          data: history.map((point) => point.totalCents),
          // Symbols on a year of daily points are a solid band; on a handful of
          // monthly ones they are the only thing that shows where the data is.
          showSymbol: history.length <= 24,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.12 },
        },
      ],
    }
    // `language` is not read in the body beyond the labels; it is a dependency because
    // every month name above changes with it.
  }, [history, language, t])

  const first = history[0]
  const last = history[history.length - 1]
  const summary =
    first === undefined || last === undefined
      ? t('empty.noData')
      : t('portfolio:chart.netWorthSummary', {
          from: formatDate(first.date),
          to: formatDate(last.date),
          start: formatMoney(first.totalCents, { whole: true }),
          end: formatMoney(last.totalCents, { whole: true }),
        })

  return <Chart option={option} summary={summary} {...(height === undefined ? {} : { height })} />
}
