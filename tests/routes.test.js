import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { createApiHandler } from '../lib/routes.js'
import { CanvasStore, makeCard, SOURCE_RELINK_MARKER } from '../lib/store.js'
import { DataStore } from '../lib/data-store.js'
import { overlaps } from '../lib/grid.js'

const PREFIX = '/api/xcharts-canvas'
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/**
 * Minimal request/response doubles. The handler uses `method`, `url`, the
 * async-iterable body, `headers`, and the `writeHead`/`end` response pair, so
 * this keeps the route logic testable without a live web server.
 *
 * The `host` header is a loopback authority because the handler applies its
 * trust fence first (see trust.test.js) — a request without one is refused.
 */
function makeReq (method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080' }
  return req
}

function makeRes () {
  const res = {
    statusCode: null,
    headers: null,
    chunks: [],
    writeHead (status, headers) { this.statusCode = status; this.headers = headers },
    end (chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)) },
  }
  res.json = () => JSON.parse(Buffer.concat(res.chunks).toString('utf8'))
  return res
}

async function request (handler, method, url, body) {
  const res = makeRes()
  await handler(makeReq(method, url, body), res)
  return res
}

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

async function withApi (fn) {
  const dir = mkdtempSync(join(tmpdir(), 'xcroutes-'))
  const handler = createApiHandler(() => new CanvasStore(dir), PREFIX)
  const store = new CanvasStore(dir)
  try {
    return await fn({ handler, store, dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('GET /canvases lists an empty catalog', async () => {
  await withApi(async ({ handler }) => {
    const res = await request(handler, 'GET', `${PREFIX}/canvases`)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { canvases: [] })
    assert.equal(res.headers['cache-control'], 'no-store')
  })
})

test('pending drafts do not touch the canvas and user confirmation commits once', async () => {
  await withApi(async ({ handler, store }) => {
    const canvas = store.createCanvas({ name: '确认流程' })
    assert.throws(() => store.createCardDraft(canvas.id, { type: 'chart', title: '缺来源' }), error => error.code === 'SOURCE_REQUIRED')
    const draft = store.createCardDraft(canvas.id, {
      type: 'chart', title: '区域销售额', chart_type: 'bar',
      echarts_option: { series: [{ type: 'bar', data: [12, 18] }] },
      dataset: 'sales.csv', query: '按区域汇总销售额',
    })
    assert.equal(draft.expected_revision, canvas.revision)
    assert.equal(store.getCanvas(canvas.id).revision, canvas.revision)
    assert.equal(store.getCanvas(canvas.id).cards.length, 0)

    const preview = await request(handler, 'GET', PREFIX + '/drafts')
    assert.equal(preview.statusCode, 200)
    assert.equal(preview.json().drafts.length, 1)
    assert.equal(preview.json().drafts[0].card.title, '区域销售额')
    assert.equal(preview.json().drafts[0].card.source.query, '按区域汇总销售额')

    const first = await request(handler, 'POST', PREFIX + '/drafts/' + draft.id + '/confirm', {})
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().idempotent, false)
    assert.equal(first.json().revision, canvas.revision + 1)
    assert.equal(store.getCanvas(canvas.id).cards.length, 1)

    const retry = await request(handler, 'POST', PREFIX + '/drafts/' + draft.id + '/confirm', {})
    assert.equal(retry.statusCode, 200)
    assert.equal(retry.json().idempotent, true)
    assert.equal(retry.json().card_id, first.json().card_id)
    assert.equal(retry.json().revision, first.json().revision)
    assert.equal(store.getCanvas(canvas.id).cards.length, 1)
  })
})

test('a newer add draft supersedes the old same-canvas draft and only the latest can be confirmed', async () => {
  await withApi(async ({ handler, store }) => {
    const canvas = store.createCanvas({ name: '反馈重预览' })
    const otherCanvas = store.createCanvas({ name: '其它画布' })
    const old = store.createCardDraft(canvas.id, { type: 'chart', title: '旧预览', dataset: 'sales.csv', query: '旧口径' })
    store.createCardDraft(otherCanvas.id, { type: 'chart', title: '其它画布预览', dataset: 'other.csv', query: '其它口径' })
    const latest = store.createCardDraft(canvas.id, { type: 'chart', title: '反馈后新预览', dataset: 'sales.csv', query: '排除退款后的口径' })

    const listed = await request(handler, 'GET', PREFIX + '/drafts')
    assert.deepEqual(listed.json().drafts.map(draft => draft.card.title), ['其它画布预览', '反馈后新预览'])
    const oldConfirm = await request(handler, 'POST', PREFIX + '/drafts/' + old.id + '/confirm', {})
    assert.equal(oldConfirm.statusCode, 409)
    assert.equal(oldConfirm.json().code, 'DRAFT_SUPERSEDED')
    assert.equal(store.getCanvas(canvas.id).revision, canvas.revision)
    assert.equal(store.getCanvas(canvas.id).cards.length, 0)

    const confirmed = await request(handler, 'POST', PREFIX + '/drafts/' + latest.id + '/confirm', {})
    assert.equal(confirmed.statusCode, 200)
    assert.equal(store.getCanvas(canvas.id).revision, canvas.revision + 1)
    assert.equal(store.getCanvas(canvas.id).cards.length, 1)
    assert.equal(store.getCanvas(canvas.id).cards[0].title, '反馈后新预览')
    const retry = await request(handler, 'POST', PREFIX + '/drafts/' + latest.id + '/confirm', {})
    assert.equal(retry.json().idempotent, true)
    assert.equal(store.getCanvas(canvas.id).cards.length, 1)

    const cancelCanvas = store.createCanvas({ name: '取消新预览' })
    const oldCancel = store.createCardDraft(cancelCanvas.id, { type: 'text', title: '旧文字', text_content: '旧内容' })
    const newCancel = store.createCardDraft(cancelCanvas.id, { type: 'text', title: '反馈后待取消', text_content: '修订内容' })
    const cancelled = await request(handler, 'POST', PREFIX + '/drafts/' + newCancel.id + '/cancel', {})
    assert.equal(cancelled.statusCode, 200)
    const oldCancelConfirm = await request(handler, 'POST', PREFIX + '/drafts/' + oldCancel.id + '/confirm', {})
    assert.equal(oldCancelConfirm.statusCode, 409)
    assert.equal(oldCancelConfirm.json().code, 'DRAFT_SUPERSEDED')
    assert.equal(store.getCanvas(cancelCanvas.id).revision, cancelCanvas.revision)
    assert.equal(store.getCanvas(cancelCanvas.id).cards.length, 0)
    assert.deepEqual((await request(handler, 'GET', PREFIX + '/drafts')).json().drafts.map(draft => draft.card.title), ['其它画布预览'])
  })
})


test('cancelling a pending draft is idempotent and never changes the canvas', async () => {
  await withApi(async ({ handler, store }) => {
    const canvas = store.createCanvas({ name: '取消流程' })
    const draft = store.createCardDraft(canvas.id, {
      type: 'table', title: '预览表格',
      table_data: { columns: [{ name: '区域' }], rows: [['华东']] },
      note: MANUAL_SOURCE_MARKER,
    })
    const first = await request(handler, 'POST', PREFIX + '/drafts/' + draft.id + '/cancel', {})
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().cancelled, true)
    assert.equal(first.json().idempotent, false)
    const retry = await request(handler, 'POST', PREFIX + '/drafts/' + draft.id + '/cancel', {})
    assert.equal(retry.statusCode, 200)
    assert.equal(retry.json().idempotent, true)
    assert.equal(store.getCanvas(canvas.id).revision, canvas.revision)
    assert.equal(store.getCanvas(canvas.id).cards.length, 0)
    assert.equal((await request(handler, 'GET', PREFIX + '/drafts')).json().drafts.length, 0)
    const confirmCancelled = await request(handler, 'POST', PREFIX + '/drafts/' + draft.id + '/confirm', {})
    assert.equal(confirmCancelled.statusCode, 400)
    assert.equal(confirmCancelled.json().code, 'DRAFT_CANCELLED')
  })
})

test('confirming a draft after another canvas write returns a conflict without adding the card', async () => {
  await withApi(async ({ handler, store }) => {
    const canvas = store.createCanvas({ name: 'revision conflict' })
    const draft = store.createCardDraft(canvas.id, {
      type: 'chart', title: 'stale preview', dataset: 'a.csv', query: 'SELECT 1',
    })
    store.renameCanvas(canvas.id, 'changed after preview', canvas.revision)
    const response = await request(handler, 'POST', PREFIX + '/drafts/' + draft.id + '/confirm', {})
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().code, 'REVISION_CONFLICT')
    assert.equal(store.getCanvas(canvas.id).cards.length, 0)
    assert.equal((await request(handler, 'GET', PREFIX + '/drafts')).json().drafts.length, 1)
  })
})

