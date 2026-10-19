import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  COLS, MIN_W, MIN_H, MAX_W, MAX_H,
  clampLayout, overlaps, buildRowIndex, rectFree, firstFreeInRows,
  findFreeSlot, placeInBand, tidyArrange, pickTierSize, smartSize, defaultLayout,
  compactHorizontal, compactVertical, nearestFreeSlot, collides,
} from '../lib/grid.js'

const card = (id, x, y, w, h, extra = {}) => ({
  id,
  layout: { x, y, w, h, grid_v: 5 },
  ...extra,
})

test('clampLayout enforces size and position bounds', () => {
  assert.deepEqual(clampLayout({ x: -5, y: -3, w: 1, h: 1 }),
    { x: 0, y: 0, w: MIN_W, h: MIN_H, grid_v: 5 })
  assert.deepEqual(clampLayout({ x: 999, y: 4, w: 999, h: 999 }),
    { x: 0, y: 4, w: MAX_W, h: MAX_H, grid_v: 5 })
  // x is clamped so the card stays inside the bound
  const c = clampLayout({ x: 90, y: 0, w: 24, h: 4 })
  assert.equal(c.x, COLS - 24)
})

test('clampLayout respects a widened column bound', () => {
  const c = clampLayout({ x: 200, y: 0, w: 24, h: 4 }, 400)
  assert.equal(c.x, 200)
})

test('overlaps detects intersection and edge-touching only', () => {
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true)
  // sharing an edge is not an overlap
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false)
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 10, w: 10, h: 10 }), false)
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 10, w: 10, h: 10 }), false)
})

test('rectFree agrees with a brute-force overlap scan', () => {
  const wins = [card('a', 0, 0, 24, 8), card('b', 24, 0, 24, 8), card('c', 0, 8, 48, 8)]
  const idx = buildRowIndex(wins)
  // brute-force reference
  const brute = (x, y, w, h) =>
    !wins.some(o => overlaps(o.layout, { x, y, w, h }))

  for (let x = 0; x < 60; x += 3) {
    for (let y = 0; y < 20; y++) {
      assert.equal(rectFree(idx, x, y, 12, 4), brute(x, y, 12, 4), `mismatch at ${x},${y}`)
    }
  }
})

test('minimized cards do not block placement', () => {
  const wins = [card('a', 0, 0, 96, 10, { minimized: true })]
  const idx = buildRowIndex(wins)
  assert.equal(rectFree(idx, 0, 0, 48, 8), true)
})

test('firstFreeInRows finds the topmost run and matches brute force', () => {
  const wins = [card('a', 0, 0, 48, 4), card('b', 48, 0, 48, 4)]
  const idx = buildRowIndex(wins)
  const slot = firstFreeInRows(idx, 0, COLS, 48, 4, 50)
  assert.equal(slot.x, 0)
  assert.equal(slot.y, 4)

  // brute-force: scan every x,y and take the topmost-then-leftmost free slot
  let brute = null
  for (let y = 0; y <= 50 && !brute; y++) {
    for (let x = 0; x + 48 <= COLS; x++) {
      if (rectFree(idx, x, y, 48, 4)) { brute = { x, y }; break }
    }
  }
  assert.deepEqual({ x: slot.x, y: slot.y }, brute)
})

test('firstFreeInRows returns null when the band is too narrow', () => {
  const idx = buildRowIndex([])
  assert.equal(firstFreeInRows(idx, 0, 10, 40, 4, 10), null)
})

test('findFreeSlot starts at origin on an empty canvas', () => {
  assert.deepEqual(findFreeSlot([], 48, 15), { x: 0, y: 0, w: 48, h: 15, grid_v: 5 })
})

test('findFreeSlot never returns an overlapping slot', () => {
  const wins = [card('a', 0, 0, 48, 15), card('b', 48, 0, 48, 15)]
  const slot = findFreeSlot(wins, 48, 15)
  assert.equal(rectFree(buildRowIndex(wins), slot.x, slot.y, slot.w, slot.h), true)
})

test('findFreeSlot prefers a slot adjacent to the anchor', () => {
  const anchor = card('a', 0, 0, 24, 8)
  const slot = findFreeSlot([anchor], 24, 8, anchor.layout)
  assert.deepEqual({ x: slot.x, y: slot.y }, { x: 24, y: 0 })
})

