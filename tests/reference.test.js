import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync as removeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import { CanvasStore } from '../lib/store.js'
import { DataStore } from '../lib/data-store.js'
import { ReferenceService, parseReference, referenceMarker } from '../lib/reference-service.js'
import { referenceToolDefinitions } from '../lib/reference-tools.js'
import { withExecution } from '../lib/execution-context.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function fixture (fn) {
  const root = mkdtempSync(join(tmpdir(), 'xc-ref-'))
  try {
    const store = new CanvasStore(root)
    const data = new DataStore(root)
    const source = await data.import({ name: '销售', filename: 'sales.csv', content_base64: Buffer.from('region,amount\nA,10\nA,20\nB,7\nB,9\nC,4\n').toString('base64') })
    const result = data.query(source.id, { group_by: ['region'], metrics: [{ op: 'sum', column: 'amount', as: 'total' }] })
    await fn({ root, store, data, source, result, references: new ReferenceService(root, {}) })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('references parse from a message marker or a bare kind:id form', () => {
  assert.deepEqual(parseReference('看这个 @cardata（1,400 行）[xcharts:ds:abc@deadbeef]'), { kind: 'ds', id: 'abc', version: 'deadbeef' })
  assert.deepEqual(parseReference('[xcharts:res:0f52]'), { kind: 'res', id: '0f52' })
  assert.deepEqual(parseReference('card:canvas-1/card-1@v1-dead'), { kind: 'card', id: 'canvas-1/card-1', version: 'v1-dead' })
  assert.throws(() => parseReference('没有引用的普通文本'), { code: 'INVALID_REFERENCE' })
  assert.equal(referenceMarker('ds', 'abc', 'hash'), '[xcharts:ds:abc@hash]')
})

test('a datasource reference reads bounded identity, sample and stats', async () => {
  await fixture(async ({ references, source, result }) => {
    const summary = await references.read(`[xcharts:ds:${source.id}@${source.content_hash}]`)
    assert.equal(summary.status, 'linked')
    assert.equal(summary.identity.row_count, 5)
    assert.equal(summary.identity.column_count, 2)
    assert.equal(summary.sample, undefined, 'summary carries no rows')

    const sample = await references.read(`[xcharts:ds:${source.id}@${source.content_hash}]`, 'sample')
    assert.equal(sample.sample.length, 5)
    assert.equal(sample.sample_truncated, false)

    const stats = await references.read(`[xcharts:ds:${source.id}@${source.content_hash}]`, 'stats')
    const amount = stats.stats.columns.find(column => column.name === 'amount')
    assert.equal(amount.numbers, 5)
    assert.equal(amount.min, 4)
    assert.equal(amount.max, 20)

    // The reference itself is a pointer: a result reference reads its snapshot,
    // not the current source, and never returns every row.
    const resultView = await references.read(`[xcharts:res:${result.id}]`)
    assert.equal(resultView.result.total_rows, 3)
    assert.equal(resultView.result.coverage, 'complete')
    assert.equal(resultView.result.source.hash, source.content_hash)
    const rows = await references.read(`[xcharts:res:${result.id}]`, 'sample')
    assert.equal(rows.sample.length, 3)
  })
})

test('a pinned version stays readable after the source content changes', async () => {
  await fixture(async ({ root, data, references, source }) => {
    const path = join(root, 'datasources', `${source.id}.json`)
    const changed = JSON.parse(readFileSync(path, 'utf8'))
    changed.rows[0][1] = 999
    changed.content_hash = hash({ columns: changed.columns, rows: changed.rows })
    writeFileSync(path, JSON.stringify(changed))

    const pinned = await references.read(`[xcharts:ds:${source.id}@${source.content_hash}]`, 'sample')
    assert.equal(pinned.status, 'current_changed')
    assert.equal(pinned.sample[0][1], 10, 'the pinned version keeps the original value')
    const current = await references.read(`[xcharts:ds:${source.id}]`, 'sample')
    assert.equal(current.sample[0][1], 999)
  })
})

test('a pinned version whose historical input was never retained falls back to current content', async () => {
  await fixture(async ({ root, source, references }) => {
    const inputs = join(root, 'inputs')
    for (const name of existsSync(inputs) ? readdirSync(inputs) : []) removeSync(join(inputs, name))
    const view = await references.read(`[xcharts:ds:${source.id}@${source.content_hash}]`, 'sample')
    assert.equal(view.status, 'linked', 'the hash still matches the current content')
    assert.equal(view.reference.version_retained, false)
    assert.equal(view.identity.row_count, 5, 'rows are served from the current content')
    assert.match(view.identity.version_note, /未保留/)
  })
})
test('usage records are append-only, scoped to the calling session and reverse-queryable', async () => {
  await fixture(async ({ root, store, data, references, source, result }) => {
    const canvas = store.createCanvas({ name: '使用情况' })
    const added = data.addToCanvas(store, { result_id: result.id, canvas_id: canvas.id, type: 'table', title: '区域汇总' })
    await withExecution({ agent: { id: 'session-a' }, callId: 'call-1', name: 'xcharts_context' }, async () => {
      await references.read(`[xcharts:ds:${source.id}@${source.content_hash}]`)
    })
    await withExecution({ agent: { id: 'session-b' }, callId: 'call-2', name: 'datasource_query' }, async () => {
      data.query(source.id, { group_by: ['region'], metrics: [{ op: 'count', as: 'n' }] })
    })

    const usage = await references.usageForSource(source.id)
    assert.deepEqual(usage.counts.cards, 1)
    assert.equal(usage.cards[0].card_id, added.card_id)
    assert.equal(usage.cards[0].linked, 'bound')
    assert.deepEqual(usage.sessions.map(session => session.session_id).sort(), ['session-a', 'session-b'])
    assert.equal(usage.sessions.every(session => session.count >= 1), true)

    const file = join(root, 'usages', `${new Date().toISOString().slice(0, 7)}.jsonl`)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines.every(record => !record.rows && !record.data), true, 'usage never carries data rows')
    assert.ok(lines.some(record => record.action === 'context' && record.session_id === 'session-a'))
    assert.ok(lines.some(record => record.action === 'query' && record.result_id))
  })
})

test('the xcharts_context tool answers ok with a reference and rejects garbage', async () => {
  await fixture(async ({ root, source }) => {
    const tool = referenceToolDefinitions(() => root)[0]
    assert.equal(tool.name, 'xcharts_context')
    const ok = JSON.parse(await tool.execute({ reference: `[xcharts:ds:${source.id}@${source.content_hash}]`, view: 'sample' }))
    assert.equal(ok.ok, true)
    assert.equal(ok.context.identity.name, '销售')
    assert.equal(ok.context.sample.length, 5)
    const bad = JSON.parse(await tool.execute({ reference: '随便写的文字' }))
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'INVALID_REFERENCE')
  })
})
