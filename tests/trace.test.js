import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { CanvasStore } from '../lib/store.js'
import { DataStore } from '../lib/data-store.js'
import { TraceService } from '../lib/trace-service.js'

async function fixture (fn, { query = {}, type = 'chart', csv = 'region,value\nEast,12\nWest,18\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xctrace-'))
  try {
    const store = new CanvasStore(root), data = new DataStore(root), trace = new TraceService(root)
    const source = await data.import({ name: '销售', filename: 'sales.csv', content_base64: Buffer.from(csv).toString('base64') })
    const result = data.query(source.id, query), canvas = store.createCanvas({ name: '溯源测试' })
    const added = data.addToCanvas(store, { canvas_id: canvas.id, result_id: result.id, title: '区域销售', type, chart_type: 'bar', x: 'region', y: 'value' })
    await fn({ root, store, data, trace, source, result, canvasId: canvas.id, cardId: added.card_id })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
function snapshot (dir, prefix = '') {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name), key = join(prefix, name)
    return statSync(path).isDirectory() ? snapshot(path, key) : [[key, readFileSync(path, 'utf8')]]
  })
}
function checkOf (response, id) { return response.checks.find(check => check.id === id) }
function mutateResult (root, id, change) {
  const path = join(root, 'results', `${id}.json`), result = JSON.parse(readFileSync(path, 'utf8'))
  change(result); writeFileSync(path, JSON.stringify(result)); return result
}

test('trace, check and recompute are read-only and verify actual bound values', async () => {
  await fixture(async ({ root, trace, canvasId, cardId }) => {
    const before = snapshot(root)
    const view = await trace.read(canvasId, cardId)
    assert.equal(view.calculation.kind, 'structured')
    assert.equal(view.data[0].status, 'linked')
    assert.ok(Object.isFrozen(view.card.echarts_option.series))
    const checked = await trace.check(canvasId, cardId)
    for (const id of ['result_hash', 'source_hash', 'coverage', 'presentation']) assert.equal(checkOf(checked, id).status, 'pass')
    assert.equal((await trace.recompute(canvasId, cardId)).status, 'match')
    assert.deepEqual(snapshot(root), before)
  })
})

test('same number of chart points does not validate wrong values, categories or extra series', async () => {
  await fixture(async ({ store, trace, canvasId, cardId }) => {
    for (const change of [option => { option.series[0].data = [99, 99] }, option => { option.xAxis.data = ['Other', 'West'] }, option => { option.series.push({ name: 'value', type: 'line', data: [0, 0] }) }]) {
      const original = store.getCanvas(canvasId).cards.find(card => card.id === cardId).echarts_option
      const option = structuredClone(original); change(option)
      store.updateCard(canvasId, cardId, { echarts_option: option })
      assert.equal(checkOf(await trace.check(canvasId, cardId), 'presentation').status, 'fail')
      store.updateCard(canvasId, cardId, { echarts_option: original })
    }
  })
})

test('legacy source query result reference proves simple series by real columns', async () => {
  await fixture(async ({ root, store, trace, canvasId, cardId }) => {
    const path = store.canvasPath(canvasId), canvas = store.getCanvas(canvasId)
    delete canvas.cards[0].binding; delete canvas.lineage; delete canvas.cards[0].data_version_id
    writeFileSync(path, JSON.stringify(canvas))
    assert.equal(checkOf(await trace.check(canvasId, cardId), 'presentation').status, 'pass')
    assert.equal((await trace.recompute(canvasId, cardId)).status, 'match')
    assert.ok(snapshot(root).length)
  })
})

test('result mutation is detected by hash and pure recomputation', async () => {
  await fixture(async ({ root, trace, result, canvasId, cardId }) => {
    mutateResult(root, result.id, value => { value.rows[0][1] = 999 })
    assert.equal(checkOf(await trace.check(canvasId, cardId), 'result_hash').status, 'fail')
    const response = await trace.recompute(canvasId, cardId)
    assert.equal(response.status, 'different'); assert.ok(response.differences.includes('rows'))
  })
})

