import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseFile } from '../lib/data-parser.js'

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
