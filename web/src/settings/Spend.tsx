/**
 * What the assistant has cost this month, and what it cost before.
 *
 * Read-only on purpose. The budget itself is `GEMINI_MONTHLY_BUDGET_EUR` in the
 * environment, not a row anyone can raise from a web page: the guard exists so that a
 * runaway loop or a curious afternoon cannot spend real money, and a cap editable by
 * whoever reached the cap is not a cap. What belongs here is the number, early enough
 * to be seen before the month ends.
 *
 * Figures are micro-euros, printed by `formatMicroEur` rather than divided here — one
 * analysis can cost €0,0004, and a page that rounded to cents would show `€ 0,00`
 * beside a button that charges for being pressed. The history is the server's, newest
 * first, and nothing on this panel is summed: `spentMicroEur` is a view over
 * `ai_runs`, which is the only place a month's total is computed.
 *
 * Read-only except for one thing, added with #122: this is where an analysis is started
 * by hand. The data jobs are started from the bar at the top of the page whose figures
 * they produce — `/api/refresh` covers all six of them and refuses `ai` by name — but
 * this one job calls Gemini, and the only screen that can honestly offer it is the one
 * already showing what the month has cost and what is left of the budget. Pressing it
 * anywhere else would be a button with a price the reader cannot see.
 */
import { useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, formatDecimal, formatMicroEur, formatMonth } from '../shared.ts'
import type { AiAvailabilityWire, AiEstimate, RefreshAccepted } from '../shared.ts'
import { Metric } from '../ui/Metric.tsx'
import { Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** A count, Belgian grouping and no decimals: token totals reach six figures. */
const count = (value: number): string => formatDecimal(value, 0)

export function SpendPanel({ settings, state, owner, estimate }: SettingsPanelProps): ReactNode {
  const { t, language } = useT()
  const { ai } = settings

  const exceeded = ai.exceeded ? (
    <div className="notice notice--warn" role="status">
      <p className="notice__lead">{t('settings:ai.exceeded')}</p>
    </div>
  ) : null

  return (
    <Panel
      title={t('settings:ai.title')}
      hint={t('settings:ai.spend', {
        spent: formatMicroEur(ai.spentMicroEur),
        budget: formatMicroEur(ai.budgetMicroEur),
      })}
      notice={exceeded}
    >
      <div className="grid-cards">
        <Metric
          label={t('settings:ai.spent')}
          value={formatMicroEur(ai.spentMicroEur)}
          unknown={t('empty.unknown')}
          note={t('settings:ai.used', { used: formatBp(ai.usedBp) })}
          {...(ai.exceeded ? { tone: 'negative' as const } : {})}
        />
        <Metric
          label={t('settings:ai.remaining')}
          value={formatMicroEur(ai.remainingMicroEur)}
          unknown={t('empty.unknown')}
          rows={[
            { label: t('settings:ai.month'), value: formatMonth(ai.month, language) },
            { label: t('settings:ai.budget'), value: formatMicroEur(ai.budgetMicroEur) },
            { label: t('settings:ai.model.fast'), value: ai.models.fast },
            { label: t('settings:ai.model.deep'), value: ai.models.deep },
          ]}
        />
      </div>

      {ai.availability.enabled ? (
        <Rerun state={state} owner={owner} estimate={estimate} />
      ) : (
        <RerunOff availability={ai.availability} />
      )}

      {ai.history.length === 0 ? null : (
        <>
          <h3 className="panel__subtitle">{t('settings:ai.history')}</h3>
          <ul className="months">
            {ai.history.map((month) => (
              <li className="months__row" key={month.month}>
                <span className="months__month">{formatMonth(month.month, language)}</span>
                <span className="months__cost num">{formatMicroEur(month.costMicroEur)}</span>
                <span className="months__meta muted num">
                  {t('settings:ai.runs')} {count(month.runCount)} ·{' '}
                  {t('settings:ai.tokens.input')} {count(month.inputTokens)} ·{' '}
                  {t('settings:ai.tokens.output')} {count(month.outputTokens)} ·{' '}
                  {t('settings:ai.tokens.cached')} {count(month.cachedTokens)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}

/**
 * The one control on this page that spends money.
 *
 * Two presses rather than one. Everything else on the settings page is undoable — a
 * threshold can be set back, a prompt version can be re-activated — and this is not: the
 * call is made, the tokens are billed, and the month's remaining budget printed two
 * inches above is smaller than it was. A confirm step whose label carries the amount is
 * the cheapest way to make that a decision rather than a click.
 *
 * The price comes first and the button only exists once it has arrived. It is the page's
 * own read of `/api/ai/estimate` — the same number the prompt editor's test run prices
 * itself with, so the two cannot disagree — and it answers a `409` on a deployment that
 * has aggregated nothing, which is a sentence rather than a failure: there is no month to
 * analyse yet and no reason to offer a run.
 *
 * **Over budget it stays pressable.** The server takes that decision, not this button:
 * `POST /api/ai/refresh` accepts the request and the analysis degrades to the cached
 * answer with a banner, which is the documented behaviour of the cost guard and the only
 * way a reader can reach it. Disabling here would be a second cost rule in a different
 * place, and the warning line says what will happen instead.
 *
 * It does not join the refresh bar's polling. That bar waits on job rows, which is right
 * for four jobs that take a second each; an analysis takes as long as Gemini takes, and
 * the honest thing to say is where the result will appear rather than to spin until it
 * does.
 */
function Rerun({
  state,
  owner,
  estimate,
}: Pick<SettingsPanelProps, 'state' | 'owner' | 'estimate'>): ReactNode {
  const { t, language } = useT()
  const [armed, setArmed] = useState(false)
  const [started, setStarted] = useState<RefreshAccepted | null>(null)

  const priced: AiEstimate | null = estimate.data
  // The fresh-deployment answer, same as the prompt editor's: nothing aggregated, so no
  // month to price a run against. Any other failure leaves the section empty rather than
  // offering a button with no price on it. The other `409` from that endpoint — an
  // unavailable model — cannot reach here: this component is not rendered at all in that
  // case, which is the only reason one code can stand for one sentence (#165).
  const noMonth = estimate.error?.code === 'conflict'

  return (
    <section className="rerun">
      <h3 className="panel__subtitle">{t('settings:ai.rerun.title')}</h3>
      <p className="muted">{t('settings:ai.rerun.lede')}</p>

      {noMonth ? <p className="muted">{t('settings:ai.rerun.noMonth')}</p> : null}
      {priced === null ? null : (
        <>
          <p className="muted">
            {t('settings:ai.rerun.price', {
              month: formatMonth(priced.month, language),
              cost: formatMicroEur(priced.estimateMicroEur),
            })}
          </p>
          {priced.allowed || priced.reason === null ? null : (
            <p className="notice notice--warn" role="status">
              {t(`settings:ai.reason.${priced.reason}`)}
            </p>
          )}
          {armed ? (
            <div className="rerun__confirm">
              <button
                type="button"
                className="button"
                disabled={!owner || state.busy}
                onClick={() => {
                  state.ask<RefreshAccepted>(
                    'ai-refresh',
                    'POST',
                    '/api/ai/refresh',
                    undefined,
                    (accepted) => {
                      setArmed(false)
                      setStarted(accepted)
                    },
                  )
                }}
              >
                {state.pending === 'ai-refresh'
                  ? t('settings:ai.rerun.starting')
                  : t('settings:ai.rerun.confirm', {
                      cost: formatMicroEur(priced.estimateMicroEur),
                    })}
              </button>
              <button
                type="button"
                className="button button--quiet"
                disabled={state.busy}
                onClick={() => setArmed(false)}
              >
                {t('settings:ai.rerun.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button button--quiet"
              disabled={!owner || state.busy}
              onClick={() => setArmed(true)}
            >
              {t('settings:ai.rerun.start')}
            </button>
          )}
        </>
      )}

      {started === null ? null : (
        <p className="muted" role="status">
          {t('settings:ai.rerun.started')}
        </p>
      )}
    </section>
  )
}

/**
 * The same section with the button removed and the reason in its place.
 *
 * Not a hidden control: a heading that disappears is read as a feature that was taken
 * away, and the number above it — a budget, a spend of zero — invites exactly the
 * question this answers. The wording is `ai:off.*`, shared with the panel on the
 * insights page, because two catalogues explaining the same three states in different
 * words is how one of them ends up wrong.
 *
 * No estimate is shown. Pricing a run that cannot start is what puts a figure in front
 * of someone as though pressing something would spend it.
 */
function RerunOff({ availability }: { availability: AiAvailabilityWire }): ReactNode {
  const { t } = useT()
  // Never null while `enabled` is false; the type cannot say so at this point.
  const reason = availability.reason ?? 'notConfigured'

  return (
    <section className="rerun">
      <h3 className="panel__subtitle">{t('settings:ai.rerun.title')}</h3>
      <p className="muted">{t(`ai:off.reason.${reason}`)}</p>
      <p className="muted">{t(`ai:off.how.${reason}`)}</p>
    </section>
  )
}
