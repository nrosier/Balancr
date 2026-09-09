/**
 * `BudgetBullet`, `CategoryTrend` and `NetWorthChart` all switched from
 * `tooltip.valueFormatter` to a full `tooltip.formatter`, because ECharts runs
 * `valueFormatter`'s return value through its own `encodeHTML` when it assembles the
 * default tooltip markup — which turns `privateText`'s `<span data-private>` wrapper
 * into literal, visible tag text instead of a real element `privacy.css` can blur. A
 * full `formatter`'s return value is inserted as-is, which is the whole fix.
 *
 * jsdom never fires the mouse events that would make ECharts call `formatter` for
 * real, so each test pulls the function straight off `getOption()` and calls it with
 * the shape ECharts documents for an axis-trigger callback: an array of per-series
 * `params`, each carrying `marker`, `seriesName`, `axisValueLabel` and `value` — see
 * `TooltipView.js`'s `_showAxisTooltip`, which builds exactly this array before handing
 * it to a custom `formatter`.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { BudgetBullet } from '../src/charts/BudgetBullet.tsx'
import { CategoryTrend } from '../src/charts/CategoryTrend.tsx'
import { echarts } from '../src/charts/echarts.ts'
import { NetWorthChart } from '../src/charts/NetWorthChart.tsx'
import { i18nReady, renderApp } from './helpers.tsx'

beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 300, configurable: true })
  await i18nReady()
})

type Formatter = (params: unknown) => string

function formatterOf(container: HTMLElement): Formatter {
  const host = container.querySelector('[role="img"]')
  if (host === null) throw new Error('chart host not found')
  const instance = echarts.getInstanceByDom(host as HTMLElement)
  const tooltip = instance?.getOption().tooltip as { formatter?: Formatter } | { formatter?: Formatter }[]
  const formatter = (Array.isArray(tooltip) ? tooltip[0]?.formatter : tooltip?.formatter) as
    | Formatter
    | undefined
  if (formatter === undefined) throw new Error('no tooltip formatter on this option')
  return formatter
}

describe('axis-trigger chart tooltips', () => {
  it('BudgetBullet renders a real <span data-private>, not its escaped text', () => {
    const { container } = renderApp(
      <BudgetBullet
        categories={[{ name: 'Rent', spentCents: 80000, assignedCents: 90000, baselineCents: 85000 }]}
      />,
    )
    const formatter = formatterOf(container)

    const html = formatter([
      { marker: '<span class="dot"></span>', seriesName: 'Assigned', axisValueLabel: 'Rent', value: 90000 },
      { marker: '<span class="dot"></span>', seriesName: 'Spent', axisValueLabel: 'Rent', value: 80000 },
      {
        marker: '<span class="dot"></span>',
        seriesName: 'Baseline',
        axisValueLabel: 'Rent',
        value: [85000, 'Rent'],
      },
    ])

    expect(html).toContain('<span data-private>')
    expect(html).not.toContain('&lt;span')
  })

  it('CategoryTrend renders a real <span data-private>, not its escaped text', () => {
    const { container } = renderApp(
      <CategoryTrend name="Groceries" months={['2026-08']} series={[42000]} baselineCents={null} />,
    )
    const formatter = formatterOf(container)

    const html = formatter([
      { marker: '<span class="dot"></span>', seriesName: 'Groceries', axisValueLabel: 'August 2026', value: 42000 },
    ])

    expect(html).toContain('<span data-private>')
    expect(html).not.toContain('&lt;span')
  })

  it('NetWorthChart renders a real <span data-private>, not its escaped text', () => {
    const { container } = renderApp(
      <NetWorthChart history={[{ date: '2026-08-31', totalCents: 4820000 }]} />,
    )
    const formatter = formatterOf(container)

    const html = formatter([
      {
        marker: '<span class="dot"></span>',
        seriesName: 'Net worth',
        axisValueLabel: '31/08/2026',
        value: 4820000,
      },
    ])

    expect(html).toContain('<span data-private>')
    expect(html).not.toContain('&lt;span')
  })
})