test('a newer add draft supersedes the old same-canvas draft and only the latest can be confirmed', async () => {
  await withApi(async ({ handler, store }) => {
    const canvas = store.createCanvas({ name: '反馈重预览' })
    const otherCanvas = store.createCanvas({ name: '其它画布' })
    const old = store.createCardDraft(canvas.id, { type: 'chart', title: '旧预览', dataset: 'sales.csv', query: '旧口径' })
    store.createCardDraft(otherCanvas.id, { type: 'chart', title: '其它画布预览', dataset: 'other.csv', query: '其它口径' })
    const latest = store.createCardDraft(canvas.id, { type: 'chart', title: '反馈后新预览', dataset: 'sales.csv', query: '排除退款后的口径' })

    const listed = await request(handler, 'GET', PREFIX + '/drafts')
    assert.deepEqual(listed.json().drafts.map(draft => draft.card.title), ['其它画布预览', '反馈后新预览'])
    const oldConfirm = await request(handler, 'POST', PREFIX + '/drafts/' + old.id + '/confirm', {})
    assert.equal(oldConfirm.statusCode, 409)
    assert.equal(oldConfirm.json().code, 'DRAFT_SUPERSEDED')
    assert.equal(store.getCanvas(canvas.id).revision, canvas.revision)
    assert.equal(store.getCanvas(canvas.id).cards.length, 0)

    const confirmed = await request(handler, 'POST', PREFIX + '/drafts/' + latest.id + '/confirm', {})
    assert.equal(confirmed.statusCode, 200)
    assert.equal(store.getCanvas(canvas.id).revision, canvas.revision + 1)
    assert.equal(store.getCanvas(canvas.id).cards.length, 1)
    assert.equal(store.getCanvas(canvas.id).cards[0].title, '反馈后新预览')
    const retry = await request(handler, 'POST', PREFIX + '/drafts/' + latest.id + '/confirm', {})
    assert.equal(retry.json().idempotent, true)
    assert.equal(store.getCanvas(canvas.id).cards.length, 1)

    const cancelCanvas = store.createCanvas({ name: '取消新预览' })
    const oldCancel = store.createCardDraft(cancelCanvas.id, { type: 'text', title: '旧文字', text_content: '旧内容' })
    const newCancel = store.createCardDraft(cancelCanvas.id, { type: 'text', title: '反馈后待取消', text_content: '修订内容' })
    const cancelled = await request(handler, 'POST', PREFIX + '/drafts/' + newCancel.id + '/cancel', {})
    assert.equal(cancelled.statusCode, 200)
    assert.equal((await request(handler, 'POST', PREFIX + '/drafts/' + oldCancel.id + '/confirm', {})).json().code, 'DRAFT_SUPERSEDED')
    assert.equal(store.getCanvas(cancelCanvas.id).revision, cancelCanvas.revision)
    assert.equal(store.getCanvas(cancelCanvas.id).cards.length, 0)
  })
})

test('update drafts preview merged content without writing, then confirm once and support undo', async () => {
  await withApi(async ({ handler, store }) => {
    let canvas = store.createCanvas({ name: '更新预览' })
    canvas = store.addCard(canvas.id, { type: 'chart', title: '原卡片', dataset: 'sales.csv', query: '旧口径', echarts_option: { series: [{ type: 'bar', data: [1] }] } }, canvas.revision)
    const old = canvas.cards[0]
    const draft = store.createCardUpdateDraft(canvas.id, old.id, { title: '更新标题', source: { query: '新口径' }, echarts_option: { series: [{ type: 'bar', data: [2] }] } }, canvas.revision)
    assert.equal(draft.operation, 'update')
    assert.equal(draft.card.id, old.id)
    assert.equal(draft.card.source.dataset, 'sales.csv')
    assert.equal(draft.card.source.query, '新口径')
    assert.deepEqual(store.getCanvas(canvas.id), canvas)
    assert.equal(store.readHistory(canvas.id).undo.length, 1)
    const confirmed = await request(handler, 'POST', PREFIX + '/drafts/' + draft.id + '/confirm', {})
    assert.equal(confirmed.statusCode, 200)
    assert.equal(confirmed.json().card_id, old.id)
    const saved = store.getCanvas(canvas.id)
    assert.equal(saved.cards.length, 1)
    assert.equal(saved.cards[0].title, '更新标题')
    assert.deepEqual(saved.cards[0].echarts_option.series[0].data, [2])
    assert.equal(saved.revision, canvas.revision + 1)
    const retry = await request(handler, 'POST', PREFIX + '/drafts/' + draft.id + '/confirm', {})
    assert.equal(retry.json().idempotent, true)
    assert.equal(store.getCanvas(canvas.id).revision, saved.revision)
    const undone = store.undo(canvas.id, saved.revision).canvas
    assert.equal(undone.cards[0].id, old.id)
    assert.equal(undone.cards[0].title, '原卡片')
    assert.equal(undone.cards[0].source.query, '旧口径')
  })
})

