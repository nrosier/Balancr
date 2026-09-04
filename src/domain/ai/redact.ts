/**
 * The only path from Balancr's data to Gemini.
 *
 * `redact` is a pure function from everything the aggregation layer computed to
 * the exact object that will be serialised and sent. Nothing else in the codebase
 * may construct a Gemini payload — the value of a single boundary is that a
 * review of this one file, plus `test/unit/ai-redact.test.ts`, is a review of
 * everything that ever leaves the machine.
 *
 * What crosses: amounts, baselines, deltas, allocation shares, computed metrics,
 * category names, and the user's own descriptions of their categories (they exist
 * precisely so the assistant understands what an envelope is for).
 *
 * What never crosses: payees, memos, transaction ids, account numbers, account
 * names, instrument names, symbols and ISINs. A category flagged `sensitive`
 * crosses as an opaque label plus its COICOP class and nature, so the model can
 * still reason about the amount without learning it is a therapist or a lawyer.
 *
 * Two rules of construction, both deliberate:
 *
 *  1. **Every field is written out by hand.** No object spreads, no `...rest`, no
 *     `JSON.parse(JSON.stringify(x))`. A spread would let a field added upstream
 *     ride along silently, which is the exact failure this module exists to
 *     prevent — and it would do so without a test failing.
 *  2. **Every category and account is addressed by a label**, sensitive or not.
 *     One code path, so there is no "sometimes the id, sometimes a label" branch
 *     for a leak to hide in, and the payload carries no source-system identifier
 *     that could be correlated back if it were ever logged elsewhere.
 */
import type { AccountKind, categoryMeta } from '../../db/schema.ts'
import type { AccountMapRow } from '../aggregate/accounts.ts'
import type { NetWorthSummary } from '../aggregate/networth.ts'
import type { Signal } from '../aggregate/overspend.ts'
import type { MonthlyFact, MonthTotals } from '../aggregate/spend.ts'
import type { DriftState } from '../advice/drift.ts'
import type { DriftPersistence } from '../advice/persistence.ts'
import type { PortfolioMetricsResult } from '../portfolio/metrics.ts'
import type { Severity } from './codes.ts'

export type CategoryMetaRow = typeof categoryMeta.$inferSelect

/**
 * A user description is a free-text field, so it is the one place a whole bank
 * statement could get pasted in. Truncated rather than rejected: the first two
 * hundred characters are the answer to "what is this for", and everything after
 * them is not something to forward to a third party.
 */
export const PURPOSE_MAX_CHARS = 200

/** Everything the analysis has, before anything is taken away. */
export interface AnalysisBundle {
  /** The month being analysed, `YYYY-MM`. */
  month: string
  /** Output language for the model, as an ISO code. */
  locale: string
  currency: string
  /** One entry per category in the month, with whatever is known about it. */
  categories: readonly BundleCategory[]
  totals: MonthTotals
  /** Trailing months, oldest first, for the model to see a trend. */
  totalsHistory: readonly MonthTotals[]
  netWorth: NetWorthSummary | null
  hygiene: BundleHygiene
  portfolio: BundlePortfolio | null
  /**
   * The portfolio against its risk profile, or null when there is nothing to measure
   * (#183). Reduced to numbers by the collector, like `holdingCount` — see `BundleDrift`.
   */
  drift: BundleDrift | null
  accounts: readonly AccountMapRow[]
  /** Deterministic findings, already computed. The model prioritises, not detects. */
  signals: readonly Signal[]
}

export interface BundleCategory {
  fact: MonthlyFact
  /** Null until the first sync has created the row. */
  meta: CategoryMetaRow | null
}

export interface BundleHygiene {
  scoreBp: number
  uncategorisedCount: number
  uncategorisedCents: number
  mismatchCount: number
}

export interface BundlePortfolio {
  metrics: PortfolioMetricsResult
  /**
   * A count, and nothing else. Which funds are held is the most identifying data
   * in the whole set, so the collector never puts a holding in the bundle: there
   * is then no instrument name for a future field to carry out by accident, and
   * the count is all any statement about the shape of a portfolio needs.
   */
  holdingCount: number
}

