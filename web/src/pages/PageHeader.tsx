/**
 * The frame every view starts from.
 *
 * All five pages now render their own content, so what is left here is the one thing
 * they share: a heading and a line under it, in the same place, at the same size, so
 * that moving between views does not move the title. This file was
 * `Placeholder.tsx` through the shell issue (#28) and carried a `Placeholder`
 * component beside this one; #29 to #33 replaced each page in turn and #32 took the
 * last of them, which is why the placeholder is gone and the file is named after
 * what remains.
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
