// The gymbro mark: an Olympic bumper plate on the 512 grid - marked rim, face, marked inner
// ring, metal collar and sleeve hole, the structure the reference plates have. Brand colours,
// not the accent: the accent is the user's, the logo is not. Never mirrored in RTL.
//
// This is the same artwork as resources/icon.svg, so the lockup and the app icon are one shape
// rather than two that have to be kept in step. It replaced the barbell that used to sit here:
// the bar survives only where a single colour is forced - the recolourable icon variants and
// Android's monochrome layer - because a plate needs its bands to read as a plate.

const PLATE = [
  { r: 196, fill: '#c26a00' },   // marked rim
  { r: 174, fill: '#ff9f0a' },   // face: inherits `color` in the one-colour mark below
  { r: 84, fill: '#c26a00' },    // marked inner ring
  { r: 68, fill: '#eef1f6' },    // metal collar
  { r: 40, fill: '#0c0e12' },    // sleeve hole
]

const discs = tint => PLATE.map((d, i) => (
  <circle key={d.r} cx="256" cy="256" r={d.r} fill={i === 1 ? (tint || d.fill) : d.fill} />
))

/** The mark alone, `height` px high (width follows: it is a circle). `color` tints the face. */
export function BrandMark({ height = 24, color, className, style }) {
  return (
    <svg className={className} viewBox="0 0 512 512" width={height} height={height}
      aria-hidden="true" focusable="false" style={{ flex: 'none', ...style }}>
      {discs(color)}
    </svg>
  )
}

/**
 * The lockup at `size` px type: mark 1.07× the type high, a gap of 0.2×, the mark's middle at
 * 0.36× above the baseline. "Gym" follows the theme (index.css .brand-lockup), "Bro" is brand
 * orange.
 */
export default function BrandLogo({ size = 34, as: Tag = 'span', className = '', style }) {
  return (
    <Tag className={('brand-lockup ' + className).trim()} dir="ltr" style={{ fontSize: size, ...style }}>
      <svg className="brand-lockup-mark" viewBox="0 0 512 512" aria-hidden="true" focusable="false">
        {discs()}
      </svg>
      <span className="brand-lockup-lead" translate="no">Gym</span><span className="brand-lockup-accent" translate="no">Bro</span>
    </Tag>
  )
}
