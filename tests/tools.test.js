import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { canvasToolDefinitions } from '../lib/tools.js'
import { CanvasStore } from '../lib/store.js'
import { overlaps } from '../lib/grid.js'

/**
 * Build the tool map against a throwaway storage root.
 *
 * Must be awaited: `return await fn(...)` keeps the temp directory alive until
 * the async test body settles. A bare `return fn(...)` would run the `finally`
 * cleanup while the body is still pending.
 */
async function withTools (fn) {
  const dir = mkdtempSync(join(tmpdir(), 'xctools-'))
  const tools = new Map(canvasToolDefinitions(() => dir).map(t => [t.name, t]))
  const call = async (name, args = {}) => {
    // Existing fixtures create synthetic data cards; mark them explicitly as manual.
    const cardArgs = name === 'canvas_add_card'
      && ['chart', 'table', 'kpi'].includes(args.type)
      && !args.dataset && !args.query && !args.note
      ? { ...args, note: '手工/无外部数据源' }
      : args
    return JSON.parse(await tools.get(name).execute(cardArgs))
  }
  try {
    return await fn({ tools, call, dir, store: new CanvasStore(dir) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const EXPECTED_TOOLS = [
  'canvas_list', 'canvas_create', 'canvas_read', 'canvas_add_card',
  'canvas_update_card', 'canvas_remove_card', 'canvas_arrange',
]

test('canvas_add_card creates a code preview without persisting or bumping revision', async () => {
  await withTools(async ({ call, store }) => {
    const created = await call('canvas_create', { name: '代码分析' })
    const added = await call('canvas_add_card', {
      canvas_id: created.canvas_id, type: 'code', title: '查询',
      text_content: 'SELECT 1', language: 'sql',
    })
    assert.equal(added.ok, true)
    assert.equal(added.status, 'pending_confirmation')
    assert.equal(added.canvas_id, created.canvas_id)
    assert.equal(added.title, '查询')
    assert.equal(Object.hasOwn(added, 'draft_id'), false)
    const canvas = store.getCanvas(created.canvas_id)
    assert.equal(canvas.revision, created.revision)
    assert.equal(canvas.cards.length, 0)
    const [draft] = store.listCardDrafts()
    assert.equal(draft.card.language, 'sql')
    assert.equal(draft.card.text_content, 'SELECT 1')
  })
})

test('canvas_add_card requires data provenance or an explicit manual marker', async () => {
  await withTools(async ({ tools, call, store }) => {
    const created = await call('canvas_create', { name: '来源校验' })
    const addCard = tools.get('canvas_add_card')
    const missing = JSON.parse(await addCard.execute({
      canvas_id: created.canvas_id, type: 'chart', title: '无来源',
    }))
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'SOURCE_REQUIRED')

    const manual = await call('canvas_add_card', {
      canvas_id: created.canvas_id, type: 'chart', title: '手工数据',
      note: '手工/无外部数据源',
    })
    assert.equal(manual.status, 'pending_confirmation')

    const sourcedCanvas = await call('canvas_create', { name: '查询结果画布' })
    const sourced = await call('canvas_add_card', {
      canvas_id: sourcedCanvas.canvas_id, type: 'table', title: '查询结果',
      dataset: 'sales.csv', query: '按月份汇总销售额',
    })
    assert.equal(sourced.status, 'pending_confirmation')
    assert.equal(Object.hasOwn(sourced, 'draft_id'), false)
    assert.deepEqual(store.listCardDrafts().map(draft => draft.card.type), ['chart', 'table'])
    assert.equal(store.getCanvas(created.canvas_id).revision, created.revision)
    assert.equal(store.getCanvas(created.canvas_id).cards.length, 0)
  })
})

test('exactly the intended tools are exposed', async () => {
  await withTools(({ tools }) => {
    assert.deepEqual([...tools.keys()].sort(), [...EXPECTED_TOOLS].sort())
  })
})

test('no query or statistics tool is exposed (the agent computes data itself)', async () => {
  await withTools(({ tools }) => {
    for (const banned of ['query_data', 'run_analysis', 'execute_python', 'query_sql']) {
      assert.equal(tools.has(banned), false, `${banned} must not be exposed`)
    }
  })
})

test('every tool declares a model-facing description, parameters and output', async () => {
  await withTools(({ tools }) => {
    for (const [name, t] of tools) {
      assert.ok(t.description && t.description.length > 10, `${name} needs a description`)
      assert.ok(t.parameters, `${name} needs parameters`)
      assert.ok(t.output?.schema && typeof t.output.render === 'function', `${name} needs output`)
      assert.equal(typeof t.execute, 'function', `${name} needs execute`)
    }
  })
})

test('tool results are JSON strings that carry ok:true on success', async () => {
  await withTools(async ({ call }) => {
    const raw = await call('canvas_list')
    assert.equal(typeof raw, 'object')
    assert.equal(raw.ok, true)
    assert.equal(raw.count, 0)
  })
})

test('canvas_create then canvas_list round-trips', async () => {
  await withTools(async ({ call, store }) => {
    const created = await call('canvas_create', { name: '销售分析', description: '季度趋势' })
    assert.equal(created.ok, true)
    assert.ok(created.canvas_id)

    const listed = await call('canvas_list')
    assert.equal(listed.count, 1)
    assert.equal(listed.canvases[0].name, '销售分析')
    assert.equal(listed.canvases[0].description, '季度趋势')
    assert.equal(listed.canvases[0].card_count, 0)
    assert.equal(created.canvas_id, listed.canvases[0].id)
    assert.equal(store.listCanvases().length, 1)
  })
})

test('canvas_add_card returns a private pending preview without persisting the card', async () => {
  await withTools(async ({ call, store, tools }) => {
    const c = await call('canvas_create', { name: 'c' })
    const added = await call('canvas_add_card', {
      canvas_id: c.canvas_id, type: 'chart', title: '月度销售额', chart_type: 'line',
      echarts_option: { xAxis: { data: ['1月', '2月'] }, series: [{ type: 'line', data: [10, 20] }] },
      dataset: '/data/sales.csv', query: 'SELECT month, SUM(amount) FROM data GROUP BY month',
    })
    assert.equal(added.ok, true)
    assert.equal(added.status, 'pending_confirmation')
    assert.equal(Object.hasOwn(added, 'card_id'), false)
    assert.equal(Object.hasOwn(added, 'draft_id'), false, 'the model must not receive a confirmation handle')
    assert.equal(tools.has('canvas_confirm_card'), false)
    assert.equal(tools.has('canvas_cancel_card'), false)

    const read = await call('canvas_read', { canvas_id: c.canvas_id })
    assert.equal(read.card_count, 0)
    assert.equal(read.revision, c.revision)
    const [draft] = store.listCardDrafts()
    assert.equal(draft.card.title, '月度销售额')
    assert.equal(draft.card.chart_type, 'line')
    assert.equal(draft.card.source.query.includes('GROUP BY'), true)
  })
})

test('new add preview supersedes the old same-canvas draft after feedback', async () => {
  await withTools(async ({ call, store, tools }) => {
    const target = await call('canvas_create', { name: '反馈重预览' })
    const other = await call('canvas_create', { name: '另一个画布' })
    await call('canvas_add_card', {
      canvas_id: target.canvas_id, type: 'chart', title: '旧预览',
      dataset: 'sales.csv', query: '按地区汇总',
    })
    const [oldDraft] = store.listCardDrafts().filter(draft => draft.canvas_id === target.canvas_id)
    await call('canvas_add_card', {
      canvas_id: other.canvas_id, type: 'chart', title: '其它画布预览',
      dataset: 'other.csv', query: '按产品汇总',
    })
    const invalid = JSON.parse(await tools.get('canvas_add_card').execute({ canvas_id: target.canvas_id, type: 'chart', title: '无来源反馈' }))
    assert.equal(invalid.code, 'SOURCE_REQUIRED')
    assert.deepEqual(store.listCardDrafts().map(draft => draft.card.title), ['旧预览', '其它画布预览'], 'invalid feedback must not retire the prior preview')

    const replacement = await call('canvas_add_card', {
      canvas_id: target.canvas_id, type: 'chart', title: '反馈后的新预览',
      dataset: 'sales.csv', query: '按地区汇总并排除退款',
    })
    assert.equal(replacement.status, 'pending_confirmation')
    assert.equal(Object.hasOwn(replacement, 'draft_id'), false)
    assert.deepEqual(store.listCardDrafts().map(draft => draft.card.title), ['其它画布预览', '反馈后的新预览'])
    assert.throws(() => store.confirmCardDraft(oldDraft.id), error => error.code === 'DRAFT_SUPERSEDED')
    assert.equal(store.getCanvas(target.canvas_id).revision, target.revision)
    assert.equal(store.getCanvas(target.canvas_id).cards.length, 0)

    const latest = store.listCardDrafts().find(draft => draft.canvas_id === target.canvas_id)
    const confirmed = store.confirmCardDraft(latest.id)
    assert.equal(confirmed.idempotent, false)
    assert.equal(store.getCanvas(target.canvas_id).cards.length, 1)
    assert.equal(store.getCanvas(target.canvas_id).cards[0].title, '反馈后的新预览')
    const savedRevision = store.getCanvas(target.canvas_id).revision

    await call('canvas_add_card', { canvas_id: target.canvas_id, type: 'chart', title: '确认后可取消', dataset: 'sales.csv', query: '另一版口径' })
    const cancelled = store.listCardDrafts().find(draft => draft.canvas_id === target.canvas_id)
    store.cancelCardDraft(cancelled.id)
    assert.equal(store.getCanvas(target.canvas_id).revision, savedRevision)
    assert.equal(store.getCanvas(target.canvas_id).cards.length, 1, 'cancelling the new preview must not add another card')
    assert.deepEqual(store.listCardDrafts().map(draft => draft.card.title), ['其它画布预览'])
  })
})

test('canvas_read omits heavy chart options unless asked', async () => {
  await withTools(async ({ call, store }) => {
    const c = await call('canvas_create', { name: 'c' })
    const big = { series: [{ type: 'bar', data: Array.from({ length: 500 }, (_, i) => i) }] }
    store.addCard(c.canvas_id, { type: 'chart', title: 'big', echarts_option: big, note: '手工/无外部数据源' }, c.revision)

    const lean = await call('canvas_read', { canvas_id: c.canvas_id })
    assert.equal(lean.cards[0].echarts_option, undefined, 'summary must not carry the option')

    const full = await call('canvas_read', { canvas_id: c.canvas_id, include_options: true })
    assert.equal(full.cards[0].echarts_option.series[0].data.length, 500)
  })
})

test('canvas_add_card creates pending previews for all card types', async () => {
  await withTools(async ({ call, store }) => {
    const specs = [
      { type: 'chart', title: 'chart', echarts_option: { series: [] } },
      { type: 'table', title: 'table', table_data: { columns: [{ name: 'a' }], rows: [[1]] } },
      { type: 'kpi', title: 'kpi', presentation_spec: { value: 42, label: '营收' } },
      { type: 'text', title: 'text', text_content: '结论：增长 12%' },
    ]
    const canvases = []
    for (const spec of specs) {
      const canvas = await call('canvas_create', { name: spec.title })
      canvases.push(canvas)
      const result = await call('canvas_add_card', { canvas_id: canvas.canvas_id, ...spec, expected_revision: canvas.revision })
      assert.equal(result.status, 'pending_confirmation', `${spec.type} should be previewed`)
    }
    for (const canvas of canvases) {
      const read = await call('canvas_read', { canvas_id: canvas.canvas_id, include_options: true })
      assert.equal(read.card_count, 0)
      assert.equal(read.revision, canvas.revision)
    }
    const drafts = store.listCardDrafts()
    assert.deepEqual(drafts.map(draft => draft.card.type), ['chart', 'table', 'kpi', 'text'])
    assert.equal(drafts[2].card.presentation_spec.value, 42)
    assert.equal(drafts[3].card.text_content.includes('12%'), true)
  })
})

test('canvas_update_card updates source fields partially and preserves legacy updates', async () => {
  await withTools(async ({ call, store }) => {
    const c = await call('canvas_create', { name: 'c' })
    const addedCanvas = store.addCard(c.canvas_id, {
      type: 'chart', title: 'before', chart_type: 'bar', dataset: 'sales.csv', query: 'SELECT 1',
    }, c.revision)
    const added = { card_id: addedCanvas.cards[0].id, revision: addedCanvas.revision }
    const upd = await call('canvas_update_card', {
      canvas_id: c.canvas_id, card_id: added.card_id,
      query: '按月份汇总销售额', source_note: '含退款冲销',
      expected_revision: added.revision,
    })
    const confirmUpdate = result => {
      assert.equal(result.status, 'pending_confirmation')
      assert.equal(Object.hasOwn(result, 'draft_id'), false)
      const draft = store.listCardDrafts().find(item => item.operation === 'update')
      return store.confirmCardDraft(draft.id)
    }
    assert.equal(upd.ok, true)
    assert.equal(store.getCanvas(c.canvas_id).revision, added.revision)
    assert.equal(store.getCanvas(c.canvas_id).cards[0].source.query, 'SELECT 1')
    upd.revision = confirmUpdate(upd).revision
    assert.deepEqual(upd.source, { dataset: 'sales.csv', query: '按月份汇总销售额', note: '含退款冲销' })

    const rejected = await call('canvas_update_card', {
      canvas_id: c.canvas_id, card_id: added.card_id, query: '',
      expected_revision: upd.revision,
    })
    assert.equal(rejected.code, 'SOURCE_REQUIRED')
    assert.match(rejected.suggestion, /dataset.*query|手工数据/)
    const unchanged = await call('canvas_read', { canvas_id: c.canvas_id, include_options: true })
    assert.equal(unchanged.revision, upd.revision)
    assert.deepEqual(unchanged.cards[0].source, upd.source, 'rejected source clear must not mutate the card')

    const manual = await call('canvas_update_card', {
      canvas_id: c.canvas_id, card_id: added.card_id, dataset: '', query: '',
      source_note: '手工/无外部数据源', expected_revision: upd.revision,
    })
    assert.equal(manual.ok, true, 'an explicit manual marker permits clearing external source fields')
    manual.revision = confirmUpdate(manual).revision
    assert.equal(manual.source.note, '手工/无外部数据源')

    const legacy = await call('canvas_update_card', {
      canvas_id: c.canvas_id, card_id: added.card_id, title: 'after',
      expected_revision: manual.revision,
    })
    assert.equal(legacy.ok, true)
    confirmUpdate(legacy)
    assert.deepEqual(legacy.source, manual.source, 'omitting source fields must preserve existing provenance')

    const read = await call('canvas_read', { canvas_id: c.canvas_id, include_options: true })
    assert.equal(read.cards[0].title, 'after')
    assert.equal(read.cards[0].chart_type, 'bar', 'chart_type must be untouched')
    assert.equal(read.cards[0].source.dataset, '')
    assert.equal(read.cards[0].source.query, '')
    assert.equal(read.cards[0].source.note, '手工/无外部数据源')
  })
})

test('canvas_remove_card deletes exactly the named card', async () => {
  await withTools(async ({ call, store }) => {
    const c = await call('canvas_create', { name: 'c' })
    let canvas = store.addCard(c.canvas_id, { type: 'chart', title: 'a', note: '手工/无外部数据源' }, c.revision)
    const a = { card_id: canvas.cards[0].id }
    canvas = store.addCard(c.canvas_id, { type: 'chart', title: 'b', note: '手工/无外部数据源' }, canvas.revision)
    const b = { revision: canvas.revision }

    const removed = await call('canvas_remove_card', {
      canvas_id: c.canvas_id, card_id: a.card_id, expected_revision: b.revision,
    })
    assert.equal(removed.ok, true)
    assert.equal(removed.card_count, 1)

    const read = await call('canvas_read', { canvas_id: c.canvas_id })
    assert.equal(read.cards.length, 1)
    assert.equal(read.cards[0].title, 'b')
  })
})

test('canvas_arrange packs cards without overlap and reports how many moved', async () => {
  await withTools(async ({ call, store }) => {
    const c = await call('canvas_create', { name: 'messy' })
    let canvas = store.getCanvas(c.canvas_id)
    for (let i = 0; i < 8; i++) {
      canvas = store.addCard(c.canvas_id, { type: 'chart', title: `card ${i}`, note: '手工/无外部数据源' }, canvas.revision)
    }
    const arranged = await call('canvas_arrange', { canvas_id: c.canvas_id, expected_revision: canvas.revision })
    assert.equal(arranged.ok, true)
    assert.equal(arranged.card_count, 8)

    const read = await call('canvas_read', { canvas_id: c.canvas_id })
    const cards = read.cards
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        assert.equal(overlaps(cards[i].layout, cards[j].layout), false, `overlap ${i}/${j} after arrange`)
      }
    }
  })
})

test('canvas_add_card rejects a stale expected_revision without creating a draft', async () => {
  await withTools(async ({ call, store }) => {
    const c = await call('canvas_create', { name: 'race' })
    store.renameCanvas(c.canvas_id, 'changed by user', c.revision)
    const stale = await call('canvas_add_card', {
      canvas_id: c.canvas_id, type: 'chart', title: 'stale', expected_revision: c.revision,
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'REVISION_CONFLICT')
    assert.equal(stale.current_revision, c.revision + 1)
    assert.ok(stale.suggestion, 'conflict must carry an actionable suggestion')
    assert.equal(store.listCardDrafts().length, 0)
    const read = await call('canvas_read', { canvas_id: c.canvas_id })
    assert.equal(read.card_count, 0, 'a stale preview request must not create a card')
  })
})

test('tool errors come back as structured ok:false rather than throwing', async () => {
  await withTools(async ({ call }) => {
    const missing = await call('canvas_read', { canvas_id: 'nope' })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'CANVAS_NOT_FOUND')
    assert.ok(missing.suggestion)

    const badType = await call('canvas_add_card', {
      canvas_id: 'nope', type: 'bogus', title: 'x',
    })
    assert.equal(badType.ok, false)

    const noName = await call('canvas_create', {})
    assert.equal(noName.ok, false)
    assert.equal(noName.code, 'INVALID_CANVAS')
  })
})

test('a path-traversal canvas id is refused, not resolved', async () => {
  await withTools(async ({ call }) => {
    const res = await call('canvas_read', { canvas_id: '../../etc/passwd' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'INVALID_CANVAS_ID')
  })
})

test('pending previews are shared across fresh tool sets without persisting cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcpersist-'))
  try {
    const first = new Map(canvasToolDefinitions(() => dir).map(t => [t.name, t]))
    const created = JSON.parse(await first.get('canvas_create').execute({ name: 'keep me' }))
    JSON.parse(await first.get('canvas_add_card').execute({
      canvas_id: created.canvas_id, type: 'kpi', title: '营收',
      presentation_spec: { value: 100 }, note: '手工/无外部数据源',
      expected_revision: created.revision,
    }))

    // a brand-new set of tools over the same directory
    const second = new Map(canvasToolDefinitions(() => dir).map(t => [t.name, t]))
    const listed = JSON.parse(await second.get('canvas_list').execute({}))
    assert.equal(listed.count, 1)
    assert.equal(listed.canvases[0].name, 'keep me')
    assert.equal(listed.canvases[0].card_count, 0)

    const read = JSON.parse(await second.get('canvas_read').execute({ canvas_id: created.canvas_id, include_options: true }))
    assert.equal(read.cards.length, 0)
    const [draft] = new CanvasStore(dir).listCardDrafts()
    assert.equal(draft.card.presentation_spec.value, 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
