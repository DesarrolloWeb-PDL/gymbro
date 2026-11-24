/**
 * The wordmark GymBro as geometry, not as text.
 *
 * A browser translator rewrites DOM text, and the brand name is the one string that must never
 * change; `translate="no"` says so but still depends on a font being present, so the lockup
 * draws these instead. Everything here is in em with the baseline at y = 0 and y negative
 * above it, which is the convention the rest of the mark uses.
 *
 * Stroke-based on purpose: a filled `o` needs a hole punched in it, and a hole has to be the
 * colour of whatever sits behind the logo. A stroked circle keeps its counter transparent, so
 * the same geometry works on the sign-in screen, a printed page and a card footer.
 *
 * Consumed by components/BrandLogo.jsx (React) and lib/print-doc.js (an HTML string), which
 * is why this is data rather than markup.
 */

export const WORDMARK_STROKE = 0.16   // in em, so the letters stay bold at any size
export const WORDMARK_TRACK = 0.10    // gap between glyphs, in em

/** Advance width of each glyph in em: G y m B r o. The box adds half a stroke past the last
 *  glyph's edge (the `o` reaches 4.59 with its round cap), so it is wider than the sum. */
export const WORDMARK_WIDTH = 4.62

/* The drawing box, in em with the baseline at y = 0. Cap height reaches -0.70 and the round
   caps add half a stroke, so the top is -0.78; the `y` descends to 0.26, +0.08 with its cap.
   The frame has to cover both ends: clipping at y = 0 cuts the `y`'s tail off and the name
   reads "GvmBro". */
export const WORDMARK_TOP = -0.80
export const WORDMARK_BOTTOM = 0.36
export const WORDMARK_BOX_H = WORDMARK_BOTTOM - WORDMARK_TOP   // 1.16
export const WORDMARK_RATIO = WORDMARK_WIDTH / WORDMARK_BOX_H  // width per unit of height

export const WORDMARK = [
  { w: 0.74, lines: [
    [[0.72, -0.62], [0.32, -0.70], [0.08, -0.48], [0.08, -0.22], [0.32, 0.00],
     [0.72, -0.06], [0.72, -0.34], [0.48, -0.34]],
  ] },
  { w: 0.56, lines: [
    [[0.06, -0.50], [0.28, -0.14]],
    [[0.52, -0.50], [0.14, 0.26]],
  ] },
  { w: 0.94, lines: [
    [[0.06, 0.00], [0.06, -0.36], [0.16, -0.50], [0.32, -0.50], [0.42, -0.36], [0.42, 0.00]],
    [[0.42, -0.36], [0.52, -0.50], [0.68, -0.50], [0.80, -0.36], [0.80, 0.00]],
  ] },
  { w: 0.70, lines: [
    [[0.06, 0.00], [0.06, -0.70], [0.44, -0.70], [0.60, -0.54], [0.44, -0.36], [0.06, -0.36]],
    [[0.06, -0.36], [0.48, -0.36], [0.66, -0.18], [0.48, 0.00], [0.06, 0.00]],
  ] },
  { w: 0.50, lines: [
    [[0.06, 0.00], [0.06, -0.50], [0.24, -0.50], [0.44, -0.34]],
  ] },
  { w: 0.64, lines: [], circles: [[0.32, -0.25, 0.25]] },
]

/** Where each glyph starts, in em, from the left edge of the wordmark. */
export const WORDMARK_OFFSETS = (() => {
  const out = []
  let x = 0
  for (const g of WORDMARK) { out.push(x); x += g.w + WORDMARK_TRACK }
  return out
})()

/**
 * The wordmark as SVG markup. Coordinates are always in em and the viewBox is the full
 * drawing box (`WORDMARK_TOP` … `WORDMARK_BOTTOM`), so the same geometry scales with whatever
 * type size surrounds it. `lead` paints Gym, `accent` paints Bro.
 *
 * `h` is the element's height in em (default: the box at 1em, i.e. unscaled); the width
 * follows from the box's aspect ratio. Pass `em: false` with `size` to get px instead.
 */
export function wordmarkSvg({ lead = '#eef1f6', accent = '#ff9f0a', cls = '', h = 1, size, em = true } = {}) {
  const sw = WORDMARK_STROKE
  const parts = []
  WORDMARK.forEach((g, i) => {
    const ox = WORDMARK_OFFSETS[i]
    const color = i < 3 ? lead : accent
    for (const line of g.lines) {
      const pts = line.map(([x, y]) => `${(ox + x).toFixed(3)},${y.toFixed(3)}`).join(' ')
      parts.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`)
    }
    for (const [cx, cy, r] of g.circles || []) {
      parts.push(`<circle cx="${(ox + cx).toFixed(3)}" cy="${cy.toFixed(3)}" r="${r.toFixed(3)}" fill="none" stroke="${color}" stroke-width="${sw}"/>`)
    }
  })
  const w = em ? `${(h * WORDMARK_RATIO).toFixed(4)}em` : (h * WORDMARK_RATIO * size).toFixed(2)
  const ht = em ? `${h}em` : (h * size).toFixed(2)
  return `<svg class="${cls}" viewBox="0 ${WORDMARK_TOP} ${WORDMARK_WIDTH} ${WORDMARK_BOX_H}" `
    + `width="${w}" height="${ht}" aria-label="GymBro" role="img" translate="no">${parts.join('')}</svg>`
}
