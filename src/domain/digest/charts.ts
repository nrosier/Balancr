/**
 * The two charts embedded in the monthly digest PDF (#52).
 *
 * Same data, same shape as `NetWorthChart.tsx` and `BudgetBullet.tsx` chart
 * client-side — this module rebuilds their `option` objects server-side from the
 * same aggregation functions those components are fed from (`loadNetWorthHistory`,
 * `loadFacts`), so a PDF chart never silently drifts from what the app itself calls
 * "net worth" or "top spending". `renderChartSvg` (`echarts-server.ts`) turns the
 * `option` into the SVG `pdf.ts` embeds.
 *
 * What is deliberately dropped versus the client components: tooltips (nothing in
 * a static image is hovered) and, for the bullet chart, the limit of 12 rows down
 * to 6 — a page has less room than a card that scrolls.
 */
import type { EChartsCoreOption } from 'echarts/core'
import { formatDate, formatMoneyCompact, formatMonthShort } from '../../i18n/format.ts'
import { t } from '../../i18n/index.ts'
import type { Db } from '../../db/index.ts'
import { loadFacts } from '../aggregate/facts.ts'
import { loadNetWorthHistory } from '../aggregate/networth-store.ts'

/** A month label where the month changes, an empty string everywhere else. */
function monthLabels(history: readonly { date: string }[], locale: string): string[] {
  return history.map((point, index) => {
    const month = point.date.slice(0, 7)
    const previous = index === 0 ? null : (history[index - 1]?.date.slice(0, 7) ?? null)
    return month === previous ? '' : formatMonthShort(month, locale)
  })
}

/**
 * Net worth over time. `null` when there is no history yet — a household on its
 * first month has nothing to plot, and an empty chart reads as a bug rather than
 * as "you just started".
 */
export function netWorthTrendOption(db: Db, tenantId: string, locale: string): EChartsCoreOption | null {
  const history = loadNetWorthHistory(db, tenantId)
  if (history.length === 0) return null

  const labels = monthLabels(history, locale)
  return {
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: history.map((point) => formatDate(point.date)),
      axisLabel: { interval: 0, formatter: (_value: string, index: number) => labels[index] ?? '' },
    },
    yAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatMoneyCompact(value) } },
    series: [
      {
        type: 'line',
        data: history.map((point) => point.totalCents),
        showSymbol: history.length <= 24,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.12 },
      },
    ],
  }
}

/** Rows in the budget-vs-actual chart. A page has less room than a scrolling card. */
export const DIGEST_BULLET_LIMIT = 6

/** How much room a bullet row needs: whichever of assigned and spent reaches further — same metric `Budget.tsx` sorts by. */
const extent = (spentCents: number, budgetedCents: number): number => Math.max(spentCents, budgetedCents)

/**
 * The top categories by assigned/spent extent, budget versus actual. `null` when
 * every category is untouched (nothing spent or assigned) — the same case
 * `Budget.tsx` renders as an empty-month notice rather than a blank chart.
 */
export function budgetVsActualOption(
  db: Db,
  tenantId: string,
  period: string,
  locale: string,
): EChartsCoreOption | null {
  const categories = loadFacts(db, tenantId, period, locale)
    .filter((fact) => !fact.isIncome && (fact.spentCents !== 0 || fact.budgetedCents !== 0))
    .sort((a, b) => extent(b.spentCents, b.budgetedCents) - extent(a.spentCents, a.budgetedCents))
    .slice(0, DIGEST_BULLET_LIMIT)
    .map((fact) => ({
      name: fact.categoryName,
      spentCents: fact.spentCents,
      assignedCents: fact.budgetedCents,
      baselineCents: fact.baseline?.baselineCents ?? null,
    }))

  if (categories.length === 0) return null

  const assigned = t(locale, 'budget:metric.assigned')
  const spent = t(locale, 'budget:metric.spent')
  const baseline = t(locale, 'budget:metric.baseline')

  return {
    legend: { data: [assigned, spent, baseline], bottom: 0 },
    grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
    xAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatMoneyCompact(value) } },
    yAxis: {
      type: 'category',
      data: categories.map((category) => category.name),
      inverse: true,
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
}