test('cancelled or stale update drafts cannot change the original card or revision', async () => {
  await withApi(async ({ handler, store }) => {
    let canvas = store.createCanvas({ name: '更新取消与冲突' })
    canvas = store.addCard(canvas.id, { type: 'text', title: '原卡片', text_content: '原内容' })
    const card = canvas.cards[0]
    const cancelled = store.createCardUpdateDraft(canvas.id, card.id, { text_content: '取消内容' })
    await request(handler, 'POST', PREFIX + '/drafts/' + cancelled.id + '/cancel', {})
    assert.deepEqual(store.getCanvas(canvas.id), canvas)
    assert.equal((await request(handler, 'POST', PREFIX + '/drafts/' + cancelled.id + '/confirm', {})).json().code, 'DRAFT_CANCELLED')
    const stale = store.createCardUpdateDraft(canvas.id, card.id, { text_content: '旧版本内容' })
    const changed = store.updateCard(canvas.id, card.id, { title: '用户修改' }, canvas.revision)
    const conflict = await request(handler, 'POST', PREFIX + '/drafts/' + stale.id + '/confirm', {})
    assert.equal(conflict.statusCode, 409)
    assert.equal(conflict.json().code, 'REVISION_CONFLICT')
    assert.deepEqual(store.getCanvas(canvas.id), changed)
    assert.throws(() => store.createCardUpdateDraft(canvas.id, 'missing', {}), e => e.code === 'CARD_NOT_FOUND')
    assert.throws(() => store.createCardUpdateDraft(canvas.id, card.id, {}, canvas.revision), e => e.code === 'REVISION_CONFLICT')
    const removed = store.createCardUpdateDraft(canvas.id, card.id, { title: '不能复活' }, changed.revision)
    const deleted = store.removeCard(canvas.id, card.id, changed.revision)
    assert.equal((await request(handler, 'POST', PREFIX + '/drafts/' + removed.id + '/confirm', {})).statusCode, 409)
    assert.deepEqual(store.getCanvas(canvas.id), deleted)
  })
})

test('capabilities identify the loaded host code without creating storage', async () => {
  await withApi(async ({ handler, store }) => {
    const res = await request(handler, 'GET', `${PREFIX}/capabilities`)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { api_version: 1, plugin_version: PACKAGE_VERSION, trace_api: 1, followup_api: 1, reference_api: 1, changelog_api: 1, storage_api: 1, workspace_backup_api: 1, database_api: 1, sql_query_api: 1, create_example: true, local_assets: 1, datasource_api: true, datasource_resources: ['datasources', 'results'], datasource_types: ['csv', 'tsv', 'xlsx', 'parquet', 'postgres', 'mysql'] })
    assert.equal(res.headers['x-xcharts-canvas-version'], PACKAGE_VERSION)
    assert.deepEqual(store.listCanvases(), [])
  })
})

test('capabilities preserve authentication and expose only a static diagnostic version on rejection', async () => {
  const handler = createApiHandler(() => { throw new Error('storage must not be accessed') }, PREFIX, () => ({ admit: () => ({ rejection: 401 }) }))
  const res = await request(handler, 'GET', `${PREFIX}/capabilities`)
  assert.equal(res.statusCode, 401)
  assert.equal(res.headers['x-xcharts-canvas-version'], PACKAGE_VERSION)
  assert.equal(Buffer.concat(res.chunks).toString(), 'unauthorized')
})

test('settings and layout routes allow wide coordinates only when enabled and recover them on close', async () => {
  await withApi(async ({ handler, store }) => {
    const canvas = store.createCanvas({ name: 'wide', cards: [{ type: 'text', title: 'A' }] })
    const id = canvas.cards[0].id
    let response = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvas.id}/settings`, { settings: { wide: true, snap: true }, expected_revision: 1 })
    assert.equal(response.statusCode, 200)
    response = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvas.id}/layout`, { layout: { [id]: { x: 200 } }, expected_revision: 2 })
    assert.equal(response.statusCode, 200)
    assert.equal(store.getCanvas(canvas.id).cards[0].layout.x, 200)
    response = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvas.id}/settings`, { settings: { wide: false }, expected_revision: 3 })
    assert.equal(response.statusCode, 200)
    assert.ok(store.getCanvas(canvas.id).cards[0].layout.x + canvas.cards[0].layout.w <= 96)
    response = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvas.id}/settings`, { settings: { wide: 'yes' } })
    assert.equal(response.statusCode, 400)
  })
})

test('batch API rejects partial changes, protects revisions, and undo restores all cards at once', async () => {
  await withApi(async ({ handler, store }) => {
    const canvas = store.createExampleCanvas()
    const ids = canvas.cards.slice(0, 3).map(c => c.id)
    let response = await request(handler, 'POST', `${PREFIX}/canvases/${canvas.id}/batch`, { operation: 'delete', card_ids: [...ids, 'missing'], expected_revision: 1 })
    assert.equal(response.statusCode, 404)
    assert.equal(store.getCanvas(canvas.id).cards.length, 10)
    response = await request(handler, 'POST', `${PREFIX}/canvases/${canvas.id}/batch`, { operation: 'delete', card_ids: ids, expected_revision: 1 })
    assert.equal(response.statusCode, 200)
    assert.equal(store.getCanvas(canvas.id).cards.length, 7)
    response = await request(handler, 'POST', `${PREFIX}/canvases/${canvas.id}/batch`, { operation: 'delete', card_ids: [canvas.cards[3].id], expected_revision: 1 })
    assert.equal(response.statusCode, 409)
    response = await request(handler, 'POST', `${PREFIX}/canvases/${canvas.id}/undo`, { expected_revision: 2 })
    assert.equal(response.statusCode, 200)
    assert.equal(store.getCanvas(canvas.id).cards.length, 10)
  })
})

test('POST /canvases creates and returns the id', async () => {
  await withApi(async ({ handler, store }) => {
    const res = await request(handler, 'POST', `${PREFIX}/canvases`, { name: '销售' })
    assert.equal(res.statusCode, 201)
    const body = res.json()
    assert.ok(body.canvas_id)
    assert.equal(body.name, '销售')
    assert.equal(body.revision, 1)
    assert.equal(store.listCanvases().length, 1)
  })
})

test('POST /canvases/example creates a complete readable case after deleting all canvases', async () => {
  await withApi(async ({ handler, store }) => {
    const seeded = store.seedExampleIfEmpty()
    store.deleteCanvas(seeded.id)
    const created = await request(handler, 'POST', `${PREFIX}/canvases/example`)
    assert.equal(created.statusCode, 201)
    const found = await request(handler, 'GET', `${PREFIX}/canvases/${created.json().canvas_id}`)
    assert.equal(found.statusCode, 200)
    assert.equal(found.json().cards.length, 10)
    const list = await request(handler, 'GET', `${PREFIX}/canvases`)
    assert.equal(list.json().canvases[0].card_count, 10)
  })
})

test('example creation respects the host authentication decision', async () => {
  await withApi(async ({ store }) => {
    const handler = createApiHandler(() => store, PREFIX, () => ({ admit: () => ({ rejection: 401 }) }))
    const res = await request(handler, 'POST', `${PREFIX}/canvases/example`)
    assert.equal(res.statusCode, 401)
    assert.equal(store.listCanvases().length, 0)
  })
})

