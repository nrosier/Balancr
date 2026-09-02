/**
 * Signals into sentences, in the browser.
 *
 * `/api/budget` and `/api/insights` return findings as a code, a severity and a map
 * of integers — never as prose. `schemas.ts` says why: a sentence in the payload would
 * fix the language at the moment the nightly job ran, and switching the UI to Dutch
 * would either show English findings or trigger a re-analysis. So the sentence is
 * assembled here, out of the same `ai:findings.*` catalogue the server's digest uses
 * and the same variable table in `domain/ai/vars.ts`.
 *
 * Three things this has to get right, and all three are about not trusting the wire:
 *
 *  - **The code may be one this bundle has never heard of.** `code` is `z.string()` in
 *    the schema, because a server a version ahead can emit a finding this client has
 *    no sentence for. `isFindingCode` narrows it and an unknown code is dropped rather
 *    than rendered as its own name.
 *  - **A sentence with a hole in it is worse than no sentence.** A missing metric
 *    would interpolate as the literal `{{delta}}`, so `missingVars` is checked first
 *    and the finding is skipped — the same rule `renderFinding` applies on the server.
 *  - **The numbers stay.** `metrics` is passed through beside the text, because the
 *    burn-rate section on the budget page draws the projection the server computed.
 *    Nothing here recomputes a figure; `projectedCents` arrives already projected.
 */
import type { TFunction } from '../i18n.ts'
import {
  FINDING_SPECS,
  findingVars,
  isFindingCode,
  isNeverReconciled,
  missingVars,
  type Budget,
  type FindingCode,
} from '../shared.ts'

/** A signal as `/api/budget` and `/api/insights` return it. */
export type WireSignal = Budget['signals'][number]

export interface RenderedSignal {
  code: string
  categoryId: string | null
  categoryName: string | null
  severity: WireSignal['severity']
  /** False for good news, so it can be styled apart from a problem. */
  negative: boolean
  /** The raw integers, for the charts that draw what the sentence describes. */
  metrics: Readonly<Record<string, number>>
  /** The sentence, in the language the component is rendering in. */
  text: string
}

/** One signal as a sentence, or null when this bundle cannot state it faithfully. */
export function renderSignal(signal: WireSignal, t: TFunction): RenderedSignal | null {
  if (!isFindingCode(signal.code)) return null
  const facts = { ...signal, code: signal.code }

  if (isNeverReconciled(facts)) {
    if (signal.categoryName === null) return null
    return {
      ...rest(facts),
      text: t('ai:variant.never_reconciled', { account: signal.categoryName }),
    }
  }

  const vars = findingVars(facts, (key, values) => t(key, values))
  if (missingVars(signal.code, vars).length > 0) return null
  return { ...rest(facts), text: t(`ai:findings.${signal.code}`, vars) }
}

/** Everything but the sentence. Split out so both paths above agree on it. */
function rest(
  signal: WireSignal & { code: FindingCode },
): Omit<RenderedSignal, 'text'> {
  return {
    code: signal.code,
    categoryId: signal.categoryId,
    categoryName: signal.categoryName,
    severity: signal.severity,
    negative: FINDING_SPECS[signal.code].negative,
    metrics: signal.metrics,
  }
}

/** What can be stated, in the order given. */
export function renderSignals(signals: readonly WireSignal[], t: TFunction): RenderedSignal[] {
  const rendered: RenderedSignal[] = []
  for (const signal of signals) {
    const one = renderSignal(signal, t)
    if (one !== null) rendered.push(one)
  }
  return rendered
}

/** The signals about one category, in the order the server ranked them. */
export function signalsFor(
  signals: readonly RenderedSignal[],
  categoryId: string,
): RenderedSignal[] {
  return signals.filter((signal) => signal.categoryId === categoryId)
}
