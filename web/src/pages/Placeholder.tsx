/**
 * The frame every view starts from.
 *
 * Issue #28 is the shell, not the content: the five pages exist so the navigation,
 * the routing and the layout can be exercised and tested, and each is replaced
 * wholesale by its own issue (#29 Overview, #30 Budget, #31 Portfolio, #32 Insights,
 * #33 Settings). The headings and ledes are the real ones, so filling a page in means
 * swapping `Placeholder` for `PageHeader` and adding content — not rewriting copy.
 *
 * Translation happens in the page, not here: these props are finished strings. A
 * component that took catalogue keys would be a second translation layer, and the
 * first thing a real page needs is a formatted number, which no key can carry.
 */

import type { ReactNode } from 'react'

export interface PageHeaderProps {
  title: string
  /** One line under the title. Optional — a dense page may not want one. */
  lede?: string
}

export function PageHeader({ title, lede }: PageHeaderProps): ReactNode {
  return (
    <header className="page__header">
      <h1 className="page__title">{title}</h1>
      {lede === undefined ? null : <p className="page__lede">{lede}</p>}
    </header>
  )
}

export interface PlaceholderProps extends PageHeaderProps {
  /** What lands here next, in the operator's language. */
  note: string
}

export function Placeholder({ title, lede, note }: PlaceholderProps): ReactNode {
  return (
    <>
      <PageHeader title={title} {...(lede === undefined ? {} : { lede })} />
      <section className="card">
        <p className="muted">{note}</p>
      </section>
    </>
  )
}
