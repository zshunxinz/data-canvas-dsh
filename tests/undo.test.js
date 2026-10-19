import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CanvasStore, CanvasError } from '../lib/store.js'
import { overlaps } from '../lib/grid.js'

const MANUAL_SOURCE_MARKER = '手工/无外部数据源'

// These helpers create synthetic fixture data; mark it explicitly as manual unless
// a fixture already supplies complete provenance or intentionally tests malformed data.
function addTestCard (store, canvasId, input, expectedRevision) {
  const type = input.type ?? 'chart'
  const dataset = input.source_dataset ?? input.dataset
  const query = input.source_query ?? input.query
  const isDataCard = ['chart', 'table', 'kpi'].includes(type)
  const hasSource = typeof dataset === 'string' && dataset.trim().length > 0
    && typeof query === 'string' && query.trim().length > 0
  const hasManualMarker = [input.note, input.source_note]
    .some(note => typeof note === 'string' && note.includes(MANUAL_SOURCE_MARKER))
  const hasMalformedSource = [dataset, query].some(value => value != null && typeof value !== 'string')
  const card = isDataCard && !hasSource && !hasManualMarker && !hasMalformedSource
    ? { ...input, source_note: [input.source_note, MANUAL_SOURCE_MARKER].filter(Boolean).join('；') }
    : input
  return store.addCard(canvasId, card, expectedRevision)
}

function withStore (fn) {
  const dir = mkdtempSync(join(tmpdir(), 'xcundo-'))
  try {
    return fn(new CanvasStore(dir), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('every mutation records a pre-change snapshot in the undo stack', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    addTestCard(store, c.id, { type: 'chart', title: 'a' })
    const history = store.readHistory(c.id)
    assert.equal(history.undo.length, 1, 'one action -> one undo entry')
    // The snapshot holds the PRE-change state: zero cards.
    assert.equal(history.undo[0].cards.length, 0)
  })
})

test('undo and redo restore data-card provenance updates', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'source history' })
    const added = addTestCard(store, c.id, {
      type: 'chart', title: '销售额', dataset: 'sales.csv', query: 'monthly sum',
    })
    const before = store.getCanvas(c.id).cards[0].source
    const updated = store.updateCard(c.id, added.cards[0].id, {
      source: { query: 'quarterly sum', note: '退款已扣除' },
    }, added.revision)
    assert.deepEqual(updated.cards[0].source, { dataset: 'sales.csv', query: 'quarterly sum', note: '退款已扣除' })

    const undone = store.undo(c.id, updated.revision).canvas
    assert.deepEqual(undone.cards[0].source, before)
    const redone = store.redo(c.id, undone.revision).canvas
    assert.deepEqual(redone.cards[0].source, updated.cards[0].source)
  })
})

test('undo restores layout after a move', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: 'a', layout: { x: 0, y: 0, w: 24, h: 8 } })
    const cardId = canvas.cards[0].id

    canvas = store.moveCard(c.id, cardId, { x: 40, y: 10 })
    assert.equal(canvas.cards[0].layout.x, 40)

    const result = store.undo(c.id)
    assert.equal(result.canvas.cards[0].layout.x, 0, 'layout must be restored')
    assert.equal(result.canvas.cards[0].layout.y, 0)
  })
})

test('undo restores a rename and description', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'before', description: 'old' })
    store.renameCanvas(c.id, 'after')

    const result = store.undo(c.id)
    assert.equal(result.canvas.name, 'before', 'canvas name restored')
    assert.equal(result.canvas.description, 'old')
    // Theme was untouched by the rename, so undo does not change it either —
    // only fields present in the snapshot are restored.
    assert.ok(result.canvas.theme, 'theme stays as-is when the snapshot carried it')
  })
})

test('undo removes a card that was added after the snapshot', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    addTestCard(store, c.id, { type: 'chart', title: 'kept' })
    addTestCard(store, c.id, { type: 'chart', title: 'added later' })
    assert.equal(store.getCanvas(c.id).cards.length, 2)

    const result = store.undo(c.id)
    assert.equal(result.canvas.cards.length, 1, 'the later add is undone')
    assert.equal(result.canvas.cards[0].title, 'kept')
    assert.equal(result.removedCards, 1)
  })
})

test('redo re-applies an undone change', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'before' })
    store.renameCanvas(c.id, 'after')

    store.undo(c.id)
    assert.equal(store.getCanvas(c.id).name, 'before')

    const result = store.redo(c.id)
    assert.equal(result.canvas.name, 'after', 'redo re-applies the rename')
  })
})

test('redo re-creates a card that undo removed', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    addTestCard(store, c.id, { type: 'chart', title: '留存' })
    addTestCard(store, c.id, { type: 'code', title: '被撤销的', text_content: 'const x = 1', language: 'js' })

    const undone = store.undo(c.id)
    assert.equal(undone.canvas.cards.length, 1, 'undo removed the later add')

    const redone = store.redo(c.id)
    assert.equal(redone.canvas.cards.length, 2, 'redo re-created the card')
    const back = redone.canvas.cards.find(card => card.title === '被撤销的')
    assert.ok(back, 'the re-created card is present')
    assert.equal(back.text_content, 'const x = 1', 'payload data survived the roundtrip')
    assert.equal(back.language, 'js')
  })
})

