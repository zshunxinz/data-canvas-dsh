/**
 * Canvas grid layout engine.
 *
 * Ported from the xchartsAI frontend (`ai-xcharts/src/utils/gridLayout.ts`,
 * 96-column grid) — the algorithms are kept behaviourally identical so the
 * canvas feels the same. Deliberately dependency-free pure functions: no
 * store, no DOM, no framework, so they can be unit-tested and reused.
 *
 * Coordinate model
 *   x  column index, 0 … COLS-1   (w = width in columns)
 *   y  row index,    0 …          (h = height in rows)
 *
 * @module lib/grid
 */

// ── Grid constants ──────────────────────────────────────────────────────────
export const COLS = 96 // 96-column grid
export const DEFAULT_ROW_PITCH = 24
export const MIN_W = 16 // smallest card ≈ 1/6 of a row
export const MIN_H = 2
export const MAX_W = 96 // full row
export const MAX_H = 32
/** Safety ceiling for the content-driven right expansion. */
export const EXTENT_COLS_CEIL = COLS * 16
export const MIN_GAP_X = 4
export const MIN_GAP_Y = 1

/** Discrete width/height tiers used by tidy arrangement. */
export const TIDY_WIDTH_TIERS = [24, 32, 48, 64, 96]
export const TIDY_HEIGHT_TIERS = [4, 8, 12, 16, 20, 24, 28, 32]

/** Smart default size per chart type. */
export function smartSize(chartType) {
  switch (chartType) {
    case 'pie':
    case 'radar':
    case 'funnel':
      return { w: 32, h: 15 }
    case 'heatmap':
    case 'table':
      return { w: 64, h: 21 }
    default:
      return { w: 48, h: 15 }
  }
}

/** Default layout for a card with no explicit size. */
export function defaultLayout() {
  return { x: 0, y: 0, w: 48, h: 15, grid_v: 5 }
}

export function clampLayout(l, colBound = COLS) {
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(l.w)))
  const h = Math.max(MIN_H, Math.min(MAX_H, Math.round(l.h)))
  const x = Math.max(0, Math.min(Math.max(0, colBound - w), Math.round(l.x)))
  const y = Math.max(0, Math.round(l.y))
  return { x, y, w, h, grid_v: 5 }
}

// ── Collision ───────────────────────────────────────────────────────────────

export function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Row-band occupancy index: y row → sorted, non-overlapping [start, end) x ranges.
 * Turns the "every cell × every window" scan into interval queries.
 */
export function buildRowIndex(wins, effCol) {
  const rows = new Map()
  for (const o of wins) {
    if (o.minimized) continue
    const s = o.layout.x
    const e = effCol === undefined ? o.layout.x + o.layout.w : Math.min(effCol, o.layout.x + o.layout.w)
    if (s >= e) continue
    for (let ry = o.layout.y; ry < o.layout.y + o.layout.h; ry++) {
      let list = rows.get(ry)
      if (!list) {
        list = []
        rows.set(ry, list)
      }
      list.push([s, e])
    }
  }
  for (const list of rows.values()) list.sort((a, b) => a[0] - b[0])
  return { rows }
}

/** Whether rectangle (x,y,w,h) is free against the index. */
export function rectFree(idx, x, y, w, h) {
  for (let ry = y; ry < y + h; ry++) {
    const list = idx.rows.get(ry)
    if (!list) continue
    const xe = x + w
    for (const [s, e] of list) {
      if (s >= xe) break
      if (e > x) return false
    }
  }
  return true
}

/**
 * Top-down scan for the first free rectangle inside the horizontal band
 * [xMin, xMax], starting at `yStart`. Equivalent to a cell-by-cell scan, in
 * O(rows × cols).
 */