test('findFreeSlot places repeatedly without collisions', () => {
  const wins = []
  for (let i = 0; i < 40; i++) {
    const slot = findFreeSlot(wins, 24, 8)
    const layout = { ...slot }
    // no collision against everything placed so far
    for (const o of wins) {
      assert.equal(overlaps(o.layout, layout), false, `collision at card ${i}`)
    }
    wins.push({ id: `w${i}`, layout: { x: slot.x, y: slot.y, w: slot.w, h: slot.h } })
  }
  assert.equal(wins.length, 40)
})

test('findFreeSlot expands the effective bound for far-right content', () => {
  const wins = [card('far', 300, 0, 24, 8)]
  const slot = findFreeSlot(wins, 24, 8, undefined, 400)
  assert.ok(slot.x >= 0)
  assert.equal(overlaps(wins[0].layout, slot), false)
})

test('placeInBand respects the requested band', () => {
  const slot = placeInBand([], 24, 8, 100, 200)
  assert.equal(slot.x, 100)
  assert.equal(slot.w, 24)
})

test('tidyArrange produces a collision-free packing inside the bound', () => {
  const wins = [
    card('a', 5, 3, 30, 9),
    card('b', 60, 1, 20, 5),
    card('c', 10, 40, 50, 12),
    card('d', 0, 0, 96, 20),
  ]
  const arranged = tidyArrange(wins)
  assert.equal(arranged.length, 4)

  const placed = arranged.map(a => ({ id: a.id, layout: a.layout }))
  for (const p of placed) {
    assert.ok(p.layout.x >= 0 && p.layout.x + p.layout.w <= COLS, `out of bounds: ${p.id}`)
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.equal(overlaps(placed[i].layout, placed[j].layout), false,
        `overlap between ${placed[i].id} and ${placed[j].id}`)
    }
  }
})

test('tidyArrange skips minimized cards', () => {
  const wins = [card('a', 0, 0, 24, 8), card('b', 0, 0, 24, 8, { minimized: true })]
  const arranged = tidyArrange(wins)
  assert.equal(arranged.length, 1)
  assert.equal(arranged[0].id, 'a')
})

test('tidy arrangement leaves horizontal air between cards on every shelf', () => {
  const arranged = tidyArrange(Array.from({ length: 8 }, (_, i) => card(String(i), 0, i * 12, 24, 8)))
  for (const a of arranged) for (const b of arranged) {
    if (a.layout.y === b.layout.y && a.layout.x < b.layout.x) {
      assert.ok(b.layout.x - a.layout.x - a.layout.w >= 2)
    }
  }
  assert.ok(new Set(arranged.map(c => c.layout.y)).size > 1)
  const halves = tidyArrange([card('left', 0, 0, 48, 16), card('right', 48, 0, 48, 16)])
  assert.equal(halves[0].layout.y, halves[1].layout.y)
  assert.equal(halves[1].layout.x - halves[0].layout.w, 2)
})

test('pickTierSize snaps to a tier and preserves aspect within tolerance', () => {
  const size = pickTierSize(48, 15)
  assert.ok([24, 32, 48, 64, 96].includes(size.w))
  assert.ok([4, 8, 12, 16, 20, 24, 28, 32].includes(size.h))
})

test('smartSize returns type-appropriate defaults', () => {
  assert.deepEqual(smartSize('pie'), { w: 32, h: 15 })
  assert.deepEqual(smartSize('table'), { w: 64, h: 21 })
  assert.deepEqual(smartSize('bar'), { w: 48, h: 15 })
})

test('defaultLayout is clamped-valid', () => {
  const d = defaultLayout()
  assert.deepEqual(clampLayout(d), d)
})

test('compactHorizontal closes a gap for a moved card', () => {
  const wins = [card('a', 0, 0, 24, 8), card('b', 40, 0, 24, 8)]
  compactHorizontal(wins, new Set(['b']))
  assert.equal(wins[1].layout.x, 24 + 4) // MIN_GAP_X
})

// NOTE: documents faithful port behaviour.
//
// `compactVertical` is a *row-wise gap closer*, not a general overlap resolver.
// It only processes rows other than the topmost, and for each moved card scans
// upward from its current row, stopping at the first candidate that is not
// blocked by a card above it. Two consequences, both present in the upstream
// source and preserved here verbatim:
//   1. a card whose current row is already the topmost is never processed;
//   2. a card that overlaps something at its own row cannot move up past it, so
//      `targetY` stays equal to `rowY` and nothing moves.
// Its real caller is the drag handler, where the moved set holds cards whose
// position was already validated — hence "close gaps", not "fix collisions".
// Reliable packing is `tidyArrange`'s job (covered above).
test('compactVertical leaves a non-overlapping moved card in place (ported behaviour)', () => {
  const wins = [card('a', 0, 0, 24, 8), card('b', 0, 20, 24, 8)]
  compactVertical(wins, new Set(['b']))
  assert.equal(wins[1].layout.y, 20, 'card is not pulled up when it does not overlap')
})

