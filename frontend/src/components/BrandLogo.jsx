// The gymbro mark: a loaded Olympic barbell on a 352×174 grid (x 80..432, y 169..343),
// square corners, brand green. The stack tapers outward the way a real bar is loaded -
// tallest plate against the grip, shortest at the sleeve - and the shaft runs the full
// width so the sleeves read as bar continuing past the plates. Brand colours, not the
// accent: the accent is the user's, the logo is not. Never mirrored in RTL.

const RECTS = [
  [80, 248, 352, 16], [85, 223, 19, 66], [107, 199, 20, 114], [130, 169, 26, 174],
  [356, 169, 26, 174], [385, 199, 20, 114], [408, 223, 19, 66],
]

/** The mark alone, `height` px high (width follows, 352:174). `color` only for a one-colour use. */
export function BrandMark({ height = 24, color = '#ff9f0a', className, style }) {
  return (
    <svg className={className} viewBox="80 169 352 174" width={height * 352 / 174} height={height}
      fill={color} aria-hidden="true" focusable="false" style={{ flex: 'none', ...style }}>
      {RECTS.map(([x, y, w, h]) => <rect key={x + '-' + y} x={x} y={y} width={w} height={h} />)}
    </svg>
  )
}

/**
 * The lockup at `size` px type: mark 1.07× the type high, a gap of 0.2×, the mark's middle at
 * 0.36× above the baseline (assets/logo/gymbro-logo-dark.svg). "gym" follows the theme
 * (index.css .brand-lockup), "bro" is brand green.
 */
export default function BrandLogo({ size = 34, as: Tag = 'span', className = '', style }) {
  return (
    <Tag className={('brand-lockup ' + className).trim()} dir="ltr" style={{ fontSize: size, ...style }}>
      <svg className="brand-lockup-mark" viewBox="80 169 352 174" aria-hidden="true" focusable="false">
        {RECTS.map(([x, y, w, h]) => <rect key={x + '-' + y} x={x} y={y} width={w} height={h} />)}
      </svg>
      <span className="brand-lockup-lead" translate="no">Gym</span><span className="brand-lockup-accent" translate="no">Bro</span>
    </Tag>
  )
}