test('source mutation cannot silently recompute using different inputs', async () => {
  await fixture(async ({ root, trace, source, canvasId, cardId }) => {
    const path = join(root, 'datasources', `${source.id}.json`), changed = JSON.parse(readFileSync(path, 'utf8'))
    changed.rows[0][1] = 400
    changed.content_hash = createHash('sha256').update(JSON.stringify({ columns: changed.columns, rows: changed.rows })).digest('hex')
    writeFileSync(path, JSON.stringify(changed))
    trace.dataStore.sourceVersion = undefined
    assert.equal((await trace.read(canvasId, cardId)).data[0].status, 'changed')
    assert.equal(checkOf(await trace.check(canvasId, cardId), 'source_hash').status, 'fail')
    assert.equal((await trace.recompute(canvasId, cardId)).status, 'unavailable')
  })
})

test('partial tables are validated as partial evidence and not complete coverage', async () => {
  await fixture(async ({ trace, canvasId, cardId }) => {
    const response = await trace.check(canvasId, cardId)
    assert.equal(checkOf(response, 'coverage').status, 'partial')
    assert.equal(checkOf(response, 'presentation').status, 'pass')
    assert.equal((await trace.recompute(canvasId, cardId)).status, 'match')
  }, { query: { limit: 1 }, type: 'table' })
})

test('table columns and KPI values must strictly correspond to the saved result', async () => {
  await fixture(async ({ trace, store, canvasId, cardId }) => {
    const table = structuredClone(store.getCanvas(canvasId).cards[0].table_data)
    table.rows[0][1] = '12'
    store.updateCard(canvasId, cardId, { table_data: table })
    assert.equal(checkOf(await trace.check(canvasId, cardId), 'presentation').status, 'fail')
  }, { type: 'table' })
  await fixture(async ({ trace, store, canvasId, cardId }) => {
    assert.equal(checkOf(await trace.check(canvasId, cardId), 'presentation').status, 'pass')
    store.updateCard(canvasId, cardId, { presentation_spec: { label: 'value', value: '30' } })
    assert.equal(checkOf(await trace.check(canvasId, cardId), 'presentation').status, 'fail')
  }, { type: 'kpi', query: { metrics: [{ column: 'value', op: 'sum', as: 'value' }] } })
})

test('declarations and explicitly referenced external calculations remain unverified', async () => {
  await fixture(async ({ trace, store, canvasId }) => {
    const canvas = store.addCard(canvasId, { type: 'text', title: '外部计算', text_content: '平均数', dataset: 'sales.csv', query: '自行计算平均数', calculation_ref: { session_id: 'external-session', call_id: 'call-one' } })
    const card = canvas.cards.at(-1)
    const checked = await trace.check(canvasId, card.id)
    assert.equal(checkOf(checked, 'result').status, 'unknown')
    // A declared reference whose execution evidence cannot be read is "missing",
    // not "pending": pending means the evidence exists but the output is unbound.
    assert.equal((await trace.read(canvasId, card.id)).calculation.status, 'missing')
    assert.equal((await trace.recompute(canvasId, card.id)).status, 'unavailable')
  })
})

test('session title lookup failure is unavailable, not evidence of deletion', async () => {
  const service = new TraceService('unused', { sessionQuery: { async readTitle () { throw new Error('token=private') } } })
  assert.deepEqual(await service.session({ session_id: 'saved' }), { id: 'saved', status: 'limited', reason: 'unavailable' })
  service.services.sessionQuery.readTitle = async () => null
  assert.equal((await service.session({ session_id: 'saved' })).status, 'missing')
  service.services.sessionQuery.readTitle = async () => '已归档会话'
  assert.equal((await service.session({ session_id: 'saved' })).status, 'available')
})

