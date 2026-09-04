/**
 * The one paragraph on this application that a model wrote.
 *
 * Everything else on every screen is a figure Balancr computed or a sentence assembled
 * from the catalogue. This is prose, generated in the language it is read in, and it is
 * inserted as HTML — which is the one thing in `web/` worth arguing for at the call
 * site rather than in a commit message.
 *
 * **Why `dangerouslySetInnerHTML` is the safe option here.** The field arrives from
 * `/api/insights` already rendered: `util/markdown.ts` escapes the model's text
 * *first* and only then emits a fixed list of tags, none of which take attributes —
 * no `href`, no `src`, no `style`, so there is nothing for a payload to hang an
 * injection on. Doing it that way round is what makes the output safe, and it has to
 * happen on the server anyway, because the stored Markdown says `c7` where a category
 * name belongs and only the server can resolve the label. A second Markdown parser in
 * the bundle would be a second sanitiser to keep correct, and would render the labels
 * verbatim.
 *
 * The byline is not decoration. A reader has to be able to tell last night's analysis
 * from one written three weeks ago by a model that has since been swapped out, so the
 * model is named beside the date. `model` is null only if the run behind the narrative
 * has been pruned, which the schema's cascade prevents — the fallback prints the date
 * alone rather than the word "null" or an em dash nobody can interpret.
 *
 * **The heading names the month, since #158.** It used to say "this month in words" over
 * whichever narrative was newest in this language, which on the 3rd of September was
 * August's — correct prose under a wrong heading, and no way to ask for July's at all.
 * The endpoint now answers per month and the picker chooses; the heading has to keep up,
 * because the one thing worse than a missing review is a review of a different month
 * under today's name.
 */
import { useState, type ReactNode } from 'react'
import { ApiError, apiSend } from '../api/client.ts'
import { useCsrf } from '../api/csrf.tsx'
import { useResource, useSessionExpiry } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import {
  formatDateTime,
  formatMicroEur,
  formatMonth,
  type AiEstimate,
  type AiNarrativeRun,
  type Insights,
} from '../shared.ts'
import { Private } from '../ui/Money.tsx'

export interface NarrativeProps {
  narrative: Insights['narrative']
  /** The month on screen, or null on a deployment with nothing aggregated. */
  month: string | null
  /** True once `month` is over. The server's clock decided this, not the browser's. */
  ended: boolean
  /** Whether this reader may spend — presentation only; the endpoint gates itself. */
  owner: boolean
  /** Whether a model can be called here at all. */
  aiEnabled: boolean
  /**
   * When `month`'s facts last actually changed (#162), or null if never
   * computed. Compared against `narrative.generatedAt` to tell a review that
   * is still current from one an edit has since walked past.
   */
  factsChangedAt: string | null
  /** Re-read `/api/insights` once a review has been written. */
  onWritten: () => void
}

export function Narrative({
  narrative,
  month,
  ended,
  owner,
  aiEnabled,
  factsChangedAt,
  onWritten,
}: NarrativeProps): ReactNode {
  const { t, language } = useT()
  // ISO timestamps from the same server clock, both in `Z` form, so this is a
  // correct ordering and not just a string comparison that happens to work.
  const stale =
    narrative !== null && factsChangedAt !== null && factsChangedAt > narrative.generatedAt

  return (
    <section className="card">
      <h2 className="card__title">
        {month === null
          ? t('ai:narrative.title')
          : t('ai:narrative.titleMonth', { month: formatMonth(month, language) })}
      </h2>
      {narrative === null ? (
        <>
          <p className="muted">{t('ai:narrative.none')}</p>
          {/*
            Mounted only when there is nothing to read, which is also the only state the
            offer has anything to say. Its estimate is a request, so a component that
            rendered beside an existing review would price a run nobody can start.
          */}
          {month === null || !aiEnabled ? null : ended ? (
            <Offer month={month} owner={owner} onWritten={onWritten} />
          ) : (
            <p className="muted">
              {t('ai:narrative.offer.notEnded', { month: formatMonth(month, language) })}
            </p>
          )}
        </>
      ) : (
        <>
          {/* Sanitised server-side by `util/markdown.ts`; see the note above. */}
          <div className="prose" dangerouslySetInnerHTML={{ __html: narrative.html }} />
          <p className="muted">
            {narrative.model === null
              ? t('time.lastUpdated', { when: formatDateTime(narrative.generatedAt) })
              : t('ai:narrative.generatedAt', {
                  when: formatDateTime(narrative.generatedAt),
                  model: narrative.model,
                })}
          </p>
          {/*
            An edit landed in this month after this review was written (#162). The
            review itself is still shown above — it is not wrong, just about facts
            that have since moved — and the offer beneath it is the same two-press,
            owner-gated control as the "no narrative yet" case, mounted fresh so its
            own estimate call is for a rewrite, not the first write.
          */}
          {stale && month !== null && aiEnabled && ended ? (
            <>
              <p className="muted">{t('ai:narrative.stale', { when: formatDateTime(factsChangedAt!) })}</p>
              <Offer month={month} owner={owner} onWritten={onWritten} />
            </>
          ) : null}
        </>
      )}
    </section>
  )
}

