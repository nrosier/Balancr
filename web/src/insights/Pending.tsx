/**
 * The two things the assistant is waiting on, and the honest reason it is still
 * waiting.
 *
 * Both lists are read-only in this version, and that is stated on screen rather than
 * implied by the absence of buttons. Answering a clarification means a round trip that
 * re-analyses the month, and applying a proposal means writing to `category_meta` with
 * an audit row — both belong to the milestone that adds the assistant's chat and the
 * apply handlers (#43–#45). Shipping the queues before the buttons is deliberate: the
 * queue is what tells you the analysis is asking about the right categories, and it is
 * worth reading a version early.
 *
 * Neither list renders anything the model wrote. `domain/ai/clarify.ts` builds the
 * question from the catalogue with the category name resolved locally — a sensitive
 * category never sent one — and `domain/ai/proposals.ts` does the same for the field
 * labels and the privacy warning. What comes from the model is the *guess* and the
 * *value*, and those are the two strings on this screen that are shown as data.
 *
 * The clarification cards show the guess rather than an open question, which is the
 * whole design of the queue: confirming "probably a fixed cost" is one press, while
 * "what kind of cost is this?" is an interrogation. `guessLabel` is the translated
 * label when the answer is one of a fixed set and null when the answer is free text,
 * so the raw guess is the fallback — and an empty guess renders no line at all rather
 * than an empty one.
 *
 * Materiality is on the card because it is why the card exists: the queue only asks
 * about categories above a threshold, and seeing the share makes the threshold legible
 * instead of mysterious.
 *
 * **Neither queue narrows to the month picked at the top of the page, and both say so
 * (#158).** The findings, the review and the run ledger do narrow, because each is a
 * statement about a month. A question and a proposal are not: they are pending work with
 * no period of their own, they stay open until somebody deals with them, and an
 * unanswered question about groceries raised in July would otherwise be invisible on
 * every month of the picker except July. `scoped` is what draws the sentence — there is
 * no picker on a deployment with nothing aggregated, so there is nothing to disclaim.
 *
 * **The proposal queue is no longer read-only (#45).** Answering a question still waits
 * on the assistant's chat, but a proposal can now be applied or rejected from the same
 * card it has always rendered on — the diff was already correct, only the buttons were
 * missing. A single press is enough per item, exactly as the diff invites: there is no
 * money at stake and nothing here is a guess dressed up as a fact. The one confirmation
 * step left is on the bulk "apply selected" action, because that one can touch as many
 * transactions and budgets as are checked at once.
 */
import { useState, type ReactNode } from 'react'
import { ApiError, apiSend } from '../api/client.ts'
import { useCsrf } from '../api/csrf.tsx'
import { useSessionExpiry } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { formatBp, formatDateTime, type Insights, type ProposalBatchApply } from '../shared.ts'

export interface QuestionsProps {
  questions: Insights['questions']
  /** True when a month picker is on screen above, so the list needs the disclaimer. */
  scoped: boolean
}

export function Questions({ questions, scoped }: QuestionsProps): ReactNode {
  const { t } = useT()

  return (
    <section className="card">
      <h2 className="card__title">{t('ai:clarify.title')}</h2>
      <p className="muted">{t('ai:clarify.hint')}</p>
      {scoped ? <p className="muted">{t('ai:clarify.standing')}</p> : null}
      {questions.length === 0 ? (
        <p className="muted">{t('ai:clarify.none')}</p>
      ) : (
        <>
          <ul className="queue">
            {questions.map((question) => {
              const guess = question.guessLabel ?? question.guess
              return (
                <li className="queue__item" key={question.id}>
                  <p className="queue__lead">{question.question}</p>
                  {guess === '' ? null : (
                    <p className="queue__guess">{t('ai:clarify.suggestion', { guess })}</p>
                  )}
                  <p className="queue__meta">
                    {t('ai:clarify.share', { share: formatBp(question.materialityBp) })}
                  </p>
                </li>
              )
            })}
          </ul>
          <p className="muted">{t('ai:clarify.readOnly')}</p>
        </>
      )}
    </section>
  )
}

export interface ProposalsProps {
  proposals: Insights['proposals']
  /** True when a month picker is on screen above, so the list needs the disclaimer. */
  scoped: boolean
  /** Whether this reader may apply or reject — presentation only; the endpoint gates itself. */
  owner: boolean
  /** Re-read `/api/insights` once a decision has been recorded. */
  onDecided: () => void
}

/** A network/auth failure into the shape the two decision paths both need to show. */
function decisionFailure(cause: unknown): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError('network_error', 'Balancr could not be reached.', 0, null)
}

