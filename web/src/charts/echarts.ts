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
 * Series types are registered here as the pages that need them arrive: line and bar
 * now, the Sankey with the budget page (#30) and the treemap with the portfolio page
 * (#31).
 */
import { BarChart, LineChart } from 'echarts/charts'
import {
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DatasetComponent,
  SVGRenderer,
])

export { echarts }
export type { EChartsCoreOption } from 'echarts/core'
