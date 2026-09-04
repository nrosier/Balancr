/**
 * The icon set, hand-drawn.
 *
 * An icon library would be one more package and, more to the point, one more thing
 * that has to be proven not to fetch anything: the whole promise of this UI is that a
 * page load reaches no third party. Nine 20×20 stroke glyphs are cheaper than
 * auditing a dependency for it.
 *
 * All of them inherit `currentColor` and scale with the font, so the nav's active
 * colour and the theme switch need no icon-specific styling at all.
 */
import type { ReactNode } from 'react'

export interface IconProps {
  className?: string
}

const svg = (children: ReactNode, props: IconProps): ReactNode => (
  <svg
    className={props.className}
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    // Decorative: every icon here sits beside its own label, or inside a button that
    // carries an accessible name. Announcing it as well would just repeat the label.
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
)

/** Overview — a rising trend. */
export const IconOverview = (props: IconProps): ReactNode =>
  svg(
    <>
      <path d="M3 13.5 7.5 9l3 3L17 5.5" />
      <path d="M13 5.5h4v4" />
      <path d="M3 17h14" />
    </>,
    props,
  )

/** Budget — envelopes, which is what Actual's model actually is. */
export const IconBudget = (props: IconProps): ReactNode =>
  svg(
    <>
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
      <path d="M2.5 7 10 11.5 17.5 7" />
    </>,
    props,
  )

/** Portfolio — allocation. */
export const IconPortfolio = (props: IconProps): ReactNode =>
  svg(
    <>
      <rect x="2.5" y="2.5" width="7" height="7" rx="1.5" />
      <rect x="12" y="2.5" width="5.5" height="4" rx="1.5" />
      <rect x="12" y="9" width="5.5" height="8.5" rx="1.5" />
      <rect x="2.5" y="12" width="7" height="5.5" rx="1.5" />
    </>,
    props,
  )

/** Insights — a remark worth reading. */
export const IconInsights = (props: IconProps): ReactNode =>
  svg(
    <>
      <path d="M10 2.5a5.5 5.5 0 0 0-3 10.1v2.4h6v-2.4A5.5 5.5 0 0 0 10 2.5Z" />
      <path d="M8 17.5h4" />
    </>,
    props,
  )

/** Settings. */
export const IconSettings = (props: IconProps): ReactNode =>
  svg(
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2M10 15.5v2M3.9 6.5l1.7 1M14.4 12.5l1.7 1M3.9 13.5l1.7-1M14.4 7.5l1.7-1" />
    </>,
    props,
  )

/** Follow the system. */
export const IconSystem = (props: IconProps): ReactNode =>
  svg(
    <>
      <rect x="2.5" y="4" width="15" height="9.5" rx="1.5" />
      <path d="M7 17h6" />
    </>,
    props,
  )

export const IconLight = (props: IconProps): ReactNode =>
  svg(
    <>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2v1.6M10 16.4V18M2 10h1.6M16.4 10H18M4.5 4.5l1.1 1.1M14.4 14.4l1.1 1.1M4.5 15.5l1.1-1.1M14.4 5.6l1.1-1.1" />
    </>,
    props,
  )

export const IconDark = (props: IconProps): ReactNode =>
  svg(<path d="M15.5 12.6A6.2 6.2 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1Z" />, props)

export const IconSignOut = (props: IconProps): ReactNode =>
  svg(
    <>
      <path d="M12.5 6V4.5a1.5 1.5 0 0 0-1.5-1.5H5a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 5 17h6a1.5 1.5 0 0 0 1.5-1.5V14" />
      <path d="M8.5 10h8" />
      <path d="M14 7.5 16.5 10 14 12.5" />
    </>,
    props,
  )

/** Privacy off — figures are visible. */
export const IconEye = (props: IconProps): ReactNode =>
  svg(
    <>
      <path d="M2 10s2.8-5.5 8-5.5S18 10 18 10s-2.8 5.5-8 5.5S2 10 2 10Z" />
      <circle cx="10" cy="10" r="2.2" />
    </>,
    props,
  )

/** Privacy on — figures are blurred. */
export const IconEyeOff = (props: IconProps): ReactNode =>
  svg(
    <>
      <path d="M2 10s2.8-5.5 8-5.5c1.5 0 2.8.35 3.9.9M18 10s-1 2-3 3.6M14.1 5.1 3.2 16" />
      <path d="M8.2 8.2a2.2 2.2 0 0 0 3.1 3.1" />
      <path d="M6 15.2C3.7 13.9 2 10 2 10" />
    </>,
    props,
  )
