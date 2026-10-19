import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  CanvasStore, CanvasError, RevisionConflict, makeCard, CANVAS_SCHEMA_VERSION, CARD_TYPES, SOURCE_RELINK_MARKER,
} from '../lib/store.js'
import { overlaps } from '../lib/grid.js'

test('drafts expire without a canvas write and terminal retries have a bounded lifetime', t => {
  withStore(store => {
    const canvas = store.createCanvas({ name: '草稿期限' })
    const otherCanvas = store.createCanvas({ name: '另一画布期限' })
    const base = Date.now()
    let clock = base
    t.mock.method(Date, 'now', () => clock)
    const pending = store.createCardDraft(canvas.id, { type: 'text', title: '过期预览' })
    const cancelled = store.createCardDraft(otherCanvas.id, { type: 'text', title: '取消预览' })
    store.cancelCardDraft(cancelled.id)
    assert.equal(store.cancelCardDraft(cancelled.id).idempotent, true)
    clock += 60 * 60 * 1000 + 1
    assert.throws(() => store.cancelCardDraft(cancelled.id), e => e.code === 'DRAFT_NOT_FOUND')
    assert.deepEqual(store.listCardDrafts().map(draft => draft.id), [pending.id])
    clock = base + 24 * 60 * 60 * 1000 + 1
    assert.deepEqual(store.listCardDrafts(), [])
    assert.throws(() => store.confirmCardDraft(pending.id), e => e.code === 'DRAFT_NOT_FOUND')
    assert.equal(store.getCanvas(canvas.id).revision, canvas.revision)
    assert.equal(store.getCanvas(otherCanvas.id).revision, otherCanvas.revision)
  })
})

test('draft limit refuses new previews while retaining existing user decisions', () => {
  withStore(store => {
    const canvases = Array.from({ length: 101 }, (_, i) => store.createCanvas({ name: `草稿上限 ${i}` }))
    for (let i = 0; i < 100; i++) store.createCardDraft(canvases[i].id, { type: 'text', title: `预览 ${i}` })
    assert.throws(() => store.createCardDraft(canvases[100].id, { type: 'text', title: '超出' }), e => e.code === 'DRAFT_LIMIT')
    const first = store.listCardDrafts()[0]
    store.cancelCardDraft(first.id)
    store.createCardDraft(canvases[100].id, { type: 'text', title: '恢复可用' })
    assert.equal(store.listCardDrafts().length, 100)
    assert.equal(store.getCanvas(canvases[0].id).cards.length, 0)
  })
})

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
  const dir = mkdtempSync(join(tmpdir(), 'xcstore-'))
  try {
    return fn(new CanvasStore(dir), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a fresh store has an empty catalog', () => {
  withStore(store => {
    assert.deepEqual(store.listCanvases(), [])
  })
})

test('createCanvas persists and appears in the catalog', () => {
  withStore(store => {
    const c = store.createCanvas({ name: '销售分析' })
    assert.equal(c.name, '销售分析')
    assert.equal(c.revision, 1)
    assert.equal(c.schema_version, CANVAS_SCHEMA_VERSION)
    assert.deepEqual(c.cards, [])

    const list = store.listCanvases()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, c.id)
    assert.equal(list[0].card_count, 0)

    // readable straight off disk
    const onDisk = JSON.parse(readFileSync(store.canvasPath(c.id), 'utf8'))
    assert.equal(onDisk.name, '销售分析')
  })
})

test('createCanvas validates initial data cards and preserves marker and non-data paths', () => {
  withStore(store => {
    assert.throws(() => store.createCanvas({ name: 'missing source', cards: [
      { type: 'text', title: 'valid first card' }, { type: 'chart', title: 'invalid second card' },
    ] }), error => error.code === 'SOURCE_REQUIRED')
    assert.deepEqual(store.listCanvases(), [], 'a rejected initial card must not leave a partial canvas')

    const manual = store.createCanvas({ name: 'manual source', cards: [
      { type: 'chart', title: 'manual chart', note: MANUAL_SOURCE_MARKER },
      { type: 'table', title: 'manual table', source_note: MANUAL_SOURCE_MARKER },
    ] })
    assert.equal(manual.cards[0].note, MANUAL_SOURCE_MARKER)
    assert.equal(manual.cards[1].source.note, MANUAL_SOURCE_MARKER)

    const sourced = store.createCanvas({ name: 'data source', cards: [
      { type: 'kpi', title: 'monthly total', dataset: 'sales.csv', query: 'monthly sum' },
    ] })
    assert.equal(sourced.cards[0].source.dataset, 'sales.csv')
    assert.equal(sourced.cards[0].source.query, 'monthly sum')

    const nonData = store.createCanvas({ name: 'non-data cards', cards: [
      { type: 'text', title: 'notes' }, { type: 'code', title: 'snippet', text_content: 'x=1' },
    ] })
    assert.deepEqual(nonData.cards.map(card => card.type), ['text', 'code'])
  })
})
test('createCanvas validates initial data cards and preserves marker and non-data paths', () => {
  withStore(store => {
    assert.throws(() => store.createCanvas({ name: 'missing source', cards: [
      { type: 'text', title: 'valid first card' }, { type: 'chart', title: 'invalid second card' },
    ] }), error => error.code === 'SOURCE_REQUIRED')
    assert.deepEqual(store.listCanvases(), [], 'a rejected initial card must not leave a partial canvas')

    const manual = store.createCanvas({ name: 'manual source', cards: [
      { type: 'chart', title: 'manual chart', note: MANUAL_SOURCE_MARKER },
      { type: 'table', title: 'manual table', source_note: MANUAL_SOURCE_MARKER },
    ] })
    assert.equal(manual.cards[0].note, MANUAL_SOURCE_MARKER)
    assert.equal(manual.cards[1].source.note, MANUAL_SOURCE_MARKER)

    const sourced = store.createCanvas({ name: 'data source', cards: [
      { type: 'kpi', title: 'monthly total', dataset: 'sales.csv', query: 'monthly sum' },
    ] })
    assert.equal(sourced.cards[0].source.dataset, 'sales.csv')
    assert.equal(sourced.cards[0].source.query, 'monthly sum')

    const nonData = store.createCanvas({ name: 'non-data cards', cards: [
      { type: 'text', title: 'notes' }, { type: 'code', title: 'snippet', text_content: 'x=1' },
    ] })
    assert.deepEqual(nonData.cards.map(card => card.type), ['text', 'code'])
  })
})
test('createCanvas rejects a missing name', () => {
  withStore(store => {
    assert.throws(() => store.createCanvas({}), err => err.code === 'INVALID_CANVAS')
    assert.throws(() => store.createCanvas({ name: '' }), err => err.code === 'INVALID_CANVAS')
  })
})