export function firstFreeInRows(idx, xMin, xMax, w, h, yLimit, yStart = 0) {
  const xEnd = xMax - w
  if (xEnd < xMin) return null
  const len = xEnd - xMin + 1
  const open = new Int32Array(len) // consecutive free rows per x
  const starts = new Int32Array(len) // start row of the current free run
  const rows = idx.rows
  for (let y = yStart; y <= yLimit; y++) {
    const list = rows.get(y)
    if (!list) {
      for (let i = 0; i < len; i++) {
        const run = open[i]
        if (run === 0) starts[i] = y
        open[i] = run + 1
        if (run + 1 >= h) return { x: xMin + i, y: starts[i], w, h, grid_v: 5 }
      }
      continue
    }
    let p = 0
    for (let i = 0; i < len; i++) {
      const x = xMin + i
      const xe = x + w
      while (p < list.length && list[p][1] <= x) p++
      const blocked = p < list.length && list[p][0] < xe
      if (blocked) {
        open[i] = 0
      } else {
        const run = open[i]
        if (run === 0) starts[i] = y
        open[i] = run + 1
        if (run + 1 >= h) return { x, y: starts[i], w, h, grid_v: 5 }
      }
    }
  }
  return null
}

// ── Compaction ──────────────────────────────────────────────────────────────

/** Close only large horizontal gaps, preserving MIN_GAP_X. */
export function compactHorizontal(wins, moved, colBound = COLS) {
  if (moved.size === 0) return
  const active = wins.filter(w => !w.minimized)

  const rowMap = new Map()
  for (const win of active) {
    const ry = win.layout.y
    if (!rowMap.has(ry)) rowMap.set(ry, [])
    rowMap.get(ry).push(win)
  }

  for (const [, row] of rowMap) {
    if (!row.some(w => moved.has(w.id))) continue
    row.sort((a, b) => a.layout.x - b.layout.x)

    for (let i = 0; i < row.length; i++) {
      const win = row[i]
      if (!moved.has(win.id)) continue

      let leftEdge = 0
      for (let j = i - 1; j >= 0; j--) {
        const left = row[j]
        if (overlaps(
          { x: left.layout.x, y: left.layout.y, w: left.layout.w, h: left.layout.h },
          { x: left.layout.x, y: win.layout.y, w: left.layout.w, h: win.layout.h },
        )) {
          leftEdge = Math.max(leftEdge, left.layout.x + left.layout.w)
        }
      }
      for (const o of active) {
        if (o.id === win.id || o.minimized) continue
        if (o.layout.y === win.layout.y) continue
        if (o.layout.y < win.layout.y + win.layout.h && o.layout.y + o.layout.h > win.layout.y) {
          leftEdge = Math.max(leftEdge, o.layout.x + o.layout.w)
        }
      }

      const targetX = leftEdge + MIN_GAP_X
      if (targetX < win.layout.x && win.layout.x - targetX > MIN_GAP_X) {
        if (targetX + win.layout.w <= colBound) win.layout.x = targetX
      }
    }
  }
}

/** Close only large vertical gaps, preserving MIN_GAP_Y. */
export function compactVertical(wins, moved) {
  if (moved.size === 0) return
  const active = wins.filter(w => !w.minimized)
  const runners = active.filter(w => moved.has(w.id))
  if (runners.length === 0) return

  for (let pass = 0; pass < 10; pass++) {
    const rowMap = new Map()
    for (const win of active) {
      const ry = win.layout.y
      if (!rowMap.has(ry)) rowMap.set(ry, [])
      rowMap.get(ry).push(win)
    }

    const sortedYs = [...rowMap.keys()].sort((a, b) => a - b)
    if (sortedYs.length < 2) return

    let anyMoved = false

    for (let i = 1; i < sortedYs.length; i++) {
      const rowY = sortedYs[i]
      const row = rowMap.get(rowY)
      if (!row.some(w => moved.has(w.id))) continue

      let targetY = rowY
      for (const win of row) {
        for (let y = rowY; y >= 0; y--) {
          let blocked = false
          for (const o of active) {
            if (o.id === win.id || o.minimized) continue
            const oBottom = o.layout.y + o.layout.h
            if (oBottom + MIN_GAP_Y > y) {
              if (o.layout.y < y + win.layout.h && overlaps({ x: win.layout.x, y, w: win.layout.w, h: win.layout.h }, o.layout)) {
                blocked = true
                break
              }
            }
          }
          if (!blocked) {
            targetY = Math.min(targetY, y)
            break
          }
          if (y === 0) targetY = Math.min(targetY, rowY)
        }
      }

      if (targetY < rowY && rowY - targetY > MIN_GAP_Y) {
        for (const win of row) {
          if (moved.has(win.id)) win.layout.y = targetY
        }
        anyMoved = true
      }
    }

    if (!anyMoved) break
  }
}