/**
 * How far the portfolio is from its profile, already reduced to what may be sent.
 *
 * Counts rather than lists, for the same reason `BundlePortfolio` holds a `holdingCount`
 * and not a holding: a suggestion names an ISIN and a fund, and the position it would come
 * out of, all of which is the most identifying data in the set. Reducing it in the
 * collector rather than in the redactor means there is no instrument name in the bundle at
 * all, so no future field can carry one out by accident.
 *
 * `unmapped` gets the same treatment for a different reason: those are Ghostfolio's own
 * asset-class strings rather than our four-value enum, so they are effectively free text
 * from a system nobody here controls. A count and a total share say everything a narrative
 * can honestly use — "8% of the portfolio is in classes your profile has no band for".
 */
export interface BundleDrift {
  persistence: DriftPersistence
  toleranceBp: number
  minTradeCents: number
  /** How many trades would close the drift, and how many were not worth making. */
  suggestionCount: number
  skippedCount: number
  /** Classes with no band, as a count and a share. Never their labels. */
  unmappedCount: number
  unmappedShareBp: number
}

// ---------------------------------------------------------------------------
//  The payload
// ---------------------------------------------------------------------------

export interface RedactedCategory {
  /** `c1`…`cN`. The only handle the model ever has on a category. */
  label: string
  /** Omitted entirely when the category is sensitive. */
  name?: string
  /** The user's own description, truncated. Omitted when sensitive. */
  purpose?: string
  coicop?: string
  nature?: CategoryMetaRow['nature']
  frequency?: CategoryMetaRow['expectedFrequency']
  /** Whether the cost is shared with the co-parent, which halves what it means. */
  custodyShared?: boolean
  income: boolean
  spentCents: number
  budgetedCents: number
  availableCents: number
  txnCount: number
  /**
   * Still scheduled to leave this envelope before month end (#159). Omitted when
   * zero, which is every past month and every envelope nothing is scheduled from.
   *
   * A cent total and nothing else. Actual's schedules carry a payee, a name and an
   * account, and none of the three ever reaches a type this file can see: the
   * adapter parses them away (`fetchSchedules`), so there is no field here to
   * decide about. Sent because the model is asked to explain an envelope, and
   * "€38 left" reads very differently once "€50 still due" is beside it.
   */
  committedCents?: number
  baselineCents?: number
  deltaBp?: number
  /** Months of history behind `baselineCents`, so thin evidence is visible. */
  baselineMonths?: number
}

export interface RedactedAccount {
  /** `a1`…`aN`. An account name routinely carries the bank and the last digits. */
  label: string
  source: AccountMapRow['source']
  kind: AccountKind
  inNetWorth: boolean
}

export interface RedactedAllocation {
  /** Ghostfolio's asset-class label — a class, never an instrument. */
  assetClass: string
  valueCents: number
  shareBp: number
}

export interface RedactedPortfolio {
  date: string
  totalValueCents: number
  /**
   * The two halves of the total. Sent because `twrBp` is a return over the whole of
   * it, cash included, and a model told only the total would read that return as the
   * performance of an invested portfolio. `allocation` is over the invested half, so
   * without these two the shares would not reconcile against the total either.
   */
  investedValueCents: number
  cashValueCents: number
  /** Ghostfolio's own figure, copied. Null when it did not report one. */
  twrBp: number | null
  holdingCount: number
  allocation: RedactedAllocation[]
}

export interface RedactedDriftLine {
  /** One of four fixed ids. Never a fund, never a position. */
  assetClass: string
  shareBp: number
  minBp: number
  targetBp: number
  maxBp: number
  state: DriftState
  /** Distance past the edge it is outside, zero when inside. */
  outsideBp: number
  /** Signed as `drift.ts` defines it: positive means short of target. */
  gapCents: number
  /** Consecutive month ends on this side of the band, ending now. 0 when inside. */
  monthsOutside: number
}