test('manual example creation survives seed deletion and preserves existing canvases', () => {
  withStore(store => {
    const seeded = store.seedExampleIfEmpty()
    store.deleteCanvas(seeded.id)
    assert.equal(store.seedExampleIfEmpty(), null)
    const example = store.createExampleCanvas()
    assert.equal(example.cards.length, 10)
    assert.match(example.name, /模拟/)
    assert.deepEqual(new Set(example.cards.map(c => c.type)), new Set(['kpi', 'chart', 'table', 'text', 'code']))
    for (const [i, card] of example.cards.entries()) {
      assert.match(card.source.dataset, /模拟/)
      assert.ok(card.source.query)
      for (const other of example.cards.slice(i + 1)) assert.equal(overlaps(card.layout, other.layout), false)
    }
    const table = example.cards.find(c => c.type === 'table').table_data.rows
    assert.deepEqual(table.at(-1), ['合计', 628, 437, 191, '30.4%'])
    const existing = store.createCanvas({ name: '保留我的画布' })
    const before = readFileSync(store.canvasPath(existing.id), 'utf8')
    const second = store.createExampleCanvas()
    assert.notEqual(second.id, example.id)
    assert.equal(readFileSync(store.canvasPath(existing.id), 'utf8'), before)
    assert.equal(new CanvasStore(store.root).getCanvas(second.id).cards.length, 10)
  })
})

test('invalid initial cards do not leave a partially created canvas', () => {
  withStore(store => {
    assert.throws(() => store.createCanvas({ name: 'bad', cards: [{ type: 'invalid', title: 'bad' }] }), /unknown card type/)
    assert.deepEqual(store.listCanvases(), [])
  })
})

test('failed example seed does not leave a marker and can be retried', () => {
  withStore((store, root) => {
    const createCanvas = store.createCanvas.bind(store)
    let failOnce = true
    store.createCanvas = options => {
      if (failOnce) { failOnce = false; throw new Error('temporary example write failure') }
      return createCanvas(options)
    }
    assert.throws(() => store.seedExampleIfEmpty(), /temporary example write failure/)
    assert.equal(existsSync(join(root, '.seeded')), false, 'failed seed must remain retryable')
    assert.deepEqual(store.listCanvases(), [])

    store.createCanvas = createCanvas
    const retried = store.seedExampleIfEmpty()
    assert.ok(retried.cards.length > 0, 'retry should recreate the example after the failed write')
    assert.equal(existsSync(join(root, '.seeded')), true)
  })
})
test('sales example halves vertical gaps without shrinking any cards', () => {
  withStore(store => {
    const canvas = store.createExampleCanvas()
    const rows = [0, 9, 26, 43].map(y => canvas.cards.filter(card => card.layout.y === y))
    assert.deepEqual(rows.map(cards => cards.length), [4, 2, 2, 2])
    assert.deepEqual(rows.map(cards => cards.map(card => card.layout.h)), [[8, 8, 8, 8], [16, 16], [16, 16], [14, 14]])
    for (let i = 1; i < rows.length; i++) {
      const previousBottom = Math.max(...rows[i - 1].map(card => card.layout.y + card.layout.h))
      assert.equal(rows[i][0].layout.y - previousBottom, 1, 'one grid row = 22px, previously two rows = 44px')
    }
    assert.deepEqual(new CanvasStore(store.root).getCanvas(canvas.id).cards.map(card => card.layout), canvas.cards.map(card => card.layout))
  })
})

test('getCanvas reports a missing canvas with a typed error', () => {
  withStore(store => {
    assert.throws(() => store.getCanvas('deadbeef'), err => err.code === 'CANVAS_NOT_FOUND')
  })
})

test('getCanvas rejects an id that could escape the directory', () => {
  withStore(store => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '', 'x'.repeat(65)]) {
      assert.throws(() => store.getCanvas(bad), err => err.code === 'INVALID_CANVAS_ID', `should reject ${bad}`)
    }
  })
})

test('addCard places the first card at the origin and bumps the revision', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c1' })
    const after = addTestCard(store, c.id, { type: 'chart', title: '销售额', chart_type: 'bar' })
    assert.equal(after.revision, 2)
    assert.equal(after.cards.length, 1)

    const card = after.cards[0]
    assert.equal(card.title, '销售额')
    assert.equal(card.type, 'chart')
    assert.equal(card.chart_type, 'bar')
    assert.equal(card.layout.x, 0)
    assert.equal(card.layout.y, 0)
    assert.ok(card.id.length === 32)
    assert.ok(card.source)
    // index reflects the new count
    assert.equal(store.listCanvases()[0].card_count, 1)
  })
})

