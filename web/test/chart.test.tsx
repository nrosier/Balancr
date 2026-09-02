/**
 * The chart wrapper, which exists for the three things that are invisible when
 * forgotten.
 *
 *  - **It disposes.** ECharts holds its instance in a registry keyed by the DOM node,
 *    not in React state, so a component that unmounts without calling `dispose` leaks
 *    one instance per navigation. `getInstanceByDom` on the *retained* node is the only
 *    way to see that from outside, which is why the tests hold onto the element.
 *  - **It re-creates on a theme change and only then.** ECharts takes its theme at
 *    `init` and cannot be re-themed, so switching light to dark has to tear the chart
 *    down. A data change must *not*, or every update loses the resize observer and any
 *    animation in flight — asserted by identity, since "it still renders" would pass
 *    either way.
 *  - **It has a text equivalent.** `summary` is a required prop rather than an
 *    optional one, and `role="img"` plus `aria-label` is what makes a treemap answer
 *    "how am I doing" for someone who cannot see it.
 *
 * jsdom reports every element as zero-sized, so nothing here asserts geometry. The SVG
 * renderer is what makes even this much possible: canvas would need a native package
 * and would hand back pixels nobody can assert against.
 */
import { render, screen } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Chart } from '../src/charts/Chart.tsx'
import { echarts, type EChartsCoreOption } from '../src/charts/echarts.ts'
import { ThemeToggle } from '../src/shell/ThemeToggle.tsx'
import { clickLink, i18nReady, renderApp, resetTheme } from './helpers.tsx'

const OPTION: EChartsCoreOption = {
  xAxis: { type: 'category', data: ['Jan', 'Feb'] },
  yAxis: { type: 'value' },
  series: [{ type: 'line', data: [1, 2] }],
}

/**
 * Gives every element a size for the duration of this file.
 *
 * Not in `setup.ts`, because a fake 800 × 600 on every element in the application is
 * exactly the kind of thing a later test would come to depend on. ECharts logs
 * "Can't get DOM width or height" against a zero-sized container, and that warning is
 * about jsdom rather than about this component.
 */
const original = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
}

beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 300, configurable: true })
  await i18nReady()
})

afterAll(() => {
  if (original.width !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', original.width)
  }
  if (original.height !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', original.height)
  }
})

beforeEach(resetTheme)

const host = (): HTMLElement => screen.getByRole('img')

describe('Chart', () => {
  it('is announced as an image with the summary as its text equivalent', () => {
    renderApp(<Chart option={OPTION} summary="Net worth rose 4% to € 48.200" />)
    expect(host().getAttribute('aria-label')).toBe('Net worth rose 4% to € 48.200')
  })

  it('draws with the SVG renderer, so it renders at all outside a browser', () => {
    renderApp(<Chart option={OPTION} summary="two months" />)
    expect(host().querySelector('svg')).not.toBeNull()
  })

  it('takes the option it was given', () => {
    renderApp(<Chart option={OPTION} summary="two months" />)
    const instance = echarts.getInstanceByDom(host())
    expect(instance).toBeDefined()
    const series = (instance?.getOption() as { series?: { type?: string }[] }).series
    expect(series?.[0]?.type).toBe('line')
  })

  it('sizes itself from the prop, since the caller chooses the height per chart', () => {
    const { unmount } = renderApp(<Chart option={OPTION} summary="two months" />)
    expect(host().style.height).toBe('16rem')
    expect(host().style.width).toBe('100%')
    unmount()

    renderApp(<Chart option={OPTION} summary="two months" height="30rem" />)
    expect(host().style.height).toBe('30rem')
  })

  it('disposes on unmount, so a navigation does not leak an instance', () => {
    const { unmount } = renderApp(<Chart option={OPTION} summary="two months" />)
    // Held onto: after unmount the node is out of the document and unreachable
    // through a query, and the registry is keyed by exactly this node.
    const element = host()
    expect(echarts.getInstanceByDom(element)).toBeDefined()

    unmount()
    expect(echarts.getInstanceByDom(element)).toBeUndefined()
  })

  it('keeps the same instance across a data change', () => {
    const { rerender } = renderApp(<Chart option={OPTION} summary="two months" />)
    const before = echarts.getInstanceByDom(host())?.id

    rerender(
      <Chart
        option={{ ...OPTION, series: [{ type: 'bar', data: [3, 4] }] }}
        summary="two months"
      />,
    )
    const instance = echarts.getInstanceByDom(host())
    expect(instance?.id).toBe(before)
    const series = (instance?.getOption() as { series?: { type?: string }[] }).series
    // `notMerge`, so the line series is gone rather than sitting underneath.
    expect(series?.map((s) => s.type)).toEqual(['bar'])
  })

  it('rebuilds on a theme change, because ECharts cannot be re-themed', () => {
    renderApp(
      <>
        <ThemeToggle />
        <Chart option={OPTION} summary="two months" />
      </>,
    )
    const before = echarts.getInstanceByDom(host())?.id
    expect(before).toBeDefined()

    clickLink(screen.getByRole('button', { name: 'Dark' }))

    const after = echarts.getInstanceByDom(host())
    expect(after).toBeDefined()
    expect(after?.id).not.toBe(before)
    expect(host().querySelector('svg')).not.toBeNull()
  })

  it('does not rebuild when the chosen mode resolves to the colour already on screen', () => {
    // `system` on a light machine and an explicit `light` are the same picture; tearing
    // the chart down between them would be visible as a flicker for no reason.
    renderApp(
      <>
        <ThemeToggle />
        <Chart option={OPTION} summary="two months" />
      </>,
    )
    const before = echarts.getInstanceByDom(host())?.id

    clickLink(screen.getByRole('button', { name: 'Light' }))
    expect(echarts.getInstanceByDom(host())?.id).toBe(before)
  })

  it('passes a class through, so a page can place it', () => {
    renderApp(<Chart option={OPTION} summary="two months" className="card__chart" />)
    expect(host().className).toBe('card__chart')
  })
})