test('followups freeze a version, persist idempotency and bound context to 20 rows', async () => {
  await fixture(async ({ root, trace, store, canvasId, cardId }) => {
    const before = store.getCanvas(canvasId)
    const followup = await trace.createFollowup(canvasId, cardId, { request_id: 'request-one' })
    assert.match(followup.prompt, /^区域销售 \[xcharts:[a-f0-9]{32}\]$/)
    const saved = await trace.context(followup.id)
    assert.equal(saved.card.table_data.rows.length, 20)
    assert.equal(saved.truncated, true)
    // The frozen version stays readable through the follow-up itself, so it
    // survives the card being changed or the canvas being deleted later.
    assert.match(saved.full_version_api, /\/followups\/[a-f0-9]{32}\/version$/)
    assert.equal(saved.session, undefined)
    store.updateCard(canvasId, cardId, { title: '新标题', table_data: { columns: [], rows: [] } })
    const restarted = new TraceService(root)
    assert.equal((await restarted.createFollowup(canvasId, cardId, { request_id: 'request-one' })).id, followup.id)
    assert.equal((await restarted.context(followup.id)).title, '区域销售')
    assert.equal((await trace.read(canvasId, cardId, saved.version.id)).card.title, '区域销售')
    await assert.rejects(trace.createFollowup(canvasId, cardId, { request_id: 'request-one', session_id: 'other' }), { code: 'FOLLOWUP_CONFLICT' })
    assert.ok(before.revision < store.getCanvas(canvasId).revision)
  }, { type: 'table', csv: 'region,value\n' + Array.from({ length: 30 }, (_, i) => `R${i},${i}`).join('\n') })
})

test('deleted cards retain readable selected versions and frozen followup context', async () => {
  await fixture(async ({ trace, store, canvasId, cardId }) => {
    const original = await trace.read(canvasId, cardId)
    const followup = await trace.createFollowup(canvasId, cardId, { request_id: 'before-delete', version_id: original.version.id })
    store.removeCard(canvasId, cardId)
    const historical = await trace.read(canvasId, cardId, original.version.id)
    assert.equal(historical.placement.deleted, true)
    assert.equal(historical.card.title, original.card.title)
    assert.equal((await trace.context(followup.id)).version.id, original.version.id)
  })
})

test('retained normalized historical input allows recomputation when current source is gone', async () => {
  await fixture(async ({ trace, data, source, canvasId, cardId }) => {
    const historical = data.get(source.id)
    data.remove(source.id)
    trace.dataStore.sourceVersion = (id, contentHash) => id === historical.id && contentHash === historical.content_hash ? historical : null
    const before = structuredClone(historical)
    assert.equal((await trace.recompute(canvasId, cardId)).status, 'match')
    assert.deepEqual(historical, before)
    assert.equal((await trace.read(canvasId, cardId)).data[0].status, 'missing')
  })
})

test('inconsistent materialized count fails coverage validation', async () => {
  await fixture(async ({ root, trace, result, canvasId, cardId }) => {
    mutateResult(root, result.id, value => { value.materialized_rows++ })
    assert.equal(checkOf(await trace.check(canvasId, cardId), 'coverage').status, 'fail')
    assert.equal((await trace.recompute(canvasId, cardId)).status, 'different')
  })
})

test('followup acknowledgement is durable, session-bound and monotonic', async () => {
  await fixture(async ({ root, trace, canvasId, cardId }) => {
    const ref = await trace.createFollowup(canvasId, cardId, { request_id: 'ack-once', session_id: 'target' })
    await assert.rejects(trace.ackFollowup(ref.id, { session_id: 'wrong', status: 'sent' }), { code: 'FOLLOWUP_SESSION_MISMATCH' })
    assert.equal((await trace.ackFollowup(ref.id, { session_id: 'target', status: 'sent' })).duplicate, false)
    const restarted = new TraceService(root)
    assert.equal((await restarted.ackFollowup(ref.id, { session_id: 'target', status: 'sent' })).duplicate, true)
    await assert.rejects(restarted.ackFollowup(ref.id, { session_id: 'target', status: 'attached' }), { code: 'FOLLOWUP_CONFLICT' })
    await assert.rejects(restarted.context('../escape'), { code: 'INVALID_FOLLOWUP' })
    await assert.rejects(trace.createFollowup(canvasId, cardId, { request_id: '../../bad' }), { code: 'INVALID_FOLLOWUP' })
  })
})
