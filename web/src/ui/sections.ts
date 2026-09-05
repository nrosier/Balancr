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
export interface Section<Id extends string> {
  readonly id: Id
  /** Absolute path, the page's own bare path for the default section. */
  readonly path: string
  /** Catalogue key for the tab's label. */
  readonly labelKey: string
}

/** The section an arbitrary path under the page's own route belongs to. */
export function sectionFor<Id extends string>(
  sections: readonly Section<Id>[],
  pathname: string,
  fallback: Id,
): Id {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const normalized = path === '' ? '/' : path
  return sections.find((section) => section.path === normalized)?.id ?? fallback
}
