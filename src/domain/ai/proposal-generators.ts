/**
 * Wires the pure rules in `domain/aggregate/proposal-rules.ts` to Actual, the
 * DB, and the proposal lifecycle — the impure half of #45's nightly generation.
 *
 * No AI call anywhere in this file. A payee match below the rules' confidence
 * bar, or a category with no baseline yet, is silently skipped rather than
 * guessed at a lower bar — that gap is left for the deferred AI-assisted
 * fast-follow issues, not filled here.
 */
import { fetchPayeeCategoryHistory, fetchUncategorisedTransactions } from '../../adapters/actual/queries.ts'
import type { Db } from '../../db/index.ts'
import { endOfMonth, startOfMonth } from '../../util/month.ts'
import type { MonthlyFact } from '../aggregate/spend.ts'
import type { Signal } from '../aggregate/overspend.ts'
import { suggestBudgetAmounts, suggestCategoryForPayee } from '../aggregate/proposal-rules.ts'
import { createProposal, encodeBudgetTarget, ProposalError } from './proposals.ts'

/**
 * One `transaction_category.set` proposal per uncategorised transaction whose
 * payee has a confident history — `createProposal` itself refuses a no-op or
 * a transaction that no longer exists (`transactionCategorySetHandler.diff`
 * calls Actual again to check), so a stale or already-categorised row here
 * just fails to create a proposal rather than throwing.
 */
export async function generateCategoryProposals(db: Db, month: string): Promise<number> {
  const transactions = await fetchUncategorisedTransactions(startOfMonth(month), endOfMonth(month))
  let created = 0

  for (const txn of transactions) {
    if (txn.payeeId === null) continue
    const history = await fetchPayeeCategoryHistory(txn.payeeId)
    const suggestion = suggestCategoryForPayee(history)
    if (suggestion === null) continue

    try {
      await createProposal(db, {
        type: 'transaction_category.set',
        targetRef: txn.id,
        payload: { categoryId: suggestion.categoryId, payeeName: txn.payeeName },
      })
      created += 1
    } catch (error) {
      if (!(error instanceof ProposalError)) throw error
    }
  }

  return created
}

/**
 * One `budget_amount.set` proposal per category the current month's signals
 * flag as miscalibrated. `signals`/`facts` are the same values `judgeMonth`
 * already computed for `computeSignals` — nothing here re-reads them.
 */
export async function generateBudgetProposals(
  db: Db,
  month: string,
  signals: readonly Signal[],
  facts: readonly MonthlyFact[],
): Promise<number> {
  let created = 0

  for (const suggestion of suggestBudgetAmounts(signals, facts)) {
    try {
      await createProposal(db, {
        type: 'budget_amount.set',
        targetRef: encodeBudgetTarget(suggestion.categoryId, month),
        payload: { amountCents: suggestion.amountCents },
      })
      created += 1
    } catch (error) {
      if (!(error instanceof ProposalError)) throw error
    }
  }

  return created
}
