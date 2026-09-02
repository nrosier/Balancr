/**
 * ECharts, assembled by hand.
 *
 * The full `echarts` bundle is around a megabyte because it contains every chart
 * type, both renderers and the map machinery. Importing from `echarts/core` and
 * registering only what is used keeps that to what this application actually draws.
 *
 * The renderer is **SVG**, deliberately:
 *
 *  - Text stays crisp at any pixel ratio, which matters for a screen that is mostly
 *    numbers.
 *  - It renders in jsdom, so a chart can be asserted in a unit test. Canvas needs the
 *    `canvas` native package and gives back pixels nobody can assert against.
 *  - The canvas renderer's advantage is tens of thousands of points. A budget draws
 *    hundreds.
 *
 * Series types are registered here as the pages that need them arrive: line, bar,
 * Sankey and scatter now, and the treemap with the portfolio page (#31).
 *
 * Scatter is here for an unobvious reason: it draws the comparative marker on the
 * budget-versus-actual bullet chart. A bullet chart's marker is a short tick at one
 * value on a category axis, which a bar cannot be — a bar starts at zero — and
 * `markLine` places one line across the whole chart rather than one per category.
 * A scatter point with a rectangular symbol is a tick at exactly one coordinate.
 *
 * `MarkLineComponent` is registered for the opposite case: on a per-category sparkline
 * the norm *is* one line across the whole chart, and that pairing — a category's twelve
 * months with the twelve-month average drawn through them — is why `TREND_MONTHS`
 * matches the EWMA window.
 */
import { BarChart, LineChart, SankeyChart, ScatterChart } from 'echarts/charts'
import {
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  BarChart,
  SankeyChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  DatasetComponent,
  SVGRenderer,
])

export { echarts }
export type { EChartsCoreOption } from 'echarts/core'
