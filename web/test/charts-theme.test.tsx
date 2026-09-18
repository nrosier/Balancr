/**
 * `echartsTheme()`'s per-series-subtype theme keys — the mechanism `theme.ts` leans on
 * for anything ECharts does not merge into the chart-wide `textStyle` on its own (#383).
 */
import { describe, expect, it } from 'vitest'
import { echartsTheme } from '../src/charts/theme.ts'
import { colours } from '../src/theme/tokens.ts'

describe('echartsTheme', () => {
  it('gives sankey node labels an explicit colour, in both palettes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const sankey = echartsTheme(theme).sankey as { label: { color: string } }
      expect(sankey.label.color).toBe(colours(theme).text)
    }
  })
})
