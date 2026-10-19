import { test } from 'node:test'
import assert from 'node:assert/strict'

import { snapLines, applySnap, overlaps } from '../lib/grid.js'

const cards = [
  { id: 'a', x: 0, y: 0, w: 24, h: 8 },
  { id: 'b', x: 28, y: 0, w: 24, h: 8 },
  { id: 'c', x: 0, y: 12, w: 48, h: 8 },
]

test('edges aligning within tolerance produce a matched line', () => {
  // Moving card's left edge aligns with card a's right edge (24) within 1.
  const { vertical } = snapLines({ id: 'm', x: 24.5, y: 0, w: 24, h: 8 }, cards)
  assert.ok(vertical.includes(24), `x=24 should match a's right edge, got ${JSON.stringify(vertical)}`)
})

test('centres align too, not just edges', () => {
  // Moving card's centre (24+12=36 … use a symmetric case): a card centred on
  // card c's centre (24) matches c's centre line.
  const { vertical } = snapLines({ id: 'm', x: 12, y: 20, w: 24, h: 8 }, cards)
  assert.ok(vertical.includes(24), 'centre of m (24) matches centre of c (24)')
})

test('nothing within tolerance produces empty line lists', () => {
  const { vertical, horizontal } = snapLines({ id: 'm', x: 60, y: 40, w: 24, h: 8 }, cards)
  assert.deepEqual(vertical, [])
  assert.deepEqual(horizontal, [])
})

test('horizontal lines match on y anchors', () => {
  // Moving card's top edge aligns with card c's bottom edge (20).
  const { horizontal } = snapLines({ id: 'm', x: 0, y: 20.5, w: 24, h: 8 }, cards)
  assert.ok(horizontal.includes(20), 'y=20 should match c\'s bottom edge')
})

test('the dragged card never snaps to itself', () => {
  // A position matching nothing: card a excluded leaves b (x anchors
  // 28/40/52) and c (y anchors 12/16/20) — none of these coincide with
  // x=50/y=40 within tolerance 1. (At a's own position the others' anchors
  // genuinely align, which is correct behaviour, not self-matching.)
  const { vertical, horizontal } = snapLines({ id: 'a', x: 50, y: 40, w: 24, h: 8 }, cards)
  assert.deepEqual(vertical, [])
  assert.deepEqual(horizontal, [])
})

test('applySnap moves the layout onto the line and reports it', () => {
  const near = { id: 'm', x: 24.6, y: 0, w: 24, h: 8 }
  const { layout, lines } = applySnap(near, cards)
  assert.equal(layout.x, 24, 'left edge snapped to 24')
  assert.equal(layout.y, 0)
  assert.deepEqual(lines.vertical, [24])
  // The snapped result must not collide with anything.
  assert.equal(overlaps(layout, cards[0]), false)
})

test('applySnap leaves the layout untouched when nothing matches', () => {
  const far = { id: 'm', x: 60, y: 40, w: 24, h: 8 }
  const { layout, lines } = applySnap(far, cards)
  assert.deepEqual(layout, far)
  assert.deepEqual(lines.vertical, [])
  assert.deepEqual(lines.horizontal, [])
})

test('a tight tolerance stops distant near-misses from snapping', () => {
  // x=31 sits 3 units off b's left edge (28) — beyond the default tolerance of
  // 1 — and y=40 matches nothing, so nothing snaps.
  const near = { id: 'm', x: 31, y: 40, w: 24, h: 8 }
  const { layout } = applySnap(near, cards)
  assert.equal(layout.x, 31, 'no snap when beyond tolerance')
})
