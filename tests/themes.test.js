import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PALETTES, PALETTE_NAMES, CHROME_MODES,
  resolveTheme, isDarkRequested, normalizeTheme, rgbaMix,
} from '../lib/themes.js'

test('six curated palettes exist, each with distinct usable colours', () => {
  assert.equal(PALETTE_NAMES.length, 6)
  for (const name of PALETTE_NAMES) {
    const palette = PALETTES[name]
    assert.ok(Array.isArray(palette) && palette.length >= 6, `${name} needs at least 6 series colours`)
    for (const color of palette) {
      assert.match(color, /^#[0-9a-f]{6}$/i, `${name}: ${color} must be a hex colour`)
    }
    assert.equal(new Set(palette).size, palette.length, `${name} colours must be distinct`)
  }
})

test('there is no separate chrome mode — the theme always follows the host', () => {
  // The light/dark toggle was removed on request: the fixed variants drifted
  // from the real shell colours, and the user wants host tracking only.
  assert.deepEqual(CHROME_MODES, ['follow-host'])
  // normalizeTheme reads old persisted blobs but drops the chrome field.
  assert.deepEqual(normalizeTheme({ chrome: 'dark', palette: 'neon' }), { palette: 'neon' })
  assert.deepEqual(normalizeTheme(null), { palette: 'classic' })
})

test('resolveTheme produces a theme usable as an ECharts theme object', () => {
  const theme = resolveTheme('classic')
  assert.ok(Array.isArray(theme.echarts.color) && theme.echarts.color.length >= 6)
  assert.equal(theme.echarts.backgroundColor, 'transparent', 'cards own the background, not the chart')
  assert.ok(theme.echarts.categoryAxis, 'axis styling must be present')
  assert.ok(theme.echarts.valueAxis, 'axis styling must be present')
  assert.ok(theme.echarts.tooltip, 'tooltip styling must be present')
})

test('resolveTheme works outside a DOM (degradation path)', () => {
  const theme = resolveTheme('pastel')
  assert.ok(theme.text)
  assert.equal(theme.isDark, false, 'no DOM markers -> light')
  assert.equal(theme.series, PALETTES.pastel, 'the chosen palette drives series colours')
})

test('isDarkRequested reads the host markers in priority order', () => {
  // 1. data-ds-theme-source wins over everything.
  assert.equal(isDarkRequested({ attr: 'dark', colorScheme: 'light', matchMedia: false }), true)
  assert.equal(isDarkRequested({ attr: 'light', colorScheme: 'dark', matchMedia: true }), false)
  // 2. color-scheme next.
  assert.equal(isDarkRequested({ colorScheme: 'dark', matchMedia: false }), true)
  assert.equal(isDarkRequested({ colorScheme: 'light dark', matchMedia: false }), true, 'a list containing dark counts')
  // 3. prefers-color-scheme last.
  assert.equal(isDarkRequested({ matchMedia: true }), true)
  // No markers at all -> light.
  assert.equal(isDarkRequested({}), false)
})

test('rgbaMix produces literal rgba strings canvas can paint', () => {
  assert.equal(rgbaMix('#ff0000', 0.12), 'rgba(255,0,0,0.12)')
  assert.equal(rgbaMix('rgb(10,20,30)', 0.5), 'rgba(128,128,128,0.5)', 'non-hex falls back to grey')
  // Every resolved theme's ECharts colours must be canvas-paintable: no
  // color-mix(), no var(), no currentColor.
  for (const name of PALETTE_NAMES) {
    const theme = resolveTheme(name)
    const colours = [
      theme.echarts.categoryAxis?.axisLine?.lineStyle?.color,
      theme.echarts.valueAxis?.splitLine?.lineStyle?.color,
    ]
    for (const colour of colours) {
      assert.ok(colour, `${name}: axis colours must be present`)
      assert.doesNotMatch(colour, /color-mix|var\(|currentColor/,
        `${name}: "${colour}" is not paintable on canvas`)
    }
  }
})

test('every palette renders sanely on dark chrome (no near-black series)', () => {
  // A dark theme with dark series colours is unreadable. Luminance of every
  // colour across the palettes must clear a floor.
  for (const name of PALETTE_NAMES) {
    for (const color of PALETTES[name]) {
      const n = parseInt(color.slice(1), 16)
      const luminance = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
      assert.ok(
        luminance > 0.15,
        `${name}.${color} is too dark for charts (luminance ${luminance.toFixed(2)})`,
      )
    }
  }
})

test('normalizeTheme falls back to defaults on unknown values', () => {
  assert.deepEqual(normalizeTheme(null), { palette: 'classic' })
  assert.deepEqual(normalizeTheme({}), { palette: 'classic' })
  assert.deepEqual(
    normalizeTheme({ palette: 'neon', chrome: 'nonsense' }),
    { palette: 'neon' },
    'valid palette survives; chrome is ignored',
  )
  assert.deepEqual(
    normalizeTheme({ palette: 'nonsense' }),
    { palette: 'classic' },
    'invalid palettes must fall back, not throw',
  )
})
