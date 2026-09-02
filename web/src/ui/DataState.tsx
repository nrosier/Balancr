/**
 * What a page shows while it has no numbers, and what it shows instead of them.
 *
 * The three non-answers are as much a part of a dashboard as the figures, and each
 * one has a wrong version that looks fine in development:
 *
 *  - **Nothing yet** must be a live region rather than a spinner. Against a local
 *    server this state lasts a few milliseconds, so an animation only ever flashes —
 *    while a screen reader gets told nothing at all.
 *  - **A failure** must carry the request id when the server gave one. The message is
 *    deliberately generic for anything the server did not choose to disclose, so the
 *    id is the only way anyone can find the real cause in the log.
 *  - **No data yet** is not a failure and must not be dressed as one. A fresh
 *    deployment has run no jobs, and the honest answer is "run a sync", not a red
 *    box — and not zero, which is a number someone would act on.
 *
 * A failure *after* a payload has arrived is a fourth case and is treated as neither:
 * a refresh that did not come back does not invalidate what is on screen, so the data
 * stays and the failure is noted above it. Blanking a working page because a reload
 * failed is the behaviour this exists to avoid.
 *
 * The children are a function rather than an element because the payload is what
 * proves the data is there. `{(data) => …}` gets a `T`, not a `T | null`, so no page
 * below this point has to re-check what this component already decided.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import type { Resource } from '../api/resource.tsx'

export interface DataStateProps<T> {
  resource: Resource<T>
  children: (data: T) => ReactNode
  /**
   * True when the payload arrived but holds nothing to show — every field null, every
   * list empty. Only the page knows what that means for its own endpoint.
   */
  isEmpty?: (data: T) => boolean
}

export function DataState<T>({ resource, children, isEmpty }: DataStateProps<T>): ReactNode {
  const { t } = useT()
  const { data, error, loading, reload } = resource

  if (data === null) {
    if (error !== null) {
      return (
        <div className="state">
          <div className="notice notice--error" role="alert">
            {error.message}
            {error.requestId === null ? null : <p className="notice__meta">{error.requestId}</p>}
          </div>
          <button type="button" className="button button--quiet" onClick={reload}>
            {t('action.retry')}
          </button>
        </div>
      )
    }

    // `loading` is false here only in a state that cannot happen — no request, no
    // data, no error — and saying "loading" is the least wrong thing to say about it.
    return (
      <div className="state" aria-busy="true">
        <p className="sr-only" role="status">
          {t('shell.loading')}
        </p>
        <p className="muted">{t('shell.loading')}</p>
      </div>
    )
  }

  if (isEmpty?.(data) === true) {
    return (
      <div className="state">
        <p className="state__title">{t('empty.noData')}</p>
        <p className="muted">{t('empty.noDataHint')}</p>
        <button type="button" className="button button--quiet" onClick={reload}>
          {t('action.refresh')}
        </button>
      </div>
    )
  }

  return (
    <div className="stack" aria-busy={loading ? 'true' : undefined}>
      {error === null ? null : (
        <div className="notice notice--error" role="alert">
          {error.message}
          {error.requestId === null ? null : <p className="notice__meta">{error.requestId}</p>}
        </div>
      )}
      {children(data)}
    </div>
  )
}
