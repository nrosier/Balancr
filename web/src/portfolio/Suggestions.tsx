/**
 * What would bring the allocation back inside its bands (#41).
 *
 * Every card here is a drift line with a price on it, and it says so: the drift sentence
 * is the same one the table above prints, built from the same `reason` the server
 * attached, because #41's requirement is that no suggestion appears without the figure
 * that motivates it. A card that only said "sell €1.337 of equities" would be an
 * instruction; with the reason it is an argument someone can disagree with.
 *
 * Four things each card has to be honest about, and each of them is a field rather than
 * a paragraph the page invents:
 *
 *  - **What the amount means.** `funding` decides that. `paired` means the trade on the
 *    other side funds it and the amount is the gap; `cash` means the invested total
 *    moves, and closing a gap out of cash takes far more than the gap. Printing the
 *    figure without this would be printing a number that is right in one of two cases.
 *  - **Which instrument, or why none.** A fund only ever comes from the curated universe
 *    (#40). When there is nothing to name, `unavailable` says which of the two reasons
 *    it is, because "no suggestion" and "no fund in your list" need different actions.
 *  - **What acting costs.** The beurstaks block, rendered by `describeTaxEstimate` —
 *    the same function a digest email would call — so the estimate reads identically
 *    everywhere and the browser holds no second copy of the tax vocabulary.
 *  - **What the cost leaves out.** `taxOmits` is never empty for a sale: the realised
 *    gain needs a cost base this app never sees. A total that quietly dropped it would
 *    read as complete.
 *
 * `skipped` is rendered too, at the end. A red band with no suggestion under it is a bug
 * report waiting to be filed, so the page says which threshold suppressed the trade and
 * how big the trade was — the numbers needed to judge the threshold.
 */
import { type ReactNode } from 'react'
import { Trans } from 'react-i18next'
import { assetClassLabel } from '../charts/AllocationChart.tsx'
import { useT, type TFunction } from '../i18n.ts'
import {
  describeTaxEstimate,
  formatBp,
  formatDecimal,
  type Advice,
  type Suggestion,
} from '../shared.ts'
import { Money } from '../ui/Money.tsx'
import { driftSentence } from './Drift.tsx'

/**
 * The catalogue key per enum member, spelled as a total map over the wire type.
 *
 * Not a template string: a new `funding` or a third `unavailable` reason then fails the
 * typecheck here rather than rendering the raw code on screen, which is the whole reason
 * those unions travel as const arrays.
 */
const FUNDING_KEY: Readonly<Record<Suggestion['funding'], string>> = {
  paired: 'portfolio:suggest.funding.paired',
  cash: 'portfolio:suggest.funding.cash',
}

const UNAVAILABLE_KEY: Readonly<Record<NonNullable<Suggestion['unavailable']>, string>> = {
  no_fund_in_universe: 'portfolio:suggest.unavailable.noFundInUniverse',
  not_held: 'portfolio:suggest.unavailable.notHeld',
}

const SKIP_KEY: Readonly<Record<Advice['skipped'][number]['reason'], string>> = {
  inside_tolerance: 'portfolio:suggest.skipped.insideTolerance',
  below_min_trade: 'portfolio:suggest.skipped.belowMinTrade',
}

const OMISSION_KEY: Readonly<Record<Suggestion['taxOmits'][number], string>> = {
  capital_gains: 'portfolio:suggest.omits.capitalGains',
}

/**
 * A TER as a percentage, keeping both digits.
 *
 * Percent to basis points so `formatBp` does the spelling: a 0,12% fund and a 0,22% one
 * differ by the second digit, and that difference is the only reason one of them was
 * picked over the other.
 */
function terText(terPercent: number): string {
  return formatBp(Math.round(terPercent * 100), { maxFractionDigits: 2 })
}