// ── Placement ───────────────────────────────────────────────────────────────

/**
 * Gap-aware flow placement: anchor-adjacent first, then scan gaps, then flow append.
 * `anchor` clusters a new card next to a related one (e.g. same datasource).
 */
export function findFreeSlot(wins, w, h, anchor, colBound = COLS) {
  const active = wins.filter(win => !win.minimized)
  if (active.length === 0) return { x: 0, y: 0, w, h, grid_v: 5 }

  const effCol = Math.min(colBound, Math.max(COLS, ...active.map(o => o.layout.x + o.layout.w + MIN_GAP_X)))
  const idx = buildRowIndex(active, effCol)

  if (anchor) {
    const adjacents = [
      { x: anchor.x + anchor.w, y: anchor.y, w, h },
      { x: anchor.x, y: anchor.y + anchor.h, w, h },
      { x: anchor.x + anchor.w + MIN_GAP_X, y: anchor.y, w, h },
      { x: anchor.x, y: anchor.y + anchor.h + MIN_GAP_Y, w, h },
      { x: anchor.x + anchor.w + MIN_GAP_X, y: anchor.y + anchor.h, w, h },
      { x: Math.max(0, anchor.x - w - MIN_GAP_X), y: anchor.y, w, h },
    ]
    for (const pos of adjacents) {
      const clamped = clampLayout(pos, colBound)
      if (rectFree(idx, clamped.x, clamped.y, clamped.w, clamped.h)) return clamped
    }
  }

  const rowMap = new Map()
  for (const win of active) {
    const ry = win.layout.y
    if (!rowMap.has(ry)) rowMap.set(ry, [])
    rowMap.get(ry).push(win)
  }

  const sortedYs = [...rowMap.keys()].sort((a, b) => a - b)
  const lastRowY = sortedYs[sortedYs.length - 1]
  const lastRow = rowMap.get(lastRowY)
  lastRow.sort((a, b) => a.layout.x - b.layout.x)

  let flowX = 0
  for (const win of lastRow) flowX = Math.max(flowX, win.layout.x + win.layout.w)

  let bottomY = 0
  for (const win of active) bottomY = Math.max(bottomY, win.layout.y + win.layout.h)

  const flowY = flowX + w <= effCol ? lastRowY : bottomY
  const flowPos = { x: flowX + w <= effCol ? flowX : 0, y: flowY, w, h }

  const gapSlot = firstFreeInRows(idx, 0, effCol, w, h, flowPos.y)
  if (gapSlot) return gapSlot

  for (let y = flowPos.y; y < flowPos.y + 100; y++) {
    const test = clampLayout({ x: flowPos.x, y, w, h, grid_v: 5 }, colBound)
    if (rectFree(idx, test.x, test.y, test.w, test.h)) return test
  }

  const fallbackY = Math.max(bottomY, ...active.map(o => o.layout.y + o.layout.h))
  return clampLayout({ x: 0, y: fallbackY + MIN_GAP_Y, w, h, grid_v: 5 }, colBound)
}

/** Find a free slot inside a fixed horizontal band (column/split strategies). */
export function placeInBand(wins, w, h, xMin, xMax, yLimit = 20000, yStart = 0) {
  const active = wins.filter(x => !x.minimized)
  const idx = buildRowIndex(active)
  const slot = firstFreeInRows(idx, xMin, xMax, w, h, yLimit, yStart)
  if (slot) return slot
  return { x: xMin, y: yStart, w, h, grid_v: 5 }
}

// ── Arrangement ─────────────────────────────────────────────────────────────

/** Two nearest tiers to `v`, by distance (ties broken by tier value). */
export function twoNearest(v, tiers) {
  const sorted = [...tiers].sort((a, b) => Math.abs(a - v) - Math.abs(b - v) || a - b)
  return sorted.slice(0, 2)
}

const TIDY_ASPECT_SAFETY = 0.4
const TIDY_ASPECT_WEIGHT = 0.5
const TIDY_SIZE_WEIGHT = 0.5

