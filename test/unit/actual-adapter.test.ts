import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as api from '@actual-app/api'
import {
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
    ] as const) {
      expect(typeof api[method], method).toBe('function')
    }
  })
})

describe('read-only boundary', () => {
  it('the adapter references no Actual method that mutates the budget', () => {
    // v1 never writes to Actual. The design enforces it by not re-exporting
    // write methods, and this asserts the source keeps that promise.
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
      'setBudgetAmount',
      'setBudgetCarryover',
      'addTransactions',
      'importTransactions',
      'updateTransaction',
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
