/**
 * `isDue` replaces a cron dependency, so it has to be right about the two things
 * cron would have been right about: not firing twice, and not skipping a day
 * around a DST change. Both are tested against explicit UTC instants, because
 * "03:00" is only unambiguous once the zone is named.
 */
import { describe, expect, it } from 'vitest'
import { describeSchedule, isDue, nextRunAt, type Schedule } from '../../src/jobs/schedule.ts'
import { dateIn, hourIn } from '../../src/util/month.ts'

const TZ = 'Europe/Brussels'
const hourly: Schedule = { kind: 'interval', minutes: 60 }
const nightly: Schedule = { kind: 'daily', hour: 3 }
const monthly: Schedule = { kind: 'monthly', day: 4, hour: 3 }

/** Winter, so local time is UTC+1 and nothing here depends on the reader's zone. */
const at = (iso: string) => new Date(iso)

describe('isDue — interval', () => {
  it('is due when it has never run', () => {
    // A fresh container should populate the database now, not in an hour.
    expect(isDue(hourly, at('2026-01-15T10:00:00Z'), null, TZ)).toBe(true)
  })

  it('is not due one minute early', () => {
    expect(
      isDue(hourly, at('2026-01-15T10:59:00Z'), at('2026-01-15T10:00:00Z'), TZ),
    ).toBe(false)
  })

  it('is due exactly on the interval', () => {
    expect(
      isDue(hourly, at('2026-01-15T11:00:00Z'), at('2026-01-15T10:00:00Z'), TZ),
    ).toBe(true)
  })

  it('is due once, not repeatedly, after a long outage', () => {
    // The ticker asks again a minute later; nothing here queues up the six hours
    // that were missed.
    expect(
      isDue(hourly, at('2026-01-15T16:00:00Z'), at('2026-01-15T10:00:00Z'), TZ),
    ).toBe(true)
  })

  it('ignores the time zone entirely', () => {
    // An elapsed-time rule has no calendar in it, so DST cannot touch it.
    const now = at('2026-03-29T02:00:00Z')
    const last = at('2026-03-29T00:30:00Z')
    expect(isDue(hourly, now, last, TZ)).toBe(isDue(hourly, now, last, 'UTC'))
  })
})

describe('isDue — daily', () => {
  it('is due when it has never run, whatever the hour', () => {
    expect(isDue(nightly, at('2026-01-15T14:00:00Z'), null, TZ)).toBe(true)
  })

  it('is not due again the same local day', () => {
    // 04:00 local, having run at 03:05 local.
    expect(
      isDue(nightly, at('2026-01-15T03:00:00Z'), at('2026-01-15T02:05:00Z'), TZ),
    ).toBe(false)
  })

  it('is not due on a new day before the hour', () => {
    // 00:30 local on the 16th.
    expect(
      isDue(nightly, at('2026-01-15T23:30:00Z'), at('2026-01-15T02:05:00Z'), TZ),
    ).toBe(false)
  })

  it('is due on a new local day at the hour', () => {
    // 03:00 local on the 16th.
    expect(
      isDue(nightly, at('2026-01-16T02:00:00Z'), at('2026-01-15T02:05:00Z'), TZ),
    ).toBe(true)
  })

  it('runs late rather than skipping a day it missed', () => {
    // The machine was off overnight and comes up at 14:00 local. Late data is
    // useful; a day-shaped hole in the net-worth series is not.
    expect(
      isDue(nightly, at('2026-01-16T13:00:00Z'), at('2026-01-15T02:05:00Z'), TZ),
    ).toBe(true)
  })

  it('uses the local calendar day, not the UTC one', () => {
    // 00:30 local on the 16th is still the 15th in UTC. A UTC comparison would
    // see the same date as the last run and stay silent all day.
    const now = at('2026-01-15T23:30:00Z')
    const last = at('2026-01-15T02:05:00Z')
    expect(isDue({ kind: 'daily', hour: 0 }, now, last, TZ)).toBe(true)
    expect(isDue({ kind: 'daily', hour: 0 }, now, last, 'UTC')).toBe(false)
  })

  it('still fires at the local hour across the spring DST change', () => {
    // Brussels skips 02:00→03:00 on 2026-03-29. 01:05Z is 03:05 CEST, which is
    // when the pass should run; in UTC that instant reads as 01:05 and the
    // nightly job would silently slip to the following day.
    const now = at('2026-03-29T01:05:00Z')
    const last = at('2026-03-28T02:05:00Z') // 03:05 CET the day before

    expect(hourIn(now, TZ)).toBe(3)
    expect(isDue(nightly, now, last, TZ)).toBe(true)
    expect(isDue(nightly, now, last, 'UTC')).toBe(false)
  })

  it('does not run twice across the autumn DST change', () => {
    // 2026-10-25 has two 02:00s in Brussels. Both instants are the same local
    // calendar day, which is what stops the second one being a second run.
    const last = at('2026-10-25T01:05:00Z') // 03:05 CEST
    const later = at('2026-10-25T04:00:00Z') // 05:00 CET

    expect(dateIn(last, TZ)).toBe(dateIn(later, TZ))
    expect(isDue(nightly, later, last, TZ)).toBe(false)
  })
})

