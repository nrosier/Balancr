/**
 * What the analysis concluded, what it is asking, and what it was told.
 *
 * The order is an argument rather than a layout: findings first, because they are the
 * reason to open the page; then the narrative that puts them in a sentence; then the
 * two queues where the analysis asks for something back; and last the ledger of calls,
 * which is the part that lets a reader check every claim above it against the bytes
 * that produced it. Conclusions, then the reasoning, then the evidence.
 *
 * **Nothing on this page calls Gemini.** `/api/insights` reads what the nightly job
 * stored, which is what makes the monthly AI budget a limit rather than a hope — and
 * it is why the two queues have no buttons yet: answering a clarification re-runs an
 * analysis and applying a proposal writes to `category_meta`, so both belong with the
 * assistant's chat and the apply handlers in `v0.9.0`. The copy says so rather than
 * leaving the reader to infer it from controls that are missing.
 *
 * The budget banner is at the top rather than beside the narrative it explains. Once
 * the month's cap is reached, every section below may be last week's answer, not the
 * narrative alone, so it is stated once ahead of all of them.
 */
import type { ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { Findings } from '../insights/Findings.tsx'
import { Ledger } from '../insights/Ledger.tsx'
import { Narrative } from '../insights/Narrative.tsx'
import { Proposals, Questions } from '../insights/Pending.tsx'
import { formatMicroEur, type Insights as InsightsPayload } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { FreshnessNote } from '../ui/Freshness.tsx'
import { PageHeader } from './PageHeader.tsx'
import '../insights/insights.css'

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
    data.signals.length === 0 &&
    data.narrative === null &&
    data.questions.length === 0 &&
    data.proposals.length === 0 &&
    data.runs.length === 0
  )
}

export function Insights(): ReactNode {
  const { t } = useT()
  const resource = useResource<InsightsPayload>('/api/insights')

  return (
    <>
      <PageHeader title={t('nav.insights')} lede={t('page.insights.lede')} />
      <DataState resource={resource} isEmpty={isEmpty}>
        {(data) => <Sections data={data} />}
      </DataState>
    </>
  )
}

function Sections({ data }: { data: InsightsPayload }): ReactNode {
  const { t } = useT()

  return (
    <>
      <FreshnessNote freshness={data.freshness} />

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

      <Findings signals={data.signals} month={data.month} />
      <Narrative narrative={data.narrative} />
      <Questions questions={data.questions} />
      <Proposals proposals={data.proposals} />
      <Ledger runs={data.runs} />
    </>
  )
}
