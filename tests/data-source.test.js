import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

import { DataStore } from '../lib/data-store.js'
import { CanvasStore } from '../lib/store.js'
import { createApiHandler } from '../lib/routes.js'
import vm from 'node:vm'
import { queryTable } from '../lib/data-query.js'
import { dataToolDefinitions } from '../lib/data-tools.js'
import ExcelJS from 'exceljs'

const PREFIX = '/api/xcharts-canvas'
const csv = Buffer.from('month,amount\nJan,10\nFeb,20\nMar,30\n').toString('base64')
const DATA_SOURCE_QUERY = readFileSync(new URL('../client-src/08-datasource-query.js', import.meta.url), 'utf8')
const DATA_SOURCE_CLIENT = readFileSync(new URL('../client-src/09-data-sources.js', import.meta.url), 'utf8')

const uiHelpers = vm.runInNewContext(DATA_SOURCE_QUERY + '\n; ({ buildDatasourceQuery, datasourceColumnWidths, datasourceQuerySummary })')
const buildQuery = uiHelpers.buildDatasourceQuery

test('datasource column sizing handles numbers, Unicode and bounded long text without changing values', () => {
  const columns = [{ name: 'price', type: 'number' }, { name: '品牌名称', type: 'string' }, { name: '说明', type: 'string' }]
  const rows = [[120.5, '汽车品牌', '原始内容'.repeat(100)], [null, '?', '保留?']]
  const original = JSON.stringify(rows)
  const widths = uiHelpers.datasourceColumnWidths(columns, rows)
  assert.ok(widths[0] >= 80 && widths[0] <= 152)
  assert.ok(widths[1] >= 96 && widths[1] < widths[2])
  assert.equal(widths[2], 224)
  assert.equal(JSON.stringify(rows), original)
  assert.equal(rows[1][1], '?')
  assert.equal(uiHelpers.datasourceColumnWidths([{ name: '数值字段'.repeat(80), type: 'number' }], [])[0], 152)
  assert.equal(uiHelpers.datasourceColumnWidths(['x'], [])[0], 96)
})

test('datasource query summary describes active aggregation, filters, order and limit', () => {
  const config = { select: ['make', 'price'], groups: ['make'], metrics: [{ op: 'avg', column: 'price' }], filters: [{ column: 'price', op: 'not_null' }, { column: 'price', op: 'gt', value: '20' }], order: [{ column: 'avg_price', direction: 'desc' }], limit: 500 }
  const summary = uiHelpers.datasourceQuerySummary(config)
  assert.match(summary, /按 make 分组/)
  assert.match(summary, /avg\(price\)/)
  assert.match(summary, /price非空/)
  assert.match(summary, /price大于20/)
  assert.match(summary, /avg_price降序/)
  assert.match(summary, /最多 500 行/)
  assert.match(uiHelpers.datasourceQuerySummary({ ...config, metrics: [], filters: [], order: [] }), /选择 2 个字段/)
})

test('query builder uses typed filters, aggregation and ordering with the shared query engine', () => {
  const data = { columns: [{ name: 'region', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'active', type: 'boolean' }], rows: [['A', 10, true], ['A', 20, true], ['B', 99, false], ['C', 5, true]] }
  const config = { select: [], groups: ['region'], filters: [{ column: 'amount', op: 'gte', value: '10' }, { column: 'active', op: 'eq', value: 'true' }], metrics: [{ op: 'sum', column: 'amount', as: 'total' }, { op: 'count', column: '', as: 'count' }], order: [{ column: 'total', direction: 'desc' }], limit: 5000 }
  const query = JSON.parse(JSON.stringify(buildQuery(data.columns, config)))
  assert.equal(query.select, undefined)
  assert.equal(query.filters[0].value, 10)
  assert.equal(query.filters[1].value, true)
  assert.deepEqual(queryTable(data, query).rows, [['A', 30, 2]])
  const raw = buildQuery(data.columns, { ...config, select: ['region', 'amount'], filters: [{ column: 'amount', op: 'not_null', value: '' }], groups: [], metrics: [], order: [{ column: 'amount', direction: 'desc' }], limit: '1' })
  const truncated = queryTable(data, raw)
  assert.deepEqual(truncated.rows, [['B', 99]])
  assert.equal(truncated.coverage, 'partial')
  assert.equal(truncated.total_rows, 4)
  assert.throws(() => buildQuery(data.columns, { ...config, limit: 5001 }), /1～5000/)
  assert.throws(() => buildQuery(data.columns, { ...config, filters: [{ column: 'amount', op: 'eq', value: '' }] }), /数值/)
  assert.throws(() => buildQuery(data.columns, { ...config, filters: [{ column: 'active', op: 'eq', value: 'yes' }] }), /true/)
  assert.throws(() => buildQuery(data.columns, { ...config, metrics: [] }), /至少添加/)
})