test('added cards never overlap each other', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'packing' })
    let canvas = c
    for (let i = 0; i < 25; i++) {
      canvas = addTestCard(store, c.id, { type: 'chart', title: `card ${i}`, chart_type: 'bar' }, canvas.revision)
    }
    assert.equal(canvas.cards.length, 25)
    for (let i = 0; i < canvas.cards.length; i++) {
      for (let j = i + 1; j < canvas.cards.length; j++) {
        assert.equal(overlaps(canvas.cards[i].layout, canvas.cards[j].layout), false,
          `cards ${i} and ${j} overlap`)
      }
    }
  })
})

test('addCard validates card type and title', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'v' })
    assert.throws(() => addTestCard(store, c.id, { type: 'nope', title: 'x' }), err => err.code === 'INVALID_CARD_TYPE')
    assert.throws(() => addTestCard(store, c.id, { type: 'chart' }), err => err.code === 'INVALID_CARD')
  })
})

test('addCard requires traceable source for data cards and allows explicit manual data', () => {
  withStore(store => {
    const c = store.createCanvas({ name: '来源校验' })
    let revision = c.revision
    let cardCount = 0

    for (const type of ['chart', 'table', 'kpi']) {
      const missing = { type, title: '缺少来源 ' + type }
      const before = store.getCanvas(c.id)
      assert.throws(() => store.addCard(c.id, missing, revision), error => error.code === 'SOURCE_REQUIRED')
      const unchanged = store.getCanvas(c.id)
      assert.equal(unchanged.revision, before.revision)
      assert.equal(unchanged.cards.length, cardCount)

      const manual = store.addCard(c.id, { type, title: '手工 ' + type, note: MANUAL_SOURCE_MARKER }, revision)
      revision = manual.revision
      cardCount++
      assert.equal(manual.cards.at(-1).note, MANUAL_SOURCE_MARKER)
    }

    const sourceNote = store.addCard(c.id, {
      type: 'chart', title: '来源备注手工数据', source_note: MANUAL_SOURCE_MARKER,
    }, revision)
    revision = sourceNote.revision
    cardCount++
    assert.equal(sourceNote.cards.at(-1).source.note, MANUAL_SOURCE_MARKER)

    const sourced = store.addCard(c.id, {
      type: 'chart', title: '真实来源', dataset: 'sales.csv', query: '按月汇总销售额',
    }, revision)
    revision = sourced.revision
    cardCount++

    const text = store.addCard(c.id, { type: 'text', title: '说明' }, revision)
    revision = text.revision
    const code = store.addCard(c.id, { type: 'code', title: '代码', text_content: 'x=1' }, revision)
    assert.equal(code.cards.length, cardCount + 2)
  })
})
test('every declared card type is accepted', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'types' })
    let canvas = c
    for (const type of CARD_TYPES) {
      canvas = addTestCard(store, c.id, { type, title: `a ${type}` }, canvas.revision)
    }
    assert.deepEqual(canvas.cards.map(x => x.type), CARD_TYPES)
  })
})

test('addCard can cluster next to an anchor card', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'anchor' })
    const first = addTestCard(store, c.id, { type: 'chart', title: 'first', chart_type: 'bar' })
    const anchorId = first.cards[0].id
    const second = addTestCard(store, c.id, { type: 'chart', title: 'second', anchorCardId: anchorId }, first.revision)
    const [a, b] = second.cards
    assert.equal(b.layout.x, a.layout.x + a.layout.w)
    assert.equal(b.layout.y, a.layout.y)
  })
})

test('updateCard changes only the given fields', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'u' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: 'old', chart_type: 'bar' }, c.revision)
    const cardId = canvas.cards[0].id

    canvas = store.updateCard(c.id, cardId, { title: 'new' }, canvas.revision)
    assert.equal(canvas.cards[0].title, 'new')
    assert.equal(canvas.cards[0].chart_type, 'bar', 'untouched field must survive')

    canvas = store.updateCard(c.id, cardId, { echarts_option: { series: [{ type: 'line' }] } }, canvas.revision)
    assert.deepEqual(canvas.cards[0].echarts_option, { series: [{ type: 'line' }] })
    assert.equal(canvas.cards[0].title, 'new')
  })
})

test('updateCard merges only supplied source fields and validates source patches', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'source' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: 'chart', dataset: 'sales.csv', query: 'SELECT 1' }, c.revision)
    const cardId = canvas.cards[0].id

    canvas = store.updateCard(c.id, cardId, { source: { query: 'SELECT 2', note: '季度口径' } }, canvas.revision)
    assert.deepEqual(canvas.cards[0].source, { dataset: 'sales.csv', query: 'SELECT 2', note: '季度口径' })
    const imported = store.importCanvasBackup(store.exportCanvasBackup(c.id))
    assert.equal(imported.cards[0].source.dataset, null, 'portable backups must continue stripping local paths')
    assert.equal(imported.cards[0].source.query, 'SELECT 2')
    assert.ok(imported.cards[0].source.note.includes('季度口径'), 'backup keeps the original source note')
    assert.ok(imported.cards[0].source.note.includes(SOURCE_RELINK_MARKER), 'dataset stripping warns that the local source must be relinked')

    const beforeRejected = store.getCanvas(c.id)
    assert.throws(() => store.updateCard(c.id, cardId, { source: { query: '' } }, beforeRejected.revision), error => error.code === 'SOURCE_REQUIRED')
    const afterRejected = store.getCanvas(c.id)
    assert.equal(afterRejected.revision, beforeRejected.revision)
    assert.deepEqual(afterRejected.cards[0].source, beforeRejected.cards[0].source)

    canvas = store.updateCard(c.id, cardId, { source: { dataset: '', query: '', note: '手工/无外部数据源' } }, afterRejected.revision)
    const undone = store.undo(c.id, canvas.revision).canvas
    assert.deepEqual(undone.cards[0].source, beforeRejected.cards[0].source)
    const redone = store.redo(c.id, undone.revision).canvas
    assert.deepEqual(redone.cards[0].source, { dataset: '', query: '', note: '手工/无外部数据源' })

    assert.throws(() => store.updateCard(c.id, cardId, { source: { dataset: 42 } }, redone.revision), error => error.code === 'INVALID_SOURCE')
  })
})