/**
 * The drift block: figures to explain, not to recompute.
 *
 * Every number here was computed by `buildAdvice` and `driftPersistence` from the same
 * snapshot the portfolio page reads, through the same function — which is what makes
 * "the narrative's figures match the page exactly" a property of the code rather than a
 * test somebody has to keep writing. The band edges travel with the share because a
 * model told only "76%" would have to be told the ceiling in prose to say anything, and
 * prose is where a number gets rounded.
 */
export interface RedactedDrift {
  /** One of four fixed profile ids, `custom` included. Not a name anybody typed. */
  profile: string
  isPreset: boolean
  toleranceBp: number
  minTradeCents: number
  /**
   * Usable month-end observations behind `monthsOutside`, so the model can tell "one
   * month outside" from "one month of history". Without it a fresh install reads as
   * reassuring.
   */
  monthsObserved: number
  lines: RedactedDriftLine[]
  suggestionCount: number
  skippedCount: number
  unmappedCount: number
  unmappedShareBp: number
}

export interface RedactedSignal {
  code: Signal['code']
  /**
   * What the signal is about: an opaque `c7`/`a2` label, a fixed id, or null.
   *
   * Null means household level, which is what the prompt calls "household". A fixed id
   * — a benchmark group, an asset class — is sent as itself, because it is one of a
   * closed set of published or built-in strings and nothing anybody typed. Sending it is
   * what lets the model rank two of them: `sourceIndex` keys on `(code, label)`, so ten
   * `above_benchmark` signals labelled "household" were nine signals the model could not
   * refer to and one it could, at random (#183).
   */
  label: string | null
  severity: Severity
  metrics: Record<string, number>
}

export interface RedactedMonthTotals {
  month: string
  incomeCents: number
  spentCents: number
  budgetedCents: number
  savingsRateBp: number | null
}

export interface RedactedNetWorth {
  date: string
  totalCents: number
  liquidCents: number
  investedCents: number
  debtCents: number
}

/** Exactly what is sent. Stored verbatim in `ai_runs.payload_json`. */
export interface RedactedPayload {
  month: string
  locale: string
  currency: string
  totals: RedactedMonthTotals
  history: RedactedMonthTotals[]
  netWorth: RedactedNetWorth | null
  hygiene: BundleHygiene
  categories: RedactedCategory[]
  accounts: RedactedAccount[]
  portfolio: RedactedPortfolio | null
  drift: RedactedDrift | null
  signals: RedactedSignal[]
}

export interface Redaction {
  payload: RedactedPayload
  /** Source id → label, for rendering the payload alongside real names locally. */
  labelFor: ReadonlyMap<string, string>
  /** Label → source id, for turning the model's answer back into a real finding. */
  categoryIdFor: ReadonlyMap<string, string>
}

/** Collapses whitespace and cuts to `PURPOSE_MAX_CHARS`. */
function purpose(text: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return null
  return clean.length <= PURPOSE_MAX_CHARS ? clean : `${clean.slice(0, PURPOSE_MAX_CHARS)}…`
}

function toTotals(totals: MonthTotals): RedactedMonthTotals {
  return {
    month: totals.month,
    incomeCents: totals.incomeCents,
    spentCents: totals.spentCents,
    budgetedCents: totals.budgetedCents,
    savingsRateBp: totals.savingsRateBp,
  }
}

function toNetWorth(netWorth: NetWorthSummary): RedactedNetWorth {
  // `contributions` and `excluded` are deliberately dropped: both are per-account
  // and would reintroduce the account dimension the labels exist to remove.
  return {
    date: netWorth.date,
    totalCents: netWorth.totalCents,
    liquidCents: netWorth.liquidCents,
    investedCents: netWorth.investedCents,
    debtCents: netWorth.debtCents,
  }
}

