import { describe, expect, it } from 'vitest'
import { drawBrand, BRAND, cardPalette } from './card-draw.js'

/* The footer every shared picture ends with (drawBrand), used by the workout card and Your year.
 *
 * Two things can go wrong here and neither is caught by looking at the image once:
 *
 *   1. The name itself. The lockup text is painted in two fillText calls, so a search for the
 *      brand as one string never finds it - which is how the rename left this painting the name
 *      the fork came from while the line above it measured the new one.
 *   2. Measuring one string and painting another. textW sizes the badge; if the painted text is a
 *      different string the badge is the wrong width and the logo overflows or floats.
 *
 * A recording context answers both without a canvas: what was measured, and what was painted.
 */

function recorder() {
  const calls = []
  const target = {
    measureText: s => { calls.push(['measure', s]); return { width: String(s).length * 10 } },
    fillText: (s, x, y) => { calls.push(['fill', s, x, y]) },
  }
  const ctx = new Proxy(target, {
    get(t, k) { return k in t ? t[k] : (() => { calls.push([String(k)]) }) },
    // fillStyle is the only state the two-tone assertion needs: which colour was in force when
    // each half was painted. The rest is written and never read back.
    set(t, k, v) { if (k === 'fillStyle') calls.push(['fillStyle', v]); t[k] = v; return true },
    // `'letterSpacing' in ctx` guards an optional canvas feature; report it absent so the code
    // takes the same path a browser without it would.
    has(t, k) { return k in t },
  })
  return { ctx, calls }
}

const draw = () => {
  const { ctx, calls } = recorder()
  drawBrand(ctx, { x: 10, y: 100, colors: cardPalette('dark'), family: 'sans-serif' })
  return calls
}

describe('drawBrand', () => {
  it('paints the brand as GymBrooo, never the name the fork came from', () => {
    const painted = draw().filter(([k]) => k === 'fill').map(([, s]) => s)
    expect(painted.join('')).toContain('GymBrooo')
    expect(painted).not.toContain('open')
  })

  it('carries no site of its own: the card is shared, and opengym.ch is not ours to advertise', () => {
    const painted = draw().filter(([k]) => k === 'fill').map(([, s]) => s)
    expect(painted.join('')).not.toContain('opengym.ch')
    expect(painted.join('')).not.toContain('.ch')
  })

  it('measures the same string it paints, so the badge is the width of the logo', () => {
    const calls = draw()
    const measured = calls.filter(([k]) => k === 'measure').map(([, s]) => s)
    const painted = calls.filter(([k]) => k === 'fill').map(([, s]) => s).join('')

    // The badge width comes from measureText('GymBrooo'); whatever is painted has to add up to it.
    expect(measured).toContain('GymBrooo')
    expect(painted).toContain('GymBrooo')
  })

  it('keeps the two-tone split: the lead in the theme ink, the accent in brand green', () => {
    const { ctx, calls } = recorder()
    const colors = cardPalette('dark')
    drawBrand(ctx, { x: 10, y: 100, colors, family: 'sans-serif' })

    // fillStyle assignments are plain sets; find the one in force for each painted half.
    const fills = []
    let style = null
    for (const c of calls) {
      if (c[0] === 'fillStyle') style = c[1]
      // Only fillText carries a string: ctx.fill() also records a 'fill' with no text, and
      // drawMark now uses it for the plate's discs.
      if (c[0] === 'fill' && typeof c[1] === 'string') fills.push([c[1], style])
    }
    const lead = fills.find(([, s]) => s !== BRAND.green)
    const accent = fills.find(([, s]) => s === BRAND.green)
    expect(lead?.[0]).toBe('Gym')
    expect(accent?.[0]).toBe('Brooo')
  })
})
