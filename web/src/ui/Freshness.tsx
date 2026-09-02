/**
 * How old the numbers are, said once, at the top of the page.
 *
 * Every `/api/*` response carries this field for a reason `freshness.ts` states
 * plainly: the endpoints read Balancr's own SQLite and never call Actual, Ghostfolio
 * or Gemini, which is what keeps a broken upstream from becoming a broken page — and
 * it means what is served can be out of date. A stale figure presented as current is
 * worse than no figure, so the age is part of the page rather than something a
 * console message mentions.
 *
 * Three states, and the distinction between the first two is the whole design:
 *
 *  - **A data job last failed.** The figures may be wrong, and which job failed is
 *    the operator's first question, so the jobs are named with their messages.
 *  - **Scheduled jobs are switched off.** Nothing is broken. A second instance, or a
 *    copy of the database someone is poking at, has data as old as its last real run
 *    and that is expected — reporting it as an error would train the reader to ignore
 *    the flag that matters.
 *  - **Everything ran.** One quiet line with the age, no colour, no icon.
 *
 * And a fourth that renders nothing: a deployment where no job has ever succeeded and
 * none has failed. That is a new installation, whose emptiness the page already says
 * far better than a warning about nothing could.
 *
 * This component translates its own strings, unlike `Metric` — it is handed a payload
 * rather than finished text, and turning a payload into a sentence is exactly the job.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatDateTime, type Freshness } from '../shared.ts'

export interface FreshnessNoteProps {
  freshness: Freshness
}

/** The jobs whose failure makes the figures wrong. Mirrors `DATA_JOBS`. */
const DATA_JOBS = ['sync', 'portfolio', 'networth', 'signals']

export function FreshnessNote({ freshness }: FreshnessNoteProps): ReactNode {
  const { t } = useT()
  const { asOf, jobsEnabled, jobs, stale } = freshness

  const age = asOf === null ? null : t('time.lastUpdated', { when: formatDateTime(asOf) })

  if (stale) {
    const failed = jobs.filter(
      (job) => job.status === 'error' && DATA_JOBS.includes(job.name),
    )
    return (
      <div className="notice notice--warn" role="status">
        <p className="notice__lead">{t('freshness.stale')}</p>
        <ul className="notice__list">
          {failed.map((job) => (
            <li key={job.name}>
              {t('freshness.jobFailed', {
                job: t(`job.${job.name}`),
                // The message the job recorded, not a stack. A failure with no message
                // is still worth naming — the job is what the reader acts on.
                error: job.error ?? t('error.generic'),
              })}
            </li>
          ))}
        </ul>
        {age === null ? null : <p className="notice__meta">{age}</p>}
      </div>
    )
  }

  if (!jobsEnabled) {
    return (
      <div className="notice notice--info" role="status">
        <p className="notice__lead">{t('freshness.jobsOff')}</p>
        {age === null ? null : <p className="notice__meta">{age}</p>}
      </div>
    )
  }

  if (age === null) return null

  return <p className="freshness muted">{age}</p>
}
