/**
 * Whether this deployment has a model, and which of three reasons it does not.
 *
 * The function is four lines, and it is tested because five surfaces read it and each
 * one prints a different sentence from the answer: the nightly job's ops row, the three
 * paid endpoints' refusal, the insights panel, the settings panel, and the prompt
 * editor's test run. A wrong reason is not a cosmetic bug — it sends whoever is holding
 * `.env` to the wrong line of it (#165).
 *
 * Precedence is the substance of the test. A deployment can be in more than one of the
 * three states at once — no key *and* `AI_ENABLED=false` is the ordinary state of an
 * instance that has never bought one — and the reason reported has to be the one whose
 * fix comes first. Telling someone to flip a switch when they have no key to switch on
 * is worse than saying nothing.
 */
import { describe, expect, it } from 'vitest'
import { AI_OFF_REASONS, aiAvailability } from '../../src/domain/ai/availability.ts'

/** Configured, switched on, funded: the only combination that reaches a model. */
const on = { aiCredentialed: true, AI_ENABLED: true, GEMINI_MONTHLY_BUDGET_EUR: 15 }

describe('aiAvailability', () => {
  it('is on when a credential, the switch and a budget are all present', () => {
    expect(aiAvailability(on)).toEqual({ enabled: true, reason: null })
  })

  it('pairs a null reason with being on, so no surface renders "off because ok"', () => {
    // The type says `AiOffReason | null`; this asserts the null half is actually used
    // rather than a fourth code called `ok` leaking into the two catalogues.
    expect(aiAvailability(on).reason).toBeNull()
  })

  it('names a missing credential first, because a switch cannot fix it', () => {
    expect(aiAvailability({ ...on, aiCredentialed: false })).toEqual({
      enabled: false,
      reason: 'notConfigured',
    })
  })

  it('still names the missing credential when the switch is off as well', () => {
    // The out-of-the-box state of an instance with no key, if someone also set the
    // flag. `switchedOff` here would point at the one variable that changes nothing.
    expect(
      aiAvailability({ ...on, aiCredentialed: false, AI_ENABLED: false }).reason,
    ).toBe('notConfigured')
  })

  it('still names the missing credential when the budget is zero as well', () => {
    expect(
      aiAvailability({ ...on, aiCredentialed: false, GEMINI_MONTHLY_BUDGET_EUR: 0 }).reason,
    ).toBe('notConfigured')
  })

  it('names the switch when a credential exists but the flag is false', () => {
    expect(aiAvailability({ ...on, AI_ENABLED: false })).toEqual({
      enabled: false,
      reason: 'switchedOff',
    })
  })

  it('names the switch before the budget, since the switch is the deliberate one', () => {
    // Someone who set `AI_ENABLED=false` did so on purpose. Reporting `budgetZero`
    // would send them to raise a budget that is not what is stopping anything.
    expect(
      aiAvailability({ ...on, AI_ENABLED: false, GEMINI_MONTHLY_BUDGET_EUR: 0 }).reason,
    ).toBe('switchedOff')
  })

  it('names a zero budget when that is the only thing missing', () => {
    expect(aiAvailability({ ...on, GEMINI_MONTHLY_BUDGET_EUR: 0 })).toEqual({
      enabled: false,
      reason: 'budgetZero',
    })
  })

  it('leaves a budget it can spend alone, however small', () => {
    // A cent is a budget. Only zero is the off switch, because a fraction of a cent
    // per finding means a small number is a real allowance and not a mistake.
    expect(aiAvailability({ ...on, GEMINI_MONTHLY_BUDGET_EUR: 1 }).enabled).toBe(true)
  })

  it('can produce every reason the wire and the catalogues carry', () => {
    // The list is exported to `schemas.ts` as a Zod enum and to both locale files as a
    // key per code. A fourth reason added to the union without a branch here would ship
    // a payload value with no sentence behind it.
    const produced = new Set([
      aiAvailability({ ...on, aiCredentialed: false }).reason,
      aiAvailability({ ...on, AI_ENABLED: false }).reason,
      aiAvailability({ ...on, GEMINI_MONTHLY_BUDGET_EUR: 0 }).reason,
    ])

    expect([...produced].sort()).toEqual([...AI_OFF_REASONS].sort())
  })
})