test('query builder spec matches tools and HTTP and preserves source on chart creation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcbuilder-'))
  try {
    const data = new DataStore(dir)
    const source = await data.import({ name: '销售', filename: 'sales.csv', content_base64: csv })
    const query = JSON.parse(JSON.stringify(buildQuery(source.columns, { select: [], groups: ['month'], filters: [{ column: 'amount', op: 'gte', value: '20' }], metrics: [{ op: 'sum', column: 'amount', as: 'total' }], order: [{ column: 'total', direction: 'desc' }], limit: 500 })))
    const handler = createApiHandler(() => new CanvasStore(dir), PREFIX)
    const http = (await request(handler, 'POST', `${PREFIX}/datasources/${source.id}/query`, { query })).json().result
    const tool = JSON.parse(await dataToolDefinitions(() => dir).find(d => d.name === 'datasource_query').execute({ datasource_id: source.id, query })).result
    assert.deepEqual(http.rows, [['Mar', 30], ['Feb', 20]])
    assert.deepEqual(http.rows, tool.rows)
    assert.deepEqual(http.query, query)
    assert.equal(http.coverage, 'complete')
    const store = new CanvasStore(dir)
    const canvas = store.createCanvas({ name: '构建器结果' })
    data.addToCanvas(store, { result_id: http.id, canvas_id: canvas.id, title: '销售统计', type: 'chart', x: 'month', y: 'total' })
    const card = store.getCanvas(canvas.id).cards[0]
    assert.equal(card.source.dataset, source.id)
    assert.deepEqual(JSON.parse(card.source.query).query, query)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function request (handler, method, url, body) {
  return new Promise(async resolve => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:3080' }
    const res = { chunks: [], writeHead (status, headers) { this.statusCode = status; this.headers = headers }, end (chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); resolve(this) } }
    res.json = () => JSON.parse(Buffer.concat(res.chunks).toString('utf8'))
    await handler(req, res)
  })
}

test('data-source management controls are keyboard accessible and recoverable', () => {
  assert.ok(DATA_SOURCE_CLIENT.includes("'data-xc-rename-datasource': menuItem.id"))
  assert.ok(DATA_SOURCE_CLIENT.includes("'data-xc-delete-datasource': menuItem.id"))
  assert.ok(DATA_SOURCE_CLIENT.includes("'aria-haspopup': 'menu'"))
  assert.ok(DATA_SOURCE_CLIENT.includes("ariaLabel: '新名称：' + item.name"))
  assert.ok(DATA_SOURCE_CLIENT.includes("event.key === 'Enter'"))
  assert.ok(DATA_SOURCE_CLIENT.includes("event.key === 'Escape'"))
  // Deleting a source asks through the themed confirm, never the browser's.
  assert.ok(!DATA_SOURCE_CLIENT.includes('window.confirm('))
  assert.ok(DATA_SOURCE_CLIENT.includes("title: '删除数据源'"), 'the confirm names the action')
  assert.ok(DATA_SOURCE_CLIENT.includes('setConfirmState({'))
  assert.ok(DATA_SOURCE_CLIENT.includes('已有查询结果和画布卡片会保留'))
  assert.ok(DATA_SOURCE_CLIENT.includes("api('/datasources/' + item.id + '/rename'"))
  assert.ok(DATA_SOURCE_CLIENT.includes("api('/datasources/' + item.id, { method: 'DELETE' })"))
  assert.ok(DATA_SOURCE_CLIENT.includes('setItems(current => current.map(source => source.id === item.id ? { ...source, ...renamed } : source))'))
  assert.ok(DATA_SOURCE_CLIENT.includes('setItems(current => current.filter(source => source.id !== item.id))'))
  assert.ok(DATA_SOURCE_CLIENT.includes('detail.deleted'))
  assert.ok(DATA_SOURCE_CLIENT.includes('重命名数据源失败：'))
  assert.ok(DATA_SOURCE_CLIENT.includes('删除数据源失败：'))
})