test('source validation handles legacy cards and rejects malformed source values', () => {
  withStore(store => {
    const legacyCanvas = store.createCanvas({ name: 'legacy source' })
    let canvas = store.withCanvas(legacyCanvas.id, legacyCanvas.revision, value => {
      const card = makeCard({ type: 'chart', title: 'legacy' }, value.cards)
      delete card.source
      value.cards.push(card)
      return value
    })
    const legacyId = canvas.cards[0].id
    canvas = store.updateCard(legacyCanvas.id, legacyId, { source: { dataset: 'legacy.csv', query: 'SELECT 1' } }, canvas.revision)
    assert.deepEqual(canvas.cards[0].source, { dataset: 'legacy.csv', query: 'SELECT 1', note: null })

    const partialCanvas = store.createCanvas({ name: 'partial source' })
    canvas = store.withCanvas(partialCanvas.id, partialCanvas.revision, value => {
      const card = makeCard({ type: 'chart', title: 'partial' }, value.cards)
      card.source = { dataset: 'partial.csv' }
      value.cards.push(card)
      return value
    })
    const partialId = canvas.cards[0].id
    canvas = store.updateCard(partialCanvas.id, partialId, { source: { query: 'SELECT 2' } }, canvas.revision)
    assert.deepEqual(canvas.cards[0].source, { dataset: 'partial.csv', query: 'SELECT 2', note: null })

    const invalidCanvas = store.createCanvas({ name: 'invalid source' })
    assert.throws(() => addTestCard(store, invalidCanvas.id, {
      type: 'chart', title: 'bad', dataset: { path: 'x' }, query: 'SELECT 3',
    }, invalidCanvas.revision), error => error.code === 'INVALID_SOURCE')
    assert.equal(store.getCanvas(invalidCanvas.id).cards.length, 0, 'invalid source must not create a card')
  })
})

test('updateCard clamps a layout and rejects an unknown card', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'clamp' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: 'c' }, c.revision)
    const cardId = canvas.cards[0].id

    canvas = store.updateCard(c.id, cardId, { layout: { x: 1, y: 2, w: 9999, h: 9999 } }, canvas.revision)
    assert.ok(canvas.cards[0].layout.w <= 96)
    assert.ok(canvas.cards[0].layout.h <= 32)

    assert.throws(() => store.updateCard(c.id, 'nope', { title: 'x' }), err => err.code === 'CARD_NOT_FOUND')
  })
})

test('removeCard deletes exactly one card', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'r' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: 'a' }, c.revision)
    canvas = addTestCard(store, c.id, { type: 'chart', title: 'b' }, canvas.revision)
    const target = canvas.cards[0].id

    canvas = store.removeCard(c.id, target, canvas.revision)
    assert.equal(canvas.cards.length, 1)
    assert.equal(canvas.cards[0].title, 'b')
    assert.equal(store.listCanvases()[0].card_count, 1)

    assert.throws(() => store.removeCard(c.id, target, canvas.revision), err => err.code === 'CARD_NOT_FOUND')
  })
})

test('renameCanvas updates both the file and the catalog', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'before' })
    const after = store.renameCanvas(c.id, 'after')
    assert.equal(after.name, 'after')
    assert.equal(store.listCanvases()[0].name, 'after')
    assert.equal(store.getCanvas(c.id).name, 'after')
  })
})

test('deleteCanvas removes the file and the catalog row', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'doomed' })
    store.deleteCanvas(c.id)
    assert.equal(store.listCanvases().length, 0)
    assert.equal(existsSync(store.canvasPath(c.id)), false)
    assert.throws(() => store.getCanvas(c.id), err => err.code === 'CANVAS_NOT_FOUND')
    assert.throws(() => store.deleteCanvas(c.id), err => err.code === 'CANVAS_NOT_FOUND')
  })
})

test('a stale revision is rejected instead of clobbering the canvas', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'race' })
    const v1 = addTestCard(store, c.id, { type: 'chart', title: 'first' }, c.revision)
    assert.equal(v1.revision, 2)

    // a second writer still believes the canvas is at revision 1
    assert.throws(
      () => addTestCard(store, c.id, { type: 'chart', title: 'second' }, 1),
      err => err instanceof RevisionConflict && err.current === 2 && err.expected === 1,
    )
    // the losing write must not have changed anything
    assert.equal(store.getCanvas(c.id).cards.length, 1)

    // retrying with the current revision succeeds
    const v3 = addTestCard(store, c.id, { type: 'chart', title: 'second' }, 2)
    assert.equal(v3.cards.length, 2)
    assert.equal(v3.revision, 3)
  })
})

test('passing null skips the revision check (last write wins, explicitly)', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'nolock' })
    addTestCard(store, c.id, { type: 'chart', title: 'a' })
    const after = addTestCard(store, c.id, { type: 'chart', title: 'b' })
    assert.equal(after.cards.length, 2)
  })
})

test('the catalog lists newest-updated first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcorder-'))
  try {
    const store = new CanvasStore(dir)
    const a = store.createCanvas({ name: 'old' })
    await new Promise(r => setTimeout(r, 5))
    const b = store.createCanvas({ name: 'new' })
    await new Promise(r => setTimeout(r, 5))
    addTestCard(store, a.id, { type: 'chart', title: 'touch a' }) // makes `a` newest

    const list = store.listCanvases()
    assert.equal(list[0].id, a.id)
    assert.equal(list[1].id, b.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writes leave no temp files behind', () => {
  withStore((store, dir) => {
    const c = store.createCanvas({ name: 'clean' })
    addTestCard(store, c.id, { type: 'chart', title: 'x' })
    const files = readdirSync(dir)
    assert.deepEqual(files.filter(f => f.endsWith('.tmp')), [], 'no leftover staging files')
  })
})