/** The beurstaks on this trade, its provenance, and what it does not include. */
function TaxBlock({
  suggestion,
  t,
  language,
}: {
  suggestion: Suggestion
  t: TFunction
  language: string
}): ReactNode {
  const { tax, taxOmits } = suggestion
  const text = tax === null ? null : describeTaxEstimate(tax, t, language)

  return (
    <div className="suggestion__tax">
      <p className="suggestion__taxHead">
        <span className="suggestion__taxLabel">{t('portfolio:tax.title')}</span>{' '}
        <span className="suggestion__taxTotal">
          {text === null ? t('portfolio:suggest.tax.none') : text.total}
        </span>
      </p>
      {text === null ? null : (
        <ul className="suggestion__taxLines">
          {text.lines.map((line) => (
            <li key={line.rule}>
              <span className="suggestion__taxTerm">{line.term}</span>{' '}
              <span className="suggestion__taxAmount">{line.amount}</span>
              <span className="suggestion__taxDetail">{line.detail}</span>
              {line.todo === undefined ? null : (
                <span className="suggestion__taxTodo">{line.todo}</span>
              )}
              {line.assumptions.map((assumption) => (
                <span className="suggestion__taxDetail" key={assumption}>
                  {assumption}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
      {/*
        Said out loud rather than left out of the total: for a sale the realised gain
        depends on a cost base Ghostfolio does not give us, so the figure above is not
        the whole bill and the page has to be the thing that admits it.
      */}
      {taxOmits.map((omission) => (
        <p className="suggestion__omits" key={omission}>
          {t(OMISSION_KEY[omission])}
        </p>
      ))}
      {text?.caveat === undefined ? null : <p className="suggestion__omits">{text.caveat}</p>}
    </div>
  )
}

/** The instrument a card names, or the reason it names none. */
function Instrument({ suggestion, t }: { suggestion: Suggestion; t: TFunction }): ReactNode {
  const { fund, position, unavailable } = suggestion

  if (fund !== null) {
    return (
      <p className="suggestion__instrument">
        <span className="suggestion__fund">{fund.name}</span>
        <span className="suggestion__isin">{fund.isin}</span>
        <span className="muted">
          {t('portfolio:suggest.fund.meta', {
            ter: terText(fund.terPercent),
            count: fund.alternatives,
          })}
        </span>
      </p>
    )
  }

  if (position !== null) {
    return (
      <p className="suggestion__instrument">
        <span className="suggestion__fund">
          {position.name ?? t('portfolio:suggest.position.unnamed')}
        </span>
        {position.isin === null ? null : <span className="suggestion__isin">{position.isin}</span>}
        <span className="muted">
          <Trans
            i18nKey="portfolio:suggest.position.meta"
            // `held`, not `value`: the count is what `{{value}}` carries in a pluralised
            // key (see `withFormattedCount`), so the money needs a name of its own.
            // `Trans` bypasses `t()`'s wrapper, so `value` is formatted here instead.
            count={position.alternatives}
            values={{ value: formatDecimal(position.alternatives) }}
            components={{ money: <Money cents={position.valueCents} options={{ whole: true }} /> }}
          />
        </span>
      </p>
    )
  }

  // Neither: the class is outside its band and there is nothing to act with. Which of
  // the two reasons it is decides what to go and do, so the code is spelled out rather
  // than reduced to "no instrument available".
  return (
    <p className="notice notice--warn suggestion__blocked">
      {unavailable === undefined
        ? t('portfolio:suggest.unavailable.unknown')
        : t(UNAVAILABLE_KEY[unavailable])}
    </p>
  )
}

function Card({
  suggestion,
  t,
  language,
}: {
  suggestion: Suggestion
  t: TFunction
  language: string
}): ReactNode {
  return (
    <li className="suggestion">
      <p className="suggestion__head">
        <span
          className={`badge ${suggestion.action === 'sell' ? 'badge--warn' : 'badge--info'}`}
        >
          {t(`portfolio:suggest.action.${suggestion.action}`)}
        </span>{' '}
        <span className="suggestion__amount">
          <Money cents={suggestion.amountCents} options={{ whole: true }} />
        </span>{' '}
        <span className="suggestion__class">{assetClassLabel(t, suggestion.assetClass)}</span>
      </p>
      {/*
        The reason, in the table's own words. #41 asks for no suggestion without the
        drift figure that motivates it, and the way to keep that true under later edits
        is for both places to call one function on the one `reason` the server sent.
      */}
      <p className="suggestion__reason">{driftSentence(suggestion.reason, t)}</p>
      <p className="suggestion__funding muted">{t(FUNDING_KEY[suggestion.funding])}</p>
      <Instrument suggestion={suggestion} t={t} />
      <TaxBlock suggestion={suggestion} t={t} language={language} />
    </li>
  )
}

export function Suggestions({ advice }: { advice: Advice }): ReactNode {
  const { t, language } = useT()
  const { suggestions, skipped } = advice

  return (
    <>
      {suggestions.length === 0 ? (
        <p className="panel__hint muted">{t('portfolio:suggest.none')}</p>
      ) : (
        <ul className="suggestion-list">
          {suggestions.map((suggestion) => (
            <Card
              key={`${suggestion.action}:${suggestion.assetClass}`}
              suggestion={suggestion}
              t={t}
              language={language}
            />
          ))}
        </ul>
      )}

      {skipped.length === 0 ? null : (
        <div className="notice notice--info suggestion__skipped" role="status">
          <p className="notice__lead">{t('portfolio:suggest.skipped.title')}</p>
          <ul className="notice__list">
            {skipped.map((skip) => (
              <li key={skip.assetClass}>
                <Trans
                  i18nKey={SKIP_KEY[skip.reason]}
                  values={{
                    name: assetClassLabel(t, skip.assetClass),
                    outside: formatBp(skip.outsideBp),
                    tolerance: formatBp(advice.toleranceBp),
                  }}
                  components={{
                    money: <Money cents={skip.amountCents} options={{ whole: true }} />,
                    money2: <Money cents={advice.minTradeCents} options={{ whole: true }} />,
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