/**
 * The second control in Balancr that spends money, and the more expensive one (#158).
 *
 * The settings page has the other — a manual analysis, the fast model — and this follows
 * it deliberately rather than inventing a second idiom: the price comes first, the button
 * only exists once the price has arrived, and it takes two presses because the charge is
 * not undoable. What differs is where it lives, and why it has to: a review is written for
 * *one month*, the month is chosen by the picker at the top of this page, and a button on
 * the settings screen could not know which one was on screen.
 *
 * **Only for a month that has ended**, which the caller enforces by not mounting this at
 * all before then — the estimate is a request, and one hook cannot be skipped by an early
 * return. `runNarrative` caches per `(period, locale)` and nothing exposes a rewrite, so a
 * review bought on the 4th would be that month's review for good, written from a tenth of
 * its facts. The server refuses it as well — this is
 * about not offering something that would be refused, and about saying why rather than
 * leaving a reader to wonder where the button went.
 *
 * **Owner only, and the sentence says so.** A viewer sees the same missing review and the
 * same reason it is missing; what they do not get is a control that 403s. Hiding the whole
 * section instead would make a shared deployment look broken to everyone but one person.
 *
 * Over budget it stays pressable, exactly as the settings page's run does: the cost guard
 * one layer down turns an exhausted allowance into a `capped` row and a banner, and a
 * second cost rule in the browser would be a different answer in a different place. The
 * warning line says what will happen.
 *
 * On success it reloads the page's own payload rather than rendering the prose it got
 * back. `/api/insights` is where a narrative is read on every other visit — labels
 * resolved, Markdown sanitised — and a second render path here would be a second place
 * for that to be right.
 */
interface OfferProps {
  month: string
  owner: boolean
  onWritten: () => void
}

function Offer({ month, owner, onWritten }: OfferProps): ReactNode {
  const { t, language } = useT()
  const csrf = useCsrf()
  const expired = useSessionExpiry()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<AiNarrativeRun | null>(null)
  const [failure, setFailure] = useState<ApiError | null>(null)

  // One request, made on mount, and the caller is what decides whether this component
  // exists: an estimate for a month the server would refuse is a price in front of
  // somebody for a button that could never be pressed. `useResource` is a hook and runs
  // whatever this function returns, which is why the "not ended yet" sentence is the
  // caller's and not an early return here.
  const estimate = useResource<AiEstimate>(`/api/ai/estimate?kind=narrative&month=${month}`)
  const priced = estimate.data

  const start = (): void => {
    setBusy(true)
    setFailure(null)
    void apiSend<AiNarrativeRun>('POST', '/api/ai/narrative', { period: month }, csrf)
      .then((outcome) => {
        setBusy(false)
        setArmed(false)
        setDone(outcome)
        // Whatever the outcome: a `capped` run wrote a ledger row this page shows, and a
        // successful one wrote the review the reload is for.
        onWritten()
      })
      .catch((cause: unknown) => {
        setBusy(false)
        setArmed(false)
        const error =
          cause instanceof ApiError
            ? cause
            : new ApiError('network_error', 'Balancr could not be reached.', 0, null)
        // A vanished session belongs to the application, not to this button. See
        // `useRefresh`, which hands the same case over the same way.
        if (error.code === 'unauthenticated') expired()
        else setFailure(error)
      })
  }

  if (done !== null) {
    return (
      <p className="muted" role="status">
        {done.status === 'ok' || done.status === 'cached' ? (
          <Private>{t('ai:narrative.offer.written', { cost: formatMicroEur(done.costMicroEur) })}</Private>
        ) : (
          t(`settings:ai.reason.${done.reason}`)
        )}
      </p>
    )
  }

  return (
    <div className="rerun">
      <p className="muted">{t('ai:narrative.offer.lede')}</p>

      {failure === null ? null : (
        <p className="notice notice--warn" role="status">
          {failure.message}
        </p>
      )}

      {priced === null ? null : (
        <>
          <p className="muted">
            <Private>
              {t('ai:narrative.offer.price', {
                month: formatMonth(priced.month, language),
                cost: formatMicroEur(priced.estimateMicroEur),
              })}
            </Private>
          </p>
          {priced.allowed || priced.reason === null ? null : (
            <p className="notice notice--warn" role="status">
              {t(`settings:ai.reason.${priced.reason}`)}
            </p>
          )}
          {owner ? null : <p className="muted">{t('ai:narrative.offer.owner')}</p>}
          {armed ? (
            <div className="rerun__confirm">
              <button type="button" className="button" disabled={!owner || busy} onClick={start}>
                {busy
                  ? t('ai:narrative.offer.starting')
                  : t('ai:narrative.offer.confirm', {
                      cost: formatMicroEur(priced.estimateMicroEur),
                    })}
              </button>
              <button
                type="button"
                className="button button--quiet"
                disabled={busy}
                onClick={() => setArmed(false)}
              >
                {t('ai:narrative.offer.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button button--quiet"
              disabled={!owner || busy}
              onClick={() => setArmed(true)}
            >
              {t('ai:narrative.offer.start')}
            </button>
          )}
        </>
      )}
    </div>
  )
}