test('a corrupt canvas file raises a typed error rather than crashing', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'bad' })
    writeFileSync(store.canvasPath(c.id), '{ not json', 'utf8')
    assert.throws(() => store.getCanvas(c.id), err => err.code === 'CORRUPT_JSON')
  })
})

test('a canvas without a cards array is reported as corrupt', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'nocards' })
    writeFileSync(store.canvasPath(c.id), JSON.stringify({ id: c.id, name: 'x' }), 'utf8')
    assert.throws(() => store.getCanvas(c.id), err => err.code === 'CORRUPT_CANVAS')
  })
})

test('a corrupt index raises a typed error', () => {
  withStore((store, dir) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.json'), 'nope', 'utf8')
    assert.throws(() => store.listCanvases(), err => err.code === 'CORRUPT_JSON')
  })
})

test('makeCard keeps provenance for later auditing', () => {
  const card = makeCard({ type: 'chart', title: 't', dataset: '/data/sales.csv', query: 'SELECT 1' }, [])
  assert.equal(card.source.dataset, '/data/sales.csv')
  assert.equal(card.source.query, 'SELECT 1')
  assert.equal(card.source.note, null)
})

// ── card presentation state ─────────────────────────────────────────────────

test('a new card defaults to a visible header, expanded, no accent', () => {
  const card = makeCard({ type: 'chart', title: 't' }, [])
  assert.equal(card.show_header, true)
  assert.equal(card.collapsed, false)
  assert.equal(card.color, null)
  assert.equal(card.note, '')
})

test('presentation state can be set at creation', () => {
  const card = makeCard({
    type: 'kpi', title: 't', show_header: false, collapsed: true, color: '#4a7', note: '口径说明',
  }, [])
  assert.equal(card.show_header, false)
  assert.equal(card.collapsed, true)
  assert.equal(card.color, '#4a7')
  assert.equal(card.note, '口径说明')
})

test('card colours are restricted to a safe set', () => {
  // The value lands in a style attribute, so anything but a literal colour
  // would be an injection surface.
  for (const good of ['#fff', '#4a71c2', 'red', 'blue', 'gray', 'default']) {
    assert.doesNotThrow(() => makeCard({ type: 'text', title: 't', color: good }, []), `should accept ${good}`)
  }
  for (const bad of ['javascript:alert(1)', 'url(//evil)', 'expression(1)', 'red;background:url(x)', '<script>']) {
    assert.throws(
      () => makeCard({ type: 'text', title: 't', color: bad }, []),
      err => err.code === 'INVALID_COLOR',
      `should reject ${bad}`,
    )
  }
})

test('presentation fields persist through updateCard', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    let canvas = addTestCard(store, c.id, { type: 'chart', title: 'a' }, c.revision)
    const cardId = canvas.cards[0].id

    canvas = store.updateCard(c.id, cardId, { collapsed: true, note: '备注', color: 'orange' }, canvas.revision)
    const card = canvas.cards[0]
    assert.equal(card.collapsed, true)
    assert.equal(card.note, '备注')
    assert.equal(card.color, 'orange')

    // and survive a reload from disk
    const reopened = store.getCanvas(c.id).cards[0]
    assert.equal(reopened.collapsed, true)
    assert.equal(reopened.note, '备注')
    assert.equal(reopened.color, 'orange')
  })
})

// ── moving cards between canvases ───────────────────────────────────────────

test('copyCardToCanvas moves a card and keeps its provenance', () => {
  withStore(store => {
    const a = store.createCanvas({ name: 'A' })
    const b = store.createCanvas({ name: 'B' })
    const canvasA = addTestCard(store, a.id, {
      type: 'chart', title: '营收', chart_type: 'line',
      dataset: 'sales.csv', query: 'SELECT 1', color: 'blue', note: '口径',
    })
    const cardId = canvasA.cards[0].id

    const result = store.copyCardToCanvas(a.id, cardId, b.id, { removeFromSource: true })

    assert.equal(store.getCanvas(a.id).cards.length, 0, 'source should be emptied')
    const target = store.getCanvas(b.id)
    assert.equal(target.cards.length, 1)
    const moved = target.cards[0]
    assert.notEqual(moved.id, cardId, 'the moved card gets its own id')
    assert.equal(moved.title, '营收')
    assert.equal(moved.chart_type, 'line')
    assert.equal(moved.source.dataset, 'sales.csv')
    assert.equal(moved.source.query, 'SELECT 1')
    assert.equal(moved.color, 'blue')
    assert.equal(moved.note, '口径')
    assert.equal(result.to, b.id)
  })
})

test('copyCardToCanvas can leave the original in place', () => {
  withStore(store => {
    const a = store.createCanvas({ name: 'A' })
    const b = store.createCanvas({ name: 'B' })
    const canvasA = addTestCard(store, a.id, { type: 'kpi', title: 'K' })
    const cardId = canvasA.cards[0].id

    store.copyCardToCanvas(a.id, cardId, b.id, { removeFromSource: false })

    assert.equal(store.getCanvas(a.id).cards.length, 1, 'source keeps its card')
    assert.equal(store.getCanvas(b.id).cards.length, 1, 'target gains a copy')
  })
})