function toCategory(entry: BundleCategory, label: string): RedactedCategory {
  const { fact, meta } = entry
  const sensitive = meta?.sensitive === true

  const out: RedactedCategory = {
    label,
    income: fact.isIncome,
    spentCents: fact.spentCents,
    budgetedCents: fact.budgetedCents,
    availableCents: fact.availableCents,
    txnCount: fact.txnCount,
  }

  if (fact.committedCents > 0) out.committedCents = fact.committedCents

  // The whole point of the flag: a sensitive category keeps its amounts and its
  // shape, and loses everything that says what it is.
  if (!sensitive) {
    out.name = fact.categoryName
    if (meta?.userDescription != null) {
      const described = purpose(meta.userDescription)
      if (described !== null) out.purpose = described
    }
  }

  if (meta !== null) {
    if (meta.coicopCode !== null) out.coicop = meta.coicopCode
    if (meta.nature !== null) out.nature = meta.nature
    out.frequency = meta.expectedFrequency
    out.custodyShared = meta.custodyShared
  }

  if (fact.baseline !== null) {
    out.baselineCents = fact.baseline.baselineCents
    if (fact.baseline.deltaBp !== null) out.deltaBp = fact.baseline.deltaBp
    out.baselineMonths = fact.baseline.monthsUsed
  }

  return out
}

function toAccount(row: AccountMapRow, label: string): RedactedAccount {
  return {
    label,
    source: row.source,
    kind: row.kind,
    inNetWorth: row.includeInNetWorth,
  }
}

function toPortfolio(portfolio: BundlePortfolio): RedactedPortfolio {
  const { metrics } = portfolio
  return {
    date: metrics.date,
    totalValueCents: metrics.totalValueCents,
    investedValueCents: metrics.investedValueCents,
    cashValueCents: metrics.cashValueCents,
    twrBp: metrics.twrBp,
    // A count, not a list — and one the bundle already reduced to a number, so
    // there is no instrument here to omit. Asset-class shares carry everything
    // useful that can be said about the shape of a portfolio.
    holdingCount: portfolio.holdingCount,
    allocation: metrics.allocation.map((slice) => ({
      assetClass: slice.key,
      valueCents: slice.valueCents,
      shareBp: slice.shareBp,
    })),
  }
}

function toDrift(drift: BundleDrift): RedactedDrift {
  const { persistence } = drift
  return {
    profile: persistence.profile,
    isPreset: persistence.isPreset,
    toleranceBp: drift.toleranceBp,
    minTradeCents: drift.minTradeCents,
    monthsObserved: persistence.monthsObserved,
    // Copied field by field rather than spread, so a field added to `PersistentLine`
    // for the portfolio page does not silently become a field in the payload.
    lines: persistence.lines.map((line) => ({
      assetClass: line.assetClass,
      shareBp: line.shareBp,
      minBp: line.minBp,
      targetBp: line.targetBp,
      maxBp: line.maxBp,
      state: line.state,
      outsideBp: line.outsideBp,
      gapCents: line.gapCents,
      monthsOutside: line.monthsOutside,
    })),
    suggestionCount: drift.suggestionCount,
    skippedCount: drift.skippedCount,
    unmappedCount: drift.unmappedCount,
    unmappedShareBp: drift.unmappedShareBp,
  }
}

function toSignal(signal: Signal, labelFor: ReadonlyMap<string, string>): RedactedSignal {
  // Metrics are copied key by key rather than passed through, so the object in
  // the payload cannot alias a live one and a non-numeric value cannot slip in
  // through a `Record<string, number>` that came from JSON at some point.
  const metrics: Record<string, number> = {}
  for (const [key, value] of Object.entries(signal.metrics)) {
    if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value
  }
  return {
    code: signal.code,
    // Three cases, and the middle one is the interesting one. A signal with a category or
    // account behind it is labelled opaquely, and one about something not in the bundle
    // gets no label rather than its name — an unlabelled signal is a bug to find, a
    // leaked name is not. A signal with no id but a name is neither: it is about a
    // benchmark group or an asset class, whose "name" is a fixed id from a closed set
    // rather than user text, so it travels as itself and the model can tell two of them
    // apart. `categoryId === null && categoryName === null` is household level, which is
    // the only thing null has ever meant here.
    label:
      signal.categoryId === null
        ? signal.categoryName
        : labelFor.get(signal.categoryId) ?? null,
    severity: signal.severity,
    metrics,
  }
}

