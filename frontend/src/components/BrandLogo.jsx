// The gymbrooo mark: an Olympic bumper plate on the 512 grid - marked rim, face, marked inner
// ring, metal collar and sleeve hole, the structure the reference plates have. Brand colours,
// not the accent: the accent is the user's, the logo is not. Never mirrored in RTL.
//
// This is the same artwork as resources/icon.svg, so the lockup and the app icon are one shape
// rather than two that have to be kept in step. It replaced the barbell that used to sit here:
// the bar survives only where a single colour is forced - the recolourable icon variants and
// Android's monochrome layer - because a plate needs its bands to read as a plate.
//
// The name beside it is geometry too (lib/wordmark.js): a browser translator rewrites DOM text
// and "GymBrooo" is the one string that must never change, so it is drawn as strokes rather than
// set in a font. Rendered from the shared data here rather than via the markup helper, which
// returns a string for print-doc.js.

import { WORDMARK, WORDMARK_OFFSETS, WORDMARK_STROKE, WORDMARK_RATIO, WORDMARK_TOP, WORDMARK_BOX_H, WORDMARK_WIDTH } from '../lib/wordmark.js'

const PLATE = [
  { r: 196, fill: '#c26a00' },   // marked rim
  { r: 174, fill: '#ff7622' },   // face: inherits `color` in the one-colour mark below
  { r: 84, fill: '#c26a00' },    // marked inner ring
  { r: 68, fill: '#ffffff' },    // metal collar
  { r: 40, fill: '#121212' },    // sleeve hole
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

// Gym is glyphs 0-2, Bro 3-5 - the same split the live text used.
const SPLIT = 3

/**
 * GymBrooo as strokes. The viewBox is the whole drawing box (`WORDMARK_TOP` … bottom), so the
 * `y` descender is inside the frame instead of clipped off it - cut at the baseline it reads
 * "GvmBro". `h` is the box height in em; the width follows from the box's aspect ratio, so
 * CSS never has to restate the numbers.
 */
export function BrandWordmark({ h = 1, lead = 'currentColor', accent = '#ff7622', className, style }) {
  const shapes = (from, to, color) => WORDMARK.slice(from, to).map((g, n) => {
    const i = from + n, ox = WORDMARK_OFFSETS[i]
    return [
      // A curved glyph carries an SVG path with arcs; a straight one carries point lists.
      // The path is glyph-local, so it is translated by the glyph's own offset - the polylines
      // below add ox to every point instead, and without this the three curved glyphs all drew
      // on top of each other at x=0.
      ...(g.path ? [
        <g key={`${i}-p`} transform={`translate(${ox} 0)`}>
          <path data-glyph={i} d={g.path} fill="none" stroke={color}
            strokeWidth={WORDMARK_STROKE} strokeLinecap="round" strokeLinejoin="round" />
        </g>,
      ] : []),
      ...(g.lines || []).map((line, l) => (
        <polyline key={`${i}-${l}`} data-glyph={i} points={line.map(([x, y]) => `${ox + x},${y}`).join(' ')}
          fill="none" stroke={color} strokeWidth={WORDMARK_STROKE}
          strokeLinecap="round" strokeLinejoin="round" />
      )),
      ...(g.circles || []).map(([cx, cy, r, w], c) => (
        <circle key={`${i}-c${c}`} data-glyph={i} cx={ox + cx} cy={cy} r={r} fill="none"
          stroke={color} strokeWidth={w ?? WORDMARK_STROKE} />
      )),
    ]
  })
  return (
    <svg className={className} viewBox={`0 ${WORDMARK_TOP} ${WORDMARK_WIDTH} ${WORDMARK_BOX_H}`}
      width={`${(h * WORDMARK_RATIO).toFixed(4)}em`} height={`${h}em`} role="img" aria-label="GymBrooo"
      translate="no" focusable="false" style={{ flex: 'none', display: 'block', ...style }}>
      {shapes(0, SPLIT, lead)}{shapes(SPLIT, WORDMARK.length, accent)}
    </svg>
  )
}

/**
 * The lockup at `size` px type: mark on top, the name under it, both centred. "Gym" is the
 * theme's ink and "Brooo" brand orange, drawn as geometry so no translator can reach them.
 */
export default function BrandLogo({ size = 34, as: Tag = 'span', className = '', style }) {
  return (
    <Tag className={('brand-lockup ' + className).trim()} dir="ltr" style={{ fontSize: size, ...style }}>
      <svg className="brand-lockup-mark" viewBox="0 0 512 512" aria-hidden="true" focusable="false">
        {discs()}
      </svg>
      <BrandWordmark className="brand-lockup-name" h={0.72} />
    </Tag>
  )
}
