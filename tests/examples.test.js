import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFile } from '../lib/data-parser.js'
import { DataStore } from '../lib/data-store.js'
import { ensureExampleSource } from '../lib/example-data.js'

test('the bundled example dataset is importable', async () => {
  const bytes = readFileSync(new URL('../examples/retail-orders.csv', import.meta.url))
  const data = await parseFile({ filename: 'retail-orders.csv', content_base64: bytes.toString('base64') })
  assert.equal(data.rows.length, 1200)
  assert.equal(data.columns.length, 19)
  const byName = Object.fromEntries(data.columns.map(column => [column.name, column]))
  assert.equal(byName['下单日期'].type, 'date')
  assert.equal(byName['销售额'].type, 'number')
  assert.equal(byName['门店'].type, 'string')
})

test('the bundled retail example becomes a ready datasource once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-example-source-'))
  try {
    const first = await ensureExampleSource(dir)
    assert.equal(first, true)
    const store = new DataStore(dir)
    const example = store.list().find(item => item.source?.type === 'bundled_example')
    assert.ok(example, 'the example datasource exists after startup')
    assert.equal(example.name, '零售订单（示例）')
    assert.equal(example.row_count, 1200)
    const second = await ensureExampleSource(dir)
    assert.equal(second, false, 'second startup does not duplicate it')
    assert.equal(new DataStore(dir).list().filter(item => item.source?.type === 'bundled_example').length, 1)
    store.remove(example.id)
    await ensureExampleSource(dir)
    assert.equal(new DataStore(dir).list().some(item => item.source?.type === 'bundled_example'), false, 'a deleted example stays deleted')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
