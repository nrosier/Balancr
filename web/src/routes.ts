/**
 * The route table.
 *
 * One list, read by both the router (which path renders which page) and the nav
 * (which links to show, in which order, with which icon). Kept as a single table
 * because the alternative — a switch in `App.tsx` and an array in `Nav.tsx` — drifts
 * the moment a page is added, and drifts silently: the page works but is unreachable.
 *
 * `labelKey` points at the existing `nav.*` catalogue keys, so a route's label is
 * translated by the same mechanism as everything else.
 *
 * **Each page is its own chunk** (#435). The pages are where the weight is — ECharts
 * reaches the bundle through five of them, and the settings page's stack of panels is
 * the largest single page by some distance — and one file meant every visitor downloaded
 * all seven to look at one. So `Page` is a `React.lazy` around a dynamic `import()`, and
 * `App.tsx` supplies the one `Suspense` boundary they all render inside.
 *
 * The icons stay statically imported, deliberately: the navigation draws all seven on
 * every page, so they are needed on first paint and are a few hundred bytes of path
 * data between them. Splitting those would cost seven requests to save nothing.
 */
import { lazy, type FunctionComponent, type ReactNode } from 'react'
import {
  IconBudget,
  IconForecast,
  IconInsights,
  IconOverview,
  IconPortfolio,
  IconScenario,
  IconSettings,
  type IconProps,
} from './shell/icons.tsx'

export interface AppRoute {
  /** Absolute path, no trailing slash except for the root. */
  readonly path: string
  /** Catalogue key in the `common` namespace. */
  readonly labelKey: string
  readonly Icon: (props: IconProps) => ReactNode
  /**
   * Suspends on first render until its chunk has arrived — see `page()` below. Takes no
   * props: the table renders `<route.Page />`, which is why a page that needs anything
   * reads it from context (`useCsrf`, `useRouter`) rather than from an argument.
   */
  readonly Page: FunctionComponent
  /**
   * Asks for this page's chunk without rendering it, so a hover or a keyboard focus on
   * a nav link starts the request a click would otherwise start. Fire-and-forget: the
   * loading state exists for the case where the click comes first, and a failed
   * prefetch is not an error anyone can act on — the real `import()` will fail again,
   * visibly, at render.
   */
  readonly preload: () => void
  /**
   * Owns every path under its own, not just an exact match. Set only where the page
   * does its own sub-navigation (Settings #200, Insights #228, Budget #230,
   * Portfolio #229) — every other route still 404s on a nested path (#30
   * onward), which `nav.tsx`'s `isActive` highlights but this does not
   * resolve to a page.
   */
  readonly nested?: boolean
}

/**
 * One page's chunk, as the two things a route needs from it.
 *
 * `React.lazy` wants a module whose `default` is the component, and these pages export
 * named components — adapting the loader here rather than adding a default export to
 * seven files keeps the pages themselves unaware that they are split.
 *
 * `preload` is the same `import()`, called for its side effect only. A module request
 * already in flight is not made twice, so a hover followed by a click fetches one chunk
 * and the click finds it resolved.
 */
function page<K extends string>(
  load: () => Promise<Record<K, FunctionComponent>>,
  name: K,
): Pick<AppRoute, 'Page' | 'preload'> {
  return {
    // `lazy` is given its type argument rather than left to infer one: inferred from
    // `Record<K, …>[K]`, the component type stays generic and `LazyExoticComponent` of a
    // generic is not assignable to a plain `FunctionComponent`.
    Page: lazy<FunctionComponent>(async () => ({ default: (await load())[name] })),
    preload: () => {
      void load()
    },
  }
}

export const ROUTES: readonly AppRoute[] = [
  {
    path: '/',
    labelKey: 'nav.overview',
    Icon: IconOverview,
    ...page(() => import('./pages/Overview.tsx'), 'Overview'),
  },
  {
    path: '/budget',
    labelKey: 'nav.budget',
    Icon: IconBudget,
    ...page(() => import('./pages/Budget.tsx'), 'Budget'),
    nested: true,
  },
  {
    path: '/portfolio',
    labelKey: 'nav.portfolio',
    Icon: IconPortfolio,
    ...page(() => import('./pages/Portfolio.tsx'), 'Portfolio'),
    nested: true,
  },
  {
    path: '/forecast',
    labelKey: 'nav.forecast',
    Icon: IconForecast,
    ...page(() => import('./pages/Forecast.tsx'), 'Forecast'),
  },
  {
    path: '/scenario',
    labelKey: 'nav.scenario',
    Icon: IconScenario,
    ...page(() => import('./pages/Scenario.tsx'), 'Scenario'),
  },
  {
    path: '/insights',
    labelKey: 'nav.insights',
    Icon: IconInsights,
    ...page(() => import('./pages/Insights.tsx'), 'Insights'),
    nested: true,
  },
  {
    path: '/settings',
    labelKey: 'nav.settings',
    Icon: IconSettings,
    ...page(() => import('./pages/Settings.tsx'), 'Settings'),
    nested: true,
  },
]

/** The route whose page owns this path, or `undefined` for a 404. */
export function routeFor(pathname: string): AppRoute | undefined {
  // A trailing slash is the same page; `/budget/` and `/budget` must not disagree.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const normalized = path === '' ? '/' : path
  return ROUTES.find(
    (route) =>
      route.path === normalized ||
      (route.nested === true && normalized.startsWith(`${route.path}/`)),
  )
}