/**
 * Everything the aggregation layer computed → exactly what may be sent.
 *
 * Labels are assigned in id order, not in the bundle's order, so the same
 * category is `c7` in every run. That keeps a stored payload readable against
 * today's data and lets the stable half of the prompt be cached; sorting by
 * salience instead would renumber everything whenever spending moved.
 */
export function redact(bundle: AnalysisBundle): Redaction {
  const labelFor = new Map<string, string>()
  const categoryIdFor = new Map<string, string>()

  const categories = [...bundle.categories].sort((a, b) =>
    a.fact.categoryId < b.fact.categoryId ? -1 : a.fact.categoryId > b.fact.categoryId ? 1 : 0,
  )
  const redactedCategories = categories.map((entry, index) => {
    const label = `c${index + 1}`
    labelFor.set(entry.fact.categoryId, label)
    categoryIdFor.set(label, entry.fact.categoryId)
    return toCategory(entry, label)
  })

  // Accounts are keyed by their source id, which is what a hygiene signal about
  // an unreconciled account carries.
  const accounts = [...bundle.accounts].sort((a, b) =>
    a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0,
  )
  const redactedAccounts = accounts.map((row, index) => {
    const label = `a${index + 1}`
    labelFor.set(row.externalId, label)
    return toAccount(row, label)
  })

  return {
    payload: {
      month: bundle.month,
      locale: bundle.locale,
      currency: bundle.currency,
      totals: toTotals(bundle.totals),
      history: bundle.totalsHistory.map(toTotals),
      netWorth: bundle.netWorth === null ? null : toNetWorth(bundle.netWorth),
      hygiene: {
        scoreBp: bundle.hygiene.scoreBp,
        uncategorisedCount: bundle.hygiene.uncategorisedCount,
        uncategorisedCents: bundle.hygiene.uncategorisedCents,
        mismatchCount: bundle.hygiene.mismatchCount,
      },
      categories: redactedCategories,
      accounts: redactedAccounts,
      portfolio: bundle.portfolio === null ? null : toPortfolio(bundle.portfolio),
      drift: bundle.drift === null ? null : toDrift(bundle.drift),
      signals: bundle.signals.map((signal) => toSignal(signal, labelFor)),
    },
    labelFor,
    categoryIdFor,
  }
}

// ---------------------------------------------------------------------------
//  #216 — a below-threshold categorisation candidate, redacted for a guess
// ---------------------------------------------------------------------------

/** One candidate's own history, before anything is taken away. */
export interface GuessCandidateInput {
  /** Not sent — used only to build `transactionIdFor` after the call returns. */
  transactionId: string
  amountCents: number
  history: readonly { categoryId: string; count: number }[]
}

export interface RedactedGuessCategory {
  /** `c1`…`cN`, scoped to this one batch — never the same namespace as a `redact()` call. */
  label: string
  /** Omitted entirely when the category is sensitive. */
  name?: string
  coicop?: string
  nature?: CategoryMetaRow['nature']
}

export interface RedactedGuessHistoryEntry {
  label: string
  count: number
}

export interface RedactedGuessCandidate {
  /** `t1`…`tN`. The only handle the model ever has on a candidate. */
  clientId: string
  amountCents: number
  history: RedactedGuessHistoryEntry[]
}

/** Exactly what is sent for a category-guess batch. Stored verbatim in `ai_runs.payload_json`. */
export interface RedactedGuessBatch {
  locale: string
  categories: RedactedGuessCategory[]
  candidates: RedactedGuessCandidate[]
}

export interface GuessRedaction {
  payload: RedactedGuessBatch
  /** `t1`…`tN` → the real transaction id, for mapping a grounded guess back to a proposal. */
  transactionIdFor: ReadonlyMap<string, string>
  /** `c1`…`cN` → the real category id, scoped to this one batch. */
  categoryIdFor: ReadonlyMap<string, string>
}