test('moving a card onto a canvas that already has content does not overlap', () => {
  withStore(store => {
    const a = store.createCanvas({ name: 'A' })
    const b = store.createCanvas({ name: 'B' })
    addTestCard(store, b.id, { type: 'chart', title: 'existing' })
    const canvasA = addTestCard(store, a.id, { type: 'chart', title: 'incoming' })

    store.copyCardToCanvas(a.id, canvasA.cards[0].id, b.id, { removeFromSource: true })

    const cards = store.getCanvas(b.id).cards
    assert.equal(cards.length, 2)
    assert.equal(overlaps(cards[0].layout, cards[1].layout), false, 'the moved card must not land on top')
  })
})

test('copyCardToCanvas reports a missing card or canvas', () => {
  withStore(store => {
    const a = store.createCanvas({ name: 'A' })
    const b = store.createCanvas({ name: 'B' })
    assert.throws(() => store.copyCardToCanvas(a.id, 'nope', b.id), err => err.code === 'CARD_NOT_FOUND')
    assert.throws(() => store.copyCardToCanvas(a.id, 'nope', 'missing'), err => err.code === 'CARD_NOT_FOUND')
  })
})

test('mergeCanvasInto appends every card below existing content', () => {
  withStore(store => {
    const a = store.createCanvas({ name: 'A' })
    const b = store.createCanvas({ name: 'B' })
    addTestCard(store, b.id, { type: 'chart', title: 'existing', layout: { x: 0, y: 0, w: 48, h: 15 } })
    let canvasA = addTestCard(store, a.id, { type: 'chart', title: 'x', layout: { x: 0, y: 0, w: 48, h: 15 } })
    canvasA = addTestCard(store, a.id, { type: 'kpi', title: 'y', layout: { x: 48, y: 0, w: 48, h: 15 } }, canvasA.revision)

    const result = store.mergeCanvasInto(a.id, b.id, { keepSource: true })

    assert.equal(result.moved, 2)
    const cards = store.getCanvas(b.id).cards
    assert.equal(cards.length, 3)
    // Every incoming card starts below the existing one.
    for (const card of cards.slice(1)) {
      assert.ok(card.layout.y >= 15, `merged card should sit below existing content, got y=${card.layout.y}`)
    }
    assert.equal(store.getCanvas(a.id).cards.length, 2, 'source kept by default')
  })
})

test('copy and merge relink legacy source-less data cards', () => {
  withStore(store => {
    const copySource = store.createCanvas({ name: 'legacy copy source' })
    const legacyCopyCanvas = store.withCanvas(copySource.id, copySource.revision, canvas => {
      const card = makeCard({ type: 'chart', title: '旧式复制卡' }, canvas.cards)
      delete card.source
      canvas.cards.push(card)
      return canvas
    })
    const copyTarget = store.createCanvas({ name: 'copy target' })
    store.copyCardToCanvas(copySource.id, legacyCopyCanvas.cards[0].id, copyTarget.id, { removeFromSource: false })
    assert.ok(store.getCanvas(copyTarget.id).cards[0].source.note.includes(SOURCE_RELINK_MARKER))

    const mergeSource = store.createCanvas({ name: 'legacy merge source' })
    store.withCanvas(mergeSource.id, mergeSource.revision, canvas => {
      const card = makeCard({ type: 'kpi', title: '旧式合并卡' }, canvas.cards)
      delete card.source
      canvas.cards.push(card)
      return canvas
    })
    const mergeTarget = store.createCanvas({ name: 'merge target' })
    store.mergeCanvasInto(mergeSource.id, mergeTarget.id)
    assert.ok(store.getCanvas(mergeTarget.id).cards[0].source.note.includes(SOURCE_RELINK_MARKER))
  })
})

test('mergeCanvasInto refuses to merge a canvas into itself', () => {
  withStore(store => {
    const a = store.createCanvas({ name: 'A' })
    assert.throws(() => store.mergeCanvasInto(a.id, a.id), err => err.code === 'INVALID_TARGET')
  })
})

test('survives a reload: a second store instance sees the same data', () => {
  withStore((store, dir) => {
    const c = store.createCanvas({ name: 'durable' })
    addTestCard(store, c.id, { type: 'kpi', title: '营收', presentation_spec: { value: 42 } })

    const reopened = new CanvasStore(dir)
    const list = reopened.listCanvases()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'durable')
    assert.equal(list[0].card_count, 1)

    const canvas = reopened.getCanvas(c.id)
    assert.equal(canvas.cards[0].title, '营收')
    assert.equal(canvas.cards[0].presentation_spec.value, 42)
  })
})

test('code cards carry text_content and a bounded language tag', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    let canvas = addTestCard(store, c.id, {
      type: 'code',
      title: '查询',
      text_content: 'SELECT sum(amount) FROM orders',
      language: 'sql',
    })
    const card = canvas.cards[0]
    assert.equal(card.type, 'code')
    assert.equal(card.text_content, 'SELECT sum(amount) FROM orders')
    assert.equal(card.language, 'sql')

    // A very long language tag is truncated, not rejected wholesale.
    canvas = addTestCard(store, c.id, { type: 'code', title: 'x', text_content: 'x', language: 'y'.repeat(40) }, canvas.revision)
    assert.ok(canvas.cards[1].language.length <= 24)
  })
})

test('the language field is updatable on an existing code card', () => {
  withStore(store => {
    const c = store.createCanvas({ name: 'c' })
    const canvas = addTestCard(store, c.id, { type: 'code', title: 'x', text_content: 'x=1', language: 'js' })
    const updated = store.updateCard(c.id, canvas.cards[0].id, { language: 'python' })
    assert.equal(updated.cards[0].language, 'python')
  })
})