test('POST /canvases without a name is a 400 with a code', async () => {
  await withApi(async ({ handler }) => {
    const res = await request(handler, 'POST', `${PREFIX}/canvases`, {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'INVALID_CANVAS')
  })
})

test('a malformed JSON body is a 400, not a crash', async () => {
  await withApi(async ({ handler }) => {
    const req = Readable.from([Buffer.from('{ not json')])
    req.method = 'POST'
    req.url = `${PREFIX}/canvases`
    req.headers = { host: '127.0.0.1:3080' }
    const res = makeRes()
    await handler(req, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'INVALID_JSON')
  })
})

test('GET /canvases/:id returns the canvas; unknown ids are 404', async () => {
  await withApi(async ({ handler }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    const found = await request(handler, 'GET', `${PREFIX}/canvases/${created.canvas_id}`)
    assert.equal(found.statusCode, 200)
    assert.equal(found.json().name, 'c')

    const missing = await request(handler, 'GET', `${PREFIX}/canvases/nope`)
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json().code, 'CANVAS_NOT_FOUND')
  })
})

test('DELETE /canvases/:id removes it', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'gone' })).json()
    const res = await request(handler, 'DELETE', `${PREFIX}/canvases/${created.canvas_id}`)
    assert.equal(res.statusCode, 200)
    assert.equal(store.listCanvases().length, 0)
  })
})

test('PATCH /canvases/:id/layout commits a card move and bumps the revision', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    const canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'a' })
    const cardId = canvas.cards[0].id

    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${created.canvas_id}/layout`, {
      layout: { [cardId]: { x: 10, y: 6, w: 20, h: 8 } },
      expected_revision: canvas.revision,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().revision, canvas.revision + 1)
    assert.deepEqual(res.json().layouts[cardId], { x: 10, y: 6, w: 20, h: 8, grid_v: 5 })
  })
})

test('layout commits clamp out-of-range geometry', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    const canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'a' })
    const cardId = canvas.cards[0].id

    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${created.canvas_id}/layout`, {
      layout: { [cardId]: { x: -50, y: -9, w: 9999, h: 9999 } },
    })
    assert.equal(res.statusCode, 200)
    const layout = res.json().layouts[cardId]
    assert.equal(layout.x, 0)
    assert.equal(layout.y, 0)
    assert.ok(layout.w <= 96)
    assert.ok(layout.h <= 32)
  })
})

test('a stale revision on layout is a 409 and changes nothing', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    let canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'a' })
    canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'b' }, canvas.revision)
    const [cardA] = canvas.cards
    const before = { ...cardA.layout }

    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${created.canvas_id}/layout`, {
      layout: { [cardA.id]: { x: 30, y: 30, w: 20, h: 8 } },
      expected_revision: 1, // stale
    })
    assert.equal(res.statusCode, 409)
    const body = res.json()
    assert.equal(body.code, 'REVISION_CONFLICT')
    assert.equal(body.current_revision, canvas.revision)
    assert.deepEqual(store.getCanvas(created.canvas_id).cards[0].layout, before)
  })
})

test('layout with an unknown card id is a 404', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    addTestCard(store, created.canvas_id, { type: 'chart', title: 'a' })
    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${created.canvas_id}/layout`, {
      layout: { nosuchcard: { x: 1, y: 1, w: 20, h: 8 } },
    })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().code, 'CARD_NOT_FOUND')
  })
})

test('layout rejects a non-object payload', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${created.canvas_id}/layout`, { layout: [1, 2, 3] })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'INVALID_LAYOUT')
  })
})

test('POST arrange packs cards without overlap', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    let canvas
    for (let i = 0; i < 7; i++) {
      canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: `c${i}` })
      // scatter them so arrangement has something to do
      store.moveCard(created.canvas_id, canvas.cards[i].id, { x: (i * 11) % 80, y: i * 3, w: 24, h: 8 })
      canvas = store.getCanvas(created.canvas_id)
    }

    const res = await request(handler, 'POST', `${PREFIX}/canvases/${created.canvas_id}/arrange`, {
      expected_revision: canvas.revision,
    })
    assert.equal(res.statusCode, 200)

    const cards = store.getCanvas(created.canvas_id).cards
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        assert.equal(overlaps(cards[i].layout, cards[j].layout), false, `overlap ${i}/${j} after arrange`)
      }
    }
  })
})

test('unknown routes and methods are reported, not ignored', async () => {
  await withApi(async ({ handler }) => {
    const notFound = await request(handler, 'GET', `${PREFIX}/nope`)
    assert.equal(notFound.statusCode, 404)

    const badMethod = await request(handler, 'PUT', `${PREFIX}/canvases`)
    assert.equal(badMethod.statusCode, 405)
    assert.equal(badMethod.json().code, 'METHOD_NOT_ALLOWED')
  })
})

test('a canvas id that tries to escape the storage directory is refused', async () => {
  await withApi(async ({ handler }) => {
    const res = await request(handler, 'GET', `${PREFIX}/canvases/${encodeURIComponent('../../secret')}`)
    assert.equal(res.statusCode, 400)
    assert.ok(['INVALID_CANVAS_ID', 'CANVAS_NOT_FOUND'].includes(res.json().code))
  })
})

test('a corrupt canvas file surfaces as a 500 rather than a bare crash', async () => {
  await withApi(async ({ handler, store, dir }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'canvases', `${created.canvas_id}.json`), 'broken', 'utf8')

    const res = await request(handler, 'GET', `${PREFIX}/canvases/${created.canvas_id}`)
    assert.equal(res.statusCode, 500)
    assert.equal(res.json().code, 'CORRUPT_JSON')
  })
})

test('every response is JSON with an explicit content type', async () => {
  await withApi(async ({ handler }) => {
    for (const [method, url] of [['GET', `${PREFIX}/canvases`], ['GET', `${PREFIX}/nope`]]) {
      const res = await request(handler, method, url)
      assert.match(res.headers['content-type'], /application\/json/)
      assert.ok(res.headers['content-length'] > 0)
    }
  })
})

// ── per-card operations (the context menu's endpoints) ──────────────────────

// ── drag landing: the commit path avoids overlap server-side ────────────────

test('a layout commit drops a card onto a free area at exactly the requested spot', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    const canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'a' })
    const cardId = canvas.cards[0].id

    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${created.canvas_id}/layout`, {
      layout: { [cardId]: { x: 30, y: 20, w: 24, h: 8 } },
      expected_revision: canvas.revision,
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().layouts[cardId], { x: 30, y: 20, w: 24, h: 8, grid_v: 5 })
  })
})

