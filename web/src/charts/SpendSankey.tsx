/**
 * Where the month's money came from and where it went.
 *
 * Three columns, and the middle one is the whole reason this is a Sankey rather than a
 * bipartite mess: **income sources → one pooled node → envelopes.** Drawing salary
 * straight to groceries would require knowing which euro bought the groceries, and
 * nothing in Actual knows that. Money arrives, it pools, it leaves. The hub is the
 * honest shape of that, and it is also the only shape that stays readable when a second
 * income source appears.
 *
 * What it deliberately does not do:
 *
 *  - **It draws no total it was not given.** The pool's inflow is the sum of the income
 *    categories, not `totals.incomeCents`. Those two can disagree — income that never
 *    landed in a category is exactly what the uncategorised notice above the chart is
 *    for — and a hub whose ribbons do not add up to its own width is worse than a
 *    number that is slightly smaller than the card beside it.
 *  - **It shows no negative flow.** A ribbon has no negative width, so a category whose
 *    month nets out to a refund is left out rather than drawn as an inflow it is not.
 *  - **It invents no "saved" node.** `Not spent` appears only when the pool genuinely
 *    has money left in it. When spending exceeded income the right-hand column simply
 *    outweighs the left, which is what happened.
 *
 * Every figure printed here goes through `format.ts` — see `NetWorthChart` on why that
 * is the one thing a chart gets wrong on its own.
 */
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { useT } from '../i18n.ts'
import { formatMoney } from '../shared.ts'
import { Chart } from './Chart.tsx'
import type { EChartsCoreOption } from './echarts.ts'
import { tooltipRow } from './tooltip.ts'

export interface SankeyCategory {
  name: string
  isIncome: boolean
  /** Positive is money out for an envelope and money in for an income category. */
  spentCents: number
}

export interface SpendSankeyProps {
  categories: readonly SankeyCategory[]
  height?: string
}

/**
 * How many envelopes get their own ribbon before the rest are pooled.
 *
 * Eight, matching the series palette, because a ninth colour would repeat the first —
 * and because a Sankey with thirty ribbons is a texture rather than a chart.
 */
const TOP_CATEGORIES = 8

interface Flow {
  name: string
  cents: number
}

/**
 * A name no other node has.
 *
 * Two envelopes really can be called "Insurance" — Actual scopes names to a group, not
 * to the budget — and a Sankey link addresses its endpoints *by name*, so a duplicate
 * silently merges two envelopes into one ribbon. Numbering the second one says what is
 * true rather than hiding it, and the hub and the pooled node go through the same
 * function so a category called "Income" cannot collide with them either.
 */
function unique(taken: Set<string>, name: string): string {
  let candidate = name
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `${name} (${suffix})`
    suffix += 1
  }
  taken.add(candidate)
  return candidate
}

/** Money in, largest first. An income row's figure is a magnitude, hence the `abs`. */
function incomeFlows(categories: readonly SankeyCategory[]): Flow[] {
  return categories
    .filter((category) => category.isIncome && category.spentCents !== 0)
    .map((category) => ({ name: category.name, cents: Math.abs(category.spentCents) }))
    .sort((a, b) => b.cents - a.cents)
}

/** Money out, largest first, with everything past the top N pooled into `otherName`. */
function spendFlows(categories: readonly SankeyCategory[], otherName: string): Flow[] {
  const spending = categories
    .filter((category) => !category.isIncome && category.spentCents > 0)
    .map((category) => ({ name: category.name, cents: category.spentCents }))
    .sort((a, b) => b.cents - a.cents)

  if (spending.length <= TOP_CATEGORIES + 1) return spending

  const top = spending.slice(0, TOP_CATEGORIES)
  const pooled = spending
    .slice(TOP_CATEGORIES)
    .reduce((sum, category) => sum + category.cents, 0)
  return [...top, { name: otherName, cents: pooled }]
}

const total = (flows: readonly Flow[]): number =>
  flows.reduce((sum, flow) => sum + flow.cents, 0)

export function SpendSankey({ categories, height }: SpendSankeyProps): ReactNode {
  const { t } = useT()

  const flows = useMemo(() => {
    const income = incomeFlows(categories)
    const spend = spendFlows(categories, t('budget:chart.sankeyOther'))
    return { income, spend, incomeCents: total(income), spendCents: total(spend) }
  }, [categories, t])

  const option = useMemo<EChartsCoreOption>(() => {
    const taken = new Set<string>()
    const hub = unique(taken, t('budget:metric.income'))
    const sources = flows.income.map((flow) => ({ ...flow, node: unique(taken, flow.name) }))
    const sinks = flows.spend.map((flow) => ({ ...flow, node: unique(taken, flow.name) }))

    // Whatever the pool still holds, as its own sink. A shortfall is not a node: see
    // the header on why the columns are allowed to disagree.
    const left = flows.incomeCents - flows.spendCents
    const saved =
      left > 0 ? { node: unique(taken, t('budget:chart.sankeySaved')), cents: left } : null
    const outflows = saved === null ? sinks : [...sinks, saved]

    const links = [
      ...sources.map((flow) => ({ source: flow.node, target: hub, value: flow.cents })),
      ...outflows.map((flow) => ({ source: hub, target: flow.node, value: flow.cents })),
    ]

    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const item = params as {
            dataType?: string
            name?: string
            value?: unknown
            data?: { source?: string; target?: string; value?: number }
          }
          const cents = typeof item.value === 'number' ? item.value : 0
          if (item.dataType === 'edge') {
            const link = item.data ?? {}
            return tooltipRow(
              `${link.source ?? ''} → ${link.target ?? ''}`,
              formatMoney(link.value ?? 0, { whole: true }),
            )
          }
          return tooltipRow(item.name ?? '', formatMoney(cents, { whole: true }))
        },
      },
      series: [
        {
          type: 'sankey',
          left: 0,
          right: 0,
          top: 8,
          bottom: 8,
          nodeWidth: 12,
          nodeGap: 10,
          // Dragging a node rearranges a picture the reader did not ask to rearrange,
          // and on a touch screen it competes with scrolling the page.
          draggable: false,
          emphasis: { focus: 'adjacency' },
          label: { width: 96, overflow: 'truncate' },
          lineStyle: { color: 'gradient', opacity: 0.4, curveness: 0.5 },
          // Node order is palette order, so the income sources take the first colours
          // and the pool sits between them and the envelopes.
          data: [...sources, { node: hub }, ...outflows].map((flow) => ({ name: flow.node })),
          links,
        },
      ],
    }
  }, [flows, t])

  const largest = flows.spend[0]
  const money = (cents: number): string => formatMoney(cents, { whole: true })
  const summary =
    largest === undefined
      ? t('budget:chart.sankeyTotals', {
          income: money(flows.incomeCents),
          spent: money(flows.spendCents),
        })
      : t('budget:chart.sankeySummary', {
          income: money(flows.incomeCents),
          spent: money(flows.spendCents),
          largest: largest.name,
          amount: money(largest.cents),
        })

  return <Chart option={option} summary={summary} {...(height === undefined ? {} : { height })} />
}