test('compactVertical does not resolve an overlap at the card own row (ported behaviour)', () => {
  const wins = [card('a', 0, 0, 24, 8), card('b', 0, 4, 24, 8)] // b overlaps a
  compactVertical(wins, new Set(['b']))
  assert.equal(wins[1].layout.y, 4, 'row-wise closer does not stack the card below the blocker')
})

test('compactVertical ignores a moved card sitting in the topmost row', () => {
  const wins = [card('a', 0, 0, 24, 8), card('b', 0, 30, 24, 8)]
  compactVertical(wins, new Set(['a']))
  assert.equal(wins[0].layout.y, 0)
})

// ── drag landing: nearestFreeSlot ───────────────────────────────────────────

test('a drop on free space keeps exactly the dropped position', () => {
  const wins = [card('a', 0, 0, 24, 8)]
  const dropped = { x: 48, y: 20, w: 24, h: 8 }
  const landed = nearestFreeSlot(wins, dropped, 'moving')
  assert.deepEqual({ x: landed.x, y: landed.y }, { x: 48, y: 20 })
})

test('a drop on top of another card settles without overlapping', () => {
  const wins = [card('a', 0, 0, 48, 15), card('moving', 0, 5, 48, 15)]
  const landed = nearestFreeSlot(wins, { x: 0, y: 5, w: 48, h: 15 }, 'moving')

  assert.equal(overlaps(wins[0].layout, landed), false, 'must not overlap the occupying card')
  // It should stay near the drop point rather than jumping to the far end.
  assert.ok(Math.abs(landed.y - 5) <= 20, `moved too far: y=${landed.y}`)
})

test('the moving card never blocks itself', () => {
  const wins = [card('moving', 10, 10, 24, 8)]
  const landed = nearestFreeSlot(wins, { x: 10, y: 10, w: 24, h: 8 }, 'moving')
  assert.deepEqual({ x: landed.x, y: landed.y }, { x: 10, y: 10 })
})

test('a drop inside a fully packed area still finds a slot', () => {
  // Fill the first two rows completely.
  const wins = []
  for (let i = 0; i < 2; i++) wins.push(card(`r${i}`, 0, i * 8, 96, 8))
  wins.push(card('moving', 0, 0, 24, 8))

  const landed = nearestFreeSlot(wins, { x: 0, y: 0, w: 24, h: 8 }, 'moving')
  for (const w of wins) {
    if (w.id === 'moving') continue
    assert.equal(overlaps(w.layout, landed), false, `overlaps ${w.id}`)
  }
  assert.ok(landed.y >= 16, `should have moved below the packed rows, got y=${landed.y}`)
})

test('a drop past the right edge is clamped back inside', () => {
  const wins = [card('a', 0, 0, 24, 8)]
  const landed = nearestFreeSlot(wins, { x: 200, y: 0, w: 24, h: 8 }, 'moving')
  assert.ok(landed.x + landed.w <= COLS, `escaped the bound: x=${landed.x} w=${landed.w}`)
})

test('nearestFreeSlot always returns a non-colliding slot for many random drops', () => {
  const wins = [card('a', 0, 0, 32, 10), card('b', 32, 0, 32, 10), card('c', 0, 10, 64, 10)]
  for (let x = 0; x < 96; x += 7) {
    for (let y = 0; y < 30; y += 3) {
      const landed = nearestFreeSlot(wins, { x, y, w: 32, h: 10 }, 'moving')
      for (const w of wins) {
        assert.equal(overlaps(w.layout, landed), false, `collision at drop (${x},${y})`)
      }
    }
  }
})

test('collides reports overlap against others but ignores the moving card', () => {
  const wins = [card('a', 0, 0, 48, 15), card('moving', 48, 0, 48, 15)]
  assert.equal(collides(wins, { x: 0, y: 0, w: 48, h: 15 }, 'moving'), true)
  assert.equal(collides(wins, { x: 48, y: 0, w: 48, h: 15 }, 'moving'), false)
  assert.equal(collides(wins, { x: 0, y: 30, w: 48, h: 15 }, 'moving'), false)
})