export function Proposals({ proposals, scoped, owner, onDecided }: ProposalsProps): ReactNode {
  const { t } = useT()
  const csrf = useCsrf()
  const expired = useSessionExpiry()

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({})
  const [armed, setArmed] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<ApiError | null>(null)

  // Intersected with the current list rather than trusted on its own: a decision that
  // just succeeded reloads the page's data, which drops the id from `proposals` before
  // this component has any reason to forget it was checked.
  const ids = proposals.map((proposal) => proposal.id)
  const selectedIds = ids.filter((id) => selected.has(id))
  const allSelected = ids.length > 0 && selectedIds.length === ids.length

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(ids))
  }

  function decideOne(id: string, action: 'apply' | 'reject'): void {
    setBusy((prev) => new Set(prev).add(id))
    setRowErrors((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })

    void apiSend(`POST`, `/api/proposals/${id}/${action}`, undefined, csrf)
      .then(() => {
        setSelected((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        onDecided()
      })
      .catch((cause: unknown) => {
        const error = decisionFailure(cause)
        // A vanished session belongs to the application, not to this row.
        if (error.code === 'unauthenticated') expired()
        else setRowErrors((prev) => ({ ...prev, [id]: error.message }))
      })
      .finally(() => {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      })
  }

  /**
   * "Apply selected" has a batch endpoint that reports one result per id — a stale
   * card in the middle of a ten-item selection must not take the other nine down with
   * it. "Reject selected" has no batch route (there is nothing for it to serialise
   * against, unlike an Actual-writing apply), so it is the same single call as the
   * per-row button, looped and reported the same way.
   */
  async function decideSelected(action: 'apply' | 'reject'): Promise<void> {
    setArmed(false)
    setBulkBusy(true)
    setBulkError(null)
    const targets = selectedIds

    try {
      const failed = new Set<string>()
      const errors: Record<string, string> = {}

      if (action === 'apply') {
        const result = await apiSend<ProposalBatchApply>(
          'POST',
          '/api/proposals/apply-batch',
          { ids: targets },
          csrf,
        )
        for (const row of result.results) {
          if (row.ok) continue
          failed.add(row.id)
          errors[row.id] = row.reason ?? ''
        }
      } else {
        for (const id of targets) {
          try {
            await apiSend('POST', `/api/proposals/${id}/reject`, undefined, csrf)
          } catch (cause) {
            const error = decisionFailure(cause)
            if (error.code === 'unauthenticated') {
              expired()
              return
            }
            failed.add(id)
            errors[id] = error.message
          }
        }
      }

      setRowErrors((prev) => ({ ...prev, ...errors }))
      setSelected(failed)
      onDecided()
    } catch (cause) {
      const error = decisionFailure(cause)
      if (error.code === 'unauthenticated') expired()
      else setBulkError(error)
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <section className="card">
      <h2 className="card__title">{t('ai:proposal.title')}</h2>
      <p className="muted">{t('ai:proposal.hint')}</p>
      {scoped ? <p className="muted">{t('ai:proposal.standing')}</p> : null}
      {proposals.length === 0 ? (
        <p className="muted">{t('ai:proposal.none')}</p>
      ) : (
        <>
          <label className="queue__selectAll">
            <input type="checkbox" checked={allSelected} disabled={!owner} onChange={toggleAll} />
            {t('ai:proposal.selectAll')}
          </label>

          <ul className="queue">
            {proposals.map((proposal) => (
              <li className="queue__item" key={proposal.id}>
                <div className="queue__row">
                  <input
                    type="checkbox"
                    checked={selected.has(proposal.id)}
                    disabled={!owner}
                    onChange={() => toggle(proposal.id)}
                    aria-label={t('ai:proposal.select', { target: proposal.targetName })}
                  />
                  <div className="queue__body">
                    <p className="queue__lead">{proposal.targetName}</p>
                    <p className="queue__meta">
                      {proposal.expiresAt === null
                        ? t('ai:proposal.diff')
                        : `${t('ai:proposal.diff')} · ${t('ai:proposal.expiresAt', {
                            when: formatDateTime(proposal.expiresAt),
                          })}`}
                    </p>
                    <dl className="change">
                      {proposal.fields.map((field) => (
                        <div className="change__row" key={field.field}>
                          <dt className="change__field">{field.label}</dt>
                          <dd className="change__values">
                            <span className="change__before">{field.before}</span>
                            {/*
                              Decorative: the order carries the meaning, and the group is
                              already headed "Now / proposed". An arrow read aloud between
                              two values says nothing a screen reader needs.
                            */}
                            <span className="change__arrow" aria-hidden="true">
                              →
                            </span>
                            <span className="change__after">{field.after}</span>
                          </dd>
                          {field.warn === null ? null : (
                            <dd className="change__warn">{field.warn}</dd>
                          )}
                        </div>
                      ))}
                    </dl>
                    {rowErrors[proposal.id] === undefined ? null : (
                      <p className="notice notice--warn" role="status">
                        {rowErrors[proposal.id]}
                      </p>
                    )}
                    <div className="queue__actions">
                      <button
                        type="button"
                        className="button button--quiet"
                        disabled={!owner || busy.has(proposal.id) || bulkBusy}
                        onClick={() => decideOne(proposal.id, 'apply')}
                      >
                        {busy.has(proposal.id) ? t('ai:proposal.applying') : t('ai:proposal.apply')}
                      </button>
                      <button
                        type="button"
                        className="button button--quiet"
                        disabled={!owner || busy.has(proposal.id) || bulkBusy}
                        onClick={() => decideOne(proposal.id, 'reject')}
                      >
                        {t('ai:proposal.reject')}
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {owner ? null : <p className="muted">{t('ai:proposal.ownerOnly')}</p>}

          {bulkError === null ? null : (
            <p className="notice notice--warn" role="status">
              {bulkError.message}
            </p>
          )}

          <div className="rerun">
            {armed ? (
              <div className="rerun__confirm">
                <button
                  type="button"
                  className="button"
                  disabled={bulkBusy}
                  onClick={() => void decideSelected('apply')}
                >
                  {bulkBusy
                    ? t('ai:proposal.applying')
                    : t('ai:proposal.confirmApply', { count: selectedIds.length })}
                </button>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={bulkBusy}
                  onClick={() => setArmed(false)}
                >
                  {t('ai:proposal.cancel')}
                </button>
              </div>
            ) : (
              <div className="rerun__confirm">
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={!owner || selectedIds.length === 0 || bulkBusy}
                  onClick={() => setArmed(true)}
                >
                  {t('ai:proposal.applySelected', { count: selectedIds.length })}
                </button>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={!owner || selectedIds.length === 0 || bulkBusy}
                  onClick={() => void decideSelected('reject')}
                >
                  {bulkBusy
                    ? t('ai:proposal.rejecting')
                    : t('ai:proposal.rejectSelected', { count: selectedIds.length })}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
