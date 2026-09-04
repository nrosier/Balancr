/**
 * The risk profile, and how far the portfolio has drifted from it (#41).
 *
 * The table the whole feature rests on. Every suggestion below it exists because one of
 * these rows left its band, and the row is the reason — so the numbers are here in full
 * rather than summarised, and the suggestion carries the same line rather than a précis
 * of it.
 *
 * Four decisions:
 *
 *  - **One row per band class, including the ones worth nothing.** A profile that wants
 *    30% bonds against a portfolio holding none is the most actionable thing this page
 *    can say, and a table built from what is held would leave that row out entirely.
 *  - **The band, not just the target.** `minBp`/`targetBp`/`maxBp` arrive per line, and
 *    the bar draws all three: a share resting between the target and the ceiling is
 *    doing exactly what a band is for, and against a bare target it would read as an
 *    error. The bar is `aria-hidden` because every figure in it is a cell in the row.
 *  - **`outsideBp`, not `driftBp`, decides the badge.** Distance from target is
 *    information; distance past an edge is the alarm. The rows arrive worst-first in
 *    that order and are not re-sorted here.
 *  - **Unmapped classes are reported, never folded in.** A class Ghostfolio has and the
 *    profile does not is a thing to go and add a band for, and quietly counting it
 *    against the four known ones would make every share slightly wrong.
 *
 * Shares are of the *invested* value, which the caption says out loud. Cash at the
 * broker is not an asset class, and on an instance whose Ghostfolio holds a synced bank
 * balance it would otherwise drag every class below its floor at once.
 */
import { useId, type ReactNode } from 'react'
import { Trans } from 'react-i18next'
import { assetClassLabel } from '../charts/AllocationChart.tsx'
import { useT, type TFunction } from '../i18n.ts'
import { formatBp, type Advice, type DriftLine } from '../shared.ts'
import { Money } from '../ui/Money.tsx'

/** The badge tone per state, which is also the exhaustiveness check on the enum. */
const TONE: Readonly<Record<DriftLine['state'], string>> = {
  inside: 'badge--ok',
  above: 'badge--warn',
  below: 'badge--warn',
}

/**
 * Where the bar puts a share.
 *
 * Percent of the full 0–100% axis rather than of the band, so two rows can be compared
 * down the column: a 65% target sits two thirds along in both. Clamped because a
 * pathological row should stretch nothing.
 */
const axis = (bp: number): string => `${String(Math.min(100, Math.max(0, bp / 100)))}%`

/** One class's band, its target and where the share actually is. Decoration only. */
function BandBar({ line }: { line: DriftLine }): ReactNode {
  return (
    <span className="band" aria-hidden="true">
      <span
        className="band__range"
        style={{ left: axis(line.minBp), width: axis(line.maxBp - line.minBp) }}
      />
      <span className="band__target" style={{ left: axis(line.targetBp) }} />
      <span
        className={`band__share band__share--${line.state}`}
        style={{ left: axis(line.shareBp) }}
      />
    </span>
  )
}

/** Why this line is outside its band, in the words the suggestion repeats. */
export function driftSentence(line: DriftLine, t: TFunction): string {
  if (line.state === 'above') {
    return t('portfolio:advice.state.aboveBy', {
      value: formatBp(line.outsideBp),
      max: formatBp(line.maxBp),
    })
  }
  if (line.state === 'below') {
    return t('portfolio:advice.state.belowBy', {
      value: formatBp(line.outsideBp),
      min: formatBp(line.minBp),
    })
  }
  return t('portfolio:advice.state.insideBand', {
    min: formatBp(line.minBp),
    max: formatBp(line.maxBp),
  })
}

export function DriftTable({ advice }: { advice: Advice }): ReactNode {
  const { t } = useT()
  const captionId = useId()
  const { drift } = advice

  return (
    <>
      <p className="panel__hint muted">
        <Trans
          i18nKey="portfolio:advice.profileLine"
          values={{ profile: t(`portfolio:advice.profile.${advice.profile}`) }}
          components={{
            money: <Money cents={drift.investedValueCents} options={{ whole: true }} />,
          }}
        />
        {advice.isPreset ? null : ` · ${t('portfolio:advice.edited')}`}
      </p>

      {drift.worstOutsideBp === 0 ? (
        <p className="notice notice--info" role="status">
          {t('portfolio:advice.inBalance')}
        </p>
      ) : null}

      <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="table">
          <caption className="table__caption" id={captionId}>
            {t('portfolio:advice.caption')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('portfolio:advice.column.class')}</th>
              <th scope="col" className="table__cell--number">
                {t('portfolio:advice.column.share')}
              </th>
              <th scope="col" className="table__cell--number">
                {t('portfolio:advice.column.target')}
              </th>
              <th scope="col">{t('portfolio:advice.column.band')}</th>
              <th scope="col" className="table__cell--number">
                {t('portfolio:advice.column.gap')}
              </th>
              <th scope="col">{t('portfolio:advice.column.state')}</th>
            </tr>
          </thead>
          <tbody>
            {drift.lines.map((line) => (
              <tr key={line.assetClass}>
                <th scope="row" className="table__cell--name">
                  {assetClassLabel(t, line.assetClass)}
                </th>
                <td className="table__cell--number">{formatBp(line.shareBp)}</td>
                <td className="table__cell--number">{formatBp(line.targetBp)}</td>
                <td className="band-cell">
                  <BandBar line={line} />
                  <span className="band__label">
                    {t('portfolio:advice.bandRange', {
                      min: formatBp(line.minBp),
                      max: formatBp(line.maxBp),
                    })}
                  </span>
                </td>
                {/*
                  The gap as money, signed: "€ 1.337 too much in equities" is the figure
                  someone acts on, and it is not the size of the trade — see `funding` on
                  the suggestion, which is where that distinction is explained.
                */}
                <td className="table__cell--number">
                  <Money cents={line.gapCents} options={{ whole: true, signed: true }} />
                </td>
                <td>
                  <span className={`badge ${TONE[line.state]}`}>
                    {t(`portfolio:advice.badge.${line.state}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {drift.unmapped.length === 0 ? null : (
        <div className="notice notice--warn" role="status">
          <p className="notice__lead">{t('portfolio:advice.unmapped.title')}</p>
          <ul className="notice__list">
            {drift.unmapped.map((slice) => (
              <li key={slice.assetClass}>
                <Trans
                  i18nKey="portfolio:advice.unmapped.line"
                  values={{
                    name: assetClassLabel(t, slice.assetClass),
                    share: formatBp(slice.shareBp),
                  }}
                  components={{ money: <Money cents={slice.valueCents} options={{ whole: true }} /> }}
                />
              </li>
            ))}
          </ul>
          <p className="notice__hint">{t('portfolio:advice.unmapped.hint')}</p>
        </div>
      )}
    </>
  )
}
