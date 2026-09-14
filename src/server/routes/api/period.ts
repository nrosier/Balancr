/**
 * Turning a bare year into a concrete anchor month, for the several API routes
 * whose period picker can select a year rather than a month (#345).
 *
 * `storedMonths` is already sorted newest-first, so the resolution is one linear
 * scan rather than a query: the latest stored month starting with the requested
 * year, or `${year}-12` when nothing was ever computed for it. Falling back to
 * December rather than null keeps a picked-but-empty year resolvable to a real
 * anchor month, the same way `resolveMonth` in `budget.ts` falls back to the
 * current month rather than 404ing a stale bookmark.
 */
export function resolveYearAnchor(months: readonly string[], year: string): string {
  const latest = months.find((month) => month.startsWith(year))
  return latest ?? `${year}-12`
}
