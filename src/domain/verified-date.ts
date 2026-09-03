/**
 * "The day somebody last read this and agreed with it."
 *
 * Shared by the two files a person maintains by hand: the fund universe (#40) and the
 * Belgian tax rules (#42). Both hold claims about the outside world that code cannot
 * check — that this ISIN is that fund, that this is still the rate — so both carry the
 * date a human last confirmed the line, and both are read in situations where the age of
 * that date changes what should happen.
 *
 * One shared rule about it: a date in the future is refused rather than warned about. It
 * is either a typo or an attempt to make an entry look permanently fresh, and the second
 * is the interesting case — a field whose whole purpose is to expire is worth defending
 * against the obvious way around it.
 */
import { z } from 'zod'

/** Milliseconds in a day. */
export const DAY_MS = 24 * 60 * 60 * 1_000

const SHAPE = /^\d{4}-\d{2}-\d{2}$/

export const verifiedDateSchema = z
  .string()
  .regex(SHAPE, 'is not a yyyy-mm-dd date')
  .superRefine((value, ctx) => {
    // Nothing to add when the shape is already wrong: the regex said so, and a second
    // sentence about the same character helps nobody.
    if (!SHAPE.test(value)) return
    const day = Date.parse(`${value}T00:00:00Z`)
    if (Number.isNaN(day)) {
      ctx.addIssue({ code: 'custom', message: 'is not a real date' })
      return
    }
    if (day > Date.now()) {
      ctx.addIssue({
        code: 'custom',
        message: `is in the future: nobody verified this on ${value} yet`,
      })
    }
  })

/** How many whole days ago that was. Negative for a date in the future. */
export function ageInDays(date: string, asOf: Date = new Date()): number {
  return Math.floor((asOf.getTime() - Date.parse(`${date}T00:00:00Z`)) / DAY_MS)
}
