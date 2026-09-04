/**
 * One envelope's last twelve months, small enough to put twelve of them on a screen.
 *
 * Two decisions carry the whole design of the wall these sit in.
 *
 * **Each chart scales to itself.** The textbook rule for small multiples is a shared
 * axis, and it is the right rule when the panels are comparable quantities. Here they
 * are not: rent is thirty times groceries, so a shared maximum would draw ten flat
 * lines along the bottom and one real chart. What the reader needs from this wall is
 * *shape* — is this envelope drifting up — and the magnitudes are already compared, on
 * one shared axis, by the bullet chart directly above it. To keep the height from being
 * misread as an amount, the card prints its own figure beside the line rather than
 * relying on an axis nobody can see.
 *
 * **The norm is drawn through it, not beside it.** A dashed line at the twelve-month
 * EWMA turns "€ 380" into "€ 380, which is high for you", and the window is twelve
 * months precisely so the line and the average describe the same period — see
 * `TREND_MONTHS` in the budget route.
 *
 * The axis shows the first and last month and nothing between: twelve labels do not fit
 * in fourteen rem, and an axis that drops labels by ECharts' own interval arithmetic
 * drops whichever ones it likes rather than the two that anchor the window.
 */
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { useT } from '../i18n.ts'
import { formatMonth, formatMonthShort, formatMoney, formatMoneyCompact } from '../shared.ts'
import { Chart } from './Chart.tsx'
import type { EChartsCoreOption } from './echarts.ts'
import { privateText } from './tooltip.ts'

export interface CategoryTrendProps {
  name: string
  /** The window, oldest first. Every category on the page shares it. */
  months: readonly string[]
  /** Spend per month, aligned to `months` and the same length. */
  series: readonly number[]
  baselineCents: number | null
  height?: string
}

export function CategoryTrend({
  name,
  months,
  series,
  baselineCents,
  height,
}: CategoryTrendProps): ReactNode {
  const { t, language } = useT()

  const option = useMemo<EChartsCoreOption>(() => {
    const last = months.length - 1
    return {
      // Almost no padding: this is a sparkline, and `containLabel` plus the theme's
      // eight-pixel grid would spend a third of the height on white space.
      grid: { left: 2, right: 2, top: 8, bottom: 18, containLabel: true },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value: unknown) =>
          typeof value === 'number' ? privateText(formatMoney(value, { whole: true })) : '',
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        // The formatted month is the value, so the tooltip header reads "August 2026"
        // with no formatter of its own — the same trick `NetWorthChart` uses.
        data: months.map((month) => formatMonth(month, language)),
        axisLabel: {
          interval: (index: number) => index === 0 || index === last,
          formatter: (_value: string, index: number) => {
            const month = months[index]
            return month === undefined ? '' : formatMonthShort(month, language)
          },
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        // Two ticks: enough to tell a scale from no scale, few enough to stay out of
        // the way. Compact, because "€ 1,2k" fits where "€ 1.200" does not.
        splitNumber: 2,
        axisLabel: { formatter: (value: number) => formatMoneyCompact(value), showMinLabel: false },
      },
      series: [
        {
          type: 'line',
          name,
          data: [...series],
          showSymbol: false,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.12 },
          ...(baselineCents === null
            ? {}
            : {
                markLine: {
                  // Silent, symbol-less and unlabelled: it is a reference, and a
                  // reference that answers the mouse steals the tooltip from the data.
                  silent: true,
                  symbol: 'none',
                  label: { show: false },
                  lineStyle: { type: 'dashed', width: 1 },
                  data: [{ yAxis: baselineCents }],
                },
              }),
        },
      ],
    }
  }, [baselineCents, language, months, name, series])

  const latestMonth = months[months.length - 1]
  const latestCents = series[series.length - 1]
  const money = (cents: number): string => formatMoney(cents, { whole: true })

  const summary =
    latestMonth === undefined || latestCents === undefined
      ? t('empty.noData')
      : baselineCents === null
        ? t('budget:chart.trendSummaryPlain', {
            category: name,
            amount: money(latestCents),
            month: formatMonth(latestMonth, language),
          })
        : t('budget:chart.trendSummary', {
            category: name,
            amount: money(latestCents),
            month: formatMonth(latestMonth, language),
            baseline: money(baselineCents),
          })

  return <Chart option={option} summary={summary} blurWhenPrivate height={height ?? '6rem'} />
}
