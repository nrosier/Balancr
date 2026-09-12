/**
 * Two paths, not one — the as-is contribution and the change being tested, run through
 * the same compounding math from the same starting point (#51).
 *
 * Not a `NetWorthChart` prop addition: that chart's own doc comment is built around a
 * single series and formatters that assume one value per point. A second series changes
 * the tooltip's shape (one row per series, plus the delta between them) and the x axis'
 * meaning (months from now, not calendar dates) enough that forcing both into one
 * component would mean branching most of its body on which mode it is in.
 *
 * The x axis labels every twelfth month rather than every month — `projectScenario` can
 * run for up to `MAX_HORIZON_MONTHS` (30 years), and 360 tick labels would be as
 * unreadable as `NetWorthChart`'s "Aug Aug Aug" problem it already solved once.
 *
 * All three props that reach the DOM as text — the two series names and the delta
 * label — arrive pre-translated, same contract as `NetWorthChart`'s `name`: this file
 * never calls `t()` itself, so nothing here can drift from the catalogue that owns the
 * words.
 */
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { formatMoney, formatMoneyCompact, type ScenarioMonth } from '../shared.ts'
import { Chart } from './Chart.tsx'
import type { EChartsCoreOption } from './echarts.ts'
import { privateText, tooltipAxis, tooltipRow, tooltipSeriesRow } from './tooltip.ts'

interface AxisTooltipPoint {
  marker?: string
  seriesName?: string
  axisValueLabel?: string
  dataIndex?: number
  value?: unknown
}

export interface ScenarioChartProps {
  months: readonly ScenarioMonth[]
  baselineName: string
  scenarioName: string
  deltaLabel: string
  /** Spoken-text accessibility fallback — see `Chart`'s own doc comment. */
  summary: string
  height?: string
}

/** A year label at month 12, 24, 36…, an empty string everywhere else. */
function yearLabels(months: readonly ScenarioMonth[]): string[] {
  return months.map((month) => (month.month % 12 === 0 ? String(month.month / 12) : ''))
}

export function ScenarioChart({
  months,
  baselineName,
  scenarioName,
  deltaLabel,
  summary,
  height,
}: ScenarioChartProps): ReactNode {
  const option = useMemo<EChartsCoreOption>(() => {
    const labels = yearLabels(months)
    return {
      tooltip: {
        trigger: 'axis',
        // A full `formatter`, not `valueFormatter` — see `NetWorthChart`'s identical
        // comment for why: `valueFormatter` escapes `privateText`'s markup instead of
        // rendering it.
        formatter: (params: unknown) => {
          const points = (Array.isArray(params) ? params : [params]) as AxisTooltipPoint[]
          const header = points[0]?.axisValueLabel ?? ''
          const rows = points.map((point) => {
            const cents = typeof point.value === 'number' ? point.value : 0
            return tooltipSeriesRow(
              point.marker ?? '',
              point.seriesName ?? '',
              privateText(formatMoney(cents, { whole: true })),
            )
          })
          const dataIndex = points[0]?.dataIndex
          const month = dataIndex === undefined ? undefined : months[dataIndex]
          if (month !== undefined) {
            rows.push(
              tooltipRow(deltaLabel, privateText(formatMoney(month.deltaCents, { whole: true, signed: true }))),
            )
          }
          return tooltipAxis(header, rows)
        },
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: months.map((month) => String(month.month)),
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
          name: baselineName,
          data: months.map((month) => month.baselineValueCents),
          showSymbol: false,
          lineStyle: { width: 2, type: 'dashed' },
        },
        {
          type: 'line',
          name: scenarioName,
          data: months.map((month) => month.scenarioValueCents),
          showSymbol: false,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.12 },
        },
      ],
    }
  }, [months, baselineName, scenarioName, deltaLabel])

  return (
    <Chart option={option} summary={summary} blurWhenPrivate {...(height === undefined ? {} : { height })} />
  )
}
