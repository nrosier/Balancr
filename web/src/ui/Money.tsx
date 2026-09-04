/**
 * Money and holdings quantities, wrapped so privacy mode has something to blur.
 *
 * `filter: blur()` needs a DOM node to apply to, and it needs to reach only the
 * figure — not the label beside it, not the whole card. `data-private` is that
 * node's marker; the CSS rule that reads it lives in `privacy/privacy.css`. The
 * formatted text itself is unchanged by any of this — still selectable, still
 * what a screen reader announces — so these components only ever wrap a string
 * in a `<span>`, never re-derive it.
 *
 * `Private` is the generic form, for a figure that is not `formatMoney` itself —
 * a holdings quantity (`formatQuantity`), or anything else that reads as an
 * amount without being one of the three functions the enforcement test scans
 * for. `Money` and `MicroEur` are the two call-site shapes `format.ts` exports,
 * kept separate so a caller states cents or micro-euros rather than pre-formatting
 * and losing the type that says which.
 */
import type { ReactNode } from 'react'
import { usePrivacy } from '../privacy/PrivacyContext.tsx'
import { formatMicroEur, formatMoney, type MoneyOptions } from '../shared.ts'

export function Private({ children }: { children: ReactNode }): ReactNode {
  const { enabled } = usePrivacy()
  // A tab stop only while there is something to peek at: with privacy mode off,
  // every figure would otherwise gain a stop nobody needs to reach.
  return (
    <span data-private tabIndex={enabled ? 0 : undefined}>
      {children}
    </span>
  )
}

export function Money({
  cents,
  options,
}: {
  cents: number
  options?: MoneyOptions
}): ReactNode {
  return <Private>{formatMoney(cents, options)}</Private>
}

export function MicroEur({ microEur }: { microEur: number }): ReactNode {
  return <Private>{formatMicroEur(microEur)}</Private>
}
