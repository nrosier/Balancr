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
 */
import type { ReactNode } from 'react'
import {
  IconBudget,
  IconInsights,
  IconOverview,
  IconPortfolio,
  IconSettings,
  type IconProps,
} from './shell/icons.tsx'
import { Budget } from './pages/Budget.tsx'
import { Insights } from './pages/Insights.tsx'
import { Overview } from './pages/Overview.tsx'
import { Portfolio } from './pages/Portfolio.tsx'
import { Settings } from './pages/Settings.tsx'

export interface AppRoute {
  /** Absolute path, no trailing slash except for the root. */
  readonly path: string
  /** Catalogue key in the `common` namespace. */
  readonly labelKey: string
  readonly Icon: (props: IconProps) => ReactNode
  readonly Page: () => ReactNode
  /**
   * Owns every path under its own, not just an exact match. Set only where the page
   * does its own sub-navigation (Settings #200, Insights #228, Budget #230) — every
   * other route still 404s on a nested path (#30 onward), which `nav.tsx`'s
   * `isActive` highlights but this does not resolve to a page.
   */
  readonly nested?: boolean
}

export const ROUTES: readonly AppRoute[] = [
  { path: '/', labelKey: 'nav.overview', Icon: IconOverview, Page: Overview },
  { path: '/budget', labelKey: 'nav.budget', Icon: IconBudget, Page: Budget, nested: true },
  { path: '/portfolio', labelKey: 'nav.portfolio', Icon: IconPortfolio, Page: Portfolio },
  { path: '/insights', labelKey: 'nav.insights', Icon: IconInsights, Page: Insights, nested: true },
  { path: '/settings', labelKey: 'nav.settings', Icon: IconSettings, Page: Settings, nested: true },
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
