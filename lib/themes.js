/**
 * Chart themes — six curated palettes plus follow-host / light / dark chrome.
 *
 * A theme here is one object that drives BOTH the ECharts instance (series
 * colours, axis text, grid lines) and the card chrome (background, text), so a
 * switch changes the whole canvas at once. This collapses the original system's
 * CSS-token mirror + theme registry into a single plain object per theme.
 *
 * `follow-host` is special: its chrome colours are resolved at runtime from the
 * shell's `--dsw-*` tokens, so a host theme switch is picked up live. Its
 * series palette cannot be derived from tokens (they are not chart semantics),
 * so it uses the default palette below.
 *
 * @module lib/themes
 */

/**
 * Series palettes. Six curated sets rather than the original's thirty-seven —
 * each is one coherent series-colour list an analysis canvas can cycle through.
 * The first entry of each doubles as that theme's accent.
 */
export const PALETTES = {
  /** Default blue-led set (matches the plugin's accent). */
  classic: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f43f5e', '#84cc16', '#64748b'],
  /** Softer, print-friendly. */
  pastel: ['#7c9ef5', '#8fd6b4', '#f2c57c', '#f19a9a', '#c3a6f2', '#7fd4e0', '#f4a4c0', '#b5d17f', '#a8b3c5'],
  /** High contrast, presentation. */
  vivid: ['#2563eb', '#16a34a', '#dc2626', '#f97316', '#7c3aed', '#0891b2', '#e11d48', '#65a30d', '#94a3b8'],
  /** Warm earth tones. */
  warm: ['#d97706', '#b91c1c', '#15803d', '#7c2d12', '#a16207', '#9f1239', '#4d7c0f', '#c2410c', '#78350f'],
  /** Cool monochrome-leaning. */
  cool: ['#0e7490', '#155e75', '#0284c7', '#0369a1', '#14b8a6', '#2563eb', '#0891b2', '#334155', '#64748b'],
  /** Dark-ready set: bright enough on dark backgrounds. */
  neon: ['#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#22d3ee', '#f472b6', '#a3e635', '#94a3b8'],
}

export const PALETTE_NAMES = Object.keys(PALETTES)

/**
 * The three chrome modes. `follow-host` chrome is filled in at runtime by
 * `resolveTheme`; light and dark are literals.
 */
/**
 * The theme follows the host: there is no separate chrome mode anymore. The
 * constant remains as a validation anchor for persisted theme blobs written by
 * older versions (chrome values are read and ignored).
 */
export const CHROME_MODES = ['follow-host']

/** Literal chrome for the two fixed modes. */
const FIXED_CHROME = {
  light: {
    background: 'transparent',
    text: '#0f1115',
    textSecondary: '#61666b',
    gridLine: 'rgba(15, 17, 21, 0.10)',
    cardSurface: 'color-mix(in srgb, #0f1115 5%, transparent)',
    selectedSurface: 'color-mix(in srgb, #0f1115 10%, transparent)',
  },
  dark: {
    background: 'transparent',
    text: '#e6e8eb',
    textSecondary: '#9ba1a8',
    gridLine: 'rgba(230, 232, 235, 0.12)',
    cardSurface: 'color-mix(in srgb, #e6e8eb 6%, transparent)',
    selectedSurface: 'color-mix(in srgb, #e6e8eb 12%, transparent)',
  },
}

/** Read a CSS custom property off :root, with a fallback. */
function token (name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  } catch {
    return fallback
  }
}

/**
 * Blend a hex/base colour into a concrete rgba() string. ECharts paints on
 * canvas and cannot resolve CSS color-mix/var(), so any colour handed to an
 * ECharts theme must be a literal value.
 */