test('a layout commit onto another card settles without overlap', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    let canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'occupant', layout: { x: 0, y: 0, w: 48, h: 15 } })
    const occupantId = canvas.cards[0].id
    canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'mover', layout: { x: 0, y: 40, w: 48, h: 15 } })
    const moverId = canvas.cards[1].id

    // Drop the mover straight on top of the occupant.
    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${created.canvas_id}/layout`, {
      layout: { [moverId]: { x: 0, y: 0, w: 48, h: 15 } },
      expected_revision: canvas.revision,
    })
    assert.equal(res.statusCode, 200)

    const cards = store.getCanvas(created.canvas_id).cards
    const occupant = cards.find(c => c.id === occupantId)
    const mover = cards.find(c => c.id === moverId)
    assert.equal(overlaps(occupant.layout, mover.layout), false, 'cards must not overlap after a commit')
    assert.ok(mover.layout.y > 0 || mover.layout.x >= occupant.layout.w, 'the mover must have been displaced')
  })
})

test('avoid_overlap:false keeps the raw position when the caller knows better', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    let canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'occupant', layout: { x: 0, y: 0, w: 48, h: 15 } })
    canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'mover', layout: { x: 0, y: 40, w: 48, h: 15 } })
    const moverId = canvas.cards[1].id

    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${created.canvas_id}/layout`, {
      layout: { [moverId]: { x: 0, y: 0, w: 48, h: 15 } },
      expected_revision: canvas.revision,
      avoid_overlap: false,
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().layouts[moverId], { x: 0, y: 0, w: 48, h: 15, grid_v: 5 })
  })
})

test('a commit reports how many cards actually moved', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    const canvas = addTestCard(store, created.canvas_id, { type: 'chart', title: 'a' })
    const cardId = canvas.cards[0].id
    const before = canvas.cards[0].layout

    const same = await request(handler, 'PATCH', `${PREFIX}/canvases/${created.canvas_id}/layout`, {
      layout: { [cardId]: { x: before.x, y: before.y } },
      expected_revision: canvas.revision,
    })
    assert.equal(same.json().moved, 0, 'a no-op commit should report zero moves')
  })
})
async function seedCard (handler, store, extra = {}) {
  const created = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
  const canvas = addTestCard(store, created.canvas_id, {
    type: 'chart', title: '原卡片', chart_type: 'bar',
    dataset: 'a.csv', query: 'SELECT 1', ...extra,
  })
  return { canvasId: created.canvas_id, card: canvas.cards[0], revision: canvas.revision }
}

test('POST /cards enforces provenance without partial writes', async () => {
  await withApi(async ({ handler, store }) => {
    const created = (await request(handler, 'POST', PREFIX + '/canvases', { name: 'typed source' })).json()
    const before = store.getCanvas(created.canvas_id)
    const path = PREFIX + '/canvases/' + created.canvas_id + '/cards'

    const missing = await request(handler, 'POST', path, { type: 'chart', title: 'missing source' })
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().code, 'SOURCE_REQUIRED')

    const malformed = await request(handler, 'POST', path, {
      type: 'chart', title: 'bad source', dataset: { path: 'sales.csv' }, query: 'SELECT 1',
    })
    assert.equal(malformed.statusCode, 400)
    assert.equal(malformed.json().code, 'INVALID_SOURCE')
    const afterRejected = store.getCanvas(created.canvas_id)
    assert.equal(afterRejected.cards.length, 0)
    assert.equal(afterRejected.revision, before.revision)

    const manual = await request(handler, 'POST', path, {
      type: 'chart', title: 'manual note', note: MANUAL_SOURCE_MARKER,
    })
    assert.equal(manual.statusCode, 201)
    assert.equal(manual.json().card.note, MANUAL_SOURCE_MARKER)

    const manualSource = await request(handler, 'POST', path, {
      type: 'table', title: 'manual source note', source_note: MANUAL_SOURCE_MARKER,
    })
    assert.equal(manualSource.statusCode, 201)
    assert.equal(manualSource.json().card.source.note, MANUAL_SOURCE_MARKER)

    const sourced = await request(handler, 'POST', path, {
      type: 'kpi', title: 'real source', dataset: 'sales.csv', query: 'monthly total',
    })
    assert.equal(sourced.statusCode, 201)
    assert.deepEqual(sourced.json().card.source, { dataset: 'sales.csv', query: 'monthly total', note: null })
  })
})

test('PATCH a card renames it and leaves other fields alone', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/cards/${card.id}`, {
      title: '新名字', expected_revision: revision,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().card.title, '新名字')
    assert.equal(res.json().card.chart_type, 'bar', 'chart_type must survive a rename')

    const stored = store.getCanvas(canvasId).cards[0]
    assert.equal(stored.title, '新名字')
    assert.equal(stored.source.query, 'SELECT 1', 'provenance must survive')
  })
})

test('PATCH a card updates source fields without clearing omitted provenance', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    const path = PREFIX + '/canvases/' + canvasId + '/cards/' + card.id
    const res = await request(handler, 'PATCH', path, {
      source: { query: 'SELECT region, SUM(amount) FROM a GROUP BY region', note: '退款已扣除' },
      expected_revision: revision,
    })
    assert.equal(res.statusCode, 200)
    const sourceAfterUpdate = res.json().card.source
    const revisionAfterUpdate = res.json().revision
    assert.deepEqual(sourceAfterUpdate, { dataset: 'a.csv', query: 'SELECT region, SUM(amount) FROM a GROUP BY region', note: '退款已扣除' })

    const empty = await request(handler, 'PATCH', path, { source: { query: '' }, expected_revision: revisionAfterUpdate })
    assert.equal(empty.statusCode, 400)
    assert.equal(empty.json().code, 'SOURCE_REQUIRED')
    const nullQuery = await request(handler, 'PATCH', path, { source: { query: null }, expected_revision: revisionAfterUpdate })
    assert.equal(nullQuery.statusCode, 400)
    assert.equal(nullQuery.json().code, 'SOURCE_REQUIRED')
    const malformed = await request(handler, 'PATCH', path, { source: { dataset: { path: 'x' } }, expected_revision: revisionAfterUpdate })
    assert.equal(malformed.statusCode, 400)
    assert.equal(malformed.json().code, 'INVALID_SOURCE')
    const unknown = await request(handler, 'PATCH', path, { source: { unexpected: 'x' }, expected_revision: revisionAfterUpdate })
    assert.equal(unknown.statusCode, 400)
    assert.equal(unknown.json().code, 'INVALID_SOURCE')
    const stale = await request(handler, 'PATCH', path, { source: { query: 'stale' }, expected_revision: revision })
    assert.equal(stale.statusCode, 409)
    assert.equal(stale.json().code, 'REVISION_CONFLICT')
    const unchanged = store.getCanvas(canvasId)
    assert.equal(unchanged.revision, revisionAfterUpdate)
    assert.deepEqual(unchanged.cards[0].source, sourceAfterUpdate, 'rejected patches must leave source and revision unchanged')

    const renamed = await request(handler, 'PATCH', path, {
      title: '改标题', expected_revision: revisionAfterUpdate,
    })
    assert.equal(renamed.statusCode, 200)
    assert.deepEqual(renamed.json().card.source, sourceAfterUpdate)
  })
})

test('PATCH a card with no updatable field is a 400', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card } = await seedCard(handler, store)
    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/cards/${card.id}`, {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'INVALID_CARD')
  })
})

test('DELETE a card removes exactly that card', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    addTestCard(store, canvasId, { type: 'text', title: '留着的', text_content: 'x' })
    const current = store.getCanvas(canvasId)

    const res = await request(handler, 'DELETE',
      `${PREFIX}/canvases/${canvasId}/cards/${card.id}?expected_revision=${current.revision}`)
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().card_count, 1)

    const remaining = store.getCanvas(canvasId).cards
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].title, '留着的')
    assert.ok(revision > 0)
  })
})

