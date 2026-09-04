/**
 * The two things the assistant is waiting on, and the honest reason it is still
 * waiting.
 *
 * Both lists are read-only in this version, and that is stated on screen rather than
 * implied by the absence of buttons. Answering a clarification means a round trip that
 * re-analyses the month, and applying a proposal means writing to `category_meta` with
 * an audit row — both belong to the milestone that adds the assistant's chat and the
 * apply handlers (#43–#45). Shipping the queues before the buttons is deliberate: the
 * queue is what tells you the analysis is asking about the right categories, and it is
 * worth reading a version early.
 *
 * Neither list renders anything the model wrote. `domain/ai/clarify.ts` builds the
 * question from the catalogue with the category name resolved locally — a sensitive
 * category never sent one — and `domain/ai/proposals.ts` does the same for the field
 * labels and the privacy warning. What comes from the model is the *guess* and the
 * *value*, and those are the two strings on this screen that are shown as data.
 *
 * The clarification cards show the guess rather than an open question, which is the
 * whole design of the queue: confirming "probably a fixed cost" is one press, while
 * "what kind of cost is this?" is an interrogation. `guessLabel` is the translated
 * label when the answer is one of a fixed set and null when the answer is free text,
 * so the raw guess is the fallback — and an empty guess renders no line at all rather
 * than an empty one.
 *
 * Materiality is on the card because it is why the card exists: the queue only asks
 * about categories above a threshold, and seeing the share makes the threshold legible
 * instead of mysterious.
 *
 * **Neither queue narrows to the month picked at the top of the page, and both say so
 * (#158).** The findings, the review and the run ledger do narrow, because each is a
 * statement about a month. A question and a proposal are not: they are pending work with
 * no period of their own, they stay open until somebody deals with them, and an
 * unanswered question about groceries raised in July would otherwise be invisible on
 * every month of the picker except July. `scoped` is what draws the sentence — there is
 * no picker on a deployment with nothing aggregated, so there is nothing to disclaim.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, formatDateTime, type Insights } from '../shared.ts'

export interface QuestionsProps {
  questions: Insights['questions']
  /** True when a month picker is on screen above, so the list needs the disclaimer. */
  scoped: boolean
}

export function Questions({ questions, scoped }: QuestionsProps): ReactNode {
  const { t } = useT()

  return (
    <section className="card">
      <h2 className="card__title">{t('ai:clarify.title')}</h2>
      <p className="muted">{t('ai:clarify.hint')}</p>
      {scoped ? <p className="muted">{t('ai:clarify.standing')}</p> : null}
      {questions.length === 0 ? (
        <p className="muted">{t('ai:clarify.none')}</p>
      ) : (
        <>
          <ul className="queue">
            {questions.map((question) => {
              const guess = question.guessLabel ?? question.guess
              return (
                <li className="queue__item" key={question.id}>
                  <p className="queue__lead">{question.question}</p>
                  {guess === '' ? null : (
                    <p className="queue__guess">{t('ai:clarify.suggestion', { guess })}</p>
                  )}
                  <p className="queue__meta">
                    {t('ai:clarify.share', { share: formatBp(question.materialityBp) })}
                  </p>
                </li>
              )
            })}
          </ul>
          <p className="muted">{t('ai:clarify.readOnly')}</p>
        </>
      )}
    </section>
  )
}

export interface ProposalsProps {
  proposals: Insights['proposals']
  /** True when a month picker is on screen above, so the list needs the disclaimer. */
  scoped: boolean
}

export function Proposals({ proposals, scoped }: ProposalsProps): ReactNode {
  const { t } = useT()

  return (
    <section className="card">
      <h2 className="card__title">{t('ai:proposal.title')}</h2>
      <p className="muted">{t('ai:proposal.hint')}</p>
      {scoped ? <p className="muted">{t('ai:proposal.standing')}</p> : null}
      {proposals.length === 0 ? (
        <p className="muted">{t('ai:proposal.none')}</p>
      ) : (
        <>
          <ul className="queue">
            {proposals.map((proposal) => (
              <li className="queue__item" key={proposal.id}>
                <p className="queue__lead">{proposal.targetName}</p>
                <p className="queue__meta">
                  {proposal.expiresAt === null
                    ? t('ai:proposal.diff')
                    : `${t('ai:proposal.diff')} · ${t('ai:proposal.expiresAt', {
                        when: formatDateTime(proposal.expiresAt),
                      })}`}
                </p>
                <dl className="change">
                  {proposal.fields.map((field) => (
                    <div className="change__row" key={field.field}>
                      <dt className="change__field">{field.label}</dt>
                      <dd className="change__values">
                        <span className="change__before">{field.before}</span>
                        {/*
                          Decorative: the order carries the meaning, and the group is
                          already headed "Now / proposed". An arrow read aloud between
                          two values says nothing a screen reader needs.
                        */}
                        <span className="change__arrow" aria-hidden="true">
                          →
                        </span>
                        <span className="change__after">{field.after}</span>
                      </dd>
                      {field.warn === null ? null : (
                        <dd className="change__warn">{field.warn}</dd>
                      )}
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          <p className="muted">{t('ai:proposal.readOnly')}</p>
        </>
      )}
    </section>
  )
}
