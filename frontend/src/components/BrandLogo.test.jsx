// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import BrandLogo from './BrandLogo.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The lockup on the sign-in screen and the mobile onboarding (views/Login.jsx,
   views/MobileOnboarding.jsx). The name used to be live text split across two spans, which a
   browser translator is free to rewrite; it is geometry now (lib/wordmark.js), so these tests
   read the shapes rather than a string. */

let host, root
afterEach(() => {
  if (root) act(() => root.unmount())
  host?.remove()
  host = root = null
})

function render(node) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(node))
  return host
}

describe('BrandLogo', () => {
  it('names itself GymBrooo for assistive tech, never the name the fork came from', () => {
    const el = render(<BrandLogo />)
    const name = el.querySelector('.brand-lockup-name')
    expect(name.getAttribute('aria-label')).toBe('GymBrooo')
    // No live text at all: a translator has nothing to rewrite.
    expect(el.textContent).toBe('')
    expect(el.innerHTML).not.toMatch(/open/i)
    // Capital G and B, per the brand: gymbrooo lowercase is the machine form, GymBrooo is the
    // written one - the tab title, the manifest and the locale keys keep the former.
    expect(name.getAttribute('aria-label')).toMatch(/^GymBrooo$/)
  })

  it('tells the translator to leave the name alone', () => {
    const el = render(<BrandLogo />)
    expect(el.querySelector('.brand-lockup-name').getAttribute('translate')).toBe('no')
  })

  it('keeps the two-tone split: the lead follows the theme, the accent is brand orange', () => {
    const el = render(<BrandLogo />)
    const name = el.querySelector('.brand-lockup-name')
    // Shapes carry which glyph they belong to, so the split is asserted by letter rather than
    // by counting strokes - a glyph may be one polyline or several.
    const byGlyph = new Map()
    for (const s of name.querySelectorAll('polyline, circle')) {
      const g = s.getAttribute('data-glyph')
      if (!byGlyph.has(g)) byGlyph.set(g, new Set())
      byGlyph.get(g).add(s.getAttribute('stroke'))
    }
    expect([...byGlyph.keys()].map(Number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // Gym (G y m) inherits the theme's ink, Brooo (B r o o o) is brand orange. The split is
    // still at glyph 3: three lead glyphs, five accent ones.
    for (const g of ['0', '1', '2']) expect([...byGlyph.get(g)]).toEqual(['currentColor'])
    for (const g of ['3', '4', '5', '6', '7']) expect([...byGlyph.get(g)]).toEqual(['#ff9f0a'])
    // The old class names must be gone: a stale one would silently drop the colour.
    expect(el.querySelector('.brand-lockup-lead')).toBeNull()
    expect(el.querySelector('.brand-lockup-accent')).toBeNull()
    expect(el.querySelector('.brand-lockup-open')).toBeNull()
    expect(el.querySelector('.brand-lockup-gym')).toBeNull()
  })

  it('carries the mark, decorative, and never mirrors in RTL', () => {
    const el = render(<BrandLogo />)
    const mark = el.querySelector('svg.brand-lockup-mark')
    expect(mark).toBeTruthy()
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(el.querySelector('.brand-lockup').getAttribute('dir')).toBe('ltr')
  })
})
