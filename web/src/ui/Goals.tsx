/**
 * Progress toward each household-stated savings goal (#407).
 *
 * A goal has no balance of its own — `currentCents`/`progressBp` are computed fresh
 * off whichever of `netWorth`'s figures it names, and `monthlyRateCents`/`etaMonth`
 * only exist when `domain/aggregate/goals.ts`'s `projectGoal` had enough trailing
 * months to support a rate. Both arrive already resolved on `OverviewGoal`, so this
 * component only has to decide which line each null means and say so — never invent
 * a percentage, a rate or an ETA the payload didn't send.
 *
 * The eta line compares `etaMonth` against `targetDate` at month precision, because
 * `etaMonth` is itself a month — a goal with no target date at all still gets an eta
 * line, just without the ahead/on-track/behind comparison it has nothing to make.
 *
 * The amounts line builds a `{{current}} of {{target}}` sentence via `t()`, which
 * returns one plain string with no sub-string DOM node `<Money>` could wrap — the
 * same shape `test/privacy-enforcement.test.tsx` already allows for a translated
 * sentence, so the whole rendered line is wrapped in `<Private>` instead. The
 * required-monthly-savings line (#407 extension) is built the same way, for the
 * same reason.
 *
 * The pace badge reuses the global `.badge` component's existing `--ok`/`--warn`/
 * `--alert` modifiers — the same three tones a finding's severity already draws in,
 * so a household learns the colour meaning once rather than once per card.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, formatDate, formatMoney, formatMonth, type OverviewGoal } from '../shared.ts'
import { Private } from './Money.tsx'

export interface GoalsCardProps {
  goals: readonly OverviewGoal[]
}

const PACE_BADGE_CLASS: Record<NonNullable<OverviewGoal['pace']>, string> = {
  onTrack: 'badge--ok',
  atRisk: 'badge--warn',
  behind: 'badge--alert',
}

export function GoalsCard({ goals }: GoalsCardProps): ReactNode {
  const { t, language } = useT()

  return (
    <section className="card">
      <h2 className="card__title">{t('portfolio:goals.title')}</h2>

      {goals.length === 0 ? (
        <p className="muted">{t('portfolio:goals.none')}</p>
      ) : (
        <dl className="metric__rows">
          {goals.map((goal) =>
            goal.status === 'done' ? (
              <div className="metric__row-group" key={goal.id}>
                <div className="metric__row">
                  <dt>
                    {goal.label}
                    <span className="badge badge--ok">{t('portfolio:goals.doneBadge')}</span>
                  </dt>
                </div>
                <p className="metric__note muted">
                  {t('portfolio:goals.doneNote', { date: formatDate(goal.doneAt as string) })}
                </p>
              </div>
            ) : (
              <div className="metric__row-group" key={goal.id}>
                <div className="metric__row">
                  <dt>
                    {goal.label}
                    {goal.pace !== null && (
                      <span className={`badge ${PACE_BADGE_CLASS[goal.pace]}`}>
                        {t(`portfolio:goals.pace.${goal.pace}`)}
                      </span>
                    )}
                  </dt>
                  <dd className="num">
                    {goal.progressBp === null ? t('portfolio:goals.unknownProgress') : formatBp(goal.progressBp)}
                  </dd>
                </div>
                <p className="metric__note muted">
                  {goal.currentCents === null ? (
                    t('portfolio:goals.amountsUnknown')
                  ) : (
                    <Private>
                      {t('portfolio:goals.amounts', {
                        current: formatMoney(goal.currentCents),
                        target: formatMoney(goal.targetCents),
                      })}
                    </Private>
                  )}
                </p>
                {goal.requiredMonthlyCents !== null && (
                  <p className="metric__note muted">
                    <Private>
                      {t('portfolio:goals.required', { amount: formatMoney(goal.requiredMonthlyCents) })}
                    </Private>
                  </p>
                )}
                {goal.categorySiblingCount > 0 && (
                  <p className="metric__note muted">
                    {t('portfolio:goals.sharing', { count: goal.categorySiblingCount })}
                  </p>
                )}
                {goal.trendMonths > 0 && goal.trendFrom !== null && goal.trendTo !== null && (
                  <p className="metric__note muted">
                    {t(goal.kind === 'category' ? 'portfolio:goals.trendCategory' : 'portfolio:goals.trend', {
                      count: goal.trendMonths,
                      from: formatMonth(goal.trendFrom, language),
                      to: formatMonth(goal.trendTo, language),
                    })}
                  </p>
                )}
                {goal.etaMonth !== null && (
                  <p className="metric__note muted">{etaLine(goal, goal.etaMonth, language, t)}</p>
                )}
              </div>
            ),
          )}
        </dl>
      )}
    </section>
  )
}

function etaLine(
  goal: OverviewGoal,
  etaMonth: string,
  language: Parameters<typeof formatMonth>[1],
  t: ReturnType<typeof useT>['t'],
): string {
  if (goal.met === true) return t('portfolio:goals.eta.reached')

  const eta = formatMonth(etaMonth, language)
  if (goal.targetDate === null) return t('portfolio:goals.eta.noTarget', { eta })

  const target = formatDate(goal.targetDate)
  const targetMonth = goal.targetDate.slice(0, 7)
  if (etaMonth < targetMonth) return t('portfolio:goals.eta.ahead', { eta, target })
  if (etaMonth > targetMonth) return t('portfolio:goals.eta.behind', { eta, target })
  return t('portfolio:goals.eta.onTrack', { eta, target })
}
