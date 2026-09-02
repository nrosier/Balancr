/**
 * Where the money is invested, by share of the portfolio.
 *
 * A treemap rather than a pie, for the reason the plan gives: a portfolio has a long
 * tail, and a pie with eleven slices is a colour-matching exercise. Area is read
 * without a legend, the labels sit inside the boxes, and the smallest slice stays
 * visible instead of becoming a sliver.
 *
 * **Nothing here computes a share.** `shareBp` arrives in basis points from
 * `portfolio_metrics`, and the value the treemap lays out is the amount in cents, so
 * the geometry and the printed percentage come from two figures the aggregation pass
 * produced together. Deriving the percentage from the cents would be a second answer
 * to the same question, and the one on screen would be the one nobody checked.
 *
 * The asset-class labels come from the catalogue where Balancr has a word for the
 * class and fall back to the provider's own key where it does not. That fallback is
 * deliberate: Ghostfolio can introduce a class at any time, and showing `PRIVATE_EQUITY`
 * is honest in a way that showing "Other" is not — one is untranslated, the other is
 * wrong.
 */
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { useT, type TFunction } from '../i18n.ts'
import { formatBp, formatMoney, type Portfolio } from '../shared.ts'
import { Chart } from './Chart.tsx'
import type { EChartsCoreOption } from './echarts.ts'
import { tooltipRow } from './tooltip.ts'

export type AllocationSlice = Portfolio['allocation'][number]

export interface AllocationChartProps {
  allocation: readonly AllocationSlice[]
  height?: string
}

/**
 * The catalogue's word for an asset class, or the provider's key.
 *
 * `t` is asked for a key that may not exist, which is why `defaultValue` is passed
 * explicitly rather than relying on i18next's key-as-fallback: the raw key would
 * otherwise print as `assetClass.PRIVATE_EQUITY`.
 */
export function assetClassLabel(t: TFunction, key: string): string {
  return t(`portfolio:assetClass.${key}`, { defaultValue: key })
}

export function AllocationChart({ allocation, height }: AllocationChartProps): ReactNode {
  const { t } = useT()

  const option = useMemo<EChartsCoreOption>(() => {
    const data = allocation.map((slice) => ({
      name: assetClassLabel(t, slice.assetClass),
      value: slice.valueCents,
      // Carried on the datum so the tooltip prints the share the pass computed
      // rather than one derived from the areas ECharts laid out.
      shareBp: slice.shareBp,
    }))

    return {
      tooltip: {
        formatter: (params: unknown) => {
          const datum = params as { name?: string; value?: number; data?: { shareBp?: number } }
          const share = datum.data?.shareBp
          const value = typeof datum.value === 'number' ? formatMoney(datum.value, { whole: true }) : ''
          const percent = typeof share === 'number' ? ` \u00b7 ${formatBp(share)}` : ''
          return tooltipRow(datum.name ?? '', `${value}${percent}`)
        },
      },
      series: [
        {
          type: 'treemap',
          data,
          // One level, so no drill-down and no breadcrumb to click into a portfolio
          // that has no sub-levels to show.
          leafDepth: 1,
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          label: {
            show: true,
            // Not escaped, unlike the tooltip: a treemap label is drawn as SVG text,
            // not parsed as markup, so escaping here would print `&amp;` at the user.
            formatter: (params: unknown) => {
              const datum = params as { name?: string; data?: { shareBp?: number } }
              const share = datum.data?.shareBp
              return typeof share === 'number'
                ? `${datum.name ?? ''}\n${formatBp(share)}`
                : (datum.name ?? '')
            },
          },
          itemStyle: { borderWidth: 2, gapWidth: 2 },
          // The default upper level draws a header strip for a hierarchy that is not
          // there; suppressing it gives the boxes the whole area.
          levels: [{ itemStyle: { borderWidth: 0, gapWidth: 2 } }],
        },
      ],
    }
  }, [allocation, t])

  const largest = allocation.reduce<AllocationSlice | null>(
    (best, slice) => (best === null || slice.valueCents > best.valueCents ? slice : best),
    null,
  )
  const summary =
    largest === null
      ? t('empty.noData')
      : t('portfolio:chart.allocationSummary', {
          count: allocation.length,
          top: assetClassLabel(t, largest.assetClass),
          share: formatBp(largest.shareBp),
        })

  return <Chart option={option} summary={summary} {...(height === undefined ? {} : { height })} />
}
