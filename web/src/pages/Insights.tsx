/**
 * What the analysis concluded, what it is asking, and what it was told.
 *
 * The order is an argument rather than a layout: findings first, because they are the
 * reason to open the page; then the narrative that puts them in a sentence; then the
 * two queues where the analysis asks for something back; and last the ledger of calls,
 * which is the part that lets a reader check every claim above it against the bytes
 * that produced it. Conclusions, then the reasoning, then the evidence.
 *
 * **Reading this page calls nothing.** `/api/insights` serves what the nightly job
 * stored, which is what makes the monthly AI budget a limit rather than a hope — and
 * it is why the two queues have no buttons yet: answering a clarification re-runs an
 * analysis and applying a proposal writes to `category_meta`, so both belong with the
 * assistant's chat and the apply handlers in `v0.9.0`. The copy says so rather than
 * leaving the reader to infer it from controls that are missing.
 *
 * The budget banner is at the top rather than beside the narrative it explains. Once
 * the month's cap is reached, every section below may be last week's answer, not the
 * narrative alone, so it is stated once ahead of all of them.
 *
 * **The month is a query parameter, not a route**, exactly as on the budget page and
 * through the same `MonthPicker`: `?month=` on the endpoint and `useState` here, because
 * `useResource` refetches on a path change and that is the whole mechanism (#158).
 *
 * Three of the sections narrow with the picker and two do not, and the page says which.
 * The findings, the review and the ledger are *about* a month — each is stored under one,
 * and reading July should show what was found in July and what the calls cost. The two
 * queues are standing work with no month of their own: an unanswered question from July
 * filed under July would be invisible from every month anyone has a reason to open. See
 * `routes/api/insights.ts`, which is where that decision is enforced.
 *
 * **One thing on this page now spends money**, which the header comment above used to be
 * able to deny outright. A month that has ended and has no review can be given one, and
 * the control is the narrative card's own: priced before it is pressed, pressed twice,
 * owner only, and never offered for a month still in progress. It is here rather than on
 * the settings page for one reason — a review is written for a *particular* month, and
 * this is the only screen that knows which month is on screen.
 */
