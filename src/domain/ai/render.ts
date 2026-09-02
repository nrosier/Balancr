/**
 * Signals into sentences, on the server.
 *
 * A finding is a code plus numbers; the sentence comes from the i18n catalogue.
 * That is what makes every finding available in both languages at no extra cost,
 * keeps output impossible to half-translate, and means a finding can never claim
 * something there is no computed number behind.
 *
 * How the numbers themselves read lives in `vars.ts`, which imports no `config` and
 * no i18next instance so the browser bundle can have it too — `/api/budget` and
 * `/api/insights` hand signals over as codes, so the client renders the same
 * vocabulary from the same table. What is left here is the server's half: a language
 * from the configuration and the i18next instance that reads the locale files off
 * disk.
 */
import { config } from '../../config.ts'
import { renderFinding, t, type Vars } from '../../i18n/index.ts'
import type { Signal } from '../aggregate/overspend.ts'
import { FINDING_SPECS, type FindingCode, type Severity } from './codes.ts'
import { findingVars as formatVars, isNeverReconciled } from './vars.ts'

export interface RenderedFinding {
  code: FindingCode
  categoryId: string | null
  severity: Severity
  /** False for good news, so the UI can style it apart from a problem. */
  negative: boolean
  /** The raw numbers, kept beside the sentence for charts and for audit. */
  metrics: Readonly<Record<string, number>>
  /** The sentence, already in `lang`. */
  text: string
}

/** The formatted variables a signal's sentence needs, in `lang`. */
export function findingVars(signal: Signal, lang: string = config.DEFAULT_LOCALE): Vars {
  return formatVars(signal, (key, vars) => t(lang, key, vars))
}

/**
 * Renders one signal, or null when its sentence would have a hole in it.
 *
 * Null rather than a throw: one malformed signal must not take down the insights
 * page. `test/unit/ai-render.test.ts` walks the whole vocabulary in both
 * languages, so a code without a working sentence is a failing build rather than
 * a finding that quietly disappears.
 */
export function renderSignal(
  signal: Signal,
  lang: string = config.DEFAULT_LOCALE,
): RenderedFinding | null {
  // "Never reconciled" is a different statement from "not reconciled in 40 days",
  // and its own sentence — see `isNeverReconciled`.
  const text = isNeverReconciled(signal)
    ? signal.categoryName === null
      ? null
      : t(lang, 'ai:variant.never_reconciled', { account: signal.categoryName })
    : renderFinding(signal.code, findingVars(signal, lang), lang)
  if (text === null) return null

  return {
    code: signal.code,
    categoryId: signal.categoryId,
    severity: signal.severity,
    negative: FINDING_SPECS[signal.code].negative,
    metrics: signal.metrics,
    text,
  }
}

/** Renders what can be rendered, in the order given. */
export function renderSignals(
  signals: readonly Signal[],
  lang: string = config.DEFAULT_LOCALE,
): RenderedFinding[] {
  const rendered: RenderedFinding[] = []
  for (const signal of signals) {
    const one = renderSignal(signal, lang)
    if (one !== null) rendered.push(one)
  }
  return rendered
}
