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
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, formatDecimal, formatMicroEur, formatMonth } from '../shared.ts'
import { Metric } from '../ui/Metric.tsx'
import { Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** A count, Belgian grouping and no decimals: token totals reach six figures. */
const count = (value: number): string => formatDecimal(value, 0)

export function SpendPanel({ settings }: SettingsPanelProps): ReactNode {
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
