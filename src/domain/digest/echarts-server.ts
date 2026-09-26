/**
 * Headless chart rendering for the monthly digest (#52).
 *
 * The digest has no browser to draw a chart in — it comes out of a cron job that
 * writes a PDF or an email, never a page. ECharts' SVG renderer already supports
 * exactly this (`ssr: true`, no DOM), so this file is a second, minimal assembly of
 * the same library `web/src/charts/echarts.ts` assembles for the browser: only the
 * series and components the digest's two charts actually use — line, bar and
 * scatter (the bullet chart's baseline tick, see `BudgetBullet.tsx`), grid and
 * legend. No tooltip component: nothing in a PDF is ever hovered.
 */
import { BarChart, LineChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, LegendComponent, SVGRenderer])

/** Renders one `option` to a standalone SVG document, sized in CSS pixels. */
export function renderChartSvg(option: EChartsCoreOption, width: number, height: number): string {
  const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width, height })
  chart.setOption(option)
  const svg = chart.renderToSVGString()
  chart.dispose()
  return svg
}