describe('isDue — monthly', () => {
  it('is due when it has never run, whatever the day', () => {
    expect(isDue(monthly, at('2026-01-01T10:00:00Z'), null, TZ)).toBe(true)
  })

  it('is not due before the day, in a month it has not run in yet', () => {
    // Local Jan 3rd, having last run in December.
    expect(
      isDue(monthly, at('2026-01-03T10:00:00Z'), at('2026-12-04T02:05:00Z'), TZ),
    ).toBe(false)
  })

  it('is not due again the same local month', () => {
    // Ran on the 4th; still the 4th's month on the 15th.
    expect(
      isDue(monthly, at('2026-01-15T10:00:00Z'), at('2026-01-04T02:05:00Z'), TZ),
    ).toBe(false)
  })

  it('is due on a new local month, on the day, at the hour', () => {
    // Ran in January; now 03:05 local on Feb 4th.
    expect(
      isDue(monthly, at('2026-02-04T02:05:00Z'), at('2026-01-04T02:05:00Z'), TZ),
    ).toBe(true)
  })

  it('is not due on a new month before the day', () => {
    expect(
      isDue(monthly, at('2026-02-03T10:00:00Z'), at('2026-01-04T02:05:00Z'), TZ),
    ).toBe(false)
  })

  it('is not due on the day but before the hour', () => {
    // 02:00 local on the 4th — day matches, hour has not arrived yet.
    expect(
      isDue(monthly, at('2026-02-04T01:00:00Z'), at('2026-01-04T02:05:00Z'), TZ),
    ).toBe(false)
  })

  it('clamps the day to a short month rather than never firing', () => {
    // `day: 31` in February 2026 (28 days) degrades to the 28th.
    const short: Schedule = { kind: 'monthly', day: 31, hour: 3 }
    const last = at('2026-01-31T02:05:00Z')

    expect(isDue(short, at('2026-02-27T02:05:00Z'), last, TZ)).toBe(false)
    expect(isDue(short, at('2026-02-28T02:05:00Z'), last, TZ)).toBe(true)
  })

  it('still fires at the local hour across the spring DST change', () => {
    // Same instant as the daily spring test: 01:05Z is 03:05 CEST once Brussels
    // skips 02:00→03:00 on 2026-03-29, but only 01:05 in UTC.
    const spring: Schedule = { kind: 'monthly', day: 29, hour: 3 }
    const now = at('2026-03-29T01:05:00Z')
    const last = at('2026-02-04T02:05:00Z')

    expect(dateIn(now, TZ)).toBe('2026-03-29')
    expect(hourIn(now, TZ)).toBe(3)
    expect(isDue(spring, now, last, TZ)).toBe(true)
    expect(isDue(spring, now, last, 'UTC')).toBe(false)
  })
})

describe('nextRunAt', () => {
  it('is now when the job is already due', () => {
    const now = at('2026-01-15T10:00:00Z')
    expect(nextRunAt(hourly, now, null, TZ)).toEqual(now)
  })

  it('counts the remaining interval', () => {
    const now = at('2026-01-15T10:10:00Z')
    const next = nextRunAt(hourly, now, at('2026-01-15T10:00:00Z'), TZ)
    expect(next!.getTime() - now.getTime()).toBe(50 * 60_000)
  })

  it('finds tomorrow at the local hour for a daily job', () => {
    const now = at('2026-01-15T11:00:00Z') // 12:00 local, already ran today
    const next = nextRunAt(nightly, now, at('2026-01-15T02:05:00Z'), TZ)

    expect(next).not.toBeNull()
    expect(dateIn(next!, TZ)).toBe('2026-01-16')
    expect(hourIn(next!, TZ)).toBe(3)
  })

  it('finds the local hour across the spring DST change', () => {
    // The reason this is a probe over `isDue` rather than its own arithmetic:
    // hand-written calendar maths would be free to disagree exactly here.
    const now = at('2026-03-28T12:00:00Z')
    const next = nextRunAt(nightly, now, at('2026-03-28T02:05:00Z'), TZ)

    expect(dateIn(next!, TZ)).toBe('2026-03-29')
    expect(hourIn(next!, TZ)).toBe(3)
  })

  it('finds later the same day for a monthly job, within the horizon', () => {
    // 02:00 local on the 4th, day already matches, hour has not arrived yet.
    const now = at('2026-02-04T01:00:00Z')
    const next = nextRunAt(monthly, now, at('2026-01-04T02:05:00Z'), TZ)

    expect(next).not.toBeNull()
    expect(dateIn(next!, TZ)).toBe('2026-02-04')
    expect(hourIn(next!, TZ)).toBe(3)
  })

  it('is null when next month is beyond the probe horizon', () => {
    // Already ran this month; next month's day-4 is weeks away, not two days.
    const now = at('2026-01-05T10:00:00Z')
    expect(nextRunAt(monthly, now, at('2026-01-04T02:05:00Z'), TZ)).toBeNull()
  })
})

describe('describeSchedule', () => {
  it('reads as a schedule in a log line', () => {
    expect(describeSchedule(hourly)).toBe('every 60m')
    expect(describeSchedule(nightly)).toBe('daily at 03:00')
    expect(describeSchedule(monthly)).toBe('monthly on day 4 at 03:00')
  })
})
