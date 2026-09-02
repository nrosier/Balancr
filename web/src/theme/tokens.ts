/**
 * Every colour, space and type size in the application, in one place.
 *
 * This file is the source of truth and `tokens.css` is generated from it by
 * `npm run tokens:write`. The direction matters: the browser needs the values as
 * CSS custom properties at first paint, with no JavaScript, or a reload flashes
 * unstyled; the chart layer needs them as real strings, because ECharts is
 * configured with colours rather than styled with them. Reading the custom
 * properties back with `getComputedStyle` would satisfy both from one place, but it
 * makes every chart depend on a live document — untestable outside a browser, and
 * wrong during the first frame.
 *
 * So the values live here once, the CSS is a build artefact, and
 * `test/unit/web-tokens.test.ts` fails if the committed CSS drifts from this file.
 * Duplication that is checked is a different thing from duplication.
 *
 * Deliberately DOM-free — a Node test and a build script import it as well as the
 * bundle.
 */

/** What does not change with the theme: type, space, shape, layout. */
export const BASE = {
  // Inter is vendored as woff2 (see `fonts.css`); what follows it is what an
  // offline or still-loading first paint falls back to.
  'font-sans':
    "'Inter Variable', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  'font-mono': "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, monospace",

  'type-xs': '0.75rem',
  'type-sm': '0.8125rem',
  'type-base': '0.9375rem',
  'type-md': '1.0625rem',
  'type-lg': '1.25rem',
  'type-xl': '1.5rem',
  'type-2xl': '2rem',

  'lead-tight': '1.2',
  'lead-normal': '1.55',

  'weight-regular': '400',
  'weight-medium': '500',
  'weight-semibold': '600',

  'space-1': '0.25rem',
  'space-2': '0.5rem',
  'space-3': '0.75rem',
  'space-4': '1rem',
  'space-5': '1.5rem',
  'space-6': '2rem',
  'space-7': '3rem',
  'space-8': '4rem',

  'radius-sm': '4px',
  'radius-md': '8px',
  'radius-lg': '14px',
  'radius-pill': '999px',

  'sidebar-width': '15rem',
  'header-height': '3.5rem',
  /** The mobile tab bar. Also the bottom padding `main` needs to clear it. */
  'nav-height': '3.5rem',
  'content-max': '78rem',

  transition: '140ms ease',
} as const

/**
 * The light theme.
 *
 * `DARK` below carries exactly these keys — enforced by the token test, because a
 * colour defined in one theme and not the other inherits whatever was there
 * instead of failing, which on a financial figure means an amount nobody can read
 * rather than an obvious mistake.
 */
export const LIGHT = {
  'surface-page': '#f5f6f8',
  'surface-card': '#ffffff',
  'surface-sunken': '#eaecf0',
  'surface-hover': '#eef1f6',

  border: '#dfe2e8',
  'border-strong': '#c4c9d2',

  text: '#111726',
  'text-muted': '#5a6373',
  /** Decoration and disabled states. Not for body text at any size. */
  'text-faint': '#727b89',
  'text-inverse': '#ffffff',

  accent: '#3450c8',
  'accent-hover': '#2a41a6',
  'accent-soft': '#e7ebfa',
  'accent-text': '#ffffff',

  positive: '#0f7355',
  'positive-soft': '#e0f2ec',
  negative: '#b5342a',
  'negative-soft': '#fbe6e4',
  warn: '#8f5b00',
  'warn-soft': '#fbeed2',
  info: '#1f6390',
  'info-soft': '#e2eef7',

  'focus-ring': '#3450c8',

  'shadow-card': '0 1px 2px rgb(17 23 38 / 0.06), 0 1px 3px rgb(17 23 38 / 0.08)',
  'shadow-pop': '0 8px 24px rgb(17 23 38 / 0.14)',

  // The series colours, in order. One ordered list used by every chart is what
  // makes a Sankey on one page and a treemap on another read as one system.
  'chart-1': '#3450c8',
  'chart-2': '#0f8f8a',
  'chart-3': '#c07000',
  'chart-4': '#8b4bc4',
  'chart-5': '#1f7a4d',
  'chart-6': '#c1476a',
  'chart-7': '#2d7fb8',
  'chart-8': '#6b7280',

  'chart-grid': '#e6e9ef',
  'chart-axis': '#727b89',
  'chart-tooltip-bg': '#ffffff',
  'chart-tooltip-text': '#111726',
} as const

/** The dark theme. Same keys as `LIGHT`, checked by the token test. */
export const DARK = {
  'surface-page': '#0f1218',
  'surface-card': '#171b23',
  'surface-sunken': '#0b0e13',
  'surface-hover': '#1f242e',

  border: '#2a303b',
  'border-strong': '#3d4552',

  text: '#e8ebf0',
  'text-muted': '#a2abba',
  'text-faint': '#8a94a3',
  'text-inverse': '#0f1218',

  accent: '#8098f0',
  'accent-hover': '#9aaef5',
  'accent-soft': '#1c2440',
  'accent-text': '#0f1218',

  positive: '#4fc79f',
  'positive-soft': '#12291f',
  negative: '#f08a80',
  'negative-soft': '#2e1512',
  warn: '#e0ac4a',
  'warn-soft': '#2c2110',
  info: '#7ab8e0',
  'info-soft': '#122232',

  'focus-ring': '#8098f0',

  'shadow-card': '0 1px 2px rgb(0 0 0 / 0.4), 0 1px 3px rgb(0 0 0 / 0.3)',
  'shadow-pop': '0 8px 24px rgb(0 0 0 / 0.55)',

  'chart-1': '#8098f0',
  'chart-2': '#3fbfb8',
  'chart-3': '#e3a54a',
  'chart-4': '#b58ae0',
  'chart-5': '#5cba85',
  'chart-6': '#ea7f9d',
  'chart-7': '#6fb2e0',
  'chart-8': '#9aa3b2',

  'chart-grid': '#252b35',
  'chart-axis': '#8a94a3',
  'chart-tooltip-bg': '#1f242e',
  'chart-tooltip-text': '#e8ebf0',
} as const

export type ColourToken = keyof typeof LIGHT
export type ResolvedTheme = 'light' | 'dark'

/** The series colours, in the order a chart should take them. */
export const CHART_SERIES = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
] as const satisfies readonly ColourToken[]

/** The palette for a resolved theme. Charts read colours here, not from the CSS. */
export function colours(theme: ResolvedTheme): Readonly<Record<ColourToken, string>> {
  return theme === 'dark' ? DARK : LIGHT
}

/** `var(--accent)`, for the rare inline style that needs a token. */
export const cssVar = (token: string): string => `var(--${token})`

const declarations = (indent: string, values: Readonly<Record<string, string>>): string =>
  Object.entries(values)
    .map(([name, value]) => `${indent}--${name}: ${value};`)
    .join('\n')

/**
 * Renders `tokens.css`.
 *
 * The dark values appear twice on purpose. The media query is what makes the first
 * paint correct, with no JavaScript, for someone whose system is dark; the
 * attribute selector is what lets an explicit choice override the system in both
 * directions. Neither can be dropped, so the token test asserts instead that the
 * two blocks are identical.
 */
export function renderTokensCss(): string {
  const dark = declarations('    ', DARK)
  return `/*
 * Generated from tokens.ts by \`npm run tokens:write\` — do not edit by hand.
 *
 * \`test/unit/web-tokens.test.ts\` fails if this file drifts from the tokens.
 */
:root {
  color-scheme: light;

${declarations('  ', BASE)}

${declarations('  ', LIGHT)}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;

${dark}
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;

${dark}
}
`
}
