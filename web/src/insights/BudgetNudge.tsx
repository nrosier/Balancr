/**
 * The one control on this page that can change a number #45 already suggested,
 * rather than only adding to what a model is allowed to say (#217).
 *
 * `suggestBudgetAmounts` looks backward at a trailing average and nothing else, so
 * a dentist bill or an annual renewal reads as ordinary drift the month it lands.
 * This reads the owner's own running note (written on the settings page) beside
 * that month's already-pending `budget_amount.set` proposals, and may adjust one —
 * `createProposal`'s existing same-target supersede is what makes the adjustment
 * show up in `Proposals` below as if #45 had suggested it that way itself.
 *
 * Same two-press, priced-before-spent idiom as `Narrative`'s `Offer`, and the same
 * shared control either way: unlike that one, this stays mounted and pressable
 * after a run rather than being replaced by whatever it just produced — the note or
 * the pending proposals can change again, and pressing it a second time is not
 * asking the same question twice.
 */
import { useState, type ReactNode } from 'react'
import { ApiError, apiSend } from '../api/client.ts'
import { useCsrf } from '../api/csrf.tsx'
import { useResource, useSessionExpiry } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { formatMicroEur, formatMonth, type AiBudgetNudgeRun, type AiEstimate } from '../shared.ts'
import { Private } from '../ui/Money.tsx'

export interface BudgetNudgeProps {
  month: string
  owner: boolean
  /** Re-read `/api/insights` once a nudge has adjusted something. */
  onAdjusted: () => void
}

export function BudgetNudge({ month, owner, onAdjusted }: BudgetNudgeProps): ReactNode {
  const { t, language } = useT()
  const csrf = useCsrf()
  const expired = useSessionExpiry()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<AiBudgetNudgeRun | null>(null)
  const [failure, setFailure] = useState<ApiError | null>(null)

  const estimate = useResource<AiEstimate>(`/api/ai/estimate?kind=budget_nudge&month=${month}`)
  const priced = estimate.data

  const start = (): void => {
    setBusy(true)
    setFailure(null)
    void apiSend<AiBudgetNudgeRun>('POST', '/api/ai/budget-nudge', { month }, csrf)
      .then((outcome) => {
        setBusy(false)
        setArmed(false)
        setDone(outcome)
        // Whatever the outcome, ask again: `estimate` may no longer say the same
        // thing once this month's own last run is in the ledger, and a real
        // adjustment is exactly what `onAdjusted` reloads the page's payload for.
        estimate.reload()
        onAdjusted()
      })
      .catch((cause: unknown) => {
        setBusy(false)
        setArmed(false)
        const error =
          cause instanceof ApiError
            ? cause
            : new ApiError('network_error', 'Balancr could not be reached.', 0, null)
        if (error.code === 'unauthenticated') expired()
        else setFailure(error)
      })
  }

  return (
    <section className="card">
      <h2 className="card__title">{t('ai:budgetNudge.title')}</h2>
      <p className="muted">{t('ai:budgetNudge.lede')}</p>

      {failure === null ? null : (
        <p className="notice notice--warn" role="status">
          {failure.message}
        </p>
      )}

      {done === null ? null : (
        <p className="muted" role="status">
          {done.status === 'ok' ? t('ai:budgetNudge.resultOk') : t(`ai:budgetNudge.reason.${done.reason}`)}
        </p>
      )}

      {priced === null ? null : (
        <div className="rerun">
          <p className="muted">
            <Private>
              {t('ai:budgetNudge.price', {
                month: formatMonth(priced.month, language),
                cost: formatMicroEur(priced.estimateMicroEur),
              })}
            </Private>
          </p>
          {priced.allowed || priced.reason === null ? null : (
            <p className="notice notice--warn" role="status">
              {t(`ai:budgetNudge.reason.${priced.reason}`)}
            </p>
          )}
          {owner ? null : <p className="muted">{t('ai:budgetNudge.owner')}</p>}
          {armed ? (
            <div className="rerun__confirm">
              <button type="button" className="button" disabled={!owner || busy} onClick={start}>
                {busy
                  ? t('ai:budgetNudge.starting')
                  : t('ai:budgetNudge.confirm', { cost: formatMicroEur(priced.estimateMicroEur) })}
              </button>
              <button
                type="button"
                className="button button--quiet"
                disabled={busy}
                onClick={() => setArmed(false)}
              >
                {t('ai:budgetNudge.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button button--quiet"
              disabled={!owner || busy}
              onClick={() => setArmed(true)}
            >
              {t('ai:budgetNudge.start')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
