/**
 * The one place a chart is created, sized and torn down.
 *
 * Everything a chart needs to behave correctly is easy to forget individually and
 * invisible when forgotten: it has to be disposed or the tab leaks an instance per
 * navigation, it has to be resized or it keeps the width of whatever the layout was
 * at mount, and it has to be re-created on a theme change because ECharts takes its
 * theme at `init` and cannot be re-themed afterwards.
 *
 * It also has to have a text equivalent, which is why `summary` is required rather
 * than optional. A treemap alone is not an answer to "how am I doing" for someone
 * using a screen reader, and an optional accessibility parameter is one that is
 * supplied for the first chart and forgotten for the next seven.
 *
 * **On the Content-Security-Policy**, which has no `'unsafe-inline'` for styles:
 * verified against zrender and ECharts rather than assumed. `zrender/lib/svg/patch.js`
 * special-cases the root `<svg>`'s style with `elm.style.cssText = …` and the tooltip
 * does the same, both of which are CSSOM writes that CSP does not police — unlike
 * `setAttribute('style', …)`, which it does. The one inline `<style>` element zrender
 * can emit comes from `renderToString`, its server-side path, which this never calls.
 *
 * The `style` prop below is safe for the same reason and it is worth saying so, because
 * `style-src 'self'` really does block a `style` *attribute* — but React never writes
 * one. `setValueForStyles` in `react-dom` assigns through `node.style`, which is CSSOM.
 * A raw `dangerouslySetInnerHTML` carrying `style="…"` would be blocked; this is not
 * that. The height has to come from here rather than from a class because the caller
 * chooses it per chart, and a stylesheet cannot enumerate every height a page wants.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { useTheme } from '../theme/ThemeContext.tsx'
import { echarts, type EChartsCoreOption } from './echarts.ts'
import { echartsTheme } from './theme.ts'

export interface ChartProps {
  option: EChartsCoreOption
  /**
   * What the chart says, in words. Read out in place of the graphic, so it should
   * carry the conclusion — "net worth rose 4% over twelve months to € 48.200" — not
   * a description of the shape.
   */
  summary: string
  /** Any CSS length. Charts reflow with the container; only the height is fixed. */
  height?: string
  className?: string
  /**
   * Blurs the whole rendered chart under privacy mode, not just its tooltip.
   * ECharts draws with the SVG renderer (see the module doc above), so the
   * chart's geometry and axis labels are real DOM inside this wrapper and a
   * CSS `filter` reaches them — unlike the tooltip, which is a separate div
   * on `document.body` and needs its own `data-private` markup regardless.
   * Reserve this for a chart whose shape alone gives away the figure it
   * would otherwise blur, such as a net-worth line against a labelled axis.
   */
  blurWhenPrivate?: boolean
}

type ChartInstance = ReturnType<typeof echarts.init>

export function Chart({
  option,
  summary,
  height = '16rem',
  className,
  blurWhenPrivate = false,
}: ChartProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null)
  const instance = useRef<ChartInstance | null>(null)
  const { resolved } = useTheme()

  // The latest option, readable by the init effect without becoming one of its
  // dependencies — otherwise every data change would tear the chart down and rebuild
  // it, losing the resize observer and any animation in flight.
  const latest = useRef(option)
  latest.current = option

  useEffect(() => {
    const element = host.current
    if (element === null) return

    const chart = echarts.init(element, echartsTheme(resolved), { renderer: 'svg' })
    instance.current = chart
    chart.setOption(latest.current)

    // ResizeObserver rather than a window listener: the sidebar collapsing changes
    // the chart's width without the window changing size at all.
    const observer = new ResizeObserver(() => {
      if (!chart.isDisposed()) chart.resize()
    })
    observer.observe(element)

    return () => {
      observer.disconnect()
      chart.dispose()
      instance.current = null
    }
  }, [resolved])

  useEffect(() => {
    // `notMerge` because a new option is a new picture: merging leaves the previous
    // series in place when a chart goes from three categories to two.
    instance.current?.setOption(option, { notMerge: true })
  }, [option])

  return (
    <div
      ref={host}
      className={className}
      style={{ height, width: '100%' }}
      role="img"
      aria-label={summary}
      data-private={blurWhenPrivate ? '' : undefined}
    />
  )
}
