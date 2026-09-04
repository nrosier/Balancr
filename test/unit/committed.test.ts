/**
 * What is still to come this month (#159), and the recurrence maths under it.
 *
 * Two halves, both load-bearing for different reasons.
 *
 * The expander is a reimplementation of somebody else's engine — Actual's own
 * recurrence rules run through `@rschedule`, which cannot be imported at runtime — so
 * every case here is a claim about what Actual would have said. A quarterly schedule
 * expanded as monthly overstates a projection by three and nothing downstream would
 * notice, which is why the awkward cases (a 31st in a 30-day month, 29 February in a
 * common year, a Sunday the 1st paid on the previous Friday) are pinned rather than
 * assumed.
 *
 * `committedForMonth` is the part that decides what a figure on screen means. Its rules
 * are asymmetric on purpose — an occurrence due today counts as still to come, an
 * inflow never counts at all, an unattributed schedule counts in the month total only —
 * and each of those is a decision in #159 rather than an implementation detail, so each
 * gets a test that would fail if somebody tidied it away.
 */
import { describe, expect, it } from 'vitest'
import type {
  ActualSchedule,
  ScheduleDate,
  ScheduleRecurrence,
} from '../../src/adapters/actual/queries.ts'
import { scheduleCategories } from '../../src/adapters/actual/queries.ts'
import {
  committedForMonth,
  emptyCommitted,
  expandOccurrences,
  type CommittedCategory,
  type CommittedMonth,
} from '../../src/domain/aggregate/committed.ts'

/**
 * A recurrence with Actual's defaults already applied, which is the shape the adapter
 * hands over — every field present, nothing optional left to guess about.
 */
function recurring(overrides: Partial<ScheduleRecurrence> & { start: string }): ScheduleDate {
  return {
    kind: 'recurring',
    recurrence: {
      frequency: 'monthly',
      interval: 1,
      patterns: [],
      skipWeekend: false,
      weekendSolveMode: 'after',
      endMode: 'never',
      endOccurrences: null,
      endDate: null,
      ...overrides,
    },
  }
}

/** € 900 a month out of Rent, unless a test says otherwise. */
function schedule(overrides: Partial<ActualSchedule> = {}): ActualSchedule {
  return {
    id: 'sch-1',
    categoryId: 'cat-rent',
    // Actual's sign convention: negative is money leaving.
    amountCents: -90_000,
    approximate: false,
    completed: false,
    postsTransaction: true,
    nextDate: null,
    date: { kind: 'once', date: '2026-09-28' },
    ...overrides,
  }
}

/** September 2026, whose 1st is a Tuesday and whose 5th and 6th are a weekend. */
const SEPT = { from: '2026-09-01', to: '2026-09-30' }

const expand = (date: ScheduleDate, window = SEPT): string[] =>
  expandOccurrences(date, window.from, window.to)

/** The row for a category, or a failure that names the id rather than `undefined`. */
function row(committed: CommittedMonth, categoryId: string): CommittedCategory {
  const found = committed.categories.get(categoryId)
  if (found === undefined) {
    throw new Error(`no committed row for "${categoryId}"; have ${[...committed.categories.keys()]}`)
  }
  return found
}

describe('expandOccurrences — a schedule that happens once', () => {
  it('yields its date when the date is in the window', () => {
    expect(expand({ kind: 'once', date: '2026-09-15' })).toEqual(['2026-09-15'])
  })

  it('yields nothing when it is not, in either direction', () => {
    expect(expand({ kind: 'once', date: '2026-08-31' })).toEqual([])
    expect(expand({ kind: 'once', date: '2026-10-01' })).toEqual([])
  })

  it('includes both edges of the window', () => {
    expect(expand({ kind: 'once', date: '2026-09-01' })).toEqual(['2026-09-01'])
    expect(expand({ kind: 'once', date: '2026-09-30' })).toEqual(['2026-09-30'])
  })
})

