// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import BrandLogo from './BrandLogo.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The lockup on the sign-in screen and the mobile onboarding (views/Login.jsx,
   views/MobileOnboarding.jsx). The brand was renamed in comments, styles and locale packs while
   this line kept painting the name the fork came from, and no test read it - so nothing failed.
   The text is split across two spans, which is why a search for the old name never matched it. */

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
  it('writes the brand as GymBro, not the name the fork came from', () => {
    const el = render(<BrandLogo />)
    expect(el.textContent).toBe('GymBro')
    expect(el.textContent).not.toMatch(/open/i)
    // Capital G and B, per the brand: gymbro lowercase is the machine form, GymBro is the
    // written one - the tab title, the manifest and the locale keys keep the former.
    expect(el.textContent).toMatch(/^GymBro$/)
  })

  it('tells the translator to leave the name alone', () => {
    const el = render(<BrandLogo />)
    for (const half of el.querySelectorAll('.brand-lockup-lead, .brand-lockup-accent')) {
      expect(half.getAttribute('translate'), half.textContent).toBe('no')
    }
  })

  it('keeps the two-tone split: the lead follows the theme, the accent is brand green', () => {
    const el = render(<BrandLogo />)
    expect(el.querySelector('.brand-lockup-lead')?.textContent).toBe('Gym')
    expect(el.querySelector('.brand-lockup-accent')?.textContent).toBe('Bro')
    // The old class names must be gone: a stale one would silently drop the colour.
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