test('settings default off, persist, and undo recovers wide settings and distant cards together', () => {
  withStore(store => {
    const canvas = store.createCanvas({ name: 'wide', cards: [{ type: 'text', title: 'near', layout: { x: 0, y: 0, w: 48, h: 8 } }] })
    assert.deepEqual(canvas.settings, { snap: false, wide: false, badges: false })
    store.setSettings(canvas.id, { wide: true, snap: true }, 1)
    const wide = store.withCanvas(canvas.id, 2, current => { current.cards[0].layout.x = 120; return current })
    const compact = store.setSettings(canvas.id, { wide: false }, wide.revision)
    assert.equal(compact.settings.snap, true)
    assert.ok(compact.cards[0].layout.x + compact.cards[0].layout.w <= 96)
    assert.equal(new CanvasStore(store.root).getCanvas(canvas.id).settings.wide, false)
    const restored = store.undo(canvas.id, compact.revision).canvas
    assert.equal(restored.settings.wide, true)
    assert.equal(restored.cards[0].layout.x, 120)
    assert.throws(() => store.setSettings(canvas.id, { snap: 'true' }), error => error.code === 'INVALID_SETTINGS')
  })
})

test('the badges setting is a whitelisted boolean that survives backup, template and undo', () => {
  withStore(store => {
    const canvas = store.createCanvas({ name: 'badges' })
    // Off unless explicitly enabled, and unknown keys are rejected rather than
    // silently stored (the settings list is a whitelist).
    assert.equal(canvas.settings.badges, false)
    assert.throws(() => store.setSettings(canvas.id, { badges: 'yes' }, 1), error => error.code === 'INVALID_SETTINGS')
    assert.throws(() => store.setSettings(canvas.id, { unknown: true }, 1), error => error.code === 'INVALID_SETTINGS')

    const on = store.setSettings(canvas.id, { badges: true }, 1)
    assert.equal(on.settings.badges, true)
    // Other settings keep their values when one changes.
    assert.equal(on.settings.snap, false)

    // Backup round-trip carries it, and a backup that omits it restores as off.
    const backup = store.exportCanvasBackup(canvas.id)
    assert.equal(backup.canvas.settings.badges, true)
    const imported = store.importCanvasBackup(backup)
    assert.equal(imported.settings.badges, true)
    const legacy = structuredClone(backup)
    delete legacy.canvas.settings.badges
    assert.equal(store.importCanvasBackup(legacy).settings.badges, false)
    assert.throws(() => store.importCanvasBackup({ ...backup, canvas: { ...backup.canvas, settings: { badges: 'yes' } } }),
      error => error.code === 'INVALID_BACKUP')

    // A template carries the display setting but never business payload.
    const template = store.createTemplate(canvas.id, 'layout only')
    assert.equal(template.settings.badges, true)
    assert.equal(store.createCanvasFromTemplate(template.id, 'from template').settings.badges, true)

    // Undo restores the previous value with the rest of the snapshot.
    const restored = store.undo(canvas.id, store.getCanvas(canvas.id).revision).canvas
    assert.equal(restored.settings.badges, false)
  })
})

test('batch delete is atomic and one undo restores the complete group', () => {
  withStore(store => {
    const canvas = store.createExampleCanvas()
    const ids = canvas.cards.slice(0, 3).map(c => c.id)
    const before = readFileSync(store.canvasPath(canvas.id), 'utf8')
    assert.throws(() => store.batchCards(canvas.id, { operation: 'delete', card_ids: [...ids, 'missing'] }, canvas.revision), error => error.code === 'CARD_NOT_FOUND')
    assert.equal(readFileSync(store.canvasPath(canvas.id), 'utf8'), before)
    const deleted = store.batchCards(canvas.id, { operation: 'delete', card_ids: ids }, canvas.revision)
    assert.equal(deleted.cards.length, 7)
    const restored = store.undo(canvas.id, deleted.revision).canvas
    assert.equal(restored.cards.length, 10)
    assert.ok(ids.every(id => restored.cards.some(c => c.id === id)))
    assert.equal(store.redo(canvas.id, restored.revision).canvas.cards.length, 7)
  })
})

test('group layouts preserve offsets, reject collisions, and never record failed history', () => {
  withStore(store => {
    const canvas = store.createCanvas({ name: 'group', cards: [0, 24, 48].map(x => ({ type: 'text', title: String(x), layout: { x, y: 0, w: 20, h: 8 } })) })
    const selected = canvas.cards.slice(0, 2)
    const layouts = Object.fromEntries(selected.map(c => [c.id, { ...c.layout, y: 12 }]))
    const moved = store.batchCards(canvas.id, { operation: 'layout', card_ids: selected.map(c => c.id), layouts }, 1)
    assert.equal(moved.revision, 2)
    assert.deepEqual(moved.cards.slice(0, 2).map(c => c.layout.y), [12, 12])
    const bad = Object.fromEntries(selected.map(c => [c.id, { ...c.layout, x: 48, y: 0 }]))
    assert.throws(() => store.batchCards(canvas.id, { operation: 'layout', card_ids: selected.map(c => c.id), layouts: bad }, 2), error => error.code === 'LAYOUT_COLLISION')
    assert.equal(store.getCanvas(canvas.id).revision, 2)
    assert.throws(() => store.batchCards(canvas.id, { operation: 'delete', card_ids: [selected[0].id] }, 1), error => error.code === 'REVISION_CONFLICT')
    const restored = store.undo(canvas.id, 2).canvas
    assert.deepEqual(restored.cards.slice(0, 2).map(c => c.layout.y), [0, 0])
  })
})


