/**
 * The debug view of #497: the exact text prepared for the model, and the exact text
 * it sent back, verbatim, for every recorded call.
 *
 * `Ledger.tsx` already shows this same list of runs to answer "what was sent" at the
 * *data* level — a redacted payload object, JSON-printed. This answers a different
 * question, at the *text* level: the literal string a provider's wire body is built
 * from, and the literal string it replied with. Nothing here is redacted a second
 * time — `requestText` is assembled from the same redacted payload `Ledger.tsx`
 * already prints, just concatenated into the shape a model actually reads.
 *
 * Self-fetching, like `StatusPanel`: `/api/settings/ai/runs` is not part of the
 * shared settings payload, and reads the whole ledger rather than one month of it, so
 * it carries its own `useResource` rather than being handed a `runs` prop the way
 * `Ledger.tsx` is fed from `/api/insights`.
 *
 * A `blocked`/`capped` row never called a provider, so its `responseText` is null —
 * that row is exactly the "prepared but never sent" case this view exists to make
 * checkable. `requestText` can also be null, in the rare case a fence-marker in the
 * data made the request itself unassemblable (`tryAssembleRequestText`); that row's
 * request is unrecoverable, not merely unsent, and the two placeholders say which.
 */
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useResource, type Resource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { formatDateTime, type AiRun, type AiRunList, type AiRunPayload } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'

export function AiLog(): ReactNode {
  const { t } = useT()
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const path =
    cursor === undefined
      ? '/api/settings/ai/runs'
      : `/api/settings/ai/runs?before=${encodeURIComponent(cursor)}`
  const page = useResource<AiRunList>(path)
  const captionId = useId()
  const [opened, setOpened] = useState<string | null>(null)
  const [runs, setRuns] = useState<readonly AiRun[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)

  // `page.data` is not cleared when `path` gains a `?before=` (#502) — it still
  // holds the prior page until the new one lands — so appending has to key off
  // the payload's own identity, not off `cursor` changing, or the prior page
  // would be appended a second time the instant "load more" is clicked.
  const seen = useRef<AiRunList | null>(null)
  useEffect(() => {
    if (page.data === null || page.data === seen.current) return
    seen.current = page.data
    const arrived = page.data
    setRuns((prev) => (cursor === undefined ? arrived.runs : [...prev, ...arrived.runs]))
    setNextCursor(arrived.nextCursor)
  }, [page.data, cursor])

  // A synthetic resource, so the accumulated pages can still go through
  // `DataState` unchanged: it already keeps prior rows on screen through a
  // reload and notes a failure above them instead of blanking the page, which
  // is exactly what a failed "load more" should do too.
  const resource: Resource<{ runs: readonly AiRun[] }> = {
    data: runs.length === 0 && page.data === null ? null : { runs },
    error: page.error,
    loading: page.loading,
    reload: page.reload,
  }

  const loadMore = (): void => {
    if (page.error !== null) {
      page.reload()
    } else if (nextCursor !== null) {
      setCursor(nextCursor)
    }
  }

  return (
    <section className="card panel">
      <h2 className="card__title">{t('ai:log.title')}</h2>
      <p className="muted">{t('ai:log.hint')}</p>
      <DataState resource={resource}>
        {({ runs }) =>
          runs.length === 0 ? (
            <p className="muted">{t('ai:log.none')}</p>
          ) : (
            <>
              <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
                <table className="table">
                  <caption className="table__caption" id={captionId}>
                    {t('ai:log.caption', { count: runs.length })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('ai:log.column.when')}</th>
                      <th scope="col">{t('ai:log.column.kind')}</th>
                      <th scope="col">{t('ai:log.column.model')}</th>
                      <th scope="col">{t('ai:log.column.status')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('ai:log.viewTranscript')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => {
                      const open = opened === run.id
                      return (
                        <Fragment key={run.id}>
                          <tr>
                            <th scope="row">{formatDateTime(run.createdAt)}</th>
                            <td>{t(`ai:privacy.kind.${run.kind}`)}</td>
                            <td className="table__cell--code">{run.model}</td>
                            <td>
                              <span className={`badge badge--${run.status}`}>
                                {t(`status.${run.status}`)}
                              </span>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="button button--quiet"
                                aria-expanded={open}
                                onClick={() => setOpened(open ? null : run.id)}
                              >
                                {open ? t('ai:log.hideTranscript') : t('ai:log.viewTranscript')}
                              </button>
                            </td>
                          </tr>
                          {open ? (
                            <tr>
                              <td className="ai-log__drawer" colSpan={5}>
                                <RunTranscript id={run.id} />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {nextCursor === null && page.error === null ? null : (
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={loadMore}
                  disabled={page.loading}
                >
                  {page.error !== null
                    ? t('action.retry')
                    : page.loading
                      ? t('ai:log.loadingMore')
                      : t('ai:log.loadMore')}
                </button>
              )}
            </>
          )
        }
      </DataState>
    </section>
  )
}

/**
 * One run's request and response, side by side, fetched because this component
 * exists — the same on-demand fetch `Ledger.tsx`'s `RunPayload` uses, and the same
 * endpoint, since the payload route already carries both fields (#497).
 */
function RunTranscript({ id }: { id: string }): ReactNode {
  const { t } = useT()
  const resource = useResource<AiRunPayload>(
    `/api/insights/runs/${encodeURIComponent(id)}/payload`,
  )

  return (
    <DataState resource={resource}>
      {(run) => (
        <div className="ai-log__transcript">
          <div>
            <h3 className="ai-log__transcriptTitle">{t('ai:log.request')}</h3>
            {run.requestText === null ? (
              <p className="muted">{t('ai:log.requestUnavailable')}</p>
            ) : (
              <pre className="ai-log__pre">{run.requestText}</pre>
            )}
          </div>
          <div>
            <h3 className="ai-log__transcriptTitle">{t('ai:log.response')}</h3>
            {run.responseText === null ? (
              <p className="muted">{t('ai:log.responseUnavailable')}</p>
            ) : (
              <pre className="ai-log__pre">{run.responseText}</pre>
            )}
          </div>
        </div>
      )}
    </DataState>
  )
}