test('undo restores a card deleted between the snapshot and now', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: '甲' })
    const cardId = canvas.cards[0].id

    store.removeCard(c.id, cardId)
    assert.equal(store.getCanvas(c.id).cards.length, 0)

    const result = store.undo(c.id)
    assert.equal(result.canvas.cards.length, 1, 'undo brings the deleted card back')
    assert.equal(result.canvas.cards[0].title, '甲')
  })
})

test('a new action clears the redo stack', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'v1' })
    store.renameCanvas(c.id, 'v2')
    store.undo(c.id)
    assert.equal(store.readHistory(c.id).redo.length, 1)

    store.renameCanvas(c.id, 'v3') // a fresh action
    assert.equal(store.readHistory(c.id).redo.length, 0, 'redo stack must be invalidated')

    assert.throws(() => store.redo(c.id), err => err.code === 'NOTHING_TO_REDO')
  })
})

test('undo past the first action reports NOTHING_TO_UNDO', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    addTestCard(store, c.id, { type: 'chart', title: 'a' })
    store.undo(c.id)
    assert.throws(() => store.undo(c.id), err => err.code === 'NOTHING_TO_UNDO')
  })
})

test('the history survives a restart and is persisted beside the canvases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcundo2-'))
  try {
    const store = new CanvasStore(dir)
    const c = store.createCanvas({ name: 'durable' })
    addTestCard(store, c.id, { type: 'chart', title: 'x' })

    const reopened = new CanvasStore(dir)
    const result = reopened.undo(c.id)
    assert.equal(result.canvas.cards.length, 0, 'undo works across restarts')

    const historyFile = join(dir, 'history', `${c.id}.json`)
    assert.ok(existsSync(historyFile), 'history must live on disk')
    const raw = JSON.parse(readFileSync(historyFile, 'utf8'))
    assert.ok(Array.isArray(raw.undo))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('undo does not push onto its own stack (no double-undo drift)', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'v1' })
    store.renameCanvas(c.id, 'v2')

    const before = store.readHistory(c.id).undo.length
    store.undo(c.id)
    const after = store.readHistory(c.id).undo.length
    assert.equal(after, before - 1, 'undo consumes one entry and pushes none onto undo')

    store.redo(c.id)
    assert.equal(store.readHistory(c.id).undo.length, before, 'redo pushes exactly one back onto undo')
  })
})

test('rapid successive mutations each get their own undo step (no batching bug)', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: 'a' })
    canvas = addTestCard(store, c.id, { type: 'chart', title: 'b' }, canvas.revision)
    canvas = addTestCard(store, c.id, { type: 'chart', title: 'c' }, canvas.revision)
    assert.equal(store.readHistory(c.id).undo.length, 3, '3 actions -> 3 undo steps')

    store.undo(c.id)
    assert.equal(store.getCanvas(c.id).cards.length, 2)
    store.undo(c.id)
    assert.equal(store.getCanvas(c.id).cards.length, 1)
  })
})

test('undo restores cards without overlap', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: 'a' })
    canvas = addTestCard(store, c.id, { type: 'chart', title: 'b' }, canvas.revision)

    store.undo(c.id)
    store.redo(c.id)
    const cards = store.getCanvas(c.id).cards
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        assert.equal(overlaps(cards[i].layout, cards[j].layout), false)
      }
    }
  })
})

test('undo throws for an unknown canvas', () => {
  withStore(store => {
    assert.throws(() => store.undo('nope'), err => err.code === 'CANVAS_NOT_FOUND')
  })
})

test('the history stack caps at 50 entries', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: 'a' })
    for (let i = 0; i < 60; i++) {
      canvas = store.renameCanvas(c.id, `v${i}`, canvas.revision)
    }
    const history = store.readHistory(c.id)
    assert.ok(history.undo.length <= 50, `history must cap at 50, got ${history.undo.length}`)
  })
})

test('undo of an unknown canvas id is typed', () => {
  withStore(store => {
    assert.throws(() => store.readHistory('../x'), err => err.code === 'INVALID_CANVAS_ID')
  })
})

test('a corrupt history file raises a typed error', () => {
  withStore((store, dir) => {
    const c = store.createCanvas({ name: 'c' })
    addTestCard(store, c.id, { type: 'chart', title: 'a' })
    writeFileSync(join(dir, 'history', `${c.id}.json`), 'broken', 'utf8')
    assert.throws(
      () => store.undo(c.id),
      err => err instanceof CanvasError && ['CORRUPT_JSON', 'CORRUPT_HISTORY'].includes(err.code),
    )
  })
})
