import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = resolve(process.argv[2] || '.')
const load = name => import(pathToFileURL(join(packageRoot, 'lib', name)).href)
const { CanvasStore } = await load('store.js')
const { canvasToolDefinitions } = await load('tools.js')
const { DataStore } = await load('data-store.js')
const root = mkdtempSync(join(tmpdir(), 'xc-package-smoke-'))
try {
  const store = new CanvasStore(root)
  const canvas = store.createCanvas({ name: '独立包运行冒烟' })
  const defs = canvasToolDefinitions(() => root)
  const call = async (name, input) => JSON.parse(await defs.find(t => t.name === name).execute(input))
  assert.equal((await call('canvas_add_card', { canvas_id: canvas.id, type: 'chart', title: '来源拒绝' })).code, 'SOURCE_REQUIRED')
  for (const title of ['预览一', '预览二']) {
    const result = await call('canvas_add_card', { canvas_id: canvas.id, type: 'chart', title, dataset: 'synthetic.csv', query: '模拟合成数据', echarts_option: { series: [{ type: 'bar', data: [1, 2] }] } })
    assert.equal(result.status, 'pending_confirmation')
    assert.equal(result.draft_id, undefined)
  }
  assert.equal(store.getCanvas(canvas.id).cards.length, 0)
  // Contract as implemented: a newer add on the same canvas replaces the older
  // pending preview, and the replaced one can never be confirmed.
  const supersededId = store.listCardDrafts()[0].id
  const latest = await call('canvas_add_card', { canvas_id: canvas.id, type: 'chart', title: '预览二', dataset: 'synthetic.csv', query: '模拟合成数据', echarts_option: { series: [{ type: 'bar', data: [2, 3] }] } })
  assert.equal(latest.status, 'pending_confirmation')
  const drafts = store.listCardDrafts()
  assert.equal(drafts.length, 1, 'only the newest preview survives')
  assert.throws(() => store.confirmCardDraft(supersededId), error => error.code === 'DRAFT_SUPERSEDED')
  assert.equal(store.getCanvas(canvas.id).cards.length, 0, 'a superseded preview never writes')
  store.confirmCardDraft(drafts[0].id)
  assert.equal(store.confirmCardDraft(drafts[0].id).idempotent, true)
  assert.equal(store.getCanvas(canvas.id).cards.length, 1)
  const beforeUpdate = store.getCanvas(canvas.id)
  const cardId = beforeUpdate.cards[0].id
  const update = await call('canvas_update_card', { canvas_id: canvas.id, card_id: cardId, title: '确认后更新', query: '更新口径', expected_revision: beforeUpdate.revision })
  assert.equal(update.status, 'pending_confirmation')
  assert.equal(update.draft_id, undefined)
  assert.deepEqual(store.getCanvas(canvas.id), beforeUpdate)
  const updateDraft = store.listCardDrafts().find(item => item.operation === 'update')
  store.confirmCardDraft(updateDraft.id)
  assert.equal(store.confirmCardDraft(updateDraft.id).idempotent, true)
  const afterUpdate = store.getCanvas(canvas.id)
  assert.equal(afterUpdate.cards.length, 1)
  assert.equal(afterUpdate.cards[0].id, cardId)
  assert.equal(afterUpdate.cards[0].title, '确认后更新')
  assert.equal(afterUpdate.cards[0].source.query, '更新口径')
  const cancelledUpdate = store.createCardUpdateDraft(canvas.id, cardId, { title: '取消更新' })
  store.cancelCardDraft(cancelledUpdate.id)
  assert.deepEqual(store.getCanvas(canvas.id), afterUpdate)
  const data = new DataStore(root)
  const source = await data.import({ name: '模拟销售', filename: 'sales.csv', content_base64: Buffer.from('region,amount\nA,10\nA,20\nB,7\n').toString('base64') })
  const result = data.query(source.id, { group_by: ['region'], metrics: [{ op: 'sum', column: 'amount', as: 'total' }], order_by: [{ column: 'total', direction: 'desc' }], limit: 500 })
  assert.deepEqual(result.rows, [['A', 30], ['B', 7]])
  // Saved-result index and naming (added with the datasource history feature).
  const second = data.query(source.id, { select: ['region'], limit: 10 })
  const history = data.listResults(source.id)
  assert.equal(history.length >= 2, true, 'every query is recorded on its source')
  assert.equal(history[0].id, second.id, 'the index is newest-first')
  assert.equal(history[0].title, undefined, 'an unnamed result stays unnamed')
  assert.equal(data.renameResult(result.id, '按区域汇总').title, '按区域汇总')
  assert.equal(data.listResults(source.id).find(entry => entry.id === result.id).title, '按区域汇总')
  assert.throws(() => data.renameResult(result.id, ''), error => error.code === 'INVALID_NAME')
  assert.equal(data.list().find(entry => entry.id === source.id).results.length >= 2, true, 'the source lists what it produced')
  data.addToCanvas(store, { result_id: result.id, canvas_id: canvas.id, type: 'chart', title: '按区域汇总', x: 'region', y: 'total' })
  assert.equal(store.getCanvas(canvas.id).cards.at(-1).source.dataset, source.id)

  // Provenance: versions, read-only check/recompute and a durable follow-up
  // reference must work from the installed package alone.
  const { TraceService } = await load('trace-service.js')
  const trace = new TraceService(root)
  const written = store.getCanvas(canvas.id).cards.at(-1)
  assert.ok(written.data_version_id, 'a data card carries an immutable data version')
  const versionBefore = store.getCanvas(canvas.id).revision
  const view = await trace.read(canvas.id, written.id)
  assert.equal(view.calculation.kind, 'structured')
  assert.equal(view.data[0].status, 'linked')
  assert.equal((await trace.check(canvas.id, written.id)).checks.find(check => check.id === 'result_hash').status, 'pass')
  assert.equal((await trace.recompute(canvas.id, written.id)).status, 'match')
  assert.equal(store.getCanvas(canvas.id).revision, versionBefore, 'reading and recomputing never write')
  const followup = await trace.createFollowup(canvas.id, written.id, { request_id: 'smoke-request' })
  assert.match(followup.prompt, /\[xcharts:[a-f0-9]{32}\]$/)
  assert.match((await trace.context(followup.id)).full_version_api, /\/followups\/[a-f0-9]{32}\/version$/)
  const stored = store.createTemplate(canvas.id, '冒烟模板')
  assert.ok(!JSON.stringify(stored).includes('smoke-request'), 'templates never carry business provenance')

  // References: a versioned datasource pointer resolves to bounded context, and
  // its use is recorded so the source can answer "who used me".
  const { ReferenceService } = await load('reference-service.js')
  const references = new ReferenceService(root)
  const marker = `[xcharts:ds:${source.id}@${source.content_hash}]`
  const context = await references.read(marker, 'sample')
  assert.equal(context.status, 'linked')
  assert.equal(context.identity.row_count, 3)
  assert.equal(context.sample.length, 3)
  references.record({ kind: 'ds', id: source.id, version: source.content_hash }, 'ask', { session_id: 'smoke-session' })
  const usage = await references.usageForSource(source.id)
  assert.equal(usage.counts.cards, 1, 'the card written from the result is found by the reverse lookup')
  assert.deepEqual(usage.sessions.map(session => session.session_id), ['smoke-session'])

  console.log('PASS package smoke: source guard, preview supersede/confirm/idempotency, saved-result history and naming, aggregate query, result provenance, immutable card versions, read-only check/recompute, durable follow-up reference, versioned data reference and reverse usage')
} finally { rmSync(root, { recursive: true, force: true }) }