/** Pick the nearest discrete size tier that least distorts aspect ratio and scale. */
export function pickTierSize(w, h) {
  const ws = twoNearest(w, TIDY_WIDTH_TIERS)
  const hs = twoNearest(h, TIDY_HEIGHT_TIERS)
  const origAspect = w / h
  let best = null
  for (const wT of ws) {
    for (const hT of hs) {
      const aspectChange = Math.abs(wT / hT / origAspect - 1)
      const sizeChange = (Math.abs(wT - w) / w + Math.abs(hT - h) / h) / 2
      const cost = TIDY_ASPECT_WEIGHT * aspectChange + TIDY_SIZE_WEIGHT * sizeChange
      if (!best || cost < best.cost) best = { w: wT, h: hT, cost, aspectChange }
    }
  }
  if (!best || best.aspectChange > TIDY_ASPECT_SAFETY) return { w, h }
  return { w: best.w, h: best.h }
}

/**
 * Tidy arrangement: snap every card to a size tier, then pack rows in reading
 * order (top-to-bottom, left-to-right) with no overlap.
 *
 * Returns a new array of `{ id, layout }`; cards that are minimized keep their
 * layout untouched.
 */
export function tidyArrange(wins, colBound = COLS, gap = 2) {
  const active = wins.filter(w => !w.minimized)
  const result = new Map()

  for (const win of active) {
    const tier = pickTierSize(win.layout.w, win.layout.h)
    // Reserve gutters inside fractional-screen tiers: two half-width cards
    // remain side by side instead of wrapping just because a gutter was added.
    const width = tier.w < COLS ? Math.max(MIN_W, tier.w - Math.ceil(gap * (1 - tier.w / COLS))) : tier.w
    result.set(win.id, { x: 0, y: 0, w: width, h: tier.h, grid_v: 5 })
  }

  // Shelf packing: fill each shelf left-to-right, wrap when full.
  const items = [...active].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
  let shelfY = 0
  let cursorX = 0
  let shelfH = 0

  for (const win of items) {
    const layout = result.get(win.id)
    if (cursorX > 0 && cursorX + layout.w > colBound) {
      shelfY += shelfH + (shelfH > 0 ? Math.max(MIN_GAP_Y, 1) : 0)
      cursorX = 0
      shelfH = 0
    }
    layout.x = cursorX
    layout.y = shelfY
    cursorX += layout.w + (gap > 0 ? gap : 0)
    shelfH = Math.max(shelfH, layout.h)
  }

  return active.map(win => ({ id: win.id, layout: result.get(win.id) }))
}

/** Place a card at the end of the canvas flow without overlapping anything. */
export function appendSlot(wins, w, h, colBound = COLS) {
  return findFreeSlot(wins, w, h, undefined, colBound)
}

/**
 * Nearest position to `target` that collides with nothing.
 *
 * Used when a drag is dropped on top of another card. Leaving them overlapping
 * looked broken and left the lower card partly unreachable, so the dropped card
 * settles into the closest legal slot instead. The search walks outward from the
 * drop point, preferring the smallest displacement and, at equal distance,
 * vertical movement — cards read top-to-bottom, so sliding down is more
 * predictable than sliding sideways.
 *
 * @param {Array} wins all cards; the moving one is skipped by id
 * @param {{x:number,y:number,w:number,h:number}} target where the user dropped it
 * @param {string|null} excludeId id of the card being moved
 * @param {number} colBound horizontal bound (a wide canvas may exceed COLS)
 * @returns {{x:number,y:number,w:number,h:number,grid_v:number}}
 */
export function nearestFreeSlot(wins, target, excludeId = null, colBound = COLS) {
  const others = wins.filter(w => !w.minimized && w.id !== excludeId)
  const idx = buildRowIndex(others)

  const base = clampLayout(target, colBound)
  if (rectFree(idx, base.x, base.y, base.w, base.h)) return base

  const maxRing = 240
  for (let d = 1; d <= maxRing; d++) {
    const candidates = [
      [0, d], [0, -d],
      [d, d], [-d, d], [d, -d], [-d, -d],
      [d, 0], [-d, 0],
    ]
    for (const [dx, dy] of candidates) {
      const probe = clampLayout({ ...base, x: base.x + dx, y: base.y + dy }, colBound)
      if (rectFree(idx, probe.x, probe.y, probe.w, probe.h)) return probe
    }
  }

  // Nothing fit in the search window: fall back to flow placement so the card
  // always ends up somewhere reachable.
  return findFreeSlot(others, base.w, base.h, undefined, colBound)
}

