/**
 * Whether the AI layer can run, and — when it cannot — which of the three reasons.
 *
 * One module because there are five surfaces that have to agree about this and no
 * good way to make them agree by convention: the nightly job decides whether to
 * spend, three endpoints decide whether to accept, the insights page decides whether
 * to draw a narrative section or an explanation, and the settings page decides
 * whether to offer a button that charges money. Each of those computing its own
 * answer from `config` is how a deployment ends up with a page that offers a run the
 * server will refuse.
 *
 * **The reasons are codes, not sentences.** Same rule as findings and status checks:
 * this application has two languages, so prose assembled on the server arrives on a
 * Dutch page in English. The wording lives in the `ai` catalogue, one file per locale.
 *
 * **Three reasons, deliberately not collapsed into one.** They look alike from the
 * outside — no model runs, either way — and they are different situations with
 * different fixes:
 *
 *  - `notConfigured` — no credential for the chosen provider. Nothing is wrong; this
 *    is a deployment that has not bought a key, and every deterministic figure in
 *    the app is still correct. The panel explains what a key would add.
 *  - `switchedOff` — `AI_ENABLED=false` with a credential present. Someone paused it
 *    on purpose, and saying "not configured" to them would send them looking for a
 *    key that is already there.
 *  - `budgetZero` — configured, switched on, allowance set to nothing. The one of
 *    the three that is about money rather than about setup, and the one an operator
 *    can undo without touching a secret.
 *
 * An *exhausted* budget is not here. That is handled inside the run by the cost
 * guard, which serves the cached answer with a banner — the layer is available, and
 * `insights.spend.exceeded` is what says the month has run out.
 */
import { config, type Config } from '../../config.ts'

export const AI_OFF_REASONS = ['notConfigured', 'switchedOff', 'budgetZero'] as const

export type AiOffReason = (typeof AI_OFF_REASONS)[number]

export interface AiAvailability {
  readonly enabled: boolean
  /** Null when it is on — an "ok" reason would be a reason for nothing. */
  readonly reason: AiOffReason | null
}

/**
 * The config's AI state, in the order the reasons should be reported.
 *
 * `notConfigured` is checked first because it subsumes the others: on an instance
 * with no key, `AI_ENABLED=false` and a budget of zero are both true statements that
 * would send the reader to the wrong variable.
 *
 * Takes the config rather than reading the singleton so a test can pose all four
 * states without `vi.stubEnv` and a module reset — which is what a test of a
 * four-way branch over the environment otherwise turns into.
 */
type AiConfig = Pick<Config, 'AI_ENABLED' | 'aiCredentialed' | 'GEMINI_MONTHLY_BUDGET_EUR'>

export function aiAvailability(cfg: AiConfig = config): AiAvailability {
  if (!cfg.aiCredentialed) return { enabled: false, reason: 'notConfigured' }
  if (!cfg.AI_ENABLED) return { enabled: false, reason: 'switchedOff' }
  if (cfg.GEMINI_MONTHLY_BUDGET_EUR === 0) return { enabled: false, reason: 'budgetZero' }
  return { enabled: true, reason: null }
}
