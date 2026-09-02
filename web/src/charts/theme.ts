/**
 * The ECharts theme, built from the same tokens as the CSS.
 *
 * This is why `tokens.ts` is TypeScript and not only CSS. ECharts is *configured*
 * with colours — it writes them into the SVG it produces — so it cannot inherit
 * anything from a stylesheet. Without a shared source, a chart's grid lines and the
 * card border beside them are two independent decisions that drift apart the first
 * time either is adjusted.
 *
 * `color` is the ordered series palette, so the first series on every chart in the
 * application is the same colour. That, more than anything else, is what makes
 * separate pages read as one system.
 */
import { BASE, CHART_SERIES, colours, type ResolvedTheme } from '../theme/tokens.ts'

/**
 * Font sizes in px rather than from the rem-based type scale: ECharts wants numbers
 * and does no unit resolution, so a `rem` string is silently ignored. Kept small and
 * close to `--type-xs`/`--type-sm` at a 16px root.
 */
const AXIS_FONT_PX = 12
const TOOLTIP_FONT_PX = 13

export interface EchartsTheme {
  color: string[]
  backgroundColor: string
  textStyle: Record<string, unknown>
  grid: Record<string, unknown>
  categoryAxis: Record<string, unknown>
  valueAxis: Record<string, unknown>
  tooltip: Record<string, unknown>
  legend: Record<string, unknown>
}

export function echartsTheme(theme: ResolvedTheme): EchartsTheme {
  const c = colours(theme)

  const axis = {
    axisLine: { show: true, lineStyle: { color: c['border-strong'] } },
    axisTick: { show: false },
    axisLabel: { color: c['chart-axis'], fontSize: AXIS_FONT_PX },
    splitLine: { show: true, lineStyle: { color: c['chart-grid'] } },
  }

  return {
    color: CHART_SERIES.map((token) => c[token]),
    // The card behind the chart already paints a surface; a second opaque rectangle
    // is what makes a chart look pasted on rather than part of the page.
    backgroundColor: 'transparent',
    textStyle: { fontFamily: BASE['font-sans'], color: c.text, fontSize: AXIS_FONT_PX },
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    categoryAxis: { ...axis, splitLine: { show: false } },
    valueAxis: axis,
    tooltip: {
      backgroundColor: c['chart-tooltip-bg'],
      borderColor: c.border,
      borderWidth: 1,
      textStyle: { color: c['chart-tooltip-text'], fontSize: TOOLTIP_FONT_PX },
      // Matches `--shadow-pop`, which a token cannot express here: ECharts takes a
      // blur radius and a colour, not a CSS shadow string.
      extraCssText: 'box-shadow: 0 8px 24px rgb(0 0 0 / 0.18); border-radius: 8px;',
    },
    legend: {
      textStyle: { color: c['text-muted'], fontSize: AXIS_FONT_PX },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
    },
  }
}