test('DELETE a card without a revision still works (explicit last-write-wins)', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card } = await seedCard(handler, store)
    const res = await request(handler, 'DELETE', `${PREFIX}/canvases/${canvasId}/cards/${card.id}`)
    assert.equal(res.statusCode, 200)
    assert.equal(store.getCanvas(canvasId).cards.length, 0)
  })
})

test('duplicating a card copies its data and provenance beside the original', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    const res = await request(handler, 'POST', `${PREFIX}/canvases/${canvasId}/cards/${card.id}/duplicate`, {
      expected_revision: revision,
    })
    assert.equal(res.statusCode, 201)
    const copy = res.json().card

    assert.notEqual(copy.id, card.id, 'the copy needs its own id')
    assert.equal(copy.title, '原卡片 副本')
    assert.equal(copy.chart_type, 'bar')
    assert.equal(copy.source.dataset, 'a.csv')
    assert.equal(copy.source.query, 'SELECT 1')

    const cards = store.getCanvas(canvasId).cards
    assert.equal(cards.length, 2)
    // The copy is anchored beside the original, not stacked on top of it.
    assert.equal(cards[1].layout.x, cards[0].layout.x + cards[0].layout.w)
    assert.equal(cards[1].layout.y, cards[0].layout.y)
  })
})

test('PATCH a card can hide and show its header', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    assert.equal(card.show_header, true, 'a new card shows its header by default')

    const hidden = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/cards/${card.id}`, {
      show_header: false, expected_revision: revision,
    })
    assert.equal(hidden.statusCode, 200)
    assert.equal(hidden.json().card.show_header, false)
    assert.equal(store.getCanvas(canvasId).cards[0].show_header, false, 'must persist, not just echo')

    const shown = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/cards/${card.id}`, {
      show_header: true, expected_revision: hidden.json().revision,
    })
    assert.equal(shown.json().card.show_header, true)
  })
})

test('hiding the header keeps the title and content intact', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/cards/${card.id}`, {
      show_header: false, expected_revision: revision,
    })
    const stored = store.getCanvas(canvasId).cards[0]
    assert.equal(stored.show_header, false)
    assert.equal(stored.title, '原卡片', 'the title must survive a hidden header')
    assert.equal(stored.source.query, 'SELECT 1', 'provenance must survive')
  })
})

// ── moving cards between canvases ───────────────────────────────────────────

test('POST move-to relocates a card to another canvas', async () => {
  await withApi(async ({ handler, store }) => {
    const src = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: '源' })).json()
    const dst = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: '目标' })).json()
    const canvas = addTestCard(store, src.canvas_id, { type: 'chart', title: '搬走我', query: 'SELECT 1' })
    const cardId = canvas.cards[0].id

    const res = await request(handler, 'POST', `${PREFIX}/canvases/${src.canvas_id}/cards/${cardId}/move-to`, {
      target_canvas_id: dst.canvas_id,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().to, dst.canvas_id)

    assert.equal(store.getCanvas(src.canvas_id).cards.length, 0, 'source should be emptied')
    const moved = store.getCanvas(dst.canvas_id).cards
    assert.equal(moved.length, 1)
    assert.equal(moved[0].title, '搬走我')
    assert.equal(moved[0].source.query, 'SELECT 1', 'provenance travels with the card')
  })
})

test('POST copy-to leaves the original in place', async () => {
  await withApi(async ({ handler, store }) => {
    const src = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: '源' })).json()
    const dst = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: '目标' })).json()
    const canvas = addTestCard(store, src.canvas_id, { type: 'kpi', title: '复制我' })
    const cardId = canvas.cards[0].id

    const res = await request(handler, 'POST', `${PREFIX}/canvases/${src.canvas_id}/cards/${cardId}/copy-to`, {
      target_canvas_id: dst.canvas_id,
    })
    assert.equal(res.statusCode, 201)
    assert.equal(store.getCanvas(src.canvas_id).cards.length, 1, 'source keeps its card')
    assert.equal(store.getCanvas(dst.canvas_id).cards.length, 1, 'target gains a copy')
  })
})

test('moving a card to its own canvas is refused', async () => {
  await withApi(async ({ handler, store }) => {
    const c = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    const canvas = addTestCard(store, c.canvas_id, { type: 'text', title: 'x' })
    const res = await request(handler, 'POST', `${PREFIX}/canvases/${c.canvas_id}/cards/${canvas.cards[0].id}/move-to`, {
      target_canvas_id: c.canvas_id,
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'INVALID_TARGET')
  })
})

test('move-to without a target is a 400', async () => {
  await withApi(async ({ handler, store }) => {
    const c = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: 'c' })).json()
    const canvas = addTestCard(store, c.canvas_id, { type: 'text', title: 'x' })
    const res = await request(handler, 'POST', `${PREFIX}/canvases/${c.canvas_id}/cards/${canvas.cards[0].id}/move-to`, {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'INVALID_TARGET')
  })
})

test('POST merge pulls a whole canvas into another', async () => {
  await withApi(async ({ handler, store }) => {
    const src = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: '源' })).json()
    const dst = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: '目标' })).json()
    addTestCard(store, dst.canvas_id, { type: 'chart', title: '已在', layout: { x: 0, y: 0, w: 48, h: 15 } })
    let s = addTestCard(store, src.canvas_id, { type: 'chart', title: 'a', layout: { x: 0, y: 0, w: 48, h: 15 } })
    s = addTestCard(store, src.canvas_id, { type: 'kpi', title: 'b', layout: { x: 48, y: 0, w: 48, h: 15 } }, s.revision)

    const res = await request(handler, 'POST', `${PREFIX}/canvases/${dst.canvas_id}/merge`, {
      source_canvas_id: src.canvas_id,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().moved, 2)
    assert.equal(res.json().kept_source, true)

    const cards = store.getCanvas(dst.canvas_id).cards
    assert.equal(cards.length, 3)
    for (const card of cards.slice(1)) {
      assert.ok(card.layout.y >= 15, 'merged cards must sit below existing content')
    }
    assert.equal(store.getCanvas(src.canvas_id).cards.length, 2, 'source kept by default')
  })
})

test('merge can consume the source canvas', async () => {
  await withApi(async ({ handler, store }) => {
    const src = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: '源' })).json()
    const dst = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: '目标' })).json()
    addTestCard(store, src.canvas_id, { type: 'text', title: 'a' })

    const res = await request(handler, 'POST', `${PREFIX}/canvases/${dst.canvas_id}/merge`, {
      source_canvas_id: src.canvas_id, keep_source: false,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().kept_source, false)
    assert.equal(store.listCanvases().length, 1, 'the consumed canvas should be gone')
  })
})

test('merge requires a source canvas', async () => {
  await withApi(async ({ handler }) => {
    const dst = (await request(handler, 'POST', `${PREFIX}/canvases`, { name: '目标' })).json()
    const res = await request(handler, 'POST', `${PREFIX}/canvases/${dst.canvas_id}/merge`, {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'INVALID_SOURCE')
  })
})

test('duplicating a legacy source-less data card marks its provenance for relinking', async () => {
  await withApi(async ({ handler, store }) => {
    const sourceCanvas = store.createCanvas({ name: 'legacy source' })
    const legacy = store.withCanvas(sourceCanvas.id, sourceCanvas.revision, canvas => {
      const card = makeCard({ type: 'chart', title: '旧式图表' }, canvas.cards)
      delete card.source
      canvas.cards.push(card)
      return canvas
    })
    const original = legacy.cards[0]
    const duplicate = await request(handler, 'POST', `${PREFIX}/canvases/${sourceCanvas.id}/cards/${original.id}/duplicate`, {
      expected_revision: legacy.revision,
    })
    assert.equal(duplicate.statusCode, 201)
    const copy = duplicate.json().card
    assert.notEqual(copy.id, original.id)
    assert.ok(copy.source.note.includes(SOURCE_RELINK_MARKER))
  })
})

test('duplicating a card preserves its header visibility', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    const hidden = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/cards/${card.id}`, {
      show_header: false, expected_revision: revision,
    })
    const dup = await request(handler, 'POST', `${PREFIX}/canvases/${canvasId}/cards/${card.id}/duplicate`, {
      expected_revision: hidden.json().revision,
    })
    assert.equal(dup.json().card.show_header, false, 'the copy should look like the original')
  })
})

