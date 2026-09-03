/**
 * A tax estimate as sentences — the part the user reads (#42).
 *
 * Split from `estimate.ts` the way the finding renderer is split from the findings: the
 * estimate is numbers and provenance, this turns them into a language, and neither knows
 * about the other's concerns. That is what lets the same estimate render identically in
 * the browser and in a digest email, in Dutch or in English, without a second copy of the
 * rule that a capped beurstaks says so.
 *
 * **Pure**, like `domain/ai/vars.ts` and for the same reason: `i18n/format.ts` and the
 * tax types, nothing else. No `config`, no i18next instance, no `node:` anything, so a
 * bundler can take it. A translator arrives as `translate`, which the server binds to a
 * language and the browser to react-i18next's own `t`.
 *
 * Two things it deliberately does not do. It never states a rate that is not in the
 * estimate — the catalogue contains no percentages at all, because a rate in a
 * translation is a rate that outlives the file it came from, and the whole point of #42
 * is that rates live in one dated place. And it does not name the instrument in a
 * message: the tax block sits beside the fund it is about, and threading a label through
 * so that every line can repeat it buys nothing except two places for it to disagree.
 */
import {
  formatBp,
  formatDate,
  formatList,
  formatMoney,
  type UiLanguage,
  type Vars,
} from '../../i18n/format.ts'
import type { Assumption, TaxEstimate, TaxLine, UnknownReason } from './estimate.ts'
import type { TaxRuleId } from './rules.ts'

/**
 * `ns:key` and its variables into a sentence, in whatever language the caller is in.
 *
 * The same contract the finding renderer takes, declared here rather than imported so
 * that this module depends on the tax rules and the formatters and nothing else.
 */
export type Translate = (key: string, vars?: Vars) => string

/** The catalogue key for each missing fact, and for each assumption made instead. */
const TODO_KEYS: Readonly<Record<UnknownReason, string>> = {
  fsma_registered: 'portfolio:tax.todo.fsmaRegistered',
  distribution: 'portfolio:tax.todo.distribution',
  interest_component: 'portfolio:tax.todo.interestComponent',
}

const ASSUMPTION_KEYS: Readonly<Record<Assumption, string>> = {
  full_annual_exemption: 'portfolio:tax.assumption.fullExemption',
  debt_claims_from_asset_class: 'portfolio:tax.assumption.debtClaims',
}

export interface TaxLineText {
  readonly rule: TaxRuleId
  /** The tax's name, from the glossary — the wording on a broker statement. */
  readonly term: string
  /** The euro amount, or the range it lies in. */
  readonly amount: string
  /** Why that number: the rate, the cap that bit, the citation, the date. */
  readonly detail: string
  /** What to go and find out, when a missing fact is why there is a range. */
  readonly todo?: string
  /** What the number took for granted, in the caller's own words. */
  readonly assumptions: readonly string[]
}

export interface TaxEstimateText {
  readonly lines: readonly TaxLineText[]
  readonly total: string
  /** Present while any rule in play is still transcribed rather than confirmed. */
  readonly caveat?: string
}

/**
 * Two decimals for a tax rate, against one everywhere else in the app.
 *
 * 0,12% and 1,32% are the two beurstaks rates a Belgian fund investor compares, and at
 * one decimal they read as 0,1% and 1,3% — which loses the digit somebody is checking
 * against their broker's table.
 */
function rate(bp: number): string {
  return formatBp(bp, { maxFractionDigits: 2 })
}

function describeLine(line: TaxLine, translate: Translate): TaxLineText {
  const term = translate(`glossary:${line.rule}.term`)
  const basis = line.basis

  const amount =
    line.amount_cents !== null
      ? formatMoney(line.amount_cents)
      : line.bounds !== undefined
        ? translate('portfolio:tax.amount.range', {
            low: formatMoney(line.bounds.min_cents),
            high: formatMoney(line.bounds.max_cents),
          })
        : translate('common:empty.unknown')

  // The rate half of the detail. Three cases, because a capped amount, an uncapped one
  // and one whose base is still unknown are three different explanations of a figure —
  // and "1,32% of € 1.000" beside a number the cap decided is the misleading one.
  const rateText =
    basis === null
      ? null
      : line.amount_cents === null
        ? translate('portfolio:tax.basis.rateOnly', { rate: rate(basis.rate_bp) })
        : basis.capped && basis.cap_cents !== null
          ? translate('portfolio:tax.basis.capped', {
              rate: rate(basis.rate_bp),
              base: formatMoney(basis.base_cents),
              cap: formatMoney(basis.cap_cents),
            })
          : translate('portfolio:tax.basis.rate', {
              rate: rate(basis.rate_bp),
              base: formatMoney(basis.base_cents),
            })

  const source =
    basis === null
      ? null
      : translate('portfolio:tax.source', {
          citation: basis.citation,
          date: formatDate(basis.last_verified),
        })

  return {
    rule: line.rule,
    term,
    amount,
    // Joined with the separator the rest of the app uses for a subtitle's clauses. The
    // parts are translated; only the dot between them is not, and no language reorders
    // "what the rate was" and "who says so" in a way that a list would fix.
    detail: [rateText, source].filter((part) => part !== null).join(' · '),
    ...(line.unknown === undefined ? {} : { todo: translate(TODO_KEYS[line.unknown]) }),
    assumptions: line.assumptions.map((assumption) => translate(ASSUMPTION_KEYS[assumption])),
  }
}

/**
 * The whole estimate as text.
 *
 * The total has three spellings, and which one appears is the honesty of the whole
 * feature: an exact figure when every line could be computed, a range when the missing
 * facts only choose between known rates, and "at least" when something could not be
 * bounded at all. There is no fourth spelling in which an incomplete estimate is
 * presented as a number.
 */
export function describeTaxEstimate(
  estimate: TaxEstimate,
  translate: Translate,
  lang: UiLanguage,
): TaxEstimateText {
  const total = estimate.complete
    ? translate('portfolio:tax.total.known', { amount: formatMoney(estimate.total_cents) })
    : estimate.total_max_cents !== null
      ? translate('portfolio:tax.total.range', {
          low: formatMoney(estimate.total_min_cents),
          high: formatMoney(estimate.total_max_cents),
        })
      : translate('portfolio:tax.total.atLeast', {
          amount: formatMoney(estimate.total_cents),
        })

  const caveat =
    estimate.transcribed.length === 0
      ? undefined
      : translate('portfolio:tax.caveat.transcribed', {
          rules: formatList(
            estimate.transcribed.map((rule) => translate(`glossary:${rule}.term`)),
            lang,
          ),
        })

  return {
    lines: estimate.lines.map((line) => describeLine(line, translate)),
    total,
    ...(caveat === undefined ? {} : { caveat }),
  }
}