test('portable backup validates its schema, strips dataset paths, and preserves wide layouts', () => {
  withStore(store => {
    const backup = {
      format: 'dsh-xcharts-canvas-backup',
      format_version: 1,
      canvas: {
        schema_version: CANVAS_SCHEMA_VERSION,
        name: '迁移画布',
        settings: { wide: true, snap: false },
        cards: [{
          id: 'source-card-id',
          type: 'text',
          title: '宽画布卡片',
          layout: { x: 120, y: 4, w: 32, h: 8 },
          text_content: '便携内容',
          source: { dataset: 'C:\\\\Users\\\\me\\\\data.csv', query: '本地说明', note: '备注' },
        }],
      },
    }
    const imported = store.importCanvasBackup(backup)
    assert.equal(imported.settings.wide, true)
    assert.deepEqual(imported.cards[0].layout, { x: 120, y: 4, w: 32, h: 8, grid_v: 5 })
    assert.notEqual(imported.cards[0].id, 'source-card-id')
    assert.equal(imported.cards[0].source.dataset, null)
    assert.equal(imported.cards[0].source.query, '本地说明')

    const badVersion = structuredClone(backup)
    badVersion.canvas.schema_version = CANVAS_SCHEMA_VERSION + 1
    assert.throws(() => store.importCanvasBackup(badVersion), error => error.code === 'INVALID_BACKUP')
    const badLayout = structuredClone(backup)
    badLayout.canvas.settings.wide = false
    assert.throws(() => store.importCanvasBackup(badLayout), error => error.code === 'INVALID_BACKUP')
    assert.equal(store.listCanvases().length, 1, 'rejected imports must not leave a partial canvas')
  })
})

test('backups round-trip five card types and preferences without old IDs or dataset aliases', () => {
  withStore(store => {
    const original = store.createExampleCanvas()
    const backup = store.exportCanvasBackup(original.id)
    assert.equal(store.listCanvases().length, 1, 'export validation must not create a canvas')
    assert.ok(backup.canvas.cards.every(c => !c.id && !c.created_at && !c.source.dataset))
    backup.canvas.cards[0].dataset = '/private/alias.csv'
    backup.canvas.cards[0].query = 'unapproved alias'
    const imported = store.importCanvasBackup(backup)
    assert.notEqual(imported.id, original.id)
    assert.deepEqual(imported.cards.map(c => c.type), original.cards.map(c => c.type))
    assert.deepEqual(imported.cards.find(c => c.type === 'table').table_data, original.cards.find(c => c.type === 'table').table_data)
    assert.ok(imported.cards.every(c => c.source.dataset === null && !original.cards.some(o => o.id === c.id)))
    assert.notEqual(imported.cards[0].source.query, 'unapproved alias')
  })
})

test('portable backup import relinks legacy data cards without provenance', () => {
  withStore(store => {
    const backup = {
      format: 'dsh-xcharts-canvas-backup', format_version: 1,
      canvas: {
        schema_version: CANVAS_SCHEMA_VERSION, name: '旧版本备份',
        cards: [{ type: 'chart', title: '旧图表', layout: { x: 0, y: 0, w: 24, h: 8 }, echarts_option: { series: [] } }],
      },
    }
    const imported = store.importCanvasBackup(backup)
    const card = imported.cards[0]
    assert.equal(card.source.dataset, null)
    assert.equal(card.source.query, null)
    assert.ok(card.source.note.includes(SOURCE_RELINK_MARKER))
    assert.equal(store.listCanvases().length, 1)
  })
})

test('invalid imported payload types and catalog failure leave no invisible canvas files', () => {
  withStore((store, root) => {
    const original = store.createExampleCanvas()
    const backup = store.exportCanvasBackup(original.id)
    const count = () => readdirSync(store.canvasDir).length
    for (const changes of [{ show_header: 'yes' }, { echarts_option: 'bad' }, { table_data: { columns: ['a'], rows: [{ a: 1 }] } }]) {
      const invalid = structuredClone(backup)
      Object.assign(invalid.canvas.cards[0], changes)
      assert.throws(() => store.importCanvasBackup(invalid), error => error.code === 'INVALID_BACKUP')
      assert.equal(count(), 1)
    }
    store.writeIndex = () => { throw new Error('simulated catalog failure') }
    assert.throws(() => store.importCanvasBackup(backup), /catalog failure/)
    assert.equal(count(), 1)
    assert.equal(new CanvasStore(root).listCanvases().length, 1)
  })
})

test('layout templates support listing, renaming, cloning and deletion without carrying business data', () => {
  withStore((store, root) => {
    const original = store.createExampleCanvas()
    const template = store.createTemplate(original.id, 'Weekly layout')
    const serialized = JSON.stringify(template)
    assert.doesNotMatch(serialized, /table_data|echarts_option|text_content|presentation_spec|source|上半年营收|SUM/)
    assert.equal(new CanvasStore(root).listTemplates()[0].id, template.id)
    store.renameTemplate(template.id, 'Renamed')
    assert.equal(store.listTemplates()[0].name, 'Renamed')
    const clone = store.createCanvasFromTemplate(template.id, 'New canvas')
    assert.equal(clone.cards.length, original.cards.length)
    assert.deepEqual(clone.cards.map(c => c.layout), original.cards.map(c => c.layout))
    assert.ok(clone.cards.every(c => !original.cards.some(o => o.id === c.id)))
    assert.ok(clone.cards.every(c => c.source.dataset === null && c.source.query === null))
    const dataCards = clone.cards.filter(card => ['chart', 'table', 'kpi'].includes(card.type))
    assert.ok(dataCards.every(card => card.source.note?.includes(MANUAL_SOURCE_MARKER) || card.note?.includes(MANUAL_SOURCE_MARKER)),
      'template placeholders must declare a manual source so they remain valid data cards')
    store.deleteTemplate(template.id)
    assert.equal(store.listTemplates().length, 0)
    assert.equal(store.getCanvas(clone.id).cards.length, 10)
    assert.throws(() => store.getTemplate('../escape'), error => error.code === 'INVALID_TEMPLATE')
    assert.throws(() => store.getTemplate(template.id), error => error.code === 'TEMPLATE_NOT_FOUND')
  })
})