test('duplicating accepts a custom title', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    const res = await request(handler, 'POST', `${PREFIX}/canvases/${canvasId}/cards/${card.id}/duplicate`, {
      title: '对比口径', expected_revision: revision,
    })
    assert.equal(res.json().card.title, '对比口径')
  })
})

test('card operations report a missing card as 404', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId } = await seedCard(handler, store)
    const patch = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/cards/nosuch`, { title: 'x' })
    assert.equal(patch.statusCode, 404)
    assert.equal(patch.json().code, 'CARD_NOT_FOUND')

    const dup = await request(handler, 'POST', `${PREFIX}/canvases/${canvasId}/cards/nosuch/duplicate`, {})
    assert.equal(dup.statusCode, 404)
  })
})

test('card operations on a missing canvas report 404', async () => {
  await withApi(async ({ handler }) => {
    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/nope/cards/whatever`, { title: 'x' })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().code, 'CANVAS_NOT_FOUND')
  })
})

test('a stale revision on a card edit is refused and changes nothing', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    store.updateCard(canvasId, card.id, { title: '先改的' })   // bumps revision

    const res = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/cards/${card.id}`, {
      title: '后改的', expected_revision: revision,   // stale
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().code, 'REVISION_CONFLICT')
    assert.equal(store.getCanvas(canvasId).cards[0].title, '先改的', 'the losing write must not land')
  })
})

test('undo via HTTP restores the previous layout and reports the new revision', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card, revision } = await seedCard(handler, store)
    const moved = await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/layout`, {
      layout: { [card.id]: { x: 40, y: 8, w: 20, h: 8 } },
      expected_revision: revision,
    })
    assert.equal(moved.statusCode, 200)

    const res = await request(handler, 'POST', `${PREFIX}/canvases/${canvasId}/undo`, {})
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.restored, 1)
    const canvas = store.getCanvas(canvasId)
    assert.equal(canvas.cards[0].layout.x, 0, 'layout restored through the HTTP path')
    assert.ok(body.revision > moved.json().revision, 'undo bumps the revision like any write')
  })
})

test('redo via HTTP re-applies the undone change', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId, card } = await seedCard(handler, store)
    await request(handler, 'PATCH', `${PREFIX}/canvases/${canvasId}/cards/${card.id}`, { title: '改名' })
    await request(handler, 'POST', `${PREFIX}/canvases/${canvasId}/undo`, {})
    assert.equal(store.getCanvas(canvasId).cards[0].title, '原卡片')

    const res = await request(handler, 'POST', `${PREFIX}/canvases/${canvasId}/redo`, {})
    assert.equal(res.statusCode, 200)
    assert.equal(store.getCanvas(canvasId).cards[0].title, '改名')
  })
})

test('undo with nothing recorded reports a typed 400', async () => {
  await withApi(async ({ handler, store }) => {
    const { canvasId } = await seedCard(handler, store)
    // Drain the whole history: every recorded pre-change snapshot gets one
    // undo until the stack is empty, then the API must report a typed 400.
    for (let i = 0; i < 8; i++) {
      const r = await request(handler, 'POST', `${PREFIX}/canvases/${canvasId}/undo`, {})
      if (r.statusCode === 400) {
        assert.equal(r.json().code, 'NOTHING_TO_UNDO')
        return
      }
      assert.equal(r.statusCode, 200)
    }
    assert.fail('undo never reported NOTHING_TO_UNDO')
  })
})

test('portable backup import creates a new canvas and rejects unsupported schema without a partial write', async () => {
  await withApi(async ({ handler, store }) => {
    const backup = {
      format: 'dsh-xcharts-canvas-backup',
      format_version: 1,
      canvas: {
        schema_version: 1,
        name: 'Route backup',
        settings: { wide: true },
        cards: [{ type: 'text', title: 'far', layout: { x: 140, y: 0, w: 24, h: 8 }, source: { dataset: 'C:\\\\private\\\\source.csv' } }],
      },
    }
    const imported = await request(handler, 'POST', `${PREFIX}/canvases/import`, backup)
    assert.equal(imported.statusCode, 201)
    const canvas = store.getCanvas(imported.json().canvas_id)
    assert.equal(canvas.settings.wide, true)
    assert.equal(canvas.cards[0].layout.x, 140)
    assert.equal(canvas.cards[0].source.dataset, null)

    const invalid = structuredClone(backup)
    invalid.canvas.schema_version = 99
    const rejected = await request(handler, 'POST', `${PREFIX}/canvases/import`, invalid)
    assert.equal(rejected.statusCode, 400)
    assert.equal(store.listCanvases().length, 1)
  })
})

test('backup and template routes complete the local asset lifecycle', async () => {
  await withApi(async ({ handler, store }) => {
    const canvas = store.createExampleCanvas()
    const backup = await request(handler, 'GET', `${PREFIX}/canvases/${canvas.id}/backup`)
    assert.equal(backup.statusCode, 200)
    const imported = await request(handler, 'POST', `${PREFIX}/canvases/import`, backup.json())
    assert.equal(imported.statusCode, 201)
    const created = await request(handler, 'POST', `${PREFIX}/canvases/templates`, { canvas_id: canvas.id, name: 'Layout' })
    assert.equal(created.statusCode, 201)
    const id = created.json().template.id
    assert.equal((await request(handler, 'GET', `${PREFIX}/canvases/templates`)).json().templates.length, 1)
    assert.equal((await request(handler, 'GET', `${PREFIX}/canvases/templates/preview/${id}`)).json().cards.length, 10)
    assert.equal((await request(handler, 'PATCH', `${PREFIX}/canvases/templates/rename/${id}`, { name: 'New name' })).json().name, 'New name')
    const clone = await request(handler, 'POST', `${PREFIX}/canvases/templates/clone/${id}`, { name: 'Copy' })
    assert.equal(clone.statusCode, 201)
    assert.equal((await request(handler, 'DELETE', `${PREFIX}/canvases/templates/delete/${id}`)).statusCode, 200)
    assert.equal((await request(handler, 'GET', `${PREFIX}/canvases/templates/preview/${id}`)).statusCode, 404)
    assert.equal(store.listCanvases().length, 3)
  })
})