import { useState, type ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { Findings } from '../insights/Findings.tsx'
import { Ledger } from '../insights/Ledger.tsx'
import { Narrative } from '../insights/Narrative.tsx'
import { Proposals, Questions } from '../insights/Pending.tsx'
import {
  formatMicroEur,
  type AiAvailabilityWire,
  type Insights as InsightsPayload,
} from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { MonthPicker } from '../ui/MonthPicker.tsx'
import { FreshnessBar } from '../ui/Refresh.tsx'
import { PageHeader } from './PageHeader.tsx'
import '../insights/insights.css'

/**
 * The job behind the findings, which is not the job behind the narrative.
 *
 * `signals` is deterministic TypeScript over the aggregated facts — it costs nothing and
 * is safe to press. The AI pass is the one job that spends money, `/api/refresh` refuses
 * it by name, and its control lives on the settings page beside the month's spend and
 * the price of a run. Two buttons on this page, one free and one not, is how the wrong
 * one gets pressed.
 */
const JOBS = ['signals'] as const

/**
 * True on a deployment where the AI layer has never run.
 *
 * `spend` is deliberately not part of it: that object is on every response and reads
 * zero of the configured budget on a fresh install, so counting it as content would
 * mean this page never says "no data yet" and showed five empty cards instead.
 */
function isEmpty(data: InsightsPayload): boolean {
  return (
    data.month === null &&
    // Not implied by `month === null`: that is the month *asked for*, and a stale
    // bookmark pointing at a month nobody computed would otherwise empty a page that
    // has three months in its picker (#158).
    data.months.length === 0 &&
    data.signals.length === 0 &&
    data.narrative === null &&
    data.questions.length === 0 &&
    data.proposals.length === 0 &&
    data.runs.length === 0
  )
}

export function Insights(): ReactNode {
  const { t } = useT()
  // Null means "whatever the server calls the latest", which is what a first visit wants
  // and what a reload after writing a review has to keep — pinning the month here on
  // mount would freeze the page on a month that had no figures yet.
  const [month, setMonth] = useState<string | null>(null)
  const resource = useResource<InsightsPayload>(
    month === null ? '/api/insights' : `/api/insights?month=${month}`,
  )

  return (
    <>
      <PageHeader title={t('nav.insights')} lede={t('page.insights.lede')} />
      <DataState resource={resource} isEmpty={isEmpty}>
        {(data) => (
          <Sections data={data} onRefreshed={resource.reload} onSelect={setMonth} />
        )}
      </DataState>
    </>
  )
}

function Sections({
  data,
  onRefreshed,
  onSelect,
}: {
  data: InsightsPayload
  onRefreshed: () => void
  onSelect: (month: string) => void
}): ReactNode {
  const { t } = useT()
  // The server's own current month, from the spend guard's clock. Comparing against it
  // rather than against the browser's `Date` is deliberate: the two can disagree across
  // a timezone, and the endpoint that writes a review refuses on the server's answer —
  // so a button drawn from the browser's would appear an evening early and 409.
  const ended = data.month !== null && data.month < data.spend.month

  return (
    <>
      <FreshnessBar freshness={data.freshness} jobs={JOBS} onRefreshed={onRefreshed} />

      {data.month === null ? null : (
        <div className="toolbar">
          <MonthPicker
            month={data.month}
            months={data.months}
            onSelect={onSelect}
            id="insights-month"
            label={t('budget:picker.month')}
          />
        </div>
      )}

      {data.spend.exceeded ? (
        <div className="notice notice--warn" role="status">
          <p className="notice__lead">{t('ai:narrative.capped')}</p>
          {/*
            The figure as well as the fact. "The budget is spent" without saying what
            the budget was is the sort of banner people learn to click past, and the
            same sentence is what the settings screen's cost panel prints.
          */}
          <p className="notice__meta">
            {t('settings:ai.spend', {
              spent: formatMicroEur(data.spend.spentMicroEur),
              budget: formatMicroEur(data.spend.budgetMicroEur),
            })}
          </p>
        </div>
      ) : null}

      {data.ai.enabled ? null : <AiOff availability={data.ai} />}

      <Findings signals={data.signals} month={data.month} />

      {/*
        Four sections that only a model can fill, each with its own "nothing yet" copy.
        On a deployment without a key that copy is a lie by omission — nothing is
        pending, nothing ever will be — so the empty ones are dropped and the panel
        above says why. Anything already stored still renders: switching the model off
        should not throw away last month's narrative.
      */}
      {data.ai.enabled || data.narrative !== null ? (
        <Narrative
          narrative={data.narrative}
          month={data.month}
          ended={ended}
          owner={data.owner}
          aiEnabled={data.ai.enabled}
          factsChangedAt={data.factsChangedAt}
          onWritten={onRefreshed}
        />
      ) : null}
      {data.ai.enabled || data.questions.length > 0 ? (
        <Questions questions={data.questions} scoped={data.month !== null} />
      ) : null}
      {data.ai.enabled || data.proposals.length > 0 ? (
        <Proposals proposals={data.proposals} scoped={data.month !== null} />
      ) : null}
      {data.ai.enabled || data.runs.length > 0 ? (
        <Ledger runs={data.runs} month={data.month} />
      ) : null}
    </>
  )
}

/**
 * What is missing, what is unaffected, and the one line of `.env` that changes it.
 *
 * Three sentences in that order, because the reader's first question is whether the
 * numbers above are trustworthy — they are, they never involved a model — and only then
 * what they are missing. An `info` notice rather than `warn`: running without a key is a
 * supported configuration, not a fault, and a yellow banner on every visit would teach
 * its owner to ignore the one that means the budget is spent.
 *
 * The reason arrives as a code and the sentence is chosen here, so both catalogues carry
 * the wording and neither the API nor this component can render half a translation.
 */
function AiOff({ availability }: { availability: AiAvailabilityWire }): ReactNode {
  const { t } = useT()
  // Cannot be null while `enabled` is false, but the type does not know that from here
  // and a non-null assertion to say so is not worth the lint.
  const reason = availability.reason ?? 'notConfigured'

  return (
    <div className="notice notice--info" role="status">
      <p className="notice__lead">{t('ai:off.title')}</p>
      <p>{t(`ai:off.reason.${reason}`)}</p>
      <p>{t('ai:off.kept')}</p>
      <p className="notice__meta">{t('ai:off.adds')}</p>
      <p className="notice__meta">{t(`ai:off.how.${reason}`)}</p>
      <p className="notice__hint">{t('ai:off.privacy')}</p>
    </div>
  )
}
