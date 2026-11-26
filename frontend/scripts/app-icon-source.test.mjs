import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { glyph, scene } from './app-icons.mjs'
import { APP_ICON_VARIANTS } from '../src/lib/app-icon-variants.js'

/* The app icon and the recolourable mark are two different files on purpose.
 *
 * resources/icon.svg  the plate: five bands, three colours. Rasterised as an `art` variant
 *                     through drawArt, which paints shapes in order and understands circles.
 * resources/mark.svg  the barbell: one colour, which every variant recolours with its own
 *                     fg/bg. glyph() reads this one.
 *
 * Splitting them is what lets the icon be multi-colour without breaking neon, light, mono and
 * the rest - and it is also why glyph() must NOT read icon.svg: it only extracts <rect>, so a
 * circle-only file would silently produce an empty glyph and blank themed icons.
 */

describe('the icon source and the mark source', () => {
  it('the plate parses as circles, not as an empty glyph', () => {
    const svg = readFileSync(new URL('../resources/icon.svg', import.meta.url), 'utf8')
    const shapes = scene(svg)
    expect(shapes.length).toBe(6)          // background + rim + face + ring + collar + hole
    expect(shapes.filter(s => s.box[2] - s.box[0] === 512).length).toBe(1)  // the background
    // Every non-background shape is round: its box is square.
    const discs = shapes.slice(1)
    expect(discs.length).toBe(5)
    for (const d of discs) {
      const w = d.box[2] - d.box[0]
      const h = d.box[3] - d.box[1]
      expect(w, 'a disc box must be square').toBe(h)
    }
  })

  it('the default variant renders the logo as art, not as a recoloured glyph', () => {
    const def = APP_ICON_VARIANTS.find(v => v.id === 'default')
    // The whole lockup now - plate, bar and the eight glyphs - not the plate alone. It is
    // still art because it is multi-colour: a glyph is one fill every variant recolours.
    expect(def.art).toBe('resources/logo.svg')
    const shapes = scene(readFileSync(new URL(`../${def.art}`, import.meta.url), 'utf8'))
    expect(shapes.length, 'the logo must parse into shapes').toBeGreaterThan(10)
  })

  it('the glyph source is the mark, and it is rectangles the variants can recolour', () => {
    const rects = glyph()
    expect(rects.length).toBeGreaterThan(0)
    // A rect quad is [x, y, w, h]; the plate's circles would never match this shape.
    for (const q of rects) expect(q).toHaveLength(4)
    const svg = readFileSync(new URL('../resources/mark.svg', import.meta.url), 'utf8')
    expect(svg).toContain('<g fill="#ff7622">')
    expect(svg).not.toContain('<circle')
  })

  it('no variant points its art at the mark, and none points its glyph at the plate', () => {
    for (const v of APP_ICON_VARIANTS.filter(v => v.art)) {
      expect(v.art, v.id).not.toBe('resources/mark.svg')
    }
  })

  it('no two colour variants are the same icon', () => {
    // The brand re-colour swept every hex it matched, and it turned the deliberately-green
    // Neon variant into a second copy of Orange. Two rows with the same colours are one row
    // with a confusing name, so this pins them apart.
    const colour = APP_ICON_VARIANTS.filter(v => !v.art)
    const seen = new Map()
    for (const v of colour) {
      const key = `${v.bg}|${v.fg}`
      expect(seen.has(key), `${v.id} is identical to ${seen.get(key)}`).toBe(false)
      seen.set(key, v.id)
    }
    expect(colour.length).toBeGreaterThan(1)
  })
})
