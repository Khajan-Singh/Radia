import type { JSX, SVGProps } from 'react'

type Props = SVGProps<SVGSVGElement>

/**
 * Line icons drawn on a 24-unit grid with a shared stroke weight, so the
 * transport row and the toolbar read as one set rather than borrowed glyphs.
 */
function Svg({ children, ...props }: Props): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const PlayIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M8 5.5 18.5 12 8 18.5V5.5Z" fill="currentColor" stroke="none" />
  </Svg>
)

export const PauseIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <rect x="7.5" y="5.5" width="3.2" height="13" rx="1.1" fill="currentColor" stroke="none" />
    <rect x="13.3" y="5.5" width="3.2" height="13" rx="1.1" fill="currentColor" stroke="none" />
  </Svg>
)

export const NextIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M6 6.5 14 12 6 17.5V6.5Z" fill="currentColor" stroke="none" />
    <rect x="16" y="6" width="2.4" height="12" rx="1.1" fill="currentColor" stroke="none" />
  </Svg>
)

export const PrevIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M18 6.5 10 12l8 5.5V6.5Z" fill="currentColor" stroke="none" />
    <rect x="5.6" y="6" width="2.4" height="12" rx="1.1" fill="currentColor" stroke="none" />
  </Svg>
)

/** Circular arrow with the skip amount written inside, like the reference UI. */
export function SkipIcon({ seconds, back, ...p }: Props & { seconds: number; back?: boolean }): JSX.Element {
  return (
    <Svg {...p}>
      <g transform={back ? 'scale(-1,1) translate(-24,0)' : undefined}>
        <path d="M12 4.6a7.4 7.4 0 1 1-7.13 5.4" />
        <path d="M11.7 1.7 14.9 4.6 11.7 7.5" />
      </g>
      <text
        x="12"
        y="15.9"
        textAnchor="middle"
        fontSize="10"
        fontWeight="700"
        letterSpacing="-0.5"
        fill="currentColor"
        stroke="none"
        fontFamily="inherit"
      >
        {seconds}
      </text>
    </Svg>
  )
}

export const PaletteIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-.9-.7-1.4-.7-2.2 0-.8.6-1.4 1.5-1.4h1.6a4.3 4.3 0 0 0 4.3-4.3c0-4-4-7.4-8.5-7.4Z" />
    <circle cx="8" cy="11" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="11" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.4" cy="8.6" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
)

export const BulbIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M9.2 17.2a6 6 0 1 1 5.6 0" />
    <path d="M9.6 17.4h4.8M10.4 20.3h3.2" />
  </Svg>
)

export const MonitorIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <rect x="2.8" y="4.4" width="18.4" height="12.4" rx="2" />
    <path d="M9 20.2h6M12 16.8v3.4" />
  </Svg>
)

export const CardIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <rect x="2.6" y="7.4" width="18.8" height="9.2" rx="2.4" />
    <rect x="5.2" y="9.8" width="4.4" height="4.4" rx="1.2" />
    <path d="M11.8 11h6M11.8 13.6h4" />
  </Svg>
)

export const ExpandIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M14.4 4.6h5v5M9.6 19.4h-5v-5M19.4 4.6 13.6 10.4M4.6 19.4l5.8-5.8" />
  </Svg>
)

/** Four corner brackets pushing outward - enter full screen. */
export const FullscreenIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M4.6 9.2V4.6h4.6M19.4 9.2V4.6h-4.6M4.6 14.8v4.6h4.6M19.4 14.8v4.6h-4.6" />
  </Svg>
)

/** The same brackets pulling inward - leave full screen. */
export const ExitFullscreenIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M9.2 4.6v4.6H4.6M14.8 4.6v4.6h4.6M9.2 19.4v-4.6H4.6M14.8 19.4v-4.6h4.6" />
  </Svg>
)

export const CheckIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M4.8 12.6 9.6 17.4 19.2 6.6" strokeWidth={2} />
  </Svg>
)

export const ChevronIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M8.5 10.2 12 6.8l3.5 3.4M8.5 13.8 12 17.2l3.5-3.4" />
  </Svg>
)

export const SunIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.6" />
    <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
  </Svg>
)

export const MinimizeIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M5.5 12h13" />
  </Svg>
)

export const CloseIcon = (p: Props): JSX.Element => (
  <Svg {...p}>
    <path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6" />
  </Svg>
)
