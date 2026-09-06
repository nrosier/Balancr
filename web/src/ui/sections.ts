/**
 * The shape behind every page's own tab strip (#200; reused by #228 and later #229/#230):
 * a section is an id, the path that makes it current, and the catalogue key for its tab
 * label. One generic here rather than a copy per page, per the issues' own instruction to
 * reuse whatever component the first split (Settings, #200) produced.
 *
 * `sectionFor` takes an explicit `fallback` rather than defaulting to `sections[0]`: with
 * `noUncheckedIndexedAccess` that element is `Section<Id> | undefined` to the type system,
 * and every call site already knows which of its own ids is the default tab.
 */
import { useEffect } from 'react'
import { useRouter } from '../router.tsx'

export interface Section<Id extends string> {
  readonly id: Id
  /** Absolute path, the page's own bare path for the default section. */
  readonly path: string
  /** Catalogue key for the tab's label. */
  readonly labelKey: string
}

/**
 * The section an arbitrary path under the page's own route belongs to.
 *
 * Prefix-aware, not exact-match-only, so a subsection path like
 * `/settings/thresholds/baseline` still resolves to `thresholds` — the longest matching
 * `path` wins, so a shorter sibling (`/settings` for `general`) never swallows a more
 * specific one just for appearing first in the list.
 */
export function sectionFor<Id extends string>(
  sections: readonly Section<Id>[],
  pathname: string,
  fallback: Id,
): Id {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const normalized = path === '' ? '/' : path

  let best: Section<Id> | undefined
  for (const section of sections) {
    const matches = normalized === section.path || normalized.startsWith(`${section.path}/`)
    if (matches && (best === undefined || section.path.length > best.path.length)) best = section
  }
  return best?.id ?? fallback
}

/**
 * The active subsection for the current path, defaulting to the first when the path
 * names the section but not a subsection (e.g. the bare `/settings/thresholds`) — and
 * replacing the URL with that default's own path so the tab strip's `exact` `Link`
 * actually lights up. `replace`, not `push`: nobody should be able to back-button into a
 * URL the app itself decided was incomplete.
 */
export function useSubsection<Id extends string>(sections: readonly Section<Id>[]): Id {
  const { path, navigate } = useRouter()
  const first = sections[0]
  if (first === undefined) throw new Error('useSubsection called with no sections')
  const active = sectionFor(sections, path, first.id)

  useEffect(() => {
    const current = sections.find((section) => section.id === active)
    if (current !== undefined && path !== current.path) navigate(current.path, { replace: true })
  }, [path, active, sections, navigate])

  return active
}
