/**
 * The frame the five panels share, and the two lines every form field needs.
 *
 * Five cards with a heading, a sentence of explanation and a body is not worth five
 * copies — but the reason it is a component rather than a snippet is the explanation.
 * Every panel here changes something whose effect is not visible on this screen:
 * thresholds apply on the next aggregation pass, a prompt applies on the next run,
 * grouping two accounts changes a figure on the overview. A card with room for that
 * sentence is what stops each panel from having to invent somewhere to put it.
 *
 * `Issue` is the other half of `state.issue()`. A rejected field has to say so beside
 * itself — a form that reported "the request body was not valid" at the top and left
 * eighteen inputs looking fine would be telling the truth and helping nobody.
 */
import type { ReactNode } from 'react'

export interface PanelProps {
  title: string
  /** What this panel changes, and when it takes effect. */
  hint?: string
  /** Shown between the hint and the body: viewer-only, budget exceeded, no accounts. */
  notice?: ReactNode
  children: ReactNode
}

export function Panel({ title, hint, notice, children }: PanelProps): ReactNode {
  return (
    <section className="card panel">
      <h2 className="card__title">{title}</h2>
      {hint === undefined ? null : <p className="panel__hint muted">{hint}</p>}
      {notice}
      {children}
    </section>
  )
}

/**
 * What the server said about one field, or nothing.
 *
 * `role="alert"` rather than a plain paragraph: the message appears after a request
 * that a keyboard user pressed with focus still on the button, and without it the
 * only signal is a red line somewhere below the fold.
 */
export function Issue({ message }: { message: string | undefined }): ReactNode {
  if (message === undefined) return null
  return (
    <p className="field__issue" role="alert">
      {message}
    </p>
  )
}