/** Whether `layout` collides with any card other than `excludeId`. */
export function collides(wins, layout, excludeId = null) {
  const idx = buildRowIndex(wins.filter(w => !w.minimized && w.id !== excludeId))
  return !rectFree(idx, layout.x, layout.y, layout.w, layout.h)
}

// ── Alignment snap lines (phase 3) ──────────────────────────────────────────

/**
 * Horizontal grid positions worth snapping to for one axis.
 *
 * For each other card, both its edges and its centre project a candidate
 * position on the axis; the moving card matches when any of ITS edges/centre
 * aligns within `tolerance` (grid units). Returns the deduplicated list of
 * matched positions — the caller draws one guide line per position and, on
 * drop, snaps the moving card to the first one.
 *
 * Pure and grid-unit based (like the rest of this module), so the server tests
 * it and the client re-implements the copy verbatim against pixel rects.
 *
 * @param {{x:number,y:number,w:number,h:number}} layout the card being dragged
 * @param {Array<{id:string,x:number,y:number,w:number,h:number}>} others cards to align against
 * @param {number} [tolerance=1] snap distance in grid units
 * @returns {{ vertical: number[], horizontal: number[] }} matched grid positions
 *   (vertical = x positions, horizontal = y positions)
 */
export function snapLines(layout, others, tolerance = 1) {
  const anchors = rect => [rect.x, rect.x + rect.w / 2, rect.x + rect.w]
  const vAnchors = rect => [rect.y, rect.y + rect.h / 2, rect.y + rect.h]

  const match = (moving, fixed, candidates) => {
    const hits = []
    for (const target of candidates) {
      for (const source of moving) {
        if (Math.abs(source - target) <= tolerance) { hits.push(target); break }
      }
    }
    return hits
  }

  const movingX = anchors(layout)
  const movingY = vAnchors(layout)
  const vertical = []
  const horizontal = []
  for (const other of others) {
    if (other.id === layout.id || other.minimized) continue
    for (const hit of match(movingX, other, anchors(other))) {
      if (!vertical.includes(hit)) vertical.push(hit)
    }
    for (const hit of match(movingY, other, vAnchors(other))) {
      if (!horizontal.includes(hit)) horizontal.push(hit)
    }
  }
  return { vertical, horizontal }
}

/**
 * Snap a layout to the nearest matched line, returning the adjusted layout and
 * the lines that fired (for the overlay to draw). When nothing matches within
 * tolerance the layout is returned unchanged with empty line lists.
 */
export function applySnap(layout, others, tolerance = 1) {
  const lines = snapLines(layout, others, tolerance)
  const next = { ...layout }
  const snapped = { vertical: [], horizontal: [] }

  if (lines.vertical.length > 0) {
    // Align the moving edge/centre closest to the first matched line.
    const target = lines.vertical[0]
    const candidates = [
      { at: layout.x, dx: target - layout.x },
      { at: layout.x + layout.w / 2, dx: target - (layout.x + layout.w / 2) },
      { at: layout.x + layout.w, dx: target - (layout.x + layout.w) },
    ].sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx))[0]
    next.x = layout.x + candidates.dx
    snapped.vertical.push(target)
  }
  if (lines.horizontal.length > 0) {
    const target = lines.horizontal[0]
    const candidates = [
      { at: layout.y, dy: target - layout.y },
      { at: layout.y + layout.h / 2, dy: target - (layout.y + layout.h / 2) },
      { at: layout.y + layout.h, dy: target - (layout.y + layout.h) },
    ].sort((a, b) => Math.abs(a.dy) - Math.abs(b.dy))[0]
    next.y = layout.y + candidates.dy
    snapped.horizontal.push(target)
  }
  return { layout: next, lines: snapped }
}
