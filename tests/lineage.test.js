import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CanvasStore } from '../lib/store.js'
import { withExecution } from '../lib/execution-context.js'
import { resolveVersion } from '../lib/lineage.js'
import { TraceService } from '../lib/trace-service.js'
import { captureExecution } from '../lib/execution-evidence.js'

function fixture (fn) {
  const root = mkdtempSync(join(tmpdir(), 'xc-version-'))
  const store = new CanvasStore(root)
  try { return fn(store, root) } finally { rmSync(root, { recursive: true, force: true }) }
}
const card = { type: 'chart', title: '销量', dataset: '手工表', query: '固定输入', echarts_option: { xAxis: { data: ['A', 'B'] }, yAxis: {}, series: [{ type: 'bar', data: [10, 20] }] } }

test('data changes append immutable versions; names, colours and layout do not', () => fixture(store => {
  const canvas = store.createCanvas({ name: '版本', cards: [card] }), id = canvas.cards[0].id
  const v1 = canvas.cards[0].data_version_id
  const renamed = store.updateCard(canvas.id, id, { title: '新标题', color: 'red', layout: { x: 1 } })
  assert.equal(renamed.cards[0].data_version_id, v1)
  const option = structuredClone(card.echarts_option); option.series[0].data[0] = 11
  const updated = store.updateCard(canvas.id, id, { echarts_option: option })
  assert.notEqual(updated.cards[0].data_version_id, v1)
  assert.equal(store.getCardVersion(canvas.id, id, v1).version.card.echarts_option.series[0].data[0], 10)
  const old = resolveVersion(updated, id, v1)
  assert.equal(old.versions.length, 2)
  assert.equal(old.version.card.title, '销量')
}))

test('undo and redo restore original data pointers without destroying their evidence', () => fixture(store => {
  const canvas = store.createCanvas({ name: '撤销', cards: [card] }), id = canvas.cards[0].id
  const v1 = canvas.cards[0].data_version_id
  const updated = store.updateCard(canvas.id, id, { echarts_option: { ...card.echarts_option, series: [{ type: 'bar', data: [30, 40] }] } })
  const v2 = updated.cards[0].data_version_id
  const undone = store.undo(canvas.id).canvas
  assert.equal(undone.cards[0].data_version_id, v1)
  assert.equal(store.redo(canvas.id).canvas.cards[0].data_version_id, v2)
  assert.equal(store.getCardVersion(canvas.id, id, v1).versions.length, 2)
}))

test('confirmation keeps draft tool identity and cancellation creates no data version', () => fixture((store, root) => {
  const canvas = store.createCanvas({ name: '草稿' })
  const draft = withExecution({ agent: { id: 'session-origin' }, callId: 'call-origin', name: 'canvas_add_card' }, () => new CanvasStore(root).createCardDraft(canvas.id, card))
  assert.equal(store.getCanvas(canvas.id).cards.length, 0)
  const saved = store.confirmCardDraft(draft.id)
  const version = store.getCardVersion(canvas.id, saved.card_id).version
  assert.equal(version.context.session_id, 'session-origin')
  assert.equal(version.context.call_id, 'call-origin')
  const cancelled = store.createCardDraft(canvas.id, { ...card, title: '取消' })
  store.cancelCardDraft(cancelled.id)
  assert.equal(store.getCanvas(canvas.id).cards.length, 1)
}))

test('copy keeps original versions and has a separate identity and branch', () => fixture(store => {
  const source = store.createCanvas({ name: '原画布', cards: [card] }), target = store.createCanvas({ name: '副本' })
  const original = source.cards[0]
  const result = store.copyCardToCanvas(source.id, original.id, target.id, { removeFromSource: false })
  assert.notEqual(result.card.id, original.id)
  assert.equal(result.card.copied_from.card_id, original.id)
  assert.equal(result.card.data_version_id, original.data_version_id)
  store.updateCard(target.id, result.card.id, { echarts_option: { series: [{ type: 'pie', data: [{ name: 'A', value: 999 }] }] } })
  assert.equal(store.getCanvas(source.id).cards[0].data_version_id, original.data_version_id)
}))

test('read-only legacy resolution never migrates the canvas on read', () => fixture(store => {
  const canvas = store.createCanvas({ name: '旧卡', cards: [card] })
  const before = readFileSync(store.canvasPath(canvas.id), 'utf8')
  const copy = structuredClone(canvas); delete copy.lineage; delete copy.cards[0].data_version_id
  const first = resolveVersion(copy, canvas.cards[0].id)
  assert.equal(resolveVersion(copy, canvas.cards[0].id).version.id, first.version.id)
  assert.equal(readFileSync(store.canvasPath(canvas.id), 'utf8'), before)
}))

test('portable backup preserves version history while templates strip it', () => fixture(store => {
  const canvas = store.createCanvas({ name: '携带历史', cards: [card] }), id = canvas.cards[0].id
  store.updateCard(canvas.id, id, { echarts_option: { series: [{ type: 'pie', data: [{ name: 'A', value: 100 }] }] } })
  const backup = store.exportCanvasBackup(canvas.id)
  assert.equal(backup.canvas.cards[0].provenance.versions.length, 2)
  const imported = store.importCanvasBackup(backup)
  assert.ok(store.getCardVersion(imported.id, imported.cards[0].id).versions.length >= 2)
  const template = store.createTemplate(canvas.id, '空模板')
  assert.ok(!JSON.stringify(store.getTemplate(template.id)).includes('session-origin'))
}))

test('exact execution reference exposes redacted completed command, never neighbour calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xc-evidence-'))
  try {
    const store = new CanvasStore(root)
    captureExecution(root, { agent: { id: 'source-session' }, callId: 'selected-call', name: 'pwsh', arguments: { command: 'python calc.py --token=abc123' } }, { isError: false, content: [{ type: 'text', text: 'value=12' }] })
    captureExecution(root, { agent: { id: 'source-session' }, callId: 'neighbour', name: 'pwsh', arguments: { command: 'python unrelated.py' } }, { isError: false, content: [] })
    const canvas = store.createCanvas({ name: '证据', cards: [{ ...card, calculation_ref: { session_id: 'source-session', call_id: 'selected-call' } }] })
    const trace = await new TraceService(root).read(canvas.id, canvas.cards[0].id)
    assert.equal(trace.calculation.status, 'pending')
    assert.match(trace.calculation.method, /calc.py/)
    assert.doesNotMatch(trace.calculation.method, /abc123|unrelated/)
    assert.equal(trace.calculation.evidence.status, 'completed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