/**
 * A batch of below-threshold candidates → exactly what may be sent for a
 * category guess (#216). Same two rules as `redact`: every field written out
 * by hand, and every category addressed only by an opaque label — no payee
 * name, no memo, and no transaction id ever crosses (only the opaque
 * `clientId` does; `transactionIdFor` maps it back once the response returns).
 *
 * Categories are collected across every candidate in the batch and labelled
 * once, in id order, so a category shared by two candidates is the same label
 * in both rather than two unrelated ones.
 */
export function redactCategoryGuessBatch(
  candidates: readonly GuessCandidateInput[],
  categoryMetaById: ReadonlyMap<string, CategoryMetaRow | null>,
  categoryNameById: ReadonlyMap<string, string>,
  locale: string,
): GuessRedaction {
  const categoryIds = new Set<string>()
  for (const candidate of candidates) {
    for (const sample of candidate.history) categoryIds.add(sample.categoryId)
  }
  const sortedCategoryIds = [...categoryIds].sort()

  const labelForCategory = new Map<string, string>()
  const categoryIdFor = new Map<string, string>()
  const redactedCategories: RedactedGuessCategory[] = sortedCategoryIds.map((categoryId, index) => {
    const label = `c${index + 1}`
    labelForCategory.set(categoryId, label)
    categoryIdFor.set(label, categoryId)

    const meta = categoryMetaById.get(categoryId) ?? null
    const sensitive = meta?.sensitive === true

    const out: RedactedGuessCategory = { label }
    if (!sensitive) {
      const name = categoryNameById.get(categoryId)
      if (name !== undefined) out.name = name
    }
    if (meta !== null) {
      if (meta.coicopCode !== null) out.coicop = meta.coicopCode
      if (meta.nature !== null) out.nature = meta.nature
    }
    return out
  })

  const transactionIdFor = new Map<string, string>()
  const redactedCandidates: RedactedGuessCandidate[] = candidates.map((candidate, index) => {
    const clientId = `t${index + 1}`
    transactionIdFor.set(clientId, candidate.transactionId)
    return {
      clientId,
      amountCents: candidate.amountCents,
      history: candidate.history.map((sample) => ({
        label: labelForCategory.get(sample.categoryId) ?? sample.categoryId,
        count: sample.count,
      })),
    }
  })

  return {
    payload: { locale, categories: redactedCategories, candidates: redactedCandidates },
    transactionIdFor,
    categoryIdFor,
  }
}

/** `PAYLOAD_KEYS`'s counterpart for a `RedactedGuessBatch` — same discipline, own allow-list. */
export const GUESS_PAYLOAD_KEYS: readonly string[] = [
  'locale',
  'categories',
  'candidates',
  'label',
  'name',
  'coicop',
  'nature',
  'clientId',
  'amountCents',
  'history',
  'count',
]

/**
 * The complete set of keys a payload may contain, at any depth.
 *
 * Asserted by `test/unit/ai-redact.test.ts` against a fully populated fixture, so
 * adding a field to the payload without deciding it is safe to send fails the
 * build. A denylist catches the values you thought of; this catches the field you
 * did not.
 *
 * One exception, checked separately: the walk does not descend into a signal's
 * `metrics`, whose keys are metric names chosen by whichever producer emitted the
 * signal. That object is instead asserted to hold nothing but finite numbers, so
 * no free text can arrive through it either way.
 */
