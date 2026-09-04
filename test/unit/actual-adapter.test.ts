import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as api from '@actual-app/api'
import {
  ENVELOPE_BUDGET_TYPES,
  EXPECTED_API_VERSION,
  actualHealth,
  type ActualHealth,
} from '../../src/adapters/actual/client.ts'

const installedVersion = (
  JSON.parse(
    readFileSync('node_modules/@actual-app/api/package.json', 'utf8'),
  ) as { version: string }
).version

describe('@actual-app/api pinning', () => {
  it('EXPECTED_API_VERSION tracks the installed package', () => {
    // The package is versioned YY.M against Actual server releases; a mismatch
    // surfaces as `out-of-sync-migrations`, so the guard must not go stale
    // silently when the dependency is bumped.
    expect(EXPECTED_API_VERSION).toBe(installedVersion)
  })

  it('still exposes every method the adapter depends on', () => {
    // The package's own d.ts already deprecated `runQuery` in favour of
    // `aqlQuery`; this catches the next such rename at test time rather than
    // inside a 3am cron run.
    for (const method of [
      'init',
      'downloadBudget',
      'sync',
      'shutdown',
      'aqlQuery',
      'q',
      'getBudgetMonth',
      'getBudgetMonths',
      'getAccountBalance',
      'getServerVersion',
      'getPreferences',
      // The two reads behind the committed figure (#159). Neither is documented
      // in Actual's API reference, which is exactly why they are asserted here.
      'getSchedules',
      'getRules',
    ] as const) {
      expect(typeof api[method], method).toBe('function')
    }
  })
})

describe('budget style (#108)', () => {
  it('counts both of Actual\'s names for envelope budgeting as envelope budgeting', () => {
    // Actual renamed its budget styles: `rollover` became `envelope`, and `report`
    // became `tracking`. The health check tested only the old name, so it warned
    // that an envelope budget was not an envelope budget — on exactly the setup it
    // exists to endorse. Both spellings are current somewhere, so both stay.
    expect(ENVELOPE_BUDGET_TYPES.has('envelope')).toBe(true)
    expect(ENVELOPE_BUDGET_TYPES.has('rollover')).toBe(true)
  })

  it('counts neither name for the tracking style as envelope budgeting', () => {
    // The case the warning is actually for: carryover and available figures assume
    // envelope budgeting, and under this style they do not mean what Balancr says.
    expect(ENVELOPE_BUDGET_TYPES.has('tracking')).toBe(false)
    expect(ENVELOPE_BUDGET_TYPES.has('report')).toBe(false)
  })

  it('tests membership rather than one spelling, which is how the bug happened', () => {
    // A test on the set alone would pass while the check beside it still compared
    // against a single literal. This is the half that regressed.
    const source = readFileSync('src/adapters/actual/client.ts', 'utf8')
    expect(source).toContain('ENVELOPE_BUDGET_TYPES.has(health.budgetType)')
    expect(source.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain("!== 'rollover'")
  })
})

describe('read-only boundary', () => {
  it('the adapter references no Actual method that mutates the budget', () => {
    // Almost every write stays refused by construction: not re-exported, so
    // an accidental call is a compile error rather than a code-review catch.
    // `updateTransaction` and `setBudgetAmount` are the two exceptions (#45)
    // — both live behind `queries.ts`'s `updateTransactionCategory` and
    // `setCategoryBudgetAmount`, both reachable only from an approved,
    // audited proposal's `applyRemote` (`domain/ai/proposals.ts`), so they are
    // removed from this denylist rather than left in it to fail. Every other
    // mutating method stays banned.
    // Comments are stripped first: the guarantee is about code, and the files
    // legitimately *name* write methods while explaining why they are absent.
    const stripComments = (code: string): string =>
      code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    const source = [
      'src/adapters/actual/client.ts',
      'src/adapters/actual/queries.ts',
    ]
      .map((file) => stripComments(readFileSync(file, 'utf8')))
      .join('\n')

    const mutating = [
      'setBudgetCarryover',
      'addTransactions',
      'importTransactions',
      'deleteTransaction',
      'createAccount',
      'updateAccount',
      'closeAccount',
      'deleteAccount',
      'createCategory',
      'updateCategory',
      'deleteCategory',
      'createCategoryGroup',
      'updateCategoryGroup',
      'deleteCategoryGroup',
      'updateNote',
      'createPayee',
      'updatePayee',
      'deletePayee',
      'mergePayees',
      'createRule',
      'updateRule',
      'deleteRule',
      'createSchedule',
      'updateSchedule',
      'deleteSchedule',
      'holdBudgetForNextMonth',
      'resetBudgetHold',
      'runBankSync',
      'importBudget',
      'batchBudgetUpdates',
    ]

    const found = mutating.filter((method) => source.includes(method))
    expect(found).toEqual([])
  })
})

describe('health', () => {
  it('reports closed before anything connects', () => {
    const health = actualHealth()
    expect(health.opened).toBe(false)
    expect(health.serverVersion).toBeNull()
    expect(health.apiVersion).toBe(EXPECTED_API_VERSION)
  })

  it('returns a copy, so callers cannot mutate adapter state', () => {
    const health = actualHealth()
    // The cast is the point: `Readonly<ActualHealth>` stops this at compile time,
    // and the copy stops it at runtime for JavaScript callers.
    ;(health as ActualHealth).opened = true
    expect(actualHealth().opened).toBe(false)
  })
})