test('DataStore auto-detects common non-UTF-8 CSV encodings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcencoding-'))
  try {
    const store = new DataStore(dir)
    const gb18030 = Buffer.concat([Buffer.from('name\n'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\n')])
    const imported = await store.import({ name: '中文', filename: 'gbk.csv', content_base64: gb18030.toString('base64') })
    assert.deepEqual(store.describe(imported.id).rows, [['中文']])

    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('name\nhello\n', 'utf16le')])
    const utf16Imported = await store.import({ name: 'UTF16', filename: 'utf16.csv', content_base64: utf16.toString('base64') })
    assert.deepEqual(store.describe(utf16Imported.id).rows, [['hello']])

    const windows1252 = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a])
    const latinImported = await store.import({ name: '西文', filename: 'latin.csv', content_base64: windows1252.toString('base64') })
    assert.deepEqual(store.describe(latinImported.id).rows, [['Café']])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DataStore imports CSV, queries a snapshot, and preserves provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcdata-'))
  try {
    const store = new DataStore(dir)
    const source = await store.import({ name: '销售额', filename: 'sales.csv', content_base64: csv, source: { type: 'attachment', attachment_id: 'att-001' }, conversation: { conversation_id: 'conv-001', message_id: 'msg-001' } })
    assert.equal(source.row_count, 3)
    assert.equal(source.source.attachment_id, 'att-001')
    assert.equal(source.conversation.message_id, 'msg-001')
    const result = store.query(source.id, { select: ['month', 'amount'], order_by: [{ column: 'amount', direction: 'desc' }], conversation: { conversation_id: 'conv-001', message_id: 'msg-002' } })
    assert.equal(result.source_id, source.id)
    assert.equal(result.source_hash, source.content_hash)
    assert.equal(result.conversation.message_id, 'msg-002')
    assert.equal(result.rows[0][0], 'Mar')
    assert.equal(result.coverage, 'complete')
    const page = store.readResult(result.id, 1, 1)
    assert.deepEqual(page.rows, [['Feb', 20]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('datasource API imports, queries, reads results, and lists metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcroutes-data-'))
  try {
    const handler = createApiHandler(() => new CanvasStore(dir), PREFIX)
    let res = await request(handler, 'POST', `${PREFIX}/datasources`, { name: '销售额', filename: 'sales.csv', content_base64: csv, source: { type: 'upload', receipt_id: 'receipt-001' } })
    assert.equal(res.statusCode, 201)
    const source = res.json().datasource
    assert.equal(source.source.receipt_id, 'receipt-001')
    res = await request(handler, 'GET', `${PREFIX}/datasources/${source.id}?offset=1&limit=1`)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().datasource.rows, [['Feb', 20]])
    assert.equal(res.json().datasource.offset, 1)
    res = await request(handler, 'POST', `${PREFIX}/datasources/${source.id}/query`, { query: { select: ['month', 'amount'] }, conversation: { conversation_id: 'conv-api', message_id: 'msg-api' } })
    assert.equal(res.statusCode, 200)
    const result = res.json().result
    assert.equal(result.conversation.message_id, 'msg-api')
    const canvas = new CanvasStore(dir).createCanvas({ name: '页面落卡' })
    res = await request(handler, 'POST', `${PREFIX}/results/${result.id}/canvas`, { canvas_id: canvas.id, type: 'table', title: '查询结果' })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().card.canvas_id, canvas.id)
    const httpCard = new CanvasStore(dir).getCanvas(canvas.id).cards.at(-1)
    assert.equal(httpCard.source.dataset, result.source_id)
    assert.ok(httpCard.source.query.includes(result.id))
    assert.match(httpCard.source.note, /完整查询结果/)
    res = await request(handler, 'GET', `${PREFIX}/results/${result.id}?offset=1&limit=1`)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().result.rows, [['Feb', 20]])
    const sourcePath = PREFIX + '/datasources/' + source.id
    const resultPath = PREFIX + '/results/' + result.id
    const canvasPath = PREFIX + '/canvases/' + canvas.id
    res = await request(handler, 'GET', PREFIX + '/datasources')
    assert.deepEqual(res.json().datasources.map(item => item.id), [source.id])
    assert.equal(res.json().datasources[0].results.length, 1, 'the source records the result it produced')

    const invalidRename = await request(handler, 'PATCH', sourcePath + '/rename', { name: '' })
    assert.equal(invalidRename.statusCode, 400)
    assert.equal((await request(handler, 'GET', sourcePath + '?offset=0&limit=1')).json().datasource.name, '销售额')

    const renamed = await request(handler, 'PATCH', sourcePath + '/rename', { name: '销售额修订' })
    assert.equal(renamed.statusCode, 200)
    assert.equal(renamed.json().datasource.name, '销售额修订')
    const refreshed = await request(handler, 'GET', sourcePath + '?offset=0&limit=1')
    assert.equal(refreshed.json().datasource.name, '销售额修订', 'name persists on a fresh read')
    assert.equal((await request(handler, 'GET', PREFIX + '/datasources')).json().datasources[0].name, '销售额修订')

    const snapshot = await request(handler, 'GET', resultPath)
    assert.equal(snapshot.statusCode, 200)
    assert.equal(snapshot.json().result.source_name, '销售额', 'query snapshot retains the source name at query time')

    const deleted = await request(handler, 'DELETE', sourcePath)
    assert.equal(deleted.statusCode, 200)
    assert.match(deleted.json().note, /结果与画布保留/)
    assert.deepEqual((await request(handler, 'GET', PREFIX + '/datasources')).json().datasources, [])
    const retainedResult = await request(handler, 'GET', resultPath)
    assert.equal(retainedResult.statusCode, 200)
    assert.deepEqual(retainedResult.json().result.rows, [['Jan', 10], ['Feb', 20], ['Mar', 30]])
    const retainedCanvas = await request(handler, 'GET', canvasPath)
    assert.equal(retainedCanvas.statusCode, 200)
    assert.equal(retainedCanvas.json().cards.length, 1)
    assert.equal(retainedCanvas.json().cards[0].source.dataset, source.id)
    const deletedAgain = await request(handler, 'DELETE', sourcePath)
    assert.equal(deletedAgain.statusCode, 404)
    assert.deepEqual((await request(handler, 'GET', PREFIX + '/datasources')).json().datasources, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a source lists its saved results and each result can be renamed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcresults-'))
  try {
    const handler = createApiHandler(() => new CanvasStore(dir), PREFIX)
    const imported = await request(handler, 'POST', `${PREFIX}/datasources`, { name: '历史', filename: 'sales.csv', content_base64: csv })
    const sourceId = imported.json().datasource.id
    const first = (await request(handler, 'POST', `${PREFIX}/datasources/${sourceId}/query`, { query: { select: ['month', 'amount'], limit: 500 } })).json().result
    const second = (await request(handler, 'POST', `${PREFIX}/datasources/${sourceId}/query`, { query: { select: ['month'], limit: 10 } })).json().result

    const listed = await request(handler, 'GET', `${PREFIX}/datasources/${sourceId}/results`)
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(listed.json().results.map(item => item.id), [second.id, first.id], 'newest first')
    assert.equal(listed.json().results[0].query.limit, 10)
    assert.equal(listed.json().results[0].title, undefined, 'an unnamed result stays unnamed')

    const renamed = await request(handler, 'PATCH', `${PREFIX}/results/${first.id}/rename`, { title: '按月汇总' })
    assert.equal(renamed.statusCode, 200)
    assert.equal(renamed.json().result.title, '按月汇总')
    const after = await request(handler, 'GET', `${PREFIX}/datasources/${sourceId}/results`)
    assert.equal(after.json().results.find(item => item.id === first.id).title, '按月汇总')
    assert.equal((await request(handler, 'PATCH', `${PREFIX}/results/${first.id}/rename`, { title: '' })).statusCode, 400)
    assert.equal((await request(handler, 'GET', `${PREFIX}/datasources/${first.id}/results`)).json().results.length, 0, 'an unknown source has no results')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('data tools expose structured query and result-to-canvas operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xctools-data-'))
  try {
    const defs = dataToolDefinitions(() => dir)
    assert.deepEqual(defs.map(def => def.name), ['datasource_list', 'datasource_import', 'datasource_describe', 'datasource_query', 'datasource_test_connection', 'analysis_read_result', 'canvas_add_result'])
    const imported = JSON.parse(await defs[1].execute({ name: '销售额', filename: 'sales.csv', content_base64: csv, source: { type: 'attachment', attachment_id: 'att-tool' } }))
    const sourceId = imported.datasource.id
    const queried = JSON.parse(await defs[3].execute({ datasource_id: sourceId, query: { select: ['month', 'amount'] }, conversation: { conversation_id: 'conv-tool', message_id: 'msg-tool' } }))
    assert.equal(queried.ok, true)
    assert.equal(queried.result.conversation.message_id, 'msg-tool')
    const canvas = new CanvasStore(dir).createCanvas({ name: '结果画布' })
    const added = JSON.parse(await defs[6].execute({ canvas_id: canvas.id, result_id: queried.result.id, type: 'chart', title: '销售额趋势', chart_type: 'line', x: 'month', y: 'amount' }))
    assert.equal(added.ok, true)
    assert.equal(added.result_id, queried.result.id)
    const saved = new CanvasStore(dir).getCanvas(canvas.id)
    const resultCard = saved.cards.at(-1)
    assert.equal(resultCard.source.dataset, queried.result.source_id)
    assert.match(resultCard.source.query, /msg-tool/)
    assert.match(resultCard.source.note, /完整查询结果/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CSV parsing repairs headers, sniffs separators and reads missing tokens as null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcparse-'))
  try {
    const store = new DataStore(dir)
    const csv = 'symboling,normalized-losses,make,,make\n3,?,alfa,,x\n1,158,audi,,y\n'
    const imported = await store.import({ name: 'auto', filename: 'auto.csv', content_base64: Buffer.from(csv).toString('base64') })
    const source = store.get(imported.id)
    assert.deepEqual(source.columns.map(column => [column.name, column.type, column.null_count]), [
      ['symboling', 'number', 0],
      ['normalized-losses', 'number', 1],
      ['make', 'string', 0],
      ['列4', 'string', 2],
      ['make_2', 'string', 0],
    ], 'the missing token turns the column numeric and duplicate/empty headers are repaired')
    assert.deepEqual(store.describe(imported.id).rows[0], [3, null, 'alfa', null, 'x'], '? becomes null, not a string')
    assert.ok(source.warnings.some(line => line.includes('normalized-losses') && line.includes('缺失')), 'the repair is explained')
    assert.ok(source.warnings.some(line => line.includes('表头已修正')), 'and so is the header change')

    // Semicolon exports import without any option, and thousands separators read as numbers.
    const semicolon = 'month;amount\nJan;"1,234"\nFeb;20\n'
    const second = await store.import({ name: 'semi', filename: 'semi.csv', content_base64: Buffer.from(semicolon).toString('base64') })
    assert.equal(store.get(second.id).columns[1].type, 'number')
    assert.deepEqual(store.describe(second.id).rows, [['Jan', 1234], ['Feb', 20]])
    assert.ok(store.get(second.id).warnings.some(line => line.includes('分隔')), 'the sniffed separator is reported')

    // An explicit opt-out keeps the token as text.
    const kept = await store.import({ name: 'keep', filename: 'keep.csv', content_base64: Buffer.from('v\n?\n1\n').toString('base64'), options: { missing_values: 'keep' } })
    assert.equal(store.get(kept.id).columns[0].type, 'string')
    assert.deepEqual(store.describe(kept.id).rows, [['?'], ['1']])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an xlsx formula without a cached result imports as null with a warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcformula-'))
  try {
    const store = new DataStore(dir)
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('Sheet1')
    sheet.addRow(['a', 'b'])
    sheet.addRow([1, { formula: 'A2+1' }])
    sheet.addRow([2, { formula: 'A3+1' }])
    const buffer = Buffer.from(await book.xlsx.writeBuffer())
    const imported = await store.import({ name: '公式', filename: 'formula.xlsx', content_base64: buffer.toString('base64') })
    assert.deepEqual(store.describe(imported.id).rows, [[1, null], [2, null]], 'uncached formulas no longer block the import')
    assert.ok(store.get(imported.id).warnings.some(line => line.includes('公式无缓存结果')), 'and the user is told why the cells are empty')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('date columns are recognized and group by day, month, quarter or year', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcdate-'))
  try {
    const store = new DataStore(dir)
    const csv = '下单日期,渠道,金额\n2024-01-02,线上,10\n2024/1/2,线下,20\n2024年1月2日,线上,5\n2024-02-01 08:30,线上,7\n'
    const imported = await store.import({ name: '日期', filename: 'dates.csv', content_base64: Buffer.from(csv).toString('base64') })
    const source = store.get(imported.id)
    assert.deepEqual(source.columns.map(column => [column.name, column.type]), [
      ['下单日期', 'date'], ['渠道', 'string'], ['金额', 'number'],
    ])
    assert.deepEqual(store.describe(imported.id).rows, [
      ['2024-01-02', '线上', 10], ['2024-01-02', '线下', 20], ['2024-01-02', '线上', 5], ['2024-02-01T08:30:00', '线上', 7],
    ], '2024/1/2 and 2024年1月2日 share one ISO day')

    const byMonth = queryTable(source, { group_by: [{ column: '下单日期', granularity: 'month' }], metrics: [{ op: 'sum', column: '金额', as: '金额' }] })
    assert.deepEqual(byMonth.columns.map(column => [column.name, column.type]), [['下单日期(月)', 'string'], ['金额', 'number']])
    assert.deepEqual(byMonth.rows, [['2024-01', 35], ['2024-02', 7]])

    const byDay = queryTable(source, { group_by: [{ column: '下单日期', granularity: 'day' }], metrics: [{ op: 'count', as: '笔数' }] })
    assert.deepEqual(byDay.rows, [['2024-01-02', 3], ['2024-02-01', 1]])
    assert.equal(byDay.columns[0].type, 'date')

    const quarter = queryTable(source, { group_by: [{ column: '下单日期', granularity: 'quarter' }], metrics: [{ op: 'count', as: '笔数' }] })
    assert.deepEqual(quarter.rows, [['2024-Q1', 4]])

    const span = queryTable(source, { metrics: [{ op: 'min', column: '下单日期', as: '首日' }, { op: 'max', column: '下单日期', as: '末日' }] })
    assert.deepEqual(span.rows, [['2024-01-02', '2024-02-01T08:30:00']])
    assert.deepEqual(span.columns.map(column => column.type), ['date', 'date'])

    const filtered = queryTable(source, { select: ['渠道'], filters: [{ column: '下单日期', op: 'gte', value: '2024/2/1' }] })
    assert.deepEqual(filtered.rows, [['线上']])
    assert.throws(() => queryTable(source, { filters: [{ column: '下单日期', op: 'gte', value: 'abc' }] }), /需要日期/)
    assert.throws(() => queryTable(source, { group_by: [{ column: '渠道', granularity: 'month' }], metrics: [{ op: 'count' }] }), /不是日期/)

    // The builder emits the granularity the pane offers.
    const columns = source.columns
    const query = buildQuery(columns, { select: [], groups: ['下单日期'], groupGranularity: { 下单日期: 'month' }, filters: [], metrics: [{ op: 'sum', column: '金额', as: '金额' }], order: [], limit: 100 })
    assert.deepEqual(JSON.parse(JSON.stringify(query.group_by)), [{ column: '下单日期', granularity: 'month' }])
    assert.deepEqual(queryTable(source, query).rows, [['2024-01', 35], ['2024-02', 7]])
    const summary = uiHelpers.datasourceQuerySummary({ groups: ['下单日期'], groupGranularity: { 下单日期: 'month' }, metrics: [{ op: 'sum', column: '金额' }], filters: [], select: [], order: [], limit: 100 })
    assert.match(summary, /按 下单日期\(月\) 分组/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an xlsx number cell with a date format imports as a date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcxlsdate-'))
  try {
    const store = new DataStore(dir)
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('Sheet1')
    sheet.addRow(['日期', '值'])
    sheet.getCell('A2').value = 45292
    sheet.getCell('A2').numFmt = 'yyyy-mm-dd'
    sheet.getCell('B2').value = 5
    sheet.getCell('A3').value = new Date(Date.UTC(2024, 0, 3))
    sheet.getCell('B3').value = 6
    const buffer = Buffer.from(await book.xlsx.writeBuffer())
    const imported = await store.import({ name: '日期表', filename: 'dates.xlsx', content_base64: buffer.toString('base64') })
    assert.equal(store.get(imported.id).columns[0].type, 'date')
    assert.deepEqual(store.describe(imported.id).rows, [['2024-01-01', 5], ['2024-01-03', 6]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