test('oversized import has an explicit 413 response and creates no data', async () => {
  await withApi(async ({ handler, store }) => {
    const response = await request(handler, 'POST', `${PREFIX}/canvases/import`, { padding: 'x'.repeat(8 * 1024 * 1024) })
    assert.equal(response.statusCode, 413)
    assert.equal(response.json().code, 'BODY_TOO_LARGE')
    assert.equal(store.listCanvases().length, 0)
  })
})

test('usages record an ask and the datasource reports reverse usage', async () => {
  await withApi(async ({ handler, store, dir }) => {
    const data = new DataStore(dir)
    const source = await data.import({ name: '路由引用', filename: 'r.csv', content_base64: Buffer.from('k,v\na,1\nb,2\n').toString('base64') })
    const result = data.query(source.id, { metrics: [{ op: 'count', as: 'n' }] })
    const canvas = store.createCanvas({ name: '引用画布' })
    const added = data.addToCanvas(store, { result_id: result.id, canvas_id: canvas.id, type: 'table', title: '计数' })

    const created = await request(handler, 'POST', `${PREFIX}/usages`, { reference: `[xcharts:ds:${source.id}@${source.content_hash}]`, session_id: 'session-route' })
    assert.equal(created.statusCode, 201)
    assert.equal(created.json().ref.id, source.id)

    const usage = await request(handler, 'GET', `${PREFIX}/datasources/${source.id}/usage`)
    assert.equal(usage.statusCode, 200)
    assert.equal(usage.json().counts.cards, 1)
    assert.equal(usage.json().cards[0].card_id, added.card_id)
    assert.deepEqual(usage.json().sessions.map(session => session.session_id), ['session-route'])

    const rejected = await request(handler, 'POST', `${PREFIX}/usages`, { reference: '不是引用' })
    assert.equal(rejected.statusCode, 400)
    assert.equal(rejected.json().code, 'INVALID_REFERENCE')
  })
})

test('the changelog route serves the bundled release notes as plain lines', async () => {
  await withApi(async ({ handler }) => {
    const response = await request(handler, 'GET', `${PREFIX}/changelog?limit=2`)
    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.current_version, PACKAGE_VERSION)
    assert.equal(payload.entries.length, 2)
    assert.equal(payload.entries[0].version, PACKAGE_VERSION, 'the newest entry matches the installed version')
    const lines = payload.entries.flatMap(entry => entry.lines)
    assert.ok(lines.length > 0, 'release notes have content')
    assert.ok(lines.every(line => !/^\s*-\s/.test(line) && !line.includes('**') && !line.includes('`')), 'markdown is reduced to plain lines')
    const capped = await request(handler, 'GET', `${PREFIX}/changelog?limit=99`)
    assert.ok(capped.json().entries.length <= 5, 'the history stays bounded')
  })
})

test('the storage route reports the host root and cleans only the allowed directories', async () => {
  await withApi(async ({ handler, dir }) => {
    mkdirSync(join(dir, 'history'), { recursive: true })
    writeFileSync(join(dir, 'history', 'canvas-a.json'), '{"undo":[],"redo":[]}')
    mkdirSync(join(dir, 'executions'), { recursive: true })
    writeFileSync(join(dir, 'executions', 'call-1.json'), '{"output":"x"}')

    const usage = await request(handler, 'GET', `${PREFIX}/storage`)
    assert.equal(usage.statusCode, 200)
    const payload = usage.json()
    assert.equal(payload.storage_path, resolve(dir), 'the path is the host storage root, not a baked-in constant')
    assert.ok(payload.total_bytes > 0)
    assert.deepEqual(payload.cleanable.map(item => item.target), ['history', 'executions', 'usages', 'inputs'])
    const history = payload.directories.find(item => item.name === 'history')
    assert.equal(history.files, 1)
    assert.equal(history.cleanable, true)

    const cleaned = await request(handler, 'POST', `${PREFIX}/storage/cleanup`, { target: 'history' })
    assert.equal(cleaned.statusCode, 200)
    assert.equal(cleaned.json().deleted_files, 1)
    assert.ok(cleaned.json().freed_bytes > 0)
    assert.equal(existsSync(join(dir, 'history')), false, 'the directory is gone')
    assert.equal(existsSync(join(dir, 'executions', 'call-1.json')), true, 'other directories are untouched')
    assert.equal(cleaned.json().storage.directories.find(item => item.name === 'executions').files, 1)

    const refused = await request(handler, 'POST', `${PREFIX}/storage/cleanup`, { target: 'datasources' })
    assert.equal(refused.statusCode, 400)
    const traversal = await request(handler, 'POST', `${PREFIX}/storage/cleanup`, { target: '../datasources' })
    assert.equal(traversal.statusCode, 400)
  })
})

test('a workspace backup exports every canvas and template and imports them as new copies', async () => {
  await withApi(async ({ handler, store }) => {
    const canvas = store.createCanvas({ name: '备份画布', cards: [{ type: 'text', title: '结论', text_content: '一段话', layout: { x: 0, y: 0, w: 24, h: 8 } }] })
    store.createTemplate(canvas.id, '布局模板')

    const exported = await request(handler, 'GET', `${PREFIX}/backup`)
    assert.equal(exported.statusCode, 200)
    const bundle = exported.json()
    assert.equal(bundle.format, 'dsh-xcharts-workspace-backup')
    assert.equal(bundle.format_version, 1)
    assert.equal(bundle.canvas_count, 1)
    assert.equal(bundle.template_count, 1)
    assert.equal(bundle.canvases[0].format, 'dsh-xcharts-canvas-backup')

    const imported = await request(handler, 'POST', `${PREFIX}/backup/import`, bundle)
    assert.equal(imported.statusCode, 201)
    assert.equal(imported.json().imported.length, 1)
    assert.equal(imported.json().imported_templates.length, 1)
    assert.equal(imported.json().failed.length, 0, 'a self-exported bundle imports without failures')
    assert.equal(store.listCanvases().length, 2, 'import creates a copy instead of replacing')
    assert.equal(store.listTemplates().length, 2)

    const refused = await request(handler, 'POST', `${PREFIX}/backup/import`, { format: 'dsh-xcharts-canvas-backup', format_version: 1 })
    assert.equal(refused.statusCode, 400)
    assert.equal(refused.json().code, 'INVALID_BACKUP')
    const empty = await request(handler, 'POST', `${PREFIX}/backup/import`, { format: 'dsh-xcharts-workspace-backup', format_version: 1, canvases: [], templates: [] })
    assert.equal(empty.statusCode, 400)
  })
})