export const PAYLOAD_KEYS: readonly string[] = [
  // top level
  'month',
  'locale',
  'currency',
  'totals',
  'history',
  'netWorth',
  'hygiene',
  'categories',
  'accounts',
  'portfolio',
  'drift',
  'signals',
  // totals & history
  'incomeCents',
  'spentCents',
  'budgetedCents',
  'savingsRateBp',
  // net worth
  'date',
  'totalCents',
  'liquidCents',
  'investedCents',
  'debtCents',
  // hygiene
  'scoreBp',
  'uncategorisedCount',
  'uncategorisedCents',
  'mismatchCount',
  // categories
  'label',
  'name',
  'purpose',
  'coicop',
  'nature',
  'frequency',
  'custodyShared',
  'income',
  'availableCents',
  'txnCount',
  'committedCents',
  'baselineCents',
  'deltaBp',
  'baselineMonths',
  // accounts
  'source',
  'kind',
  'inNetWorth',
  // portfolio
  'totalValueCents',
  'investedValueCents',
  'cashValueCents',
  'twrBp',
  'holdingCount',
  'allocation',
  'assetClass',
  'valueCents',
  'shareBp',
  // drift
  'profile',
  'isPreset',
  'toleranceBp',
  'minTradeCents',
  'monthsObserved',
  'lines',
  'minBp',
  'targetBp',
  'maxBp',
  'state',
  'outsideBp',
  'gapCents',
  'monthsOutside',
  'suggestionCount',
  'skippedCount',
  'unmappedCount',
  'unmappedShareBp',
  // signals
  'code',
  'severity',
  'metrics',
]

// ---------------------------------------------------------------------------
//  #217 — a pending budget-amount candidate, redacted for a nudge
// ---------------------------------------------------------------------------

/** One pending `budget_amount.set` proposal's own numbers, before anything is taken away. */
export interface NudgeCandidateInput {
  categoryId: string
  /** #45's own trailing-average suggestion — what the nudge may adjust. */
  suggestedCents: number
  /** The category's current budgeted amount, for context. */
  currentCents: number
  /** Null when the category has no baseline yet. */
  baselineCents: number | null
}

export interface RedactedNudgeCandidate {
  /** `c1`…`cN`, scoped to this one batch — never the same namespace as a `redact()` call. */
  label: string
  /** Omitted entirely when the category is sensitive. */
  name?: string
  suggestedCents: number
  currentCents: number
  baselineCents?: number
}

/** Exactly what is sent for a budget-nudge batch. Stored verbatim in `ai_runs.payload_json`. */
export interface RedactedNudgeBatch {
  month: string
  locale: string
  /** The owner's own words, collapsed and truncated — never a category's own description. */
  note: string
  candidates: RedactedNudgeCandidate[]
}

export interface NudgeRedaction {
  payload: RedactedNudgeBatch
  /** `c1`…`cN` → the real category id, scoped to this one batch. */
  categoryIdFor: ReadonlyMap<string, string>
}

/**
 * The pending budget-amount candidates for one month → exactly what may be sent
 * for a nudge (#217). Same two rules as `redact`: every field written out by
 * hand, and every category addressed only by an opaque label — assigned in
 * sorted-id order, same discipline as `redactCategoryGuessBatch`.
 */
export function redactBudgetNudgeBatch(
  candidates: readonly NudgeCandidateInput[],
  categoryMetaById: ReadonlyMap<string, CategoryMetaRow | null>,
  month: string,
  locale: string,
  note: string,
): NudgeRedaction {
  const sorted = [...candidates].sort((a, b) => a.categoryId.localeCompare(b.categoryId))

  const categoryIdFor = new Map<string, string>()
  const redactedCandidates: RedactedNudgeCandidate[] = sorted.map((candidate, index) => {
    const label = `c${index + 1}`
    categoryIdFor.set(label, candidate.categoryId)

    const meta = categoryMetaById.get(candidate.categoryId) ?? null
    const sensitive = meta?.sensitive === true

    const out: RedactedNudgeCandidate = {
      label,
      suggestedCents: candidate.suggestedCents,
      currentCents: candidate.currentCents,
    }
    if (!sensitive && meta !== null) out.name = meta.nameSnapshot
    if (candidate.baselineCents !== null) out.baselineCents = candidate.baselineCents
    return out
  })

  return {
    payload: { month, locale, note, candidates: redactedCandidates },
    categoryIdFor,
  }
}

/** `PAYLOAD_KEYS`'s counterpart for a `RedactedNudgeBatch` — same discipline, own allow-list. */
export const NUDGE_PAYLOAD_KEYS: readonly string[] = [
  'month',
  'locale',
  'note',
  'candidates',
  'label',
  'name',
  'suggestedCents',
  'currentCents',
  'baselineCents',
]
