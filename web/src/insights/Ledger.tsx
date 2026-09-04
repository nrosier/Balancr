/**
 * Every call to Google, and exactly what went in it.
 *
 * This is the privacy claim made checkable from a browser instead of from a SQLite
 * prompt on the host. The rest of the page shows what the model concluded; a page that
 * shows conclusions and hides the input is asking to be trusted, and "category names
 * and amounts only, no payees, no transactions" is a sentence that should not have to
 * be taken on faith.
 *
 * **Every attempt is a row, not only the ones that produced something.** A `capped` or
 * `blocked` run cost nothing and has a payload, and those are the rows most worth
 * reading, because they are the answers that are *missing* from the page above. A
 * `failed` run shows the upstream message verbatim — the only text on this screen
 * Balancr did not write — because a failure that will not say why is
 * indistinguishable from a run that never happened.
 *
 * **The payload is fetched when a row is opened, not with the page.** Twenty redacted
 * bundles of a few thousand tokens each would be most of `/api/insights`, downloaded
 * on every visit to render a list of dates and costs. Mounting `RunPayload` is what
 * starts its request — that is the whole mechanism, and it buys the loading, error,
 * retry and expired-session handling from `DataState` without a second copy of any of
 * it. One row at a time: reading two payloads side by side is not a task anyone has,
 * and a table with four open JSON blobs in it is unreadable.
 *
 * **`cachedTokens` and `durationMs` are deliberately not columns.** Both are on the
 * wire and both belong on the settings screen's cost panel, where the question is what
 * this is costing; here the question is what was sent, and six columns is already the
 * most a phone can scroll through.
 *
 * **Since #158 the rows are the selected month's, and a sentence says so** — but there is
 * no seventh column for the period, because every row would print the same value as the
 * picker above it. The rows that carry no month at all are in here too: a chat turn
 * answers a question rather than a month, and a run that failed before it knew which
 * month it was for has none either. Those are precisely the rows this table exists for,
 * so filtering them out would hide them under every month on the picker.
 */
import { Fragment, useId, useState, type ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import {
  formatDateTime,
  formatDecimal,
  formatMonth,
  type AiRun,
  type AiRunPayload,
} from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { MicroEur } from '../ui/Money.tsx'

/** Belgian grouping, no decimals: a token count is a count. */
const count = (value: number): string => formatDecimal(value, 0)

export interface LedgerProps {
  runs: readonly AiRun[]
  /** The month the rows were narrowed to, or null when nothing is aggregated yet. */
  month: string | null
}

export function Ledger({ runs, month }: LedgerProps): ReactNode {
  const { t, language } = useT()
  const captionId = useId()
  const [opened, setOpened] = useState<string | null>(null)

  return (
    <section className="card">
      <h2 className="card__title">{t('ai:privacy.title')}</h2>
      <p className="muted">{t('ai:privacy.hint')}</p>
      {month === null ? null : (
        <p className="muted">
          {t('ai:privacy.month', { month: formatMonth(month, language) })}
        </p>
      )}
      {runs.length === 0 ? (
        <p className="muted">{t('ai:privacy.none')}</p>
      ) : (
        <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
          <table className="table">
            <caption className="table__caption" id={captionId}>
              {t('ai:privacy.caption', { count: runs.length })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('ai:privacy.column.when')}</th>
                <th scope="col">{t('ai:privacy.column.kind')}</th>
                <th scope="col">{t('ai:privacy.column.model')}</th>
                <th scope="col" className="table__cell--number">
                  {t('ai:privacy.column.tokens')}
                </th>
                <th scope="col" className="table__cell--number">
                  {t('ai:privacy.column.cost')}
                </th>
                <th scope="col">{t('ai:privacy.column.status')}</th>
                {/* The disclosure column has no header worth printing, and a screen
                    reader still needs to be told what the cell in it does. */}
                <th scope="col">
                  <span className="sr-only">{t('ai:privacy.viewPayload')}</span>
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
                      <td className="table__cell--number">
                        {t('ai:privacy.tokens', {
                          input: count(run.inputTokens),
                          output: count(run.outputTokens),
                        })}
                      </td>
                      <td className="table__cell--number">
                        <MicroEur microEur={run.costMicroEur} />
                      </td>
                      <td>
                        <span className={`badge badge--${run.status}`}>
                          {t(`status.${run.status}`)}
                        </span>
                        {run.error === null ? null : (
                          <p className="ledger__error">{run.error}</p>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button button--quiet"
                          aria-expanded={open}
                          onClick={() => setOpened(open ? null : run.id)}
                        >
                          {open ? t('ai:privacy.hidePayload') : t('ai:privacy.viewPayload')}
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr>
                        <td className="ledger__drawer" colSpan={7}>
                          <RunPayload id={run.id} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * One payload, fetched because this component exists.
 *
 * `payload: null` is not an error and is not rendered as one: it means the stored JSON
 * would not parse, the row around it is still true, and saying so is more useful than
 * a red box — it is the audit view reporting a finding about itself.
 */
function RunPayload({ id }: { id: string }): ReactNode {
  const { t } = useT()
  const resource = useResource<AiRunPayload>(
    `/api/insights/runs/${encodeURIComponent(id)}/payload`,
  )

  return (
    <DataState resource={resource}>
      {(run) =>
        run.payload === null ? (
          <p className="muted">{t('ai:privacy.unreadable')}</p>
        ) : (
          <pre className="payload">{JSON.stringify(run.payload, null, 2)}</pre>
        )
      }
    </DataState>
  )
}