export function rgbaMix (color, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(color).trim())
  if (!m) return `rgba(128,128,128,${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/**
 * Build the full theme object for a (chromeMode, paletteName) pair.
 *
 * @param {string} chromeMode 'follow-host' | 'light' | 'dark'
 * @param {string} paletteName key of PALETTES
 * @returns {{ series: string[], background: string, text: string,
 *   textSecondary: string, gridLine: string, cardSurface: string,
 *   selectedSurface: string, isDark: boolean, echarts: object }}
 *   `echarts` is ready to pass as the theme object to `echarts.init`.
 */
export function resolveTheme (paletteName) {
  const series = PALETTES[paletteName] || PALETTES.classic
  const isDark = isDarkRequested()

  // Chrome always derives from the shell's own tokens so a host theme switch is
  // picked up without a plugin reload. Falls back to light values when the
  // tokens are absent (e.g. a composition without the theme package). Colours
  // handed to ECharts must be literal rgba()/hex — canvas cannot resolve CSS
  // color-mix or var().
  const chrome = {
    background: 'transparent',
    text: token('--dsw-alias-label-primary', FIXED_CHROME.light.text),
    textSecondary: token('--dsw-alias-label-tertiary', FIXED_CHROME.light.textSecondary),
    gridLine: rgbaMix(token('--dsw-alias-label-primary', FIXED_CHROME.light.text), 0.12),
    cardSurface: 'color-mix(in srgb, currentColor 5%, transparent)',
    selectedSurface: 'color-mix(in srgb, currentColor 10%, transparent)',
  }

  return {
    ...chrome,
    series,
    isDark,
    /** Theme object for `echarts.init(dom, theme)` / `registerTheme`. */
    echarts: {
      color: series,
      backgroundColor: 'transparent',
      textStyle: { color: chrome.text },
      title: { textStyle: { color: chrome.text } },
      legend: { textStyle: { color: chrome.text } },
      categoryAxis: {
        axisLine: { lineStyle: { color: chrome.gridLine } },
        axisLabel: { color: chrome.textSecondary },
        splitLine: { show: false },
      },
      valueAxis: {
        axisLine: { show: false },
        axisLabel: { color: chrome.textSecondary },
        splitLine: { lineStyle: { color: chrome.gridLine } },
      },
      tooltip: {
        backgroundColor: isDark ? 'rgba(30,32,36,.94)' : 'rgba(255,255,255,.96)',
        textStyle: { color: chrome.text },
      },
    },
  }
}

/**
 * Follow the host's own light/dark decision. The canvas has no light/dark
 * toggle of its own — measured markers, in priority order
 * (probe: ai-xcharts/scripts/xc-theme-probe.mjs):
 *   1. html[data-ds-theme-source="light|dark"] — the host's own attribute
 *   2. html style/computed color-scheme        — resolved scheme
 *   3. prefers-color-scheme                    — OS level fallback
 *
 * In Node (no DOM) this always returns false — light chrome — which is the
 * degradation path a composition without the theme package would take too.
 *
 * @param {object} [dom] test seam: { attr, colorScheme, matchMedia } lookups
 * @returns {boolean}
 */
export function isDarkRequested (dom = null) {
  try {
    const source = dom?.attr ?? (typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-ds-theme-source')
      : null)
    if (source === 'dark') return true
    if (source === 'light') return false
    const scheme = dom?.colorScheme ?? (typeof window !== 'undefined'
      ? (document.documentElement.style?.colorScheme
        || getComputedStyle(document.documentElement).getPropertyValue('color-scheme'))
      : '')
    if (/\bdark\b/.test(scheme)) return true
    if (/\blight\b/.test(scheme)) return false
    if (dom?.matchMedia ?? (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-color-scheme: dark)')?.matches)) return true
  } catch { /* non-DOM: default to light */ }
  return false
}

/** Validate a persisted theme choice; unknown values fall back to defaults. */
export function normalizeTheme (stored) {
  // Chrome is always follow-host now; only the palette is user-selectable.
  // Older persisted blobs may still carry a chrome field — read and dropped.
  const palette = PALETTES[stored?.palette] ? stored.palette : 'classic'
  return { palette }
}
