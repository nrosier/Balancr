/**
 * The one place a chart is created, sized and torn down — and the one place ECharts is
 * loaded.
 *
 * **ECharts arrives after the page does** (#435). It is by far the heaviest thing the
 * frontend ships, and it is decoration for a dashboard whose subject is numbers: the
 * figures, the metric cards and every chart's `summary` are all readable without it.
 * So the module is behind a dynamic `import()` here rather than a static one, which
 * leaves it in a chunk of its own that the entry never waits for, and which the two
 * routes that draw nothing (settings, insights) never request at all.
 *
 * What that costs is one render with an empty box, and the box is deliberately the whole
 * cost: the host element below — its `role="img"`, its `aria-label` and its height — is
 * rendered on the first pass, before the module is asked for. So the chart's text
 * equivalent is available to a screen reader immediately rather than when a network
 * request finishes, and the layout does not shift when the picture lands. `aria-busy`
 * says which of the two states the box is in.
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
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTheme } from '../theme/ThemeContext.tsx'
import type { EChartsCoreOption } from './echarts.ts'
import { echartsTheme } from './theme.ts'

/** The hand-assembled build in `echarts.ts`, with its series types already registered. */
type EchartsModule = typeof import('./echarts.ts')

let loading: Promise<EchartsModule> | null = null

/**
 * The ECharts chunk, asked for once per page load.
 *
 * Memoised at module level rather than per component: a page draws up to eight charts,
 * and although eight `import()` calls would be deduplicated by the loader, the *promise*
 * is the thing worth sharing — the second chart to mount resolves off the first one's
 * request instead of starting its own round trip.
 *
 * Deliberately not retried, and deliberately not caught. A chunk that fails to load
 * means the browser and the server disagree about which build is deployed, which
 * re-asking cannot fix; the charts stay empty boxes with their summaries intact, and the
 * rejection surfaces in the console rather than being swallowed into a silence nobody
 * can debug.
 */
function loadEcharts(): Promise<EchartsModule> {
  loading ??= import('./echarts.ts')
  return loading
}

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

type ChartInstance = ReturnType<EchartsModule['echarts']['init']>

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
  const [loaded, setLoaded] = useState<EchartsModule | null>(null)

  // The latest option, readable by the init effect without becoming one of its
  // dependencies — otherwise every data change would tear the chart down and rebuild
  // it, losing the resize observer and any animation in flight.
  const latest = useRef(option)
  latest.current = option

  useEffect(() => {
    let live = true
    void loadEcharts().then((module) => {
      // The guard is for the chart that unmounts while its chunk is in flight — a
      // navigation away from the overview within the first few hundred milliseconds.
      if (live) setLoaded(module)
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const element = host.current
    if (element === null || loaded === null) return

    const chart = loaded.echarts.init(element, echartsTheme(resolved), { renderer: 'svg' })
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
  }, [loaded, resolved])

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
      // The box is the right size and says the right thing before ECharts has arrived;
      // this is what distinguishes "still drawing" from "drawn".
      aria-busy={loaded === null ? 'true' : undefined}
      data-private={blurWhenPrivate ? '' : undefined}
    />
  )
}