describe('expandOccurrences — daily and weekly', () => {
  it('walks a daily schedule day by day', () => {
    const dates = expand(recurring({ frequency: 'daily', start: '2026-09-01' }), {
      from: '2026-09-01',
      to: '2026-09-05',
    })
    expect(dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'])
  })

  it('jumps to the window rather than stepping through eight months of nothing', () => {
    // Every ten days from New Year's Day: 240 days after 1 January is 29 August, so
    // September holds the 8th, the 18th and the 28th. The interesting part is that
    // nothing has to be counted on the way, so the expander divides instead of
    // looping — the answer has to be identical either way.
    expect(
      expand(recurring({ frequency: 'daily', interval: 10, start: '2026-01-01' })),
    ).toEqual(['2026-09-08', '2026-09-18', '2026-09-28'])
  })

  it('walks a weekly schedule a week at a time', () => {
    expect(expand(recurring({ frequency: 'weekly', start: '2026-09-04' }))).toEqual([
      '2026-09-04',
      '2026-09-11',
      '2026-09-18',
      '2026-09-25',
    ])
  })

  it('counts a fortnightly schedule from its own start, not from the 1st', () => {
    // Started on 21 August, so the fortnights land on the 4th and the 18th. Anchoring
    // to the window instead would put them on the 1st and the 15th — a fortnightly
    // schedule that is wrong about which fortnight it is in.
    expect(
      expand(recurring({ frequency: 'weekly', interval: 2, start: '2026-08-21' })),
    ).toEqual(['2026-09-04', '2026-09-18'])
  })
})

describe('expandOccurrences — monthly', () => {
  it('repeats on the day of the month it started on', () => {
    expect(expand(recurring({ start: '2026-03-15' }))).toEqual(['2026-09-15'])
  })

  it('skips a 31st in a 30-day month rather than clamping it to the 30th', () => {
    // What rschedule does, and the only answer that keeps agreeing with Actual's own
    // "next up" list. A clamp would quietly move a payment into a month it was never
    // due in, which is exactly the kind of silent shift #159 rules out.
    const monthly = recurring({ start: '2026-01-31' })
    expect(expand(monthly)).toEqual([])
    expect(expand(monthly, { from: '2026-08-01', to: '2026-08-31' })).toEqual(['2026-08-31'])
  })

  it('counts a quarterly schedule in quarters', () => {
    const quarterly = recurring({ interval: 3, start: '2026-03-15' })
    expect(expand(quarterly)).toEqual(['2026-09-15'])
    expect(expand(quarterly, { from: '2026-08-01', to: '2026-08-31' })).toEqual([])
  })

  it('reads a negative day pattern back from the end of the month', () => {
    expect(expand(recurring({ patterns: [{ value: -1, type: 'day' }], start: '2026-01-01' }))).toEqual([
      '2026-09-30',
    ])
  })

  it('finds the nth weekday, counting from either end', () => {
    // September 2026: Tuesdays on the 1st, 8th, 15th, 22nd and 29th; Fridays on the
    // 4th, 11th, 18th and 25th.
    expect(expand(recurring({ patterns: [{ value: 2, type: 'TU' }], start: '2026-01-01' }))).toEqual([
      '2026-09-08',
    ])
    expect(expand(recurring({ patterns: [{ value: -1, type: 'FR' }], start: '2026-01-01' }))).toEqual([
      '2026-09-25',
    ])
  })

  it('yields nothing for a fifth Friday in a month with four', () => {
    expect(expand(recurring({ patterns: [{ value: 5, type: 'FR' }], start: '2026-01-01' }))).toEqual([])
  })

  it('yields every pattern in one month, ascending', () => {
    const twice = recurring({
      patterns: [
        { value: 15, type: 'day' },
        { value: 1, type: 'day' },
      ],
      start: '2026-01-01',
    })
    expect(expand(twice)).toEqual(['2026-09-01', '2026-09-15'])
  })

  it('yields nothing before the recurrence started', () => {
    // A schedule created on the 15th and set to the 1st of the month starts next
    // month. rschedule yields nothing before `start`, and a date it never yields must
    // not be counted — nor, below, consume an occurrence budget.
    const first = recurring({ patterns: [{ value: 1, type: 'day' }], start: '2026-09-15' })
    expect(expand(first)).toEqual([])
    expect(expand(first, { from: '2026-10-01', to: '2026-10-31' })).toEqual(['2026-10-01'])
  })
})

describe('expandOccurrences — yearly', () => {
  it('repeats on the same date each year', () => {
    expect(
      expand(recurring({ frequency: 'yearly', start: '2020-09-09' })),
    ).toEqual(['2026-09-09'])
  })

  it('counts a schedule due every second year in years, not months', () => {
    // Started in 2021, so it falls in the odd years: nothing in 2026, something in
    // 2027. An expander that treated `interval` as months would put it in November.
    const biennial = recurring({ frequency: 'yearly', interval: 2, start: '2021-09-09' })
    expect(expand(biennial)).toEqual([])
    expect(expand(biennial, { from: '2027-09-01', to: '2027-09-30' })).toEqual(['2027-09-09'])
  })

  it('has no occurrence on 29 February in a common year, and does not spend one either', () => {
    // 2029, 2030 and 2031 have no 29th, so a schedule limited to two occurrences still
    // has its second one in 2032. Consuming the count on a date that does not exist
    // would end the schedule three years early and quietly drop a real payment.
    const leapDay = recurring({
      frequency: 'yearly',
      start: '2028-02-29',
      endMode: 'after_n_occurrences',
      endOccurrences: 2,
    })
    expect(expand(leapDay, { from: '2029-02-01', to: '2029-02-28' })).toEqual([])
    expect(expand(leapDay, { from: '2032-02-01', to: '2032-02-29' })).toEqual(['2032-02-29'])
  })
})

describe('expandOccurrences — where it ends', () => {
  it('stops on the date the schedule says it stops', () => {
    expect(
      expand(
        recurring({
          frequency: 'daily',
          start: '2026-09-01',
          endMode: 'on_date',
          endDate: '2026-09-03',
        }),
      ),
    ).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
  })

  it('stops after the number of occurrences the schedule says', () => {
    expect(
      expand(
        recurring({
          frequency: 'weekly',
          start: '2026-09-04',
          endMode: 'after_n_occurrences',
          endOccurrences: 2,
        }),
      ),
    ).toEqual(['2026-09-04', '2026-09-11'])
  })

  it('counts occurrences from the start, not from the window', () => {
    // Twelve monthly occurrences from January is the whole of 2026, so September is
    // the ninth and is in. Counting from the window would make every schedule with a
    // limit run twelve months past its end.
    const twelve = recurring({
      start: '2026-01-20',
      endMode: 'after_n_occurrences',
      endOccurrences: 12,
    })
    expect(expand(twelve)).toEqual(['2026-09-20'])
    expect(expand(twelve, { from: '2027-01-01', to: '2027-01-31' })).toEqual([])
  })

  it('treats an occurrence count of zero as a schedule with nothing left', () => {
    expect(
      expand(
        recurring({
          frequency: 'daily',
          start: '2026-09-01',
          endMode: 'after_n_occurrences',
          endOccurrences: 0,
        }),
      ),
    ).toEqual([])
  })
})

describe('expandOccurrences — weekends', () => {
  it('moves a weekend date forward to the Monday, or back to the Friday', () => {
    // 5 September 2026 is a Saturday and the 6th is the Sunday after it.
    const saturday = { patterns: [{ value: 5, type: 'day' as const }], start: '2026-01-01' }
    const sunday = { patterns: [{ value: 6, type: 'day' as const }], start: '2026-01-01' }
    expect(expand(recurring({ ...saturday, skipWeekend: true }))).toEqual(['2026-09-07'])
    expect(expand(recurring({ ...sunday, skipWeekend: true }))).toEqual(['2026-09-07'])
    expect(
      expand(recurring({ ...saturday, skipWeekend: true, weekendSolveMode: 'before' })),
    ).toEqual(['2026-09-04'])
    expect(
      expand(recurring({ ...sunday, skipWeekend: true, weekendSolveMode: 'before' })),
    ).toEqual(['2026-09-04'])
  })

  it('leaves a weekday alone, and leaves a weekend alone when the schedule says nothing', () => {
    const saturday = recurring({ patterns: [{ value: 5, type: 'day' }], start: '2026-01-01' })
    expect(expand(saturday)).toEqual(['2026-09-05'])
    expect(
      expand(recurring({ patterns: [{ value: 7, type: 'day' }], skipWeekend: true, start: '2026-01-01' })),
    ).toEqual(['2026-09-07'])
  })

  it('counts two dates solved onto the same Monday as two payments', () => {
    // 1 August 2026 is a Saturday, the 2nd is the Sunday, and both are paid on the
    // 3rd. Deduping after the shift would lose one of them, and a rent and a car
    // payment that happen to land together are still two payments.
    const both = recurring({
      patterns: [
        { value: 1, type: 'day' },
        { value: 2, type: 'day' },
      ],
      skipWeekend: true,
      start: '2026-01-01',
    })
    expect(expand(both, { from: '2026-08-01', to: '2026-08-31' })).toEqual([
      '2026-08-03',
      '2026-08-03',
    ])
  })

  it('pulls an occurrence into the window from the month after it', () => {
    // 1 November 2026 is a Sunday, so a schedule solving backwards is paid on Friday
    // 30 October: October holds two payments and November holds none. Filtering to
    // the window before the shift would report the opposite, which is where a
    // committed figure would silently be a month out.
    const first = recurring({
      patterns: [{ value: 1, type: 'day' }],
      skipWeekend: true,
      weekendSolveMode: 'before',
      start: '2026-01-01',
    })
    expect(expand(first, { from: '2026-10-01', to: '2026-10-31' })).toEqual([
      '2026-10-01',
      '2026-10-30',
    ])
    expect(expand(first, { from: '2026-11-01', to: '2026-11-30' })).toEqual([])
  })
})

describe('emptyCommitted', () => {
  it('is a month with nothing scheduled', () => {
    expect(emptyCommitted('2026-09')).toEqual({
      month: '2026-09',
      categories: new Map(),
      unallocatedCents: 0,
      unallocatedCount: 0,
      totalCents: 0,
      approximate: false,
    })
  })

  it('refuses something that is not a month', () => {
    expect(() => emptyCommitted('2026-09-01')).toThrow()
  })
})

describe('committedForMonth — which month it will answer for', () => {
  it('reports nothing for a month that is not the month today falls in', () => {
    // A past month's committed figure is zero by definition: whatever was scheduled
    // either happened, and is spend, or did not and never will be.
    for (const month of ['2026-08', '2026-10']) {
      const committed = committedForMonth({
        schedules: [schedule({ date: recurring({ start: '2026-01-28' }) })],
        month,
        today: '2026-09-04',
      })
      expect(committed).toEqual(emptyCommitted(month))
    }
  })

  it('reports the current month', () => {
    const committed = committedForMonth({
      schedules: [schedule()],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(committed.month).toBe('2026-09')
    expect(committed.totalCents).toBe(90_000)
  })
})

describe('committedForMonth — what counts', () => {
  const on = (day: string, overrides: Partial<ActualSchedule> = {}): ActualSchedule =>
    schedule({ date: { kind: 'once', date: day }, ...overrides })

  it('counts an occurrence still to come', () => {
    const committed = committedForMonth({
      schedules: [on('2026-09-28')],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(row(committed, 'cat-rent')).toEqual({
      remainingCents: 90_000,
      toDateCents: 0,
      occurrences: 1,
      approximate: false,
    })
    expect(committed.totalCents).toBe(90_000)
  })

  it('counts one due today as still to come', () => {
    // #159 says "between today and month end", and on the one day a month a bill
    // falls due it may or may not have posted yet. Both answers are wrong on that
    // day; this one is wrong in the direction that warns instead of reassuring.
    const committed = committedForMonth({
      schedules: [on('2026-09-04')],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(row(committed, 'cat-rent').remainingCents).toBe(90_000)
    expect(row(committed, 'cat-rent').occurrences).toBe(1)
  })

  it('keeps one that already fell out of the total, but remembers the amount', () => {
    // Rent paid on the 1st is spend, and counting it again would double it. It is
    // still recorded, because it is what lets the burn-rate projection tell rent from
    // thirty days of groceries.
    const committed = committedForMonth({
      schedules: [on('2026-09-01')],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(row(committed, 'cat-rent')).toEqual({
      remainingCents: 0,
      toDateCents: 90_000,
      occurrences: 0,
      approximate: false,
    })
    expect(committed.totalCents).toBe(0)
  })

  it('ignores a completed schedule, whatever its dates say', () => {
    const committed = committedForMonth({
      schedules: [on('2026-09-28', { completed: true })],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(committed).toEqual(emptyCommitted('2026-09'))
  })

  it('ignores an inflow', () => {
    // A scheduled salary is not a commitment, and netting one against a bill would
    // take the weight off an overspend warning with money that has not arrived.
    const committed = committedForMonth({
      schedules: [on('2026-09-25', { amountCents: 250_000, categoryId: 'cat-income' })],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(committed).toEqual(emptyCommitted('2026-09'))
  })

  it('ignores a schedule for nothing', () => {
    const committed = committedForMonth({
      schedules: [on('2026-09-25', { amountCents: 0 })],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(committed).toEqual(emptyCommitted('2026-09'))
  })

  it('sums every schedule pointing at one envelope', () => {
    const committed = committedForMonth({
      schedules: [
        on('2026-09-10', { id: 'a', categoryId: 'cat-utilities', amountCents: -6_500 }),
        on('2026-09-20', { id: 'b', categoryId: 'cat-utilities', amountCents: -4_000 }),
        on('2026-09-02', { id: 'c', categoryId: 'cat-utilities', amountCents: -1_000 }),
      ],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(row(committed, 'cat-utilities')).toEqual({
      remainingCents: 10_500,
      toDateCents: 1_000,
      occurrences: 2,
      approximate: false,
    })
  })

  it('counts every occurrence of a repeating schedule separately', () => {
    const committed = committedForMonth({
      schedules: [
        schedule({
          categoryId: 'cat-groceries',
          amountCents: -12_000,
          date: recurring({ frequency: 'weekly', start: '2026-09-04' }),
        }),
      ],
      month: '2026-09',
      today: '2026-09-12',
    })
    // The 4th and the 11th have gone; the 18th and the 25th have not.
    expect(row(committed, 'cat-groceries')).toEqual({
      remainingCents: 24_000,
      toDateCents: 24_000,
      occurrences: 2,
      approximate: false,
    })
  })
})

describe("committedForMonth — Actual's own next date", () => {
  /** A monthly 31st, which September does not have — a stand-in for any disagreement. */
  const noSeptember = recurring({ patterns: [{ value: 31, type: 'day' }], start: '2026-01-01' })

  it('counts the cost when Actual says a date this expander did not find', () => {
    // A disagreement between the two resolves toward counting the money, which is the
    // same direction as every other decision here.
    const committed = committedForMonth({
      schedules: [schedule({ date: noSeptember, nextDate: '2026-09-30' })],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(row(committed, 'cat-rent').remainingCents).toBe(90_000)
    expect(row(committed, 'cat-rent').occurrences).toBe(1)
  })

  it('does not count one Actual puts in the past or outside the month', () => {
    // `getNextDate` falls back to the *last* occurrence once a schedule is exhausted,
    // so a next date behind today says the schedule is over, not that a bill is due.
    for (const nextDate of ['2026-09-01', '2026-10-31']) {
      const committed = committedForMonth({
        schedules: [schedule({ date: noSeptember, nextDate })],
        month: '2026-09',
        today: '2026-09-04',
      })
      expect(committed).toEqual(emptyCommitted('2026-09'))
    }
  })

  it('is ignored when the expansion found something, so nothing is counted twice', () => {
    const committed = committedForMonth({
      schedules: [schedule({ date: { kind: 'once', date: '2026-09-28' }, nextDate: '2026-09-28' })],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(row(committed, 'cat-rent').remainingCents).toBe(90_000)
  })
})

describe('committedForMonth — money nobody has attributed', () => {
  it('counts it in the month total only, and says how many', () => {
    // Never attributed to an envelope by inference: the total says the money is
    // coming, the unallocated line says nobody knows out of which envelope.
    const committed = committedForMonth({
      schedules: [
        schedule({ id: 'a', categoryId: null, amountCents: -3_000, date: { kind: 'once', date: '2026-09-20' } }),
        schedule({ id: 'b', date: { kind: 'once', date: '2026-09-28' } }),
      ],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(committed.unallocatedCents).toBe(3_000)
    expect(committed.unallocatedCount).toBe(1)
    expect(committed.totalCents).toBe(93_000)
    // The documented consequence: the total is not the sum of the rows above it.
    expect(row(committed, 'cat-rent').remainingCents).toBe(90_000)
    expect(committed.categories.size).toBe(1)
  })

  it('does not count one whose occurrence has already gone', () => {
    const committed = committedForMonth({
      schedules: [
        schedule({ categoryId: null, date: { kind: 'once', date: '2026-09-01' } }),
      ],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(committed.unallocatedCents).toBe(0)
    expect(committed.unallocatedCount).toBe(0)
    expect(committed.totalCents).toBe(0)
  })
})

describe('committedForMonth — an amount nobody stated exactly', () => {
  it('marks the row and the month when a schedule gives a range', () => {
    // The adapter has already taken the upper bound; this is the flag that lets every
    // screen printing the figure say the amount was not exact.
    const committed = committedForMonth({
      schedules: [
        schedule({ categoryId: 'cat-utilities', amountCents: -8_000, approximate: true, date: { kind: 'once', date: '2026-09-20' } }),
      ],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(row(committed, 'cat-utilities').approximate).toBe(true)
    expect(committed.approximate).toBe(true)
  })

  it('leaves the month exact when the only approximate schedule has already gone', () => {
    // Nothing still to come is uncertain, so there is no caveat to print beside the
    // total. The row keeps its flag, because its `toDateCents` is still an estimate
    // and that figure is what the projection subtracts.
    const committed = committedForMonth({
      schedules: [
        schedule({ categoryId: 'cat-utilities', amountCents: -8_000, approximate: true, date: { kind: 'once', date: '2026-09-01' } }),
      ],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(committed.approximate).toBe(false)
    expect(row(committed, 'cat-utilities').approximate).toBe(true)
  })

  it('stays exact when every schedule states an amount', () => {
    const committed = committedForMonth({
      schedules: [schedule()],
      month: '2026-09',
      today: '2026-09-04',
    })
    expect(committed.approximate).toBe(false)
  })
})

describe('scheduleCategories', () => {
  it('reads the category a rule sets', () => {
    expect(
      scheduleCategories([{ id: 'rule-1', actions: [{ op: 'set', field: 'category', value: 'cat-rent' }] }]),
    ).toEqual(new Map([['rule-1', 'cat-rent']]))
  })

  it('ignores a tombstoned rule', () => {
    // Actual soft-deletes, so a deleted rule is still in the list it hands over.
    expect(
      scheduleCategories([
        { id: 'rule-1', actions: [{ op: 'set', field: 'category', value: 'cat-rent' }], tombstone: true },
      ]),
    ).toEqual(new Map())
  })

  it('ignores every action that is not setting a category', () => {
    expect(
      scheduleCategories([
        {
          id: 'rule-1',
          actions: [
            { op: 'set', field: 'notes', value: 'cat-rent' },
            { op: 'link-schedule', field: 'category', value: 'cat-rent' },
            { op: 'prepend-notes', value: 'x' },
          ],
        },
      ]),
    ).toEqual(new Map())
  })

  it('treats "set the category to nothing" as no attribution at all', () => {
    // Legitimate in Actual, and not a link: a schedule whose rule clears the category
    // belongs in the unallocated line rather than in an envelope called `null`.
    expect(
      scheduleCategories([
        { id: 'rule-1', actions: [{ op: 'set', field: 'category', value: null }] },
        { id: 'rule-2', actions: [{ op: 'set', field: 'category', value: '' }] },
        { id: 'rule-3', actions: [{ op: 'set', field: 'category', value: 42 }] },
      ]),
    ).toEqual(new Map())
  })

  it('keeps one entry per rule across a list', () => {
    expect(
      scheduleCategories([
        { id: 'rule-1', actions: [{ op: 'set', field: 'category', value: 'cat-rent' }] },
        { id: 'rule-2', actions: [] },
        { id: 'rule-3', actions: [{ op: 'set', field: 'category', value: 'cat-utilities' }] },
      ]),
    ).toEqual(
      new Map([
        ['rule-1', 'cat-rent'],
        ['rule-3', 'cat-utilities'],
      ]),
    )
  })
})
