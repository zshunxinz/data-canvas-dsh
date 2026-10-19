import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { salesExample } from '../lib/examples.js'
import { makeCard, CanvasStore } from '../lib/store.js'
import { DataStore } from '../lib/data-store.js'
import { createApiHandler } from '../lib/routes.js'
import { ReferenceService } from '../lib/reference-service.js'

import { React, renderToString, resetRenderState, flushEffects, renderedElements } from './helpers/react-standin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_SOURCE = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Flush pending microtasks so the workspace's async load completes. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

const chartOption = { series: [{ type: 'line', data: [3, 7, 4] }] }
const bigOption = { series: [{ type: 'bar', data: Array.from({ length: 200 }, (_, i) => i) }] }
const pairsOption = { series: [{ type: 'bar', data: [['一', 5], [6, '二'], { value: 9, name: '三' }], type: 'bar' }] }
const emptyOption = { series: [] }

const CANVAS = {
  id: 'canvas1',
  name: '渲染测试',
  description: null,
  revision: 3,
  cards: [
    { id: 'c1', type: 'chart', title: '趋势', chart_type: 'line', echarts_option: chartOption, layout: { x: 0, y: 0, w: 48, h: 15 }, source: { dataset: 'a.csv', query: 'SELECT 1', note: '季度口径说明' }, show_header: true, color: 'blue' },
    { id: 'c2', type: 'chart', title: '大数据', echarts_option: bigOption, layout: { x: 0, y: 16, w: 48, h: 15 }, show_header: true },
    { id: 'c3', type: 'chart', title: '坐标对', echarts_option: pairsOption, layout: { x: 0, y: 32, w: 48, h: 15 }, show_header: true },
    { id: 'c4', type: 'chart', title: '空图', echarts_option: emptyOption, layout: { x: 0, y: 48, w: 48, h: 15 }, show_header: true },
    { id: 'c5', type: 'table', title: '明细', table_data: { columns: [{ name: '区域' }, { name: '值' }], rows: [['华东', 1], ['华南', 2]] }, layout: { x: 0, y: 64, w: 48, h: 15 }, show_header: true },
    { id: 'c6', type: 'kpi', title: '营收', presentation_spec: { value: 80, label: '上半年', unit: '万', target: 100, delta: -12, delta_dir: 'up' }, layout: { x: 0, y: 80, w: 48, h: 15 }, show_header: true },
    { id: 'c9', type: 'chart', title: '色标卡', echarts_option: { series: [{ type: 'bar', data: [1] }] }, layout: { x: 0, y: 96, w: 48, h: 15 }, show_header: true, color: 'red' },
    { id: 'c7', type: 'text', title: '结论', text_content: '增长 18%。', layout: { x: 0, y: 96, w: 48, h: 15 }, show_header: true },
    { id: 'c8', type: 'chart', title: '无头卡', echarts_option: chartOption, layout: { x: 0, y: 112, w: 48, h: 15 }, show_header: false },
  ],
}

/**
 * Execute the bundle and return { plugin, renderPage }.
 *
 * `fetch` is stubbed with the fixture above so CanvasWorkspace runs its real
 * load flow: list → load → ready → cards rendered. That is the path the
 * `t is not a function` crash took, and no static check could see it.
 */
function loadClient ({ initialCanvases = [CANVAS], failList = false, failExample = false, fetchOverride, environment = {} } = {}) {
  resetRenderState()
  let canvases = [...initialCanvases]
  let plugin = null
  const listeners = new Map()
  // Every native dialog the bundle might still reach for is recorded, so a test
  // can prove the themed dialogs are the only ones in play.
  const nativeDialogs = []
  const sandboxWindow = {
    // Effects register window listeners (resize, drag, menu dismissal); a
    // no-op keeps them loadable without a DOM.
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
    },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    prompt: (...args) => { nativeDialogs.push(['prompt', ...args]); return CANVAS.name },
    confirm: (...args) => { nativeDialogs.push(['confirm', ...args]); return true },
  }
  // ECharts stub: records the lifecycle so the test can assert init/setOption/
  // dispose really happen on the chart path. The bundle loads it through
  // require.async('./client.echarts.js'), so the require stand-in carries it.
  const echartsCalls = { init: 0, setOption: 0, dispose: 0, resize: 0 }
  const fakeChart = {
    setOption: () => { echartsCalls.setOption++ },
    resize: () => { echartsCalls.resize++ },
    dispose: () => { echartsCalls.dispose++ },
    getDataURL: () => 'data:image/png;base64,AAAA',
  }
  const echartsStub = {
    init: () => { echartsCalls.init++; return fakeChart },
  }
  const loaderRequire = name => (name === 'echarts' ? echartsStub : React)
  loaderRequire.async = async spec => {
    if (spec === './client.echarts.js') return echartsStub
    throw new Error(`unexpected chunk request in test: ${spec}`)
  }
  const sandbox = {
    document: { activeElement: null },
    window: sandboxWindow,
    // Node has neither rAF nor ResizeObserver; the echarts lifecycle needs both
    // (init gates on a non-zero size seen by the observer, resize batches via
    // rAF). The observer stub fires immediately so init proceeds in flush.
    requestAnimationFrame: callback => { setImmediate(callback); return 0 },
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      constructor (callback) { this.cb = callback }
      observe () { this.cb([], this) }
      disconnect () {}
      unobserve () {}
    },
    __ModuleLoader__: {
      load: definition => {
        plugin = definition.factory(loaderRequire)
      },
    },
    console,
    navigator: {},
    fetch: fetchOverride || (async (url, options) => {
      const path = String(url).split('/api/xcharts-canvas')[1] || ''
      let payload = {}
      if (path === '/capabilities') {
        payload = { api_version: 1, create_example: true }
      } else if (path === '/canvases/example' && options?.method === 'POST') {
        if (failExample) throw new Error('example creation failed')
        const example = salesExample()
        const data = { ...example, id: 'example1', revision: 1, cards: example.cards.map(c => makeCard(c, [])) }
        canvases.push(data)
        payload = { canvas_id: data.id }
      } else if (path === '/storage') {
        payload = {
          storage_path: 'D:/dsh-home/storages/xcharts-canvas', source: 'custom', platform: 'win32', home: 'D:/home', dsh_home: 'D:/dsh-home',
          total_bytes: 3072, total_files: 4,
          directories: [{ name: 'datasources', files: 1, bytes: 1024, cleanable: false }, { name: 'history', files: 2, bytes: 2048, cleanable: true }],
          cleanable: [{ target: 'history', label: '撤销历史', hint: '删除撤销记录' }, { target: 'executions', label: '调用证据', hint: '删除调用证据' }, { target: 'usages', label: '使用记录', hint: '删除使用记录' }, { target: 'inputs', label: '版本快照', hint: '删除版本快照' }],
        }
      } else if (path.startsWith('/changelog')) {
        payload = { current_version: '9.9.9', entries: [{ version: '9.9.9', date: '2026-10-17', lines: ['更新日志测试条目'] }] }
      } else if (path === '/canvases' && options?.method === 'POST') {
        canvases.push(CANVAS)
        payload = { canvas_id: CANVAS.id }
      } else if (path === '/canvases') {
        if (failList) throw new Error('catalog unavailable')
        payload = { canvases: canvases.map(c => ({ id: c.id, name: c.name, card_count: c.cards.length, updated_at: c.revision })) }
      } else if (options?.method === 'DELETE') {
        canvases = canvases.filter(c => path !== `/canvases/${c.id}`)
      } else if (/^\/canvases\/[a-z0-9]+$/.test(path)) payload = canvases.find(c => path === `/canvases/${c.id}`)
      else throw new Error(`unexpected request: ${path}`)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      }
    }),
  }
  Object.assign(sandbox, environment)
  sandboxWindow.__ModuleLoader__ = sandbox.__ModuleLoader__
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(plugin?.apply, 'the bundle must register a plugin with apply()')
  return { plugin, echartsCalls, nativeDialogs, pure: plugin.__pure,
    emit: (name, event) => { for (const fn of [...(listeners.get(name) || [])]) fn(event) },
  }
}

function applyPlugin (plugin, services = {}) {
  const slots = {}
  const ctx = {
    slots: {
      inject: (name, factory) => {
        (slots[name] = slots[name] || []).push(factory())
      },
      register: (meta, component) => ({ meta, component }),
    },
    locale: { current: 'zh' },
    // Client services are published after activation; a test may hand in a stub
    // that appears through this lazy getter exactly like the host does.
    get: name => services[name],
  }
  plugin.apply(ctx)
  const main = (slots.main || [])[0]
  assert.ok(main, 'the main slot must hold the page registration')
  assert.equal(main.meta.key, 'xcharts-canvas')
  // Every registration stays reachable so a test can mount the datasource page
  // too, not only the first main entry.
  main.component.__slots = slots
  return main.component
}

// Exercise the actual request handler/store while modeling older route generations.
function hostAdapter (store, { capabilityStatus = 200, exampleStatus = 201 } = {}) {
  const writes = []
  const handler = createApiHandler(() => store, '/api/xcharts-canvas')
  const fetchOverride = async (url, options = {}) => {
    const method = options.method || 'GET'
    if (method === 'POST') writes.push(String(url))
    const reply = status => ({ ok: false, status, text: async () => JSON.stringify({ error: 'host request failed' }) })
    if (String(url).endsWith('/capabilities') && capabilityStatus !== 200) return reply(capabilityStatus)
    if (String(url).endsWith('/canvases/example') && exampleStatus !== 201) return reply(exampleStatus)
    const req = Readable.from(options.body ? [Buffer.from(options.body)] : [])
    req.method = method
    req.url = String(url)
    req.headers = { host: '127.0.0.1:3080' }
    let status
    let body = ''
    await handler(req, {
      writeHead: value => { status = value },
      end: value => { body = String(value || '') },
    })
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  return { writes, fetchOverride }
}

for (const status of [404, 405, 401, 403, 500]) {
  test(`host capability HTTP ${status} stops before any canvas is created`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'xchost-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const store = new CanvasStore(dir)
    const host = hostAdapter(store, { capabilityStatus: status })
    const { plugin } = loadClient(host)
    const Page = applyPlugin(plugin)
    const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
    render()
    await flushEffects()
    render()
    await renderedElements.find(el => el.props['data-xc-add-example']).props.onClick()
    const html = render()
    assert.ok(html.includes(status === 404 || status === 405 ? 'DSH' : 'host request failed'))
    assert.deepEqual(host.writes, [])
    assert.equal(store.listCanvases().length, 0)
    assert.equal(renderedElements.find(el => el.props['data-xc-add-example']).props.disabled, false)
  })
}

for (const status of [404, 405, 500]) {
  test(`example HTTP ${status} never falls back to partial creation`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'xchost-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const store = new CanvasStore(dir)
    const host = hostAdapter(store, { exampleStatus: status })
    const { plugin } = loadClient(host)
    const Page = applyPlugin(plugin)
    const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
    render()
    await flushEffects()
    render()
    await renderedElements.find(el => el.props['data-xc-add-example']).props.onClick()
    render()
    assert.deepEqual(host.writes, ['/api/xcharts-canvas/canvases/example'])
    assert.equal(store.listCanvases().length, 0)
  })
}

test('matching UI and host create ten persisted cards in a single request', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xchost-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const host = hostAdapter(store)
  const { plugin } = loadClient(host)
  const Page = applyPlugin(plugin)
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render()
  await flushEffects()
  render()
  await renderedElements.find(el => el.props['data-xc-add-example']).props.onClick()
  render()
  assert.deepEqual(host.writes, ['/api/xcharts-canvas/canvases/example'])
  const list = store.listCanvases()
  assert.equal(list.length, 1)
  assert.equal(new CanvasStore(dir).getCanvas(list[0].id).cards.length, 10)
  assert.equal(renderedElements.filter(el => el.props['data-xc-card']).length, 10)
})

test('table sort helpers order rows numerically with nulls last', () => {
  const { pure } = loadClient()
  const { sortRows } = pure
  // Values cross a vm realm, so compare via JSON rather than deepStrictEqual
  // (prototypes differ across realms).
  const values = (rows, col = 1) => JSON.stringify(rows.map(r => r[col]))
  const rows = [
    ['华东', 30],
    ['华南', 10],
    ['缺失', null],
    ['华北', 20],
  ]
  const asc = sortRows(rows, 1, 1)
  assert.equal(values(asc), JSON.stringify([10, 20, 30, null]), 'numeric ascending, null last')
  const desc = sortRows(rows, 1, -1)
  assert.equal(values(desc), JSON.stringify([30, 20, 10, null]), 'numeric descending, null still last')
  const natural = sortRows(rows, 1, 0)
  assert.equal(natural, rows, 'dir 0 returns the input order untouched')
  // String columns compare as locale strings — for these zh labels the first is
  // 华北 (b < d < n in the second character under pinyin collation).
  const byName = sortRows(rows, 0, 1)
  assert.equal(byName[0][0], '华北', 'locale string ascending')
})

test('CSV preserves escaping, Unicode, numeric types and neutralizes formula strings', () => {
  const { pure } = loadClient()
  const csv = pure.tableCsv(['名称', 'value'], [['a,"b\nc', '=SUM(A1)'], ['负数', -12], ['空', null], ['空白公式', ' \t+1'], ['对象', { a: 1 }]])
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes('"a,""b\nc"'))
  assert.ok(csv.includes('"\'=SUM(A1)"'))
  assert.ok(csv.includes('"-12"'))
  assert.ok(csv.includes('"\' \t+1"'))
  assert.ok(csv.includes('"{""a"":1}"'))
})

test('table filters loaded rows, resets pagination and exports all sorted matches', async () => {
  let downloaded
  const environment = { Blob, URL: { createObjectURL: blob => { downloaded = blob; return 'blob:test' }, revokeObjectURL () {} }, setTimeout: callback => callback(),
    document: { activeElement: null, body: { appendChild () {} }, createElement: () => ({ click () {}, remove () {} }) } }
  const canvas = { ...CANVAS, cards: [{ id: 'table', type: 'table', title: 'data', layout: { x: 0, y: 0, w: 96, h: 20 },
    table_data: { columns: ['group', 'value'], rows: Array.from({ length: 70 }, (_, i) => [i % 2 ? 'B' : 'A', i]) } }] }
  const { render } = await readyWorkspace({ initialCanvases: [canvas], environment })
  renderedElements.find(e => e.props['data-xc-page-next']).props.onClick(); render()
  await chooseOption(render, 'data-xc-table-column', '0')
  await chooseOption(render, 'data-xc-table-value', JSON.stringify('B'))
  assert.ok(renderedElements.find(e => e.props['data-xc-page-info']).children.join('').includes('35 匹配'))
  const header = () => renderedElements.find(e => e.props['data-xc-sort-col'] === '1')
  header().props.onClick(); render(); header().props.onClick(); render()
  renderedElements.find(e => e.props['data-xc-table-csv']).props.onClick()
  const csv = await downloaded.text()
  assert.ok(csv.includes('"B","69"'))
  assert.ok(csv.includes('"B","1"'), 'CSV includes matches beyond the first page')
  assert.ok(!csv.includes('"A"'))
  renderedElements.find(e => e.props['data-xc-table-filter']).props.onChange({ target: { value: 'missing' } }); render()
  assert.equal(renderedElements.filter(e => e.type === 'td').length, 0)
  renderedElements.find(e => e.props['data-xc-table-clear']).props.onClick(); render()
  assert.ok(renderedElements.find(e => e.props['data-xc-page-info']).children.join('').includes('70 匹配'))
})

test('template UI saves, previews, clones and deletes layouts through real routes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xctemplate-ui-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  store.createExampleCanvas()
  const { render } = await readyWorkspace(hostAdapter(store))
  await renderedElements.find(e => e.props['data-xc-templates']).props.onClick(); render()
  await renderedElements.find(e => e.props['data-xc-template-save']).props.onClick(); render()
  // Naming a template goes through the themed prompt, never `window.prompt`.
  await submitPrompt(render, '布局一'); await flushEffects(); render()
  assert.equal(store.listTemplates().length, 1)
  const id = store.listTemplates()[0].id
  assert.equal(store.listTemplates()[0].name, '布局一')
  await renderedElements.find(e => e.props['data-xc-template-item'] === id).props.onClick(); render()
  assert.ok(renderedElements.find(e => e.props['data-xc-template-preview'] === id))
  await renderedElements.find(e => e.props['data-xc-template-clone']).props.onClick(); render()
  await submitPrompt(render, '由模板创建'); await flushEffects(); render()
  assert.equal(store.listCanvases().length, 2)
  await renderedElements.find(e => e.props['data-xc-templates']).props.onClick(); render()
  await renderedElements.find(e => e.props['data-xc-template-item'] === id).props.onClick(); render()
  await renderedElements.find(e => e.props['data-xc-template-delete']).props.onClick(); render()
  assert.ok(renderedElements.find(e => e.props['data-xc-confirm-ok']), 'deleting a template asks first')
  await acceptConfirm(render); await flushEffects(); render()
  assert.equal(store.listTemplates().length, 0)
  assert.equal(store.listCanvases().length, 2)
})

test('templates remain usable when no canvases exist and keep hook order on clone', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xctemplate-empty-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const canvas = store.createExampleCanvas()
  const template = store.createTemplate(canvas.id, 'Empty restore')
  store.deleteCanvas(canvas.id)
  const { render } = await readyWorkspace(hostAdapter(store))
  await renderedElements.find(e => e.props['data-xc-templates']).props.onClick(); render()
  assert.equal(renderedElements.find(e => e.props['data-xc-template-save']).props.disabled, true)
  await renderedElements.find(e => e.props['data-xc-template-item'] === template.id).props.onClick(); render()
  await renderedElements.find(e => e.props['data-xc-template-clone']).props.onClick(); render()
  await submitPrompt(render, 'Empty restore copy'); await flushEffects(); render()
  assert.equal(renderedElements.filter(e => e.props['data-xc-card']).length, 10)
})

test('an old host is detected before local asset operations attempt unsupported routes', async () => {
  const { render } = await readyWorkspace()
  await renderedElements.find(e => e.props['data-xc-templates']).props.onClick(); render()
  assert.match(render(), /重新启动 DSH/)
  assert.ok(!renderedElements.find(e => e.props['data-xc-template-save']).props.disabled)
})

test('backup file import creates a new canvas and invalid JSON creates none', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xcbackup-ui-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const original = store.createExampleCanvas()
  const backup = store.exportCanvasBackup(original.id)
  store.deleteCanvas(original.id)
  const { render } = await readyWorkspace(hostAdapter(store))
  const input = () => renderedElements.find(e => e.props.type === 'file')
  const selection = { files: [{ size: 20, text: async () => '{bad' }], value: 'selected' }
  await input().props.onChange({ currentTarget: selection }); render()
  assert.equal(selection.value, '')
  assert.ok(renderedElements.find(e => e.props['data-xc-confirm-ok']), 'importing asks first')
  await acceptConfirm(render); await flushEffects(); render()
  assert.equal(store.listCanvases().length, 0)
  assert.match(render(), /备份导入失败/)
  selection.files = [{ size: 200, text: async () => JSON.stringify(backup) }]
  await input().props.onChange({ currentTarget: selection }); render()
  await acceptConfirm(render); await flushEffects(); render()
  assert.equal(store.listCanvases().length, 1)
  assert.equal(renderedElements.filter(e => e.props['data-xc-card']).length, 10)
  assert.notEqual(store.listCanvases()[0].id, original.id)
})

test('the header renders as a single non-wrapping line with SVG icon buttons', async () => {
  const { render } = await readyWorkspace()
  const toolbar = renderedElements.find(e => e.props['data-xc-toolbar'])
  assert.ok(toolbar, 'the header must carry its own hook')
  assert.equal(toolbar.props.style.flexWrap, 'nowrap', 'the header must never wrap')
  assert.equal(toolbar.props.style.overflow, 'hidden')

  // Every icon is a real inline SVG, never a text glyph. The ToolIcon glyphs
  // carry `stroke: currentColor` on the svg itself so they follow the theme;
  // the shell-cloned sidebar toggle instead strokes its child paths.
  const icons = renderedElements.filter(e => e.type === 'svg' && e.props.viewBox === '0 0 16 16')
  const glyphs = icons.filter(svg => svg.props.stroke === 'currentColor')
  assert.ok(glyphs.length >= 8, `expected the toolbar glyphs as SVG, found ${glyphs.length}`)
  assert.ok(icons.every(svg => svg.props['aria-hidden'] === 'true'), 'decorative glyphs must be hidden from AT')

  // The controls that must survive any width: the list toggle and settings are
  // structural, and the ⋯ (or the inline actions it stands for) is the escape
  // hatch that keeps everything else reachable.
  for (const hook of ['data-xc-toggle-list', 'data-xc-settings']) {
    assert.ok(renderedElements.find(e => e.props[hook] !== undefined), `header is missing ${hook}`)
  }
  assert.ok(
    renderedElements.find(e => e.props['data-xc-export']) || renderedElements.find(e => e.props['data-xc-more']),
    'export must be reachable inline or through ⋯')
  // The stand-in's ResizeObserver reports a 400px pane, so the header folds;
  // either state is a single line, which is the invariant that matters.
  assert.ok(['unmeasured', 'full', 'compact'].includes(toolbar.props['data-xc-toolbar']))
})

test('a narrow header folds controls into a ⋯ menu that still reaches them', async () => {
  const { pure } = loadClient()
  // The budget planner is the decision the header uses; exercise it directly.
  const wide = pure.planToolbar(Infinity)
  assert.equal(wide.overflow.size, 0, 'an unbounded header folds nothing')
  assert.deepEqual([...wide.inline].sort(), [...pure.TOOLBAR_ITEMS].sort())

  // A measured header large enough for everything folds nothing either.
  const roomy = pure.planToolbar(900)
  assert.equal(roomy.overflow.size, 0, 'a 900px header has room for every control')

  const narrow = pure.planToolbar(420)
  assert.ok(narrow.overflow.size > 0, 'a 420px header must fold something away')
  // Least valuable first: refresh goes before undo or search.
  assert.ok(narrow.overflow.has('refresh'), 'the least valuable action folds first')
  assert.ok(narrow.overflow.has('export-png'))
  // Fold priority is explicit, and every foldable name must be a real control.
  // (`.length` rather than deepEqual: values crossing the vm realm carry the
  // sandbox's Array prototype, which strict deepEqual rejects.)
  assert.equal(pure.TOOLBAR_FOLD_ORDER.filter(n => !pure.TOOLBAR_ITEMS.includes(n)).length, 0,
    'every foldable name must be a real toolbar item')
  assert.equal(pure.TOOLBAR_FOLD_ORDER.filter(n => pure.TOOLBAR_NEVER_FOLDS.includes(n)).length, 0,
    'a control listed as never-folding must not also be in the fold order')
  // Structure and navigation survive even a very cramped header.
  const cramped = pure.planToolbar(200)
  assert.ok(cramped.overflow.size >= narrow.overflow.size, 'a narrower header never folds less')
  for (const name of pure.TOOLBAR_NEVER_FOLDS) {
    assert.ok(cramped.inline.has(name), `${name} must never fold`)
  }
})

test('every rendered header control has a reachable counterpart when folded', async () => {
  // NOTE: use readyWorkspace's own `pure`. Calling loadClient() again would run
  // resetRenderState() and wipe the elements the assertions below inspect.
  const { render, pure } = await readyWorkspace()
  // The stand-in pane is roomy, so assert the reachability contract at a width
  // that genuinely folds, and drive the real ⋯ handler from that plan.
  const plan = pure.planToolbar(360)
  assert.ok(plan.overflow.size > 0, '360px is a folding width')
  render()
  // At the stand-in's roomy width nothing folds, so every action is inline.
  const inlineHooks = ['data-xc-export', 'data-xc-export-backup', 'data-xc-export-html', 'data-xc-refresh']
  assert.ok(plan.overflow.size > 0, 'the narrow plan folds some of these')
  for (const hook of inlineHooks) {
    assert.ok(renderedElements.find(e => e.props[hook] !== undefined), `${hook} must be reachable inline at a roomy width`)
  }

  // Now exercise the ⋯ menu itself, at a width that really folds.
  const foldedToolbar = pure.planToolbar(360)
  assert.ok(foldedToolbar.overflow.size > 0)
  const more = renderedElements.find(e => e.props['data-xc-more'])
  if (more) {
    more.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 400, bottom: 40 }) } })
    render()
    const entries = renderedElements.filter(e => e.props['data-xc-menu-item']).map(e => e.props['data-xc-menu-item'])
    assert.ok(entries.length > 0, 'the ⋯ menu must list the folded actions')
  } else {
    // No folding at this width: the ⋯ must be absent rather than empty.
    assert.equal(renderedElements.filter(e => e.props['data-xc-menu-item']).length, 0)
  }
})

test('wide compass exposes off-screen cards and supports click-to-select navigation', async () => {
  const canvas = { ...CANVAS, settings: { wide: true }, cards: [
    { id: 'near', type: 'text', title: 'near', layout: { x: 0, y: 0, w: 24, h: 8 } },
    { id: 'far', type: 'text', title: 'far', layout: { x: 120, y: 0, w: 24, h: 8 } },
  ] }
  const { render } = await readyWorkspace({ initialCanvases: [canvas] })
  const entries = renderedElements.filter(e => e.props['data-xc-compass-card'])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].props['data-xc-compass-card'], 'far')
  assert.ok(entries[0].children.join('').includes('→'))
  entries[0].props.onClick(); render()
  assert.ok(renderedElements.find(e => e.props['data-xc-card'] === 'far').props.style.outline)
  renderedElements.find(e => e.props['data-xc-fit']).props.onClick(); render(); await flushEffects(); render()
  assert.ok(!renderedElements.find(e => e.props['data-xc-compass']))
})

async function readyWorkspace (options = {}) {
  const client = loadClient(options)
  const Page = applyPlugin(client.plugin)
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  for (let i = 0; i < 4; i++) { render(); await flushEffects() }
  render()
  return { ...client, render }
}

/** Answer the themed confirm dialog that replaced every `window.confirm`. */
async function acceptConfirm (render) {
  const ok = renderedElements.find(e => e.props['data-xc-confirm-ok'])
  assert.ok(ok, 'a confirm dialog must be open')
  await ok.props.onClick()
  render()
}

/** Type into the themed prompt dialog and submit it. */
async function submitPrompt (render, value) {
  const input = renderedElements.find(e => e.props['data-xc-prompt-input'])
  assert.ok(input, 'a prompt dialog must be open')
  input.props.onChange({ target: { value } })
  render()
  const ok = renderedElements.find(e => e.props['data-xc-prompt-ok'])
  assert.ok(ok, 'the prompt must offer a submit action')
  await ok.props.onClick()
  render()
}

/** Open a themed `Select` and pick one of its options by value. */
async function chooseOption (render, hook, value) {
  const trigger = renderedElements.find(e => e.props[hook] !== undefined)
  assert.ok(trigger, `no Select trigger carries ${hook}`)
  trigger.props.onClick({
    currentTarget: { getBoundingClientRect: () => ({ left: 20, top: 20, right: 120, bottom: 48, width: 100, height: 28 }) },
  })
  render()
  const panel = renderedElements.find(e => e.props['data-xc-select-panel'])
  assert.ok(panel, `${hook} must open a listbox`)
  const option = renderedElements.find(e => e.props['data-xc-option'] === String(value))
  assert.ok(option, `option ${value} is missing from ${hook}`)
  await option.props.onClick()
  render()
}

/** The label a themed `Select` trigger is currently showing. */
function selectLabel (hook) {
  const trigger = renderedElements.find(e => e.props[hook] !== undefined)
  assert.ok(trigger, `no Select trigger carries ${hook}`)
  return trigger.children[0].children.join('')
}

test('pending card previews appear in the workspace and only visible user buttons confirm or cancel', async () => {
  const canvas = { ...CANVAS, revision: 3, cards: [] }
  const first = {
    id: 'draft-confirm', canvas_id: canvas.id, canvas_name: canvas.name, expected_revision: canvas.revision,
    card: { id: 'preview-card', type: 'chart', title: '区域销售额预览', chart_type: 'bar',
      layout: { x: 0, y: 0, w: 48, h: 15 },
      echarts_option: { series: [{ type: 'bar', name: '营收', data: [12, 18] }] },
      source: { dataset: 'sales.csv', query: '按区域汇总销售额', note: '扣除退款' }, note: '' },
  }
  const second = {
    id: 'draft-cancel', canvas_id: canvas.id, canvas_name: canvas.name, expected_revision: canvas.revision,
    card: { id: 'cancel-card', type: 'text', title: '取消此草稿', text_content: '预览文本',
      layout: { x: 48, y: 0, w: 48, h: 10 }, source: { dataset: null, query: null, note: null }, note: '' },
  }
  let drafts = []
  let poll
  const actions = []
  let copiedPrompt = ''
  const fetchOverride = async (url, options = {}) => {
    const path = String(url).split('/api/xcharts-canvas')[1] || ''
    const method = options.method || 'GET'
    if (path === '/canvases' && method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ canvases: [{ id: canvas.id, name: canvas.name, card_count: canvas.cards.length, updated_at: canvas.revision }] }) }
    if (path === '/canvases/' + canvas.id && method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify(canvas) }
    if (path === '/drafts' && method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ drafts }) }
    if (path === '/drafts/draft-confirm/confirm' && method === 'POST') {
      actions.push('confirm')
      canvas.cards.push(first.card)
      canvas.revision++
      drafts = drafts.filter(draft => draft.id !== first.id)
      return { ok: true, status: 200, text: async () => JSON.stringify({ canvas_id: canvas.id, revision: canvas.revision }) }
    }
    if (path === '/drafts/draft-cancel/cancel' && method === 'POST') {
      actions.push('cancel')
      drafts = drafts.filter(draft => draft.id !== second.id)
      return { ok: true, status: 200, text: async () => JSON.stringify({ cancelled: true }) }
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'unexpected request: ' + method + ' ' + path }) }
  }
  const { plugin } = loadClient({ initialCanvases: [canvas], fetchOverride,
    environment: { navigator: { clipboard: { writeText: async text => { copiedPrompt = text } } }, setInterval: fn => { poll = fn; return 1 }, clearInterval: () => {} } })
  const Page = applyPlugin(plugin)
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render()
  await flushEffects()
  render()
  assert.ok(poll, 'workspace should poll for drafts created while it is open')
  assert.equal(actions.length, 0, 'loading and rendering the preview must not confirm it')

  drafts = [first, second]
  await poll()
  await flushEffects()
  const html = render()
  assert.ok(html.includes('区域销售额预览'))
  assert.ok(html.includes('sales.csv'))
  assert.ok(html.includes('按区域汇总销售额'))
  assert.ok(html.includes('扣除退款'))
  assert.ok(renderedElements.find(el => el.props['data-xc-draft-confirm'] === first.id))
  assert.ok(renderedElements.find(el => el.props['data-xc-draft-cancel'] === second.id))
  assert.deepEqual(actions, [], 'the model-triggered draft and poll are read-only')

  await renderedElements.find(el => el.props['data-xc-draft-confirm'] === first.id).props.onClick()
  await flushEffects()
  assert.deepEqual(actions, ['confirm'])
  assert.equal(canvas.cards.length, 1)
  assert.equal(canvas.revision, 4)

  render()
  renderedElements.find(el => el.props['aria-label'] === '修改意见：取消此草稿').props.onChange({ target: { value: '改用完整的季度口径' } })
  render()
  await renderedElements.find(el => el.props['data-xc-draft-revise'] === second.id).props.onClick()
  await flushEffects()
  assert.match(copiedPrompt, /改用完整的季度口径/)
  assert.match(copiedPrompt, /读取最新画布版本/)
  assert.match(copiedPrompt, /canvas1/)
  assert.ok(render().includes('请粘贴到对话发送'))
  assert.deepEqual(actions, ['confirm', 'cancel'])
  assert.equal(canvas.cards.length, 1, 'cancelling a preview must not add a card')
  assert.equal(canvas.revision, 4, 'cancelling a preview must not change the canvas revision')
})

test('workspace polling replaces an older canvas preview with the feedback-generated latest draft', async () => {
  const canvas = { ...CANVAS, cards: [] }
  const oldDraft = { id: 'old-feedback-draft', canvas_id: canvas.id, canvas_name: canvas.name,
    card: { id: 'old-card', type: 'chart', title: '旧预览', chart_type: 'line', layout: { x: 0, y: 0, w: 48, h: 15 },
      echarts_option: { series: [{ type: 'line', data: [1] }] }, source: { dataset: 'sales.csv', query: '旧口径', note: null }, note: '' } }
  const latestDraft = { id: 'latest-feedback-draft', canvas_id: canvas.id, canvas_name: canvas.name,
    card: { id: 'latest-card', type: 'chart', title: '反馈后的新预览', chart_type: 'line', layout: { x: 0, y: 0, w: 48, h: 15 },
      echarts_option: { series: [{ type: 'line', data: [2] }] }, source: { dataset: 'sales.csv', query: '最新反馈口径', note: null }, note: '' } }
  let drafts = [oldDraft]
  let poll
  const fetchOverride = async url => {
    const path = String(url).split('/api/xcharts-canvas')[1] || ''
    if (path === '/canvases') return { ok: true, status: 200, text: async () => JSON.stringify({ canvases: [{ id: canvas.id, name: canvas.name, card_count: 0, updated_at: canvas.revision }] }) }
    if (path === '/canvases/' + canvas.id) return { ok: true, status: 200, text: async () => JSON.stringify(canvas) }
    if (path === '/drafts') return { ok: true, status: 200, text: async () => JSON.stringify({ drafts }) }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'unexpected request: ' + path }) }
  }
  const { plugin } = loadClient({ initialCanvases: [canvas], fetchOverride,
    environment: { setInterval: fn => { poll = fn; return 1 }, clearInterval: () => {} } })
  const Page = applyPlugin(plugin)
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render(); await flushEffects(); render()
  assert.ok(render().includes('旧预览'))
  drafts = [latestDraft]
  await poll(); await flushEffects()
  const latest = render()
  assert.deepEqual(
    renderedElements.filter(el => el.props['data-xc-draft-preview']).map(el => el.props['data-xc-draft-preview']),
    [latestDraft.id], 'the preview list must replace the superseded draft with the latest response',
  )
  assert.equal(renderedElements.some(el => el.props['data-xc-draft-preview'] === oldDraft.id), false, 'superseded preview node must be removed')
  assert.ok(latest.includes('反馈后的新预览'))
  assert.ok(latest.includes('最新反馈口径'))
  assert.equal(renderedElements.find(el => el.props['data-xc-draft-confirm'] === oldDraft.id), undefined)
  assert.ok(renderedElements.find(el => el.props['data-xc-draft-confirm'] === latestDraft.id))
})

test('an update preview confirms the original card through real routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-update-ui-'))
  try {
    const store = new CanvasStore(dir)
    let canvas = store.createCanvas({ name: '更新界面回归' })
    canvas = store.addCard(canvas.id, { type: 'text', title: '原卡', text_content: '旧内容' })
    const cardId = canvas.cards[0].id
    const draft = store.createCardUpdateDraft(canvas.id, cardId, { title: '修订卡', text_content: '新内容' }, canvas.revision)
    const { fetchOverride } = hostAdapter(store)
    const { plugin } = loadClient({ fetchOverride })
    const Page = applyPlugin(plugin)
    const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
    render(); await flushEffects(); render(); await flushEffects()
    const html = render()
    assert.ok(html.includes('更新已有卡片'))
    assert.ok(html.includes('确认并更新'))
    assert.ok(html.includes('新内容'))
    assert.equal(store.getCanvas(canvas.id).cards[0].text_content, '旧内容')
    await renderedElements.find(el => el.props['data-xc-draft-confirm'] === draft.id).props.onClick()
    await flushEffects()
    const saved = store.getCanvas(canvas.id)
    assert.equal(saved.cards.length, 1)
    assert.equal(saved.cards[0].id, cardId)
    assert.equal(saved.cards[0].text_content, '新内容')
    assert.equal(saved.revision, canvas.revision + 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the add-source dialog is Chinese, equal-height and its database inputs are visible', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-addsrc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const { fetchOverride } = hostAdapter(store)
  const { plugin } = loadClient({ fetchOverride })
  const Page = applyPlugin(plugin).__slots.main.find(entry => entry.meta.key === 'xcharts-datasources').component
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render(); await flushEffects(); render(); await flushEffects()

  const entry = renderedElements.find(e => e.props['data-xc-import'])
  assert.ok(entry, 'the create entry exists')
  assert.ok(render().includes('新增数据源'), 'the entry reads 新增数据源 in Chinese')
  await entry.props.onClick(); render(); await flushEffects()
  assert.ok(renderedElements.some(e => e.type === 'strong' && e.children.join('') === '新增数据源'), 'the dialog title is Chinese too')

  const tabs = renderedElements.filter(e => e.props['data-xc-source-tab'])
  assert.deepEqual(tabs.map(tab => tab.children.join('')), ['文件', '数据库'])
  const dropzone = renderedElements.find(e => e.props['data-xc-dropzone'])
  assert.equal(dropzone.props.style.height, '248px', 'the file pane has a fixed height')

  await renderedElements.find(e => e.props['data-xc-source-tab'] === 'database').props.onClick(); render(); await flushEffects()
  const form = renderedElements.find(e => e.props['data-xc-db-form'])
  assert.ok(form, 'the database pane renders')
  assert.equal(form.props.style.height, '248px', 'both panes share one height')
  const host = renderedElements.find(e => e.props['data-xc-db-field'] === 'host')
  assert.ok(host, 'the host input exists')
  assert.match(host.props.style.background, /var\(--dsw-alias-bg-base/, 'inputs have a visible background')
  assert.match(host.props.style.border, /1px solid/, 'and a visible border')
  for (const key of ['name', 'port', 'database', 'user', 'password']) {
    assert.ok(renderedElements.find(e => e.props['data-xc-db-field'] === key), `字段 ${key} 可见`)
  }
  assert.ok(renderedElements.find(e => e.props['data-xc-db-test']), '测试连接按钮存在')
})
test('the datasource page shows import-time parse warnings for the selected source', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-warn-ui-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const data = new DataStore(dir)
  const source = await data.import({
    name: '带告警的数据源',
    filename: 'warn.csv',
    content_base64: Buffer.from('a,b\n1,?\n2,3\n').toString('base64'),
  })
  assert.ok(data.get(source.id).warnings.length, 'the fixture really carries a warning')
  const { fetchOverride } = hostAdapter(store)
  const { plugin } = loadClient({ fetchOverride })
  const Page = applyPlugin(plugin).__slots.main.find(entry => entry.meta.key === 'xcharts-datasources').component
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render(); await flushEffects(); render(); await flushEffects()
  await renderedElements.find(el => el.props['data-xc-select-datasource'] === source.id).props.onClick()
  render(); await flushEffects(); render(); await flushEffects()
  // 解析提示现在是一条浮动消息，需要再渲染一次让 effect 推入。
  render(); await flushEffects()
  const warning = renderedElements.find(el => el.props['data-xc-source-warnings'])
  assert.ok(warning, 'the repair note is visible while the source is selected')
  assert.ok(render().includes('解析提示'), 'and it is written as a parse note')
  assert.ok(render().includes('缺失值'), 'naming the actual repair')
})
test('the datasource page mounts, and its query pane appears only when asked for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-ds-page-'))
  try {
    const store = new CanvasStore(dir)
    const data = new DataStore(dir)
    const source = await data.import({ name: '渲染用数据源', filename: 'sales.csv', content_base64: Buffer.from('month,amount\nJan,10\n').toString('base64') })
    const { fetchOverride } = hostAdapter(store)
    const { plugin } = loadClient({ fetchOverride })
    const CanvasPage = applyPlugin(plugin)
    const Page = CanvasPage.__slots.main.find(entry => entry.meta.key === 'xcharts-datasources').component
    assert.ok(Page, 'the datasource page must be registered in the main slot')
    const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
    render()
    await flushEffects()
    render()
    await flushEffects()
    const row = renderedElements.find(el => el.props['data-xc-select-datasource'] === source.id)
    assert.ok(row, 'the imported datasource must be listed')
    await row.props.onClick()
    await flushEffects()
    render()
    await flushEffects()
    const toggle = renderedElements.find(el => el.props['data-xc-query-pane-toggle'])
    assert.ok(toggle, 'the datasource page must render without a crash')
    assert.equal(renderedElements.find(el => el.props['data-xc-query-pane-resizer']), undefined, 'the pane stays closed by default')
    assert.equal(renderedElements.find(el => el.props['data-xc-query-builder']), undefined, 'the builder is not built until the pane opens')

    // The default view is the table alone: the query actions live in the page
    // header, and neither the identity line nor a query summary sits above the
    // table.
    const header = renderedElements.find(el => el.props['data-xc-datasource-header'])
    const inHeader = pred => header.children.some(child => child && child.props && pred(child))
    assert.ok(inHeader(c => c.props && c.props['data-xc-run-query']), '执行查询 belongs to the page header')
    assert.ok(renderedElements.find(el => el.props && el.props['data-xc-query-pane-toggle']), '配置查询 is an icon in the page header')
    assert.equal(renderedElements.find(el => el.props['data-xc-query-summary']), undefined, 'no query summary above the table')
    assert.equal(renderedElements.find(el => el.props['data-xc-data-toolbar']), undefined, 'no tool strip above the table until a result exists')
    assert.ok(renderedElements.find(el => el.props['data-xc-data-table-scroll']), 'and the table is there')
    const mainText = renderedElements
      .find(el => el.props['data-xc-data-main']).children
      .filter(Boolean).map(c => (c && c.children ? c.children.join('') : '')).join(' ')
    assert.equal(mainText.includes('渲染用数据源'), false, 'the identity is not repeated inside the content pane')
    assert.equal(mainText.includes('CSV'), false, 'nor is the format')

    await toggle.props.onClick()
    await flushEffects()
    const html = render()
    assert.ok(renderedElements.find(el => el.props['data-xc-query-pane-resizer']), 'opening the pane adds the drag divider')
    assert.ok(renderedElements.find(el => el.props['data-xc-query-builder']), 'the builder mounts inside the pane')
    assert.ok(html.includes('查询构建器'))
    const resizer = renderedElements.find(el => el.props['data-xc-query-pane-resizer'])
    assert.equal(resizer.props['aria-orientation'], 'vertical')
    await renderedElements.find(el => el.props['data-xc-query-pane-close']).props.onClick()
    await flushEffects()
    render()
    assert.equal(renderedElements.find(el => el.props['data-xc-query-pane-resizer']), undefined, 'closing removes the pane again')

    // Running a query keeps the raw preview in place and adds a result view.
    await renderedElements.find(el => el.props['data-xc-run-query']).props.onClick()
    await flushEffects()
    render()
    await flushEffects()
    const resultTab = renderedElements.find(el => el.props['data-xc-data-tab'] === 'result')
    assert.ok(resultTab, 'a ready result must add its own view')
    assert.equal(resultTab.props['aria-selected'], false, 'the raw preview stays selected')
    await resultTab.props.onClick()
    await flushEffects()
    render()
    const resultHtml = render()
    assert.ok(renderedElements.find(el => el.props['data-xc-add-to-canvas']), 'the canvas action sits on the tool row')
    // One control per action: the raw preview is reached through its tab, not
    // through a second button that does the same thing.
    assert.equal(renderedElements.find(el => el.props['data-xc-back-to-preview']), undefined, 'no duplicate "back to preview" control')
    await renderedElements.find(el => el.props['data-xc-data-tab'] === 'preview').props.onClick()
    await flushEffects()
    render()
    assert.equal(renderedElements.find(el => el.props['data-xc-data-tab'] === 'preview').props['aria-selected'], true, 'the tab is the way back')
    await renderedElements.find(el => el.props['data-xc-data-tab'] === 'result').props.onClick()
    await flushEffects()
    render()
    // The identity (name · format · rows · columns) is stated once, in the page
    // header, so the content pane must not repeat it.
    const headerText = renderedElements.find(el => el.props['data-xc-datasource-header']).children
      .filter(Boolean).map(c => (c && c.children ? c.children.join('') : '')).join(' ')
    assert.match(headerText, /数据源与分析/)
    assert.match(headerText, /渲染用数据源 · CSV · 1 行 · 2 列/, 'the open source is identified once, in the header')
    const toolbar = renderedElements.find(el => el.props['data-xc-data-toolbar'])
    const toolbarText = toolbar.children.filter(Boolean).map(c => (c && c.children ? c.children.join('') : '')).join(' ')
    assert.equal(toolbarText.includes('CSV'), false, 'no second copy of the source identity in the content pane')
    assert.equal(toolbarText.includes('数据源'), false, 'no second copy of the source name in the content pane')
    const pagerText = renderedElements.find(el => el.props['data-xc-table-pager']).children
      .filter(Boolean).map(c => (c && c.children ? c.children.join('') : '')).join(' ')
    assert.equal(pagerText, '1 条', 'the pager states the row range only; column count lives in the result bar')
    assert.ok(renderedElements.find(el => el.props['data-xc-table-tools'] === 'result'), 'the table toolbar sits in the top-right corner')
    assert.ok(renderedElements.find(el => el.props['data-xc-table-fullscreen'] === 'result'), 'fullscreen is an icon in the toolbar')
    // The 口径 line only appears when the stored query is no longer the one on
    // screen; here nothing changed after running, so there is nothing to say.
    assert.equal(renderedElements.find(el => el.props['data-xc-result-note']), undefined, 'no restatement of the config that is already visible')
    assert.equal(resultHtml.includes('完整结果'), false, 'completeness is the absence of a truncation marker')
    // Diagnostics live with the other diagnostics inside the query pane.
    assert.equal(resultHtml.includes('复制诊断信息'), false, 'no diagnostics button floating above the table')
    await renderedElements.find(el => el.props['data-xc-query-pane-toggle']).props.onClick()
    await flushEffects()
    const paneHtml = render()
    assert.ok(paneHtml.includes('复制诊断信息'), 'diagnostics sit in 说明与诊断')
    assert.equal(paneHtml.includes('source_hash'), false, 'no raw JSON dump of the query')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the card menu opens the shared provenance dialog instead of a text dump', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xctraceui-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const canvas = store.createCanvas({ name: '溯源界面', cards: [{ type: 'chart', title: '区域销售', chart_type: 'bar',
    echarts_option: { xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: {}, series: [{ type: 'bar', data: [1, 2] }] },
    dataset: 'car.csv', query: '按区域汇总销售额', note: '完整来源备注。' }] })
  const { render } = await readyWorkspace(hostAdapter(store))
  const before = render()
  assert.equal(renderedElements.find(el => el.props['data-xc-source-details']), undefined, 'no provenance strip on the card')
  assert.equal(before.includes('完整来源备注'), false)

  await renderedElements.find(el => el.props['data-xc-card'] === canvas.cards[0].id).props.onContextMenu({ preventDefault () {}, stopPropagation () {}, clientX: 10, clientY: 10 })
  await flushEffects()
  render()
  const entry = renderedElements.find(el => el.props['data-xc-source-menu'] === canvas.cards[0].id)
  assert.ok(entry, 'the card menu offers 溯源')
  await entry.props.onClick()
  for (let i = 0; i < 4; i++) { await flushEffects(); render() }
  assert.ok(renderedElements.find(el => el.props['data-xc-trace-dialog']), 'the menu entry opens the provenance dialog')
  // Three independent dimensions, never one combined "trusted" light.
  const title = render()
  assert.ok(title.includes('数据') && title.includes('计算') && title.includes('会话'), title.slice(0, 400))
})

test('provenance dialog copies the stored method and reports the outcome in place', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xctracecopy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const canvas = store.createCanvas({ name: '复制', cards: [{ type: 'text', title: '外部计算', text_content: '平均数',
    dataset: 'sales.csv', query: '自行计算平均数' }] })
  let copied = ''
  const { render } = await readyWorkspace({ ...hostAdapter(store), environment: { navigator: { clipboard: { writeText: async text => { copied = text } } } } })
  await renderedElements.find(el => el.props['data-xc-card'] === canvas.cards[0].id).props.onContextMenu({ preventDefault () {}, stopPropagation () {}, clientX: 10, clientY: 10 })
  await flushEffects(); render()
  await renderedElements.find(el => el.props['data-xc-source-menu'] === canvas.cards[0].id).props.onClick()
  for (let i = 0; i < 4; i++) { await flushEffects(); render() }
  const copy = renderedElements.find(el => el.props['data-xc-trace-copy'])
  assert.ok(copy, 'the dialog offers an explicit copy action')
  await copy.props.onClick()
  await flushEffects(); render()
  assert.equal(copied, '自行计算平均数', 'copy takes the stored method, not a re-rendered guess')
  assert.ok(render().includes('已复制'), 'the button reports success in place')
})

test('deleting a card asks nothing, writes once, and names the way back', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xccarddelete-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const canvas = store.createCanvas({ name: '删除卡片', cards: [
    { type: 'text', title: 'A', layout: { x: 0, y: 0, w: 20, h: 8 } },
    { type: 'text', title: 'B', layout: { x: 24, y: 0, w: 20, h: 8 } },
  ] })
  const host = hostAdapter(store)
  const { render, nativeDialogs } = await readyWorkspace(host)
  const before = store.getCanvas(canvas.id)
  const card = renderedElements.find(el => el.props['data-xc-card'] === before.cards[0].id)
  card.props.onContextMenu({ preventDefault () {}, stopPropagation () {}, clientX: 10, clientY: 10 })
  render()
  await renderedElements.find(el => el.props['data-xc-menu-item'] === 'delete').props.onClick()
  render()
  // Undoable, therefore unasked: no themed confirm, and certainly no native one.
  assert.equal(renderedElements.find(el => el.props['data-xc-confirm-ok']), undefined,
    'an undoable delete must not interrupt with a confirmation')
  assert.deepEqual(nativeDialogs, [], 'the bundle must not reach for window.confirm/prompt')
  await flushEffects(); render()
  assert.equal(store.getCanvas(canvas.id).cards.length, 1)
  const notice = renderedElements.find(el => el.props['data-xc-notice'])
  assert.ok(notice, 'the result must be reported on the status line')
  assert.match(notice.children.join(''), /Ctrl\+Z/, 'the status line must name the way back')
})

test('deleting a canvas asks through the themed danger confirm and can be declined', async () => {
  const { render, nativeDialogs } = await readyWorkspace()
  renderedElements.find(el => el.props['data-xc-board']).props.onContextMenu({ preventDefault () {}, clientX: 0, clientY: 0 })
  render()
  await renderedElements.find(el => el.props['data-xc-menu-item'] === 'delete-canvas').props.onClick()
  render()
  const section = renderedElements.find(el => el.props.role === 'dialog')
  assert.ok(section, 'deleting a canvas is the case that still asks')
  assert.match(section.props.style.borderRadius, /--dsw-radius-lg/, 'the dialog uses the menu radius token')
  assert.match(section.props.style.boxShadow, /--dsw-elevation-panel/, 'the dialog uses the menu elevation token')
  const overlay = renderedElements.find(el => el.props.style?.zIndex === 1000 && el.props.style?.inset === 0)
  assert.equal(overlay.props.style.background, 'rgba(0,0,0,.35)', 'the mask keeps its previous value')
  assert.equal(section.props.style.background, 'var(--dsw-alias-bg-base, #fff)',
    'the panel keeps its previous opaque fill')
  const header = renderedElements.find(el => el.props['data-xc-dialog-header'])
  const body = renderedElements.find(el => el.props['data-xc-dialog-body'])
  assert.ok(header && body, 'the dialog is a header/body/footer skeleton')
  assert.equal(body.props.style.overflow, 'auto', 'only the body scrolls')
  assert.notEqual(header.props.style.overflow, 'auto', 'the title never scrolls away')
  const ok = renderedElements.find(el => el.props['data-xc-confirm-ok'])
  const cancel = renderedElements.find(el => el.props['data-xc-confirm-cancel'])
  assert.equal(ok.children.join(''), '删除')
  assert.match(ok.props.style.background, /state-error-primary/, 'a danger action is not painted with the brand colour')
  assert.deepEqual(nativeDialogs, [])
  await cancel.props.onClick(); render()
  assert.equal(renderedElements.find(el => el.props.role === 'dialog'), undefined)
  assert.ok(renderedElements.find(el => el.props['data-xc-board']), 'declining keeps the canvas')
})

test('deleting a datasource keeps the promise its confirm makes, and the confirm is themed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xcdsdelete-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const data = new DataStore(dir)
  const source = await data.import({ name: '待删除数据源', filename: 'sales.csv', content_base64: Buffer.from('month,amount\nJan,10\n').toString('base64') })
  const { fetchOverride } = hostAdapter(store)
  const { plugin, nativeDialogs } = loadClient({ fetchOverride })
  const Page = applyPlugin(plugin).__slots.main.find(entry => entry.meta.key === 'xcharts-datasources').component
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render(); await flushEffects(); render(); await flushEffects()
  await renderedElements.find(el => el.props['data-xc-select-datasource'] === source.id).props.onClick()
  await flushEffects(); render()
  renderedElements.find(el => el.props['data-xc-datasource-menu'] === source.id)
    .props.onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 220, bottom: 30 }) } })
  render()
  await renderedElements.find(el => el.props['data-xc-menu-item'] === 'delete').props.onClick()
  render()
  const body = renderedElements.find(el => el.props['data-xc-dialog-body'])
  assert.ok(body, 'deleting a datasource asks')
  const text = render()
  assert.ok(text.includes('已有查询结果和画布卡片会保留'), 'the confirm states the consequence it promises')
  assert.deepEqual(nativeDialogs, [], 'the themed confirm replaced window.confirm')
  const cancel = renderedElements.find(el => el.props['data-xc-confirm-cancel'])
  await cancel.props.onClick(); render()
  assert.ok(renderedElements.find(el => el.props['data-xc-select-datasource'] === source.id), 'declining keeps the source')
})

test('the prompt dialog blocks an empty value, submits on Enter and cancels on Escape', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xcprompt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  store.createExampleCanvas()
  const { render, nativeDialogs } = await readyWorkspace(hostAdapter(store))
  const open = async () => {
    await renderedElements.find(e => e.props['data-xc-templates']).props.onClick(); render()
    await renderedElements.find(e => e.props['data-xc-template-save']).props.onClick(); render()
  }
  const type = (value, key) => {
    const input = renderedElements.find(e => e.props['data-xc-prompt-input'])
    input.props.onChange({ target: { value } }); render()
    if (key) renderedElements.find(e => e.props['data-xc-prompt-input']).props.onKeyDown({ key, preventDefault () {}, currentTarget: { value } })
    render()
  }

  await open()
  assert.ok(renderedElements.find(e => e.props['data-xc-prompt-input']), 'naming opens the themed prompt')
  assert.equal(renderedElements.find(e => e.props['data-xc-prompt-ok']).props.disabled, true,
    'an empty name cannot be submitted')
  // Escape abandons without writing anything.
  type('放弃的名字', 'Escape'); await flushEffects()
  assert.equal(renderedElements.find(e => e.props['data-xc-prompt-input']), undefined, 'Escape closes the prompt')
  assert.equal(store.listTemplates().length, 0)

  await open()
  // Enter (with the caret in the field) submits the typed name.
  type('回车创建', 'Enter'); await flushEffects(); render()
  assert.equal(store.listTemplates().length, 1)
  assert.equal(store.listTemplates()[0].name, '回车创建')
  assert.deepEqual(nativeDialogs, [])
})

test('the card title renames in place: Enter saves, Escape abandons, blur saves', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xcinline-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const canvas = store.createCanvas({ name: '就地重命名', cards: [{ type: 'text', title: '原标题', layout: { x: 0, y: 0, w: 40, h: 8 } }] })
  const { render, nativeDialogs } = await readyWorkspace(hostAdapter(store))
  const cardId = () => store.getCanvas(canvas.id).cards[0].id
  const headerOf = () => renderedElements.find(el => el.props['data-xc-card-header'] === cardId())
  const type = (value, key) => {
    const input = renderedElements.find(e => e.props['data-xc-card-rename-input'] === cardId())
    assert.ok(input, 'the title must have become an input')
    if (key) input.props.onKeyDown({ key, preventDefault () {}, stopPropagation () {}, currentTarget: { value } })
    else input.props.onBlur({ currentTarget: { value } })
    render()
  }

  headerOf().props.onDoubleClick({ stopPropagation () {} }); render()
  const input = renderedElements.find(e => e.props['data-xc-card-rename-input'] === cardId())
  assert.ok(input, 'double-clicking the header edits the title where it is')
  assert.equal(input.props.defaultValue, '原标题')
  assert.deepEqual(nativeDialogs, [], 'no prompt is involved')

  type('改过的标题', 'Escape'); await flushEffects(); render()
  assert.equal(store.getCanvas(canvas.id).cards[0].title, '原标题', 'Escape must abandon the edit')

  headerOf().props.onDoubleClick({ stopPropagation () {} }); render()
  type('回车标题', 'Enter'); await flushEffects(); render()
  assert.equal(store.getCanvas(canvas.id).cards[0].title, '回车标题')

  headerOf().props.onDoubleClick({ stopPropagation () {} }); render()
  type('失焦标题'); await flushEffects(); render()
  assert.equal(store.getCanvas(canvas.id).cards[0].title, '失焦标题', 'blur commits, like the datasource list')
})

test('the themed Select is a keyboard-complete combobox', async () => {
  const { render } = await readyWorkspace()
  const trigger = () => renderedElements.find(e => e.props['data-xc-zoom'])
  const panel = () => renderedElements.find(e => e.props['data-xc-select-panel'])
  const options = () => renderedElements.filter(e => e.props['data-xc-option'] !== undefined)
  const active = () => options().find(o => o.props['data-active'] === 'true')?.props['data-xc-option']
  const key = k => { trigger().props.onKeyDown({ key: k, preventDefault () {}, stopPropagation () {} }); render() }

  assert.equal(trigger().props.role, 'combobox')
  assert.equal(trigger().props['aria-haspopup'], 'listbox')
  assert.equal(trigger().props['aria-expanded'], 'false')
  assert.equal(panel(), undefined, 'the listbox is not built until it is asked for')

  key('Enter')
  assert.ok(panel(), 'Enter opens the listbox')
  assert.equal(trigger().props['aria-expanded'], 'true')
  assert.equal(active(), '1', 'opening puts the highlight on the current value')
  assert.ok(options().every(option => option.props.tabIndex === undefined),
    'listbox rows are reached with the arrows, never with Tab')

  key('ArrowDown')
  assert.notEqual(active(), '1', 'the arrows move the highlight')
  key('Home'); assert.equal(active(), '0.1')
  key('End'); assert.equal(active(), '2')
  key('Escape')
  assert.equal(panel(), undefined, 'Escape closes the listbox')
  assert.equal(selectLabel('data-xc-zoom'), '100%', 'Escape must not change the value')

  // Type-ahead: the first label starting with the typed character wins.
  key('5')
  assert.equal(selectLabel('data-xc-zoom'), '50%')
  // Closed, the arrows step the value like a native select.
  key('ArrowDown')
  assert.notEqual(selectLabel('data-xc-zoom'), '50%')
})

test('a themed Select marks the current value with the host fill, never a system colour', async () => {
  const { render } = await readyWorkspace()
  const trigger = () => renderedElements.find(e => e.props['data-xc-theme-palette'])
  trigger().props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 38 }) } })
  render()
  // Move the highlight off the current value so both states are visible at once.
  renderedElements.find(e => e.props['data-xc-select-panel'])
  renderedElements.find(e => e.props['data-xc-option'] === 'pastel').props.onPointerEnter()
  render()
  const selected = renderedElements.find(e => e.props['data-xc-option'] === 'classic')
  assert.equal(selected.props['data-selected'], 'true')
  assert.match(selected.props.style.background, /^color-mix\(in srgb, var\(--dsw-alias-label-primary/,
    'selection is the host translucent fill, not a system accent')
  assert.equal(/\b(blue|#0[0-9a-f]{3,5})\b/i.test(selected.props.style.background), false)
  // The listbox surface is the menu surface.
  const panel = renderedElements.find(e => e.props['data-xc-select-panel'])
  assert.match(panel.props.style.background, /--dsw-menu-surface-fill/)
  assert.match(panel.props.style.boxShadow, /--dsw-elevation-panel/)
  assert.equal(panel.props.role, 'listbox')
})

test('a dropdown inside a card escapes the card instead of being clipped', async () => {
  const canvas = { ...CANVAS, cards: [{ id: 'table-card', type: 'table', title: 'T', layout: { x: 0, y: 0, w: 48, h: 15 },
    table_data: { columns: ['区域', '值'], rows: [['华东', 1], ['华南', 2]] } }] }
  const { render } = await readyWorkspace({ initialCanvases: [canvas] })
  const card = renderedElements.find(e => e.props['data-xc-card'] === 'table-card')
  assert.equal(card.props.style.overflow, 'visible', 'the card must not clip its own popups')
  renderedElements.find(e => e.props['data-xc-table-column']).props.onClick({
    currentTarget: { getBoundingClientRect: () => ({ left: 20, top: 20, right: 120, bottom: 48 }) },
  })
  render()
  const panel = renderedElements.find(e => e.props['data-xc-select-panel'])
  assert.ok(panel, 'the in-card dropdown opens its own listbox')
  assert.ok(['fixed', 'absolute'].includes(panel.props.style.position),
    'the panel is taken out of flow so no ancestor overflow can clip it')
})

test('the card menu keeps danger last in its own group and carries one icon per meaning', async () => {
  const { render } = await readyWorkspace()
  renderedElements.find(e => e.props['data-xc-card'] === 'c1')
    .props.onContextMenu({ preventDefault () {}, stopPropagation () {}, clientX: 8, clientY: 8 })
  render()
  const rows = renderedElements.filter(e => e.props['data-xc-menu-index'] !== undefined)
  assert.deepEqual(rows.map(e => e.props['data-xc-menu-item']),
    ['focus', 'rename', 'duplicate', 'source-details', 'ask-card', 'toggle-header', 'delete'])
  const icons = rows.map(e => e.props['data-xc-menu-icon'])
  assert.equal(new Set(icons).size, icons.length, 'one glyph per meaning inside a menu')
  const children = renderedElements.find(e => e.props.role === 'menu').children
  assert.equal(children.at(-1).props['data-xc-menu-item'], 'delete', 'danger is always last')
  assert.equal(children.at(-2).props.role, 'separator', 'and always alone in its group')
})

test('menus are fully keyboard operable', async () => {
  const { render, emit } = await readyWorkspace()
  const menu = () => renderedElements.find(e => e.props.role === 'menu')
  const activeId = () => renderedElements.find(e => e.props['data-active'] === 'true')?.props['data-xc-menu-item']
  const key = k => { emit('keydown', { key: k, preventDefault () {}, stopPropagation () {} }); render() }

  const openMenu = async () => {
    renderedElements.find(e => e.props['data-xc-card'] === 'c1')
      .props.onContextMenu({ preventDefault () {}, stopPropagation () {}, clientX: 8, clientY: 8 })
    render()
    // The menu's key handling is a window listener registered by an effect.
    await flushEffects(); render()
  }
  await openMenu()
  assert.ok(menu(), 'the card menu opens')
  assert.equal(activeId(), 'focus', 'the first row starts highlighted')

  key('ArrowDown'); assert.equal(activeId(), 'rename')
  key('End'); assert.equal(activeId(), 'delete')
  key('ArrowDown'); assert.equal(activeId(), 'focus', 'the arrows wrap forwards')
  key('ArrowUp'); assert.equal(activeId(), 'delete', 'and backwards')
  key('Home'); assert.equal(activeId(), 'focus')

  // Escape closes without triggering anything.
  key('Escape')
  assert.equal(menu(), undefined)

  // Enter triggers the highlighted row.
  await openMenu()
  key('End'); key('Enter'); await flushEffects(); render()
  assert.equal(menu(), undefined, 'selecting closes the menu')
})

test('Ctrl+Alt+B toggles the canvas list, exactly as aria-keyshortcuts advertises', async () => {
  const { render, emit } = await readyWorkspace({ environment: { document: { activeElement: { tagName: 'DIV' } } } })
  assert.equal(renderedElements.find(e => e.props['data-xc-toggle-list']).props['aria-keyshortcuts'], 'Control+Alt+B')
  // The list stays mounted and folds to zero width, so its scroll position and
  // search text survive — the state is what changes.
  const listState = () => renderedElements
    .find(e => e.props['data-xc-canvas-list'] && e.props['data-xc-side-list'])
    ?.props['data-xc-side-list']
  assert.equal(listState(), 'expanded')
  const press = () => { emit('keydown', { key: 'b', altKey: true, ctrlKey: false, shiftKey: false, preventDefault () {} }); render() }
  press()
  assert.equal(listState(), 'collapsed', 'the declared shortcut must actually work')
  press()
  assert.equal(listState(), 'expanded', 'and toggle back')
})

test('table sorts every loaded row before pagination and resets the page when sorting', async () => {
  const canvas = { ...CANVAS, cards: [{ id: 'table', type: 'table', title: 'All data', layout: { x: 0, y: 0, w: 96, h: 20 },
    table_data: { columns: ['key', 'value'], rows: Array.from({ length: 65 }, (_, i) => [`row-${i + 1}`, i + 1]) } }] }
  const { render } = await readyWorkspace({ initialCanvases: [canvas] })
  const cells = () => renderedElements.filter(e => e.type === 'td').map(e => e.children.join(''))
  const header = () => renderedElements.find(e => e.props['data-xc-sort-col'] === '1')
  assert.ok(!cells().includes('row-65'))
  header().props.onClick(); render()
  header().props.onClick(); render()
  assert.equal(cells()[0], 'row-65', 'highest value outside original first page must sort to the front')
  renderedElements.find(e => e.props['data-xc-page-next']).props.onClick(); render()
  assert.equal(cells()[0], 'row-35')
  header().props.onClick(); render()
  assert.equal(cells()[0], 'row-1', 'natural order and first page restored')
})

test('settings use the two-pane layout: nav sections, switch rows, storage and about', async () => {
  const { render, emit } = await readyWorkspace()
  await flush() // the changelog read settles before the dialog is opened
  assert.equal(renderedElements.filter(e => e.props['data-xc-resize']).length, CANVAS.cards.length * 8)
  assert.equal(renderedElements.some(e => e.type === 'button' && e.children.join('') === '删除'), false)
  renderedElements.find(e => e.props['data-xc-settings']).props.onClick(); render(); await flushEffects()
  assert.ok(renderedElements.find(e => e.props.role === 'dialog'))

  // The left rail names the sections, the same shape as the host settings dialog.
  assert.deepEqual(renderedElements.filter(e => e.props['data-xc-settings-nav']).map(e => e.props['data-xc-settings-nav']), ['display', 'backup', 'storage', 'about'])
  assert.equal(renderedElements.find(e => e.props['data-xc-settings-content']).props['data-xc-settings-content'], 'display')

  // Display: one switch row per setting, all off by default, plus the zoom reset.
  const switches = renderedElements.filter(e => e.props['data-xc-setting'])
  assert.deepEqual(switches.map(e => e.props['data-xc-setting']), ['snap', 'wide', 'badges'])
  assert.ok(switches.every(e => e.props.checked === false && e.props.role === 'switch' && e.props['aria-checked'] === 'false'))
  assert.ok(renderedElements.find(e => e.props['data-xc-reset-zoom']), 'the zoom reset is a row, not a stray button')

  // Backup: real export/import rows, with the scope explained in the row itself.
  renderedElements.find(e => e.props['data-xc-settings-nav'] === 'backup').props.onClick(); render(); await flushEffects()
  assert.equal(renderedElements.find(e => e.props['data-xc-settings-content']).props['data-xc-settings-content'], 'backup')
  assert.ok(renderedElements.find(e => e.props['data-xc-backup-export']), 'the backup pane exports a real file')
  assert.ok(renderedElements.find(e => e.props['data-xc-backup-import']), 'and imports one')
  assert.ok(renderedElements.find(e => e.props['data-xc-backup-input']), 'through a file input, not a text box')

  // Storage: location comes from the host response and is visible without expanding.
  await flush()
  renderedElements.find(e => e.props['data-xc-settings-nav'] === 'storage').props.onClick(); render(); await flushEffects(); await flush(); render(); await flushEffects()
  assert.equal(renderedElements.find(e => e.props['data-xc-settings-content']).props['data-xc-settings-content'], 'storage')
  assert.ok(renderedElements.find(e => e.props['data-xc-storage-path']), 'the settings dialog shows where the data is stored')
  assert.ok(render().includes('D:/dsh-home/storages/xcharts-canvas'), 'the path comes from the host response')
  assert.ok(renderedElements.some(e => e.props['data-xc-storage-clean'] === 'history'), 'and offers a cleanup action')

  // About: version plus the bundled changelog in its own dialog.
  renderedElements.find(e => e.props['data-xc-settings-nav'] === 'about').props.onClick(); render(); await flushEffects()
  assert.ok(renderedElements.find(e => e.props['data-xc-version']), 'the about pane shows the installed version')
  renderedElements.find(e => e.props['data-xc-changelog']).props.onClick(); render(); await flushEffects()
  assert.ok(renderedElements.find(e => e.props['data-xc-changelog-dialog']), 'clicking it opens the changelog dialog')
  assert.ok(render().includes('更新日志测试条目'), 'the dialog shows the bundled changelog lines')

  emit('keydown', { key: 'Escape', preventDefault () {}, stopPropagation () {} }); render()
  assert.ok(!renderedElements.find(e => e.props.role === 'dialog'))
  renderedElements.find(e => e.props['data-xc-toggle-list']).props.onClick(); render()
  assert.equal(renderedElements.find(e => e.props['data-xc-workspace-row']).props.style.gap, 0)
  assert.equal(
    renderedElements.find(e => e.props['data-xc-canvas-list'] && e.props['data-xc-side-list']).props['data-xc-side-list'],
    'collapsed',
  )
})
test('card type badges are hidden by default and appear only when the setting is on', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xcbadges-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const canvas = store.createExampleCanvas()
  const { render } = await readyWorkspace(hostAdapter(store))

  // Default: no badge anywhere, so the header shows title + focus only.
  assert.equal(renderedElements.filter(e => e.props['data-xc-card-badge']).length, 0,
    'type labels must be off by default')

  // Turn the setting on through the real settings dialog + route.
  renderedElements.find(e => e.props['data-xc-settings']).props.onClick(); render()
  await renderedElements.find(e => e.props['data-xc-setting'] === 'badges').props.onClick()
  render(); await flushEffects(); render()
  assert.equal(store.getCanvas(canvas.id).settings.badges, true)

  const badges = renderedElements.filter(e => e.props['data-xc-card-badge'])
  assert.equal(badges.length, canvas.cards.filter(c => c.show_header !== false).length,
    'every visible header carries its type label once enabled')
  // Every card type resolves to a real label, including code (which previously
  // fell through to the literal key `card.code`).
  const labels = badges.map(b => b.children.join(''))
  for (const label of labels) assert.ok(label && !/^card\./.test(label), `untranslated badge: ${label}`)
  assert.ok(labels.includes('代码'), 'code cards must render a translated label')

  // And it persists as a canvas setting.
  assert.equal(new CanvasStore(dir).getCanvas(canvas.id).settings.badges, true)
})

test('focus uses the original card content and search selects the requested result', async () => {
  const { render } = await readyWorkspace()
  renderedElements.find(e => e.props['data-xc-focus'] === 'c5').props.onClick({ stopPropagation () {} }); render()
  assert.equal(renderedElements.find(e => e.props.role === 'dialog').props['aria-label'], '明细')
  assert.ok(renderedElements.find(e => e.props['data-xc-focus-body'] === 'c5'))
  renderedElements.find(e => e.props['data-xc-dialog-close']).props.onClick()
  render()
  render()
  renderedElements.find(e => e.props['data-xc-search']).props.onClick(); render()
  renderedElements.find(e => e.props['data-xc-search-input']).props.onChange({ target: { value: '营收' } }); render()
  const results = renderedElements.filter(e => e.props['data-xc-search-result'])
  assert.equal(results.length, 1)
  assert.equal(results[0].props['data-xc-search-result'], 'c6')
  results[0].props.onClick(); render()
  assert.ok(renderedElements.find(e => e.props['data-xc-card'] === 'c6').props.style.outline)
})

test('four-edge resizing preserves opposite edges and enforces size and wide boundaries', () => {
  const { pure } = loadClient()
  const rect = { x: 24, y: 10, w: 32, h: 16 }
  const west = pure.dragLayout(rect, 'w', -10, 0)
  assert.equal(west.x + west.w, 56)
  assert.equal(west.x, 14)
  const north = pure.dragLayout(rect, 'n', 0, -4)
  assert.equal(north.y + north.h, 26)
  assert.equal(north.y, 6)
  assert.equal(pure.dragLayout(rect, 's', 0, 100).h, 32)
  assert.equal(pure.dragLayout(rect, 'e', -100, 0).w, 16)
  assert.equal(pure.dragLayout(rect, 'move', 200, -100).x, 64)
  assert.equal(pure.dragLayout(rect, 'move', 200, -100, 1536).x, 224)
  assert.equal(pure.dragLayout(rect, 'move', 200, -100, 1536).y, 0)
})

test('group move preserves offsets at boundaries; alignment and distribution retain endpoints', () => {
  const { pure } = loadClient()
  const cards = [0, 32, 76].map((x, i) => ({ id: String(i), layout: { x, y: i * 10, w: 20, h: 8 } }))
  const moved = pure.groupMove(cards, 100, -20)
  assert.equal(moved['1'].x - moved['0'].x, 32)
  assert.equal(moved['0'].y, 0)
  assert.equal(moved['2'].x, 76)
  const spaced = pure.alignGroup(cards, 'spaceX')
  assert.equal(spaced['1'].x, 38)
  assert.equal(spaced['2'].x, 76)
  const aligned = pure.alignGroup(cards, 'alignRight')
  assert.deepEqual(Object.values(aligned).map(r => r.x), [76, 76, 76])
  assert.throws(() => pure.alignGroup(cards.slice(0, 2), 'spaceX'), /three/)
})

test('snapping chooses closest anchor and tolerance follows screen zoom', () => {
  const { pure } = loadClient()
  const rect = { x: 31, y: 20, w: 20, h: 8 }
  const others = [{ layout: { x: 32, y: 0, w: 24, h: 8 } }, { layout: { x: 30, y: 0, w: 20, h: 8 } }]
  assert.equal(pure.snapLayout(rect, others, 5, 22, 1, 96).layout.x, 32)
  assert.equal(pure.snapLayout(rect, others, 5, 22, 2, 96).layout.x, 31)
  assert.ok(pure.snapLayout(rect, others, 5, 22, 1, 96).lines.v.includes(32))
})

test('HTML export is offline, escapes data, preserves dark theme and includes all table rows and KPI fields', () => {
  const { pure } = loadClient()
  const canvas = structuredClone(CANVAS)
  canvas.name = '<script>danger</script>'
  canvas.cards[0].source = { note: '<source & note>' }
  canvas.cards.find(c => c.type === 'table').table_data.rows = Array.from({ length: 65 }, (_, i) => [`row-${i}`, '<img onerror=bad>'])
  const images = Object.fromEntries(canvas.cards.filter(c => c.type === 'chart').map(c => [c.id, 'data:image/png;base64,AAAA']))
  const html = pure.exportHtml(canvas, { isDark: true }, images)
  assert.ok(html.includes('row-64'))
  assert.ok(html.includes('&lt;img onerror=bad&gt;'))
  assert.ok(html.includes('&lt;script&gt;danger&lt;/script&gt;'))
  assert.ok(html.includes('&lt;source &amp; note&gt;'), 'note-only source must be escaped and included in HTML')
  assert.ok(html.includes('Target: 100'))
  assert.ok(html.includes('80.0%'))
  assert.ok(html.includes('-12'))
  assert.ok(html.includes('#15171b'))
  assert.ok(html.includes("default-src 'none'"))
  assert.doesNotMatch(html, /<script|https?:\/\//)
  assert.throws(() => pure.exportHtml(canvas, {}, {}), /Chart unavailable/)
})

test('PNG renderer paints table rows, KPI unit/delta/target and dark surfaces', () => {
  const { pure } = loadClient()
  const texts = [], colors = [], draws = []
  const ctx = new Proxy({
    measureText: text => ({ width: String(text).length * 6 }),
    fillText: (text, x, y) => { const value = String(text); texts.push(value); draws.push({ text: value, y }) },
  }, {
    get: (object, key) => key in object ? object[key] : () => {},
    set: (object, key, value) => { object[key] = value; if (key === 'fillStyle') colors.push(value); return true },
  })
  pure.drawExportCard(ctx, CANVAS.cards.find(c => c.type === 'table'), { isDark: true }, null, 1200)
  pure.drawExportCard(ctx, CANVAS.cards.find(c => c.type === 'kpi'), { isDark: true }, null, 1200)
  assert.ok(texts.includes('区域'))
  assert.ok(texts.includes('华东'))
  assert.ok(texts.some(s => s.includes('80 万')))
  assert.ok(texts.some(s => s.includes('-12')))
  assert.ok(texts.some(s => s.includes('Target: 100')))
  assert.ok(colors.includes('#202329'))

  const noteOnly = {
    id: 'note-png', type: 'text', title: '仅备注来源', show_header: false,
    text_content: '正文内容 '.repeat(180), layout: { x: 0, y: 0, w: 48, h: 15 },
    source: { note: '只有备注来源 '.repeat(40) },
  }
  pure.drawExportCard(ctx, noteOnly, { isDark: true }, null, 1200)
  const body = draws.filter(draw => draw.text.startsWith('正文内容'))
  const footer = draws.filter(draw => draw.text.endsWith('…')).at(-1)
  assert.ok(body.length > 0, 'note-only card body must render')
  assert.ok(footer && footer.text.includes('只有备注来源'), 'long note-only provenance must render with a visible truncation marker')
  assert.ok(footer.y - Math.max(...body.map(draw => draw.y)) >= 25, 'source footer space must be reserved below the card body')
})

test('settings dialog persists wide mode and a drag at 50% reaches horizontal extended columns', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xcwide-ui-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const canvas = store.createCanvas({ name: 'Wide UI', cards: [{ type: 'text', title: 'Move me', layout: { x: 0, y: 0, w: 20, h: 8 } }] })
  const { render, emit } = await readyWorkspace(hostAdapter(store))
  renderedElements.find(e => e.props['data-xc-settings']).props.onClick(); render()
  await renderedElements.find(e => e.props['data-xc-setting'] === 'wide').props.onClick()
  render(); await flushEffects(); render()
  assert.equal(store.getCanvas(canvas.id).settings.wide, true)
  renderedElements.find(e => e.props['data-xc-dialog-close']).props.onClick(); render()
  await chooseOption(render, 'data-xc-zoom', '0.5'); await flushEffects()
  const header = renderedElements.find(e => e.props['data-xc-card-header'])
  header.props.onPointerDown({ button: 0, clientX: 100, clientY: 100, preventDefault () {}, stopPropagation () {} })
  emit('pointermove', { clientX: 340, clientY: 100 })
  emit('pointerup', {}); await flush(); render(); await flushEffects()
  assert.equal(store.getCanvas(canvas.id).cards[0].layout.x, 120, '240 screen pixels / 0.5 / 4 pixels per column')
  assert.equal(store.getCanvas(canvas.id).revision, 3)
})

test('group drag and batch delete flow through one write each and one undo restores the whole action', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xcgroup-ui-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const canvas = store.createCanvas({ name: 'Group UI', cards: [0, 30].map(x => ({ type: 'text', title: String(x), layout: { x, y: 0, w: 20, h: 8 } })) })
  const host = hostAdapter(store)
  const { render, emit } = await readyWorkspace(host)
  const select = () => {
    for (const el of renderedElements.filter(e => e.props['data-xc-card'])) el.props.onClick({ ctrlKey: true, target: {}, stopPropagation () {} })
    render()
  }
  select()
  await chooseOption(render, 'data-xc-zoom', '0.5'); await flushEffects()
  const begin = () => renderedElements.find(e => e.props['data-xc-card-header']).props.onPointerDown({ button: 0, clientX: 100, clientY: 100, preventDefault () {}, stopPropagation () {} })
  begin(); emit('pointermove', { clientX: 100, clientY: 210 }); render()
  assert.ok(renderedElements.filter(e => e.props['data-xc-card']).every(e => e.props.style.top === '220px'))
  emit('pointercancel', {}); render()
  assert.equal(store.getCanvas(canvas.id).revision, 1, 'cancel must not write')
  begin(); emit('pointermove', { clientX: 100, clientY: 210 }); emit('pointerup', {}); await flush(); render(); await flushEffects(); render()
  assert.deepEqual(store.getCanvas(canvas.id).cards.map(c => c.layout.y), [10, 10])
  assert.equal(store.getCanvas(canvas.id).revision, 2)
  assert.deepEqual(host.writes, [`/api/xcharts-canvas/canvases/${canvas.id}/batch`])
  await renderedElements.find(e => e.props['data-xc-undo']).props.onClick(); render(); await flushEffects(); render()
  assert.deepEqual(store.getCanvas(canvas.id).cards.map(c => c.layout.y), [0, 0])
  await renderedElements.find(e => e.props['data-xc-batch-delete']).props.onClick(); render(); await flushEffects(); render()
  assert.equal(store.getCanvas(canvas.id).cards.length, 0)
  await renderedElements.find(e => e.props['data-xc-undo']).props.onClick(); render()
  assert.equal(store.getCanvas(canvas.id).cards.length, 2)
})

test('PNG export tiles a long canvas without clamping the final cards to 400 rows', async () => {
  const sizes = []
  const context = new Proxy({ measureText: text => ({ width: String(text).length * 5 }) }, { get: (o, k) => k in o ? o[k] : () => {} })
  const document = { activeElement: null, createElement: tag => {
    assert.equal(tag, 'canvas')
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => { sizes.push([canvas.width, canvas.height]); return 'data:image/png;base64,AAAA' } }
    return canvas
  } }
  const { pure } = loadClient({ environment: { document } })
  const canvas = { name: 'Long', cards: [{ id: 'end', type: 'text', title: 'Last', text_content: 'not lost', layout: { x: 0, y: 500, w: 96, h: 16 } }] }
  const result = await pure.exportArtifacts(canvas, { isDark: false }, 'png', 960)
  assert.equal(result.length, 3)
  assert.ok(result[2].name.endsWith('-3-1.png'))
  assert.ok(sizes.every(([w, h]) => w <= 4096 && h <= 4096))
  assert.equal(sizes.reduce((sum, [, h]) => sum + h, 0), 516 * 22 + 20)
})

test('HTML export renders every chart offscreen and releases every temporary chart/container', async () => {
  let appended = 0, removed = 0
  const document = { activeElement: null, body: { appendChild: () => { appended++ } }, createElement: () => ({ style: {}, remove: () => { removed++ } }) }
  const { pure, echartsCalls } = loadClient({ environment: { document } })
  const results = await pure.exportArtifacts(CANVAS, { isDark: false, echarts: {} }, 'html', 1200)
  const count = CANVAS.cards.filter(c => c.type === 'chart').length
  assert.equal(echartsCalls.init, count)
  assert.equal(echartsCalls.setOption, count)
  assert.equal(echartsCalls.dispose, count)
  assert.equal(appended, count)
  assert.equal(removed, count)
  assert.equal(results.length, 1)
  assert.equal((results[0].content.match(/data:image\/png;base64,AAAA/g) || []).length, count)
})

test('fit all accounts for both axes including sixteen-screen horizontal extent', async () => {
  const canvas = { ...CANVAS, settings: { wide: true, snap: false }, cards: [{ id: 'far', type: 'text', title: 'Far', layout: { x: 1440, y: 1000, w: 96, h: 16 } }] }
  const { render } = await readyWorkspace({ initialCanvases: [canvas] })
  renderedElements.find(e => e.props['data-xc-fit']).props.onClick(); render()
  // Read the applied scale (the board transform), not the rounded trigger label.
  const zoom = Number(/scale\(([^)]+)\)/.exec(renderedElements.find(e => e.props['data-xc-board-inner']).props.style.transform)[1])
  assert.ok(zoom < 0.1)
  assert.ok((1536 * 4 + 20) * zoom <= 384)
  assert.ok((1016 * 22 + 20) * zoom <= 184)
})

test('real ECharts renders demo line, bar and pie options for offline snapshot preparation', async () => {
  let echarts
  const runtime = { console, setTimeout, clearTimeout, navigator: { userAgent: 'Node.js' } }
  runtime.window = runtime
  runtime.__ModuleLoader__ = { load: definition => { echarts = definition.factory() } }
  vm.runInNewContext(readFileSync(join(here, '..', 'client.echarts.js'), 'utf8'), runtime)
  const { pure } = loadClient()
  const charts = salesExample().cards.filter(c => c.type === 'chart')
  for (const card of charts) {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 300 })
    try {
      chart.setOption({ ...pure.normalizeOption(card.echarts_option), animation: false })
      const svg = chart.renderToSVGString()
      assert.match(svg, /<svg/)
      assert.match(svg, /<path/)
      assert.ok(svg.length > 1000)
    } finally { chart.dispose() }
  }
})

test('header clicks cycle asc → desc → natural', () => {
  const { pure } = loadClient()
  assert.equal(pure.nextSortDir(null, 0), 1, 'first click sorts ascending')
  assert.equal(pure.nextSortDir({ col: 0, dir: 1 }, 0), -1, 'second click flips to descending')
  assert.equal(pure.nextSortDir({ col: 0, dir: -1 }, 0), 0, 'third click returns to natural')
  assert.equal(pure.nextSortDir({ col: 2, dir: -1 }, 0), 1, 'switching columns restarts at ascending')
})

test('markdown output escapes HTML and keeps the supported subset', () => {
  const { pure } = loadClient()
  const md = pure.renderMarkdown('# 标题\n**粗** 和 `码`\n<script>alert(1)</script>')
  assert.match(md, /<h1>标题<\/h1>/)
  assert.match(md, /<strong>粗<\/strong>/)
  assert.match(md, /<code>码<\/code>/)
  assert.doesNotMatch(md, /<script>/, 'raw HTML must be escaped, never passed through')
  assert.match(md, /&lt;script&gt;/)
})

test('code rendering escapes HTML and tints keywords', () => {
  const { pure } = loadClient()
  const html = pure.renderCode('const x = "<b>"\nSELECT 1')
  assert.doesNotMatch(html, /<b>/, 'code source must be escaped')
  assert.match(html, /&lt;b&gt;/)
  assert.match(html, /const/, 'the keyword itself stays visible')
})

test('an empty catalog renders the empty state without changing hook count', async () => {
  // Measured crash (user report): status stays 'ready' while canvas is null
  // after the last canvas is deleted, and the board code dereferenced
  // canvas.cards. The empty branch must win before those blocks.
  resetRenderState()
  let plugin = null
  const CANVASES = { canvases: [] } // fresh install / everything deleted
  const sandboxWindow = { addEventListener: () => {}, removeEventListener: () => {} }
  const sandbox = {
    window: sandboxWindow,
    requestAnimationFrame: cb => { setImmediate(cb); return 0 },
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      constructor (cb) { this.cb = cb }
      observe () { this.cb([], this) }
      disconnect () {}
      unobserve () {}
    },
    __ModuleLoader__: {
      load: definition => {
        plugin = definition.factory(name => (name === 'echarts'
          ? { init: () => ({ setOption () {}, resize () {}, dispose () {} }) }
          : React))
      },
    },
    console,
    navigator: {},
    fetch: async url => {
      const path = String(url).split('/api/xcharts-canvas')[1] || ''
      const payload = path === '/canvases' ? CANVASES : {}
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
    },
  }
  sandboxWindow.__ModuleLoader__ = sandbox.__ModuleLoader__
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  const Page = applyPlugin(plugin)
  renderToString(React.createElement(Page, { locale: 'zh' }))
  await flushEffects()
  // Must not throw; must paint the empty-state copy.
  const html = renderToString(React.createElement(Page, { locale: 'zh' }))
  assert.ok(html.includes('还没有画布'), 'the empty state must render')
  assert.ok(html.includes('新建画布'), 'the create button must be offered')
})

test('create, delete last canvas, and recreate preserve the workspace hook sequence', async () => {
  const { plugin } = loadClient({ initialCanvases: [] })
  const Page = applyPlugin(plugin)
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  const click = async label => {
    const button = renderedElements.find(el => el.type === 'button' && el.children.join('') === label)
    assert.ok(button, `expected button: ${label}`)
    await button.props.onClick()
  }
  assert.match(render(), /加载中/)
  await flushEffects()
  assert.match(render(), /还没有画布/)
  for (let round = 0; round < 2; round++) {
    await click('+ 新建画布')
    assert.match(render(), /趋势/)
    renderedElements.find(el => el.props['data-xc-board']).props.onContextMenu({ preventDefault () {}, clientX: 0, clientY: 0 })
    render()
    await renderedElements.find(el => el.props['data-xc-menu-item'] === 'delete-canvas').props.onClick()
    render()
    await acceptConfirm(render)
    await flush()
    assert.match(render(), /还没有画布/)
  }
})

test('a failed catalog load renders an error without changing hook count', async () => {
  const { plugin } = loadClient({ failList: true })
  const Page = applyPlugin(plugin)
  renderToString(React.createElement(Page, { locale: 'zh' }))
  await flushEffects()
  const html = renderToString(React.createElement(Page, { locale: 'zh' }))
  assert.match(html, /catalog unavailable/)
  assert.match(html, /重试/)
})

test('the empty-state example button opens the case and returns after last-canvas deletion', async () => {
  const { plugin } = loadClient({ initialCanvases: [] })
  const Page = applyPlugin(plugin)
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render()
  await flushEffects()
  render()
  const button = renderedElements.find(el => el.props['data-xc-add-example'])
  assert.ok(button)
  const pending = button.props.onClick()
  render()
  assert.equal(renderedElements.find(el => el.props['data-xc-add-example']).props.disabled, true)
  await pending
  const ready = render()
  assert.match(ready, /销售经营分析（模拟案例）/)
  assert.match(ready, /复核计算/)
  assert.equal(renderedElements.filter(el => el.props['data-xc-card']).length, 10)
  assert.equal(renderedElements.some(el => el.props['data-xc-add-example']), false)
  renderedElements.find(el => el.props['data-xc-board']).props.onContextMenu({ preventDefault () {}, clientX: 0, clientY: 0 })
  render()
  await renderedElements.find(el => el.props['data-xc-menu-item'] === 'delete-canvas').props.onClick()
  render()
  await acceptConfirm(render)
  await flush()
  render()
  assert.ok(renderedElements.find(el => el.props['data-xc-add-example']))
})

test('example creation errors are visible and the empty-state button becomes available again', async () => {
  const { plugin } = loadClient({ initialCanvases: [], failExample: true })
  const Page = applyPlugin(plugin)
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render()
  await flushEffects()
  render()
  await renderedElements.find(el => el.props['data-xc-add-example']).props.onClick()
  assert.match(render(), /example creation failed/)
  assert.equal(renderedElements.find(el => el.props['data-xc-add-example']).props.disabled, false)
})

test('marquee ignores clicks and card bodies, and selects in the scrolled board coordinate space', async () => {
  const { plugin, emit } = loadClient()
  const Page = applyPlugin(plugin)
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render()
  await flushEffects()
  render()
  await flushEffects()
  render()
  const board = () => renderedElements.find(el => el.props.onPointerDown && el.props.ref)
  const selected = () => renderedElements.filter(el => el.props['data-xc-card'] && el.props.style.outline).map(el => el.props['data-xc-card'])

  board().props.onPointerDown({ button: 0, clientX: 10, clientY: 10 })
  emit('pointerup', {})
  render()
  assert.deepEqual(selected(), [], 'a click must not select the whole board')

  board().props.onPointerDown({ button: 0, clientX: 10, clientY: 10, target: { closest: () => ({}) } })
  emit('pointermove', { clientX: 150, clientY: 150 })
  render()
  assert.equal(renderedElements.some(el => el.props['data-xc-marquee']), false, 'card body presses must not start a marquee')

  const inner = renderedElements.find(el => el.props['data-xc-board-inner']).props.ref.current
  inner.getBoundingClientRect = () => ({ left: 20, top: -330 })
  board().props.onPointerDown({ button: 0, clientX: 30, clientY: 30 })
  emit('pointermove', { clientX: 150, clientY: 150 })
  render()
  const marquee = renderedElements.find(el => el.props['data-xc-marquee'])
  assert.equal(marquee.props.style.top, '360px')
  emit('pointerup', {})
  render()
  assert.deepEqual(selected(), ['c2'], 'scrolling must select the visible second card, not the first')

  board().props.onPointerDown({ button: 0, clientX: 30, clientY: 30 })
  emit('pointermove', { clientX: 150, clientY: 150 })
  emit('pointercancel', {})
  emit('pointerup', {})
  render()
  assert.deepEqual(selected(), [])
  assert.equal(renderedElements.some(el => el.props['data-xc-marquee']), false)
})

test('the workspace reaches ready and renders every card type for real', async () => {
  const { plugin, echartsCalls } = loadClient()
  const Page = applyPlugin(plugin)

  // First render: the loading state, whose effects kick off the data load.
  const loading = renderToString(React.createElement(Page, { locale: 'zh' }))
  assert.ok(loading.includes('加载中'), 'the first render should show the loading state')

  // Run the load effects until the workspace settles.
  await flushEffects()
  // Second render: now in ready state, the chart cards mount, kick the chunk
  // request, and REGISTER their echarts effects (init runs in an effect, after
  // the container ref attaches and the async chunk resolves).
  const html = renderToString(React.createElement(Page, { locale: 'zh' }))
  await flushEffects()
  // The chunk promise resolves in a microtask; the lib state update lands on
  // the next render, whose effects carry the actual init call.
  renderToString(React.createElement(Page, { locale: 'zh' }))
  await flushEffects()

  // Chart initialization updates chartReady; option application runs on the
  // following render, after that state update (as it does in React).
  renderToString(React.createElement(Page, { locale: 'zh' }))
  await flushEffects()

  // Every card type made it through its renderer.
  for (const title of ['趋势', '大数据', '坐标对', '空图', '明细', '营收', '结论', '色标卡']) {
    assert.ok(html.includes(title), `card "${title}" must render`)
  }
  // The real chart path ran: init happened for the chart cards, and option
  // pushes went through (200-point fixture exercises the big option too).
  assert.ok(echartsCalls.init >= 1, 'echarts.init must be called for chart cards')
  assert.ok(echartsCalls.setOption >= 1, 'setOption must be called with the card option')
  // A canvas refresh after a theme or option change disposes and re-inits;
  // at steady state there is nothing to dispose yet, so dispose stays 0.
  assert.equal(echartsCalls.dispose, 0, 'no chart should be disposed while the page is settled')

  // KPI target/delta chrome (c6: value 80 / target 100 / delta -12).
  assert.ok(html.includes('80%'), 'target progress must show the percentage')
  assert.ok(html.includes('目标 100'), 'the target line must render')
  assert.ok(html.includes('-12'), 'the delta must render')
  // Table row-cap hint (明细 fixture has >30 rows? use the sorter hint as smoke).
  assert.ok(html.includes('目标'), 'KPI chrome present')
})

test('a card with a hidden header hides its title but keeps its body', async () => {
  const { plugin } = loadClient()
  const Page = applyPlugin(plugin)
  // The workspace loads its data inside effects, so drive the same
  // render → flush → render cycle as the test above before asserting.
  renderToString(React.createElement(Page, { locale: 'zh' }))
  await flushEffects()
  const html = renderToString(React.createElement(Page, { locale: 'zh' }))
  // Strip the data-* attribute dump the stand-in serializes: visibility means
  // text content, not test hooks (real DOM also carries data-xc-title invisibly).
  const visible = html.replace(/ data-[a-z-]+="[^"]*"/g, '')
  // c8's header is hidden, so its title is not painted.
  assert.equal(visible.split('无头卡').length, 1, 'a hidden header must not paint the title')
  // Provenance left the card body entirely: it is reached through the card menu.
  assert.equal(visible.includes('数据来源'), false, 'no provenance strip is painted on cards')
  assert.equal(visible.includes('季度口径说明'), false, 'source notes are no longer painted on cards')
  // c9 carries color "red": the top accent bar must paint (structural marker).
  assert.match(html, /data-xc-color-bar="red"/, 'the colour marker bar must render')
})

test('the crash regression: SeriesPreview never receives an undefined translator', async () => {
  // The shipped bundle crashed with `TypeError: t is not a function` because
  // CardBody rendered SeriesPreview without passing `t`. Guard it structurally:
  // both call sites must name `t` in their props.
  const callSites = [...CLIENT_SOURCE.matchAll(/h\(SeriesPreview,\s*\{([^}]*)\}\)/g)].map(m => m[1])
  assert.ok(callSites.length > 0, 'expected at least one SeriesPreview call site')
  for (const site of callSites) {
    assert.match(site, /\bt\b/, `SeriesPreview must be passed t: h(SeriesPreview, { ${site.trim()} })`)
  }
})

// ── conversation tool card ──────────────────────────────────────────────────

test('a card tool renders its chart inside the conversation, from the call arguments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-toolcard-'))
  try {
    const store = new CanvasStore(dir)
    const client = loadClient(hostAdapter(store))
    const { pure } = client
    const Page = applyPlugin(client.plugin)
    const entries = Page.__slots['tool.call.toolview']
    assert.ok(entries, 'the card tools must claim a conversation tool view')
    assert.deepEqual(entries.map(entry => entry.meta.key), ['canvas_add_card', 'canvas_update_card', 'canvas_add_result'])
    assert.equal(entries[0].meta.name, 'tool.call.toolview')

    // Why the arguments and not the draft API: the draft projection trims a
    // series to 8 points for the panel's sample preview.
    const data = Array.from({ length: 20 }, (_, i) => i + 1)
    const canvas = store.createCanvas({ name: '对话内预览' })
    store.createCardDraft(canvas.id, {
      type: 'chart', title: '区域趋势', echarts_option: { series: [{ type: 'line', data }] },
      dataset: 'sales.csv', query: 'SELECT 1',
    })
    const projected = store.listCardDrafts()[0].card.echarts_option.series[0].data.length
    assert.equal(projected, 8, 'the draft preview is a sample')

    const argsRaw = JSON.stringify({
      canvas_id: canvas.id, type: 'chart', title: '区域趋势',
      echarts_option: { series: [{ type: 'line', data }] },
    })
    const card = pure.toolCardArgs({ argsRaw })
    assert.equal(card.echarts_option.series[0].data.length, 20, 'the call arguments carry every point')
    assert.equal(card.type, 'chart')

    const View = entries[0].component
    const render = props => {
      const html = renderToString(React.createElement(View, { locale: 'zh', ...props }))
      return { html, els: renderedElements }
    }
    const has = (els, key) => els.some(el => el.props && el.props[key])

    // Preparing: a line of status, no chart yet.
    const preparing = render({ phase: 'preparing', block: { phase: 'preparing', callId: 'c1', name: 'canvas_add_card' } })
    assert.equal(has(preparing.els, 'data-xc-echart'), false, 'preparing renders no chart')
    assert.ok(has(preparing.els, 'data-xc-tool-card'), 'but the card row is already there')

    // Started: the arguments are complete, so the chart surface exists and the
    // payload behind it is the whole series.
    const started = render({ phase: 'start', block: { phase: 'start', callId: 'c1', name: 'canvas_add_card', argsRaw } })
    assert.ok(has(started.els, 'data-xc-echart'), 'the started call mounts the chart')
    assert.ok(started.html.includes('区域趋势'))

    // Settled with a pending draft: the status names the next step, chart stays.
    const content = [{ type: 'text', text: JSON.stringify({ status: 'pending_confirmation', canvas_id: canvas.id, title: '区域趋势', message: '预览已显示在插件画布界面，等待用户确认或取消。' }) }]
    const settled = { kind: 'tool-result', callId: 'c1', call: { name: 'canvas_add_card', argsRaw }, content, isError: false, subCalls: [] }
    const pending = render({ phase: 'result', block: settled })
    assert.ok(has(pending.els, 'data-xc-echart'), 'the settled call keeps the chart')
    assert.ok(has(pending.els, 'data-xc-tool-status'))
    assert.ok(pending.html.includes('等待在分析画布确认'))

    // An update sends only the changed fields: the type is inferred, so the chart
    // still renders instead of falling back to a bare row.
    const update = render({
      phase: 'start',
      block: { phase: 'start', callId: 'c2', name: 'canvas_update_card', argsRaw: JSON.stringify({ canvas_id: canvas.id, card_id: 'card1', echarts_option: { series: [{ type: 'bar', data: [3, 4, 5] }] } }) },
    })
    assert.equal(pure.toolCardArgs({ argsRaw: JSON.stringify({ echarts_option: { series: [] } }) }).type, 'chart', 'an update infers its type')
    assert.ok(has(update.els, 'data-xc-echart'), 'an update call renders the changed option')

    // Failures and malformed arguments degrade to text, never to nothing.
    const failed = render({ phase: 'result', block: { kind: 'tool-result', callId: 'c3', call: null, content: [], isError: true, error: { name: 'CanvasError', code: 'SOURCE_REQUIRED', reason: '缺少来源' }, subCalls: [] } })
    assert.ok(failed.html.includes('缺少来源'))
    assert.ok(has(failed.els, 'data-xc-tool-card'), 'a failed call still renders its row')
    const broken = render({ phase: 'start', block: { phase: 'start', callId: 'c4', name: 'canvas_add_card', argsRaw: '{"type":"chart","echarts_op' } })
    assert.equal(has(broken.els, 'data-xc-echart'), false, 'a truncated argument prefix renders no chart')
    assert.ok(has(broken.els, 'data-xc-tool-card'), 'and the card row still renders')

    // `canvas_add_result` carries no option: the host builds the card from the
    // result snapshot and writes it straight into the canvas, so the view reads
    // that saved card back — which also proves the write really landed.
    const written = store.addCard(canvas.id, {
      type: 'chart', title: '各学历客户数', chart_type: 'bar',
      echarts_option: { xAxis: { type: 'category', data: ['1', '2'] }, series: [{ type: 'bar', data: [561, 520] }] },
      dataset: 'cardata', query: '按学历分组计数',
    }, store.getCanvas(canvas.id).revision)
    const writtenCardId = written.cards.at(-1).id
    const WrittenView = entries[2].component
    const settledResult = {
      kind: 'tool-result', callId: 'c5', call: { name: 'canvas_add_result', argsRaw: JSON.stringify({ canvas_id: canvas.id, result_id: 'r1', type: 'chart', title: '各学历客户数' }) },
      content: [{ type: 'text', text: JSON.stringify({ ok: true, canvas_id: canvas.id, card_id: writtenCardId, revision: written.revision }) }],
      isError: false, subCalls: [],
    }
    renderToString(React.createElement(WrittenView, { locale: 'zh', phase: 'result', toolName: 'canvas_add_result', block: settledResult }))
    await flushEffects()
    await flush()
    const writtenHtml = renderToString(React.createElement(WrittenView, { locale: 'zh', phase: 'result', toolName: 'canvas_add_result', block: settledResult }))
    await flushEffects()
    assert.ok(renderedElements.some(el => el.props && el.props['data-xc-tool-written']), 'the saved card is read back')
    // The chart box only exists when a card was resolved: the arguments of this
    // call carry no option at all, so anything drawn came from the canvas read.
    assert.ok(
      renderedElements.some(el => el.props && el.props.style && el.props.style.height === '300px'),
      'and the fetched card is drawn as a chart',
    )
    assert.ok(
      renderedElements.some(el => el.props && el.props['data-xc-echart']),
      'the real chart shell comes from the fetched option, not the call arguments',
    )
    assert.equal(renderedElements.some(el => el.props && el.props['data-xc-tool-body-missing']), false, 'a resolved card never shows the empty-body notice')
    assert.ok(writtenHtml.includes('各学历客户数'), 'by its real title')
    assert.ok(renderedElements.some(el => el.props['data-xc-tool-status'] === 'done'), 'the status says the write landed')

    // A pie card written from a result snapshot must reach the chart shell too.
    const pieCard = store.addCard(canvas.id, {
      type: 'chart', title: '贷款客户按收入档构成', chart_type: 'pie',
      echarts_option: { tooltip: { trigger: 'item' }, series: [{ type: 'pie', data: [{ name: '1', value: 48 }, { name: '2', value: 382 }, { name: '3', value: 570 }] }] },
      dataset: 'cardata', query: '按收入档统计贷款客户数',
    }, store.getCanvas(canvas.id).revision)
    const pieCardId = pieCard.cards.at(-1).id
    const pieResult = {
      kind: 'tool-result', callId: 'c6', call: { name: 'canvas_add_result', argsRaw: JSON.stringify({ canvas_id: canvas.id, result_id: 'r2', type: 'chart', chart_type: 'pie', title: '贷款客户按收入档构成' }) },
      content: [{ type: 'text', text: JSON.stringify({ ok: true, canvas_id: canvas.id, card_id: pieCardId, revision: pieCard.revision }) }],
      isError: false, subCalls: [],
    }
    renderToString(React.createElement(WrittenView, { locale: 'zh', phase: 'result', toolName: 'canvas_add_result', block: pieResult }))
    await flushEffects()
    await flush()
    renderToString(React.createElement(WrittenView, { locale: 'zh', phase: 'result', toolName: 'canvas_add_result', block: pieResult }))
    await flushEffects()
    assert.ok(renderedElements.some(el => el.props && el.props['data-xc-echart']), 'a pie card renders its chart shell as well')
    assert.equal(renderedElements.some(el => el.props && el.props['data-xc-tool-body-missing']), false, 'and it is not an empty body')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/** Assert the shared page skeleton on whichever workspace is currently rendered. */
function assertSkeleton (listName, pageTitle) {
  const label = pageTitle
  const header = renderedElements.find(e => e.props['data-xc-page-header'])
  assert.ok(header, `missing the shared page header on ${label}`)
  assert.equal(header.type, 'header', 'the header must be a <header> element')
  assert.equal(header.props.style.height, '48px')
  assert.equal(header.props.style.padding, '0 16px')
  assert.equal(header.props.style.borderBottom, '1px solid var(--dsw-alias-border-l1)')

  const title = renderedElements.find(e => e.type === 'h2' && e.children.join('') === pageTitle)
  assert.ok(title, `${label} must put its name in the shared title slot`)
  assert.equal(title.props.style.fontSize, '16px', 'both page titles are 16px (the shell’s 48px header scale)')
  assert.equal(title.props.style.fontWeight, 500)

  const list = renderedElements.find(e => e.props['data-xc-side-list'])
  assert.ok(list, `missing the shared side list on ${label}`)
  assert.equal(list.props['data-xc-side-list'], 'expanded')
  assert.equal(list.props.style.width, '240px', 'both side lists are exactly as wide as each other')

  // The identity line is temporarily hidden on both pages (SHOW_LIST_TITLE) —
  // both pages already name themselves in the page header — but the list keeps
  // its accessible name, so the region is still announced.
  assert.equal(renderedElements.find(e => e.props['data-xc-list-header']), undefined, 'the visible identity line is hidden for now')
  assert.equal(list.props['aria-label'], listName, 'the list is still named for assistive tech')
  assert.equal(list.props.role, 'navigation', 'and it is still a labelled navigation region')

  const rows = renderedElements.filter(e => e.props['data-xc-list-row'])
  assert.ok(rows.length > 0, `${label} must render its rows`)
  for (const row of rows) {
    const main = row.children.find(c => c && c.props && c.props['data-xc-list-row-main'])
    assert.equal(main.type, 'button', 'a row is a real button, not a clickable div')
    assert.equal(main.props.style.height, '45px', 'one row height for both lists')
    assert.equal(main.props.style.padding, '5px 10px')
    assert.equal(main.props.style.borderRadius, 'var(--dsw-radius-md, 12px)')
    assert.equal(row.props.style.borderRadius, 'var(--dsw-radius-md, 12px)')
  }

  const create = renderedElements.find(e => e.props['data-xc-list-primary'])
  assert.ok(create, `missing the create entry on ${label}`)
  assert.equal(create.type, 'button')
  assert.equal(create.props.style.height, '38px', 'the create entry uses the shell’s raised-card size')
  // Same width as the rows: one padded column holds both, and neither adds its own
  // horizontal inset (the scroll area used to reserve a scrollbar gutter, which
  // made the selected row a scrollbar narrower than this button).
  assert.equal(create.props.style.margin, '0 0 8px')
  const body = renderedElements.find(e => e.props['data-xc-list-body'])
  assert.ok(body, `missing the shared list column on ${label}`)
  assert.equal(body.props.style.padding, '0 8px')
  const scroll = renderedElements.find(e => e.props['data-xc-list-scroll'])
  assert.ok(body.children.indexOf(create) >= 0 || renderedElements.indexOf(body) < renderedElements.indexOf(create), 'the create entry sits in that column')
  assert.ok(renderedElements.indexOf(create) < renderedElements.indexOf(scroll), 'and the rows come after it')

  assert.ok(renderedElements.find(e => e.props['data-xc-split']), 'the columns sit in the shared split')

  // One order for both pages: header → split → side list → rows.
  const at = pred => renderedElements.findIndex(pred)
  const [headerAt, splitAt, listAt, rowAt] = [
    at(e => e.props['data-xc-page-header']),
    at(e => e.props['data-xc-split']),
    at(e => e.props['data-xc-side-list']),
    at(e => e.props['data-xc-list-row']),
  ]
  assert.ok(
    headerAt >= 0 && headerAt < splitAt && splitAt < listAt && listAt < rowAt,
    `${label}: order must be page header → split → side list → rows (got ${headerAt}/${splitAt}/${listAt}/${rowAt})`,
  )
}

test('both workspaces render one skeleton: header, list identity line, real row buttons', async () => {
  const canvas = await readyWorkspace()
  canvas.render()
  assertSkeleton('分析画布', '分析画布')

  const dir = mkdtempSync(join(tmpdir(), 'xc-skeleton-'))
  try {
    const store = new CanvasStore(dir)
    const data = new DataStore(dir)
    await data.import({
      name: '骨架数据源', filename: 'skeleton.csv',
      content_base64: Buffer.from('a,b\n1,2\n').toString('base64'),
    })
    const { plugin } = loadClient(hostAdapter(store))
    const Page = applyPlugin(plugin)
    const entry = Page.__slots.main.find(item => item.meta.key === 'xcharts-datasources')
    assert.ok(entry, 'the datasource page must be registered in the main slot')
    const renderSources = () => renderToString(React.createElement(entry.component, { locale: 'zh' }))
    for (let i = 0; i < 4; i++) { renderSources(); await flushEffects() }
    renderSources()
    assertSkeleton('数据源', '数据源与分析')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the datasource list toggle honours the shortcut it advertises', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-ds-keys-'))
  try {
    const store = new CanvasStore(dir)
    const { plugin, emit } = loadClient({ ...hostAdapter(store), environment: { document: { activeElement: { tagName: 'DIV' } } } })
    const Page = applyPlugin(plugin)
    const entry = Page.__slots.main.find(item => item.meta.key === 'xcharts-datasources')
    const render = () => renderToString(React.createElement(entry.component, { locale: 'zh' }))
    for (let i = 0; i < 4; i++) { render(); await flushEffects() }
    render()

    const toggle = renderedElements.find(e => e.props['data-xc-toggle-datasource-list'])
    assert.equal(toggle.props['aria-keyshortcuts'], 'Control+Alt+B')
    const state = () => renderedElements
      .find(e => e.props['data-xc-datasource-list'] && e.props['data-xc-side-list'])
      .props['data-xc-side-list']
    assert.equal(state(), 'expanded')

    emit('keydown', { key: 'b', altKey: true, ctrlKey: false, shiftKey: false, preventDefault () {} })
    render()
    assert.equal(state(), 'collapsed', 'the declared shortcut must actually work here too')
    emit('keydown', { key: 'b', altKey: true, ctrlKey: false, shiftKey: false, preventDefault () {} })
    render()
    assert.equal(state(), 'expanded', 'and toggle back')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function mountDataSourcePage () {
  const dir = mkdtempSync(join(tmpdir(), 'xc-ref-ui-'))
  const store = new CanvasStore(dir)
  const data = new DataStore(dir)
  const source = await data.import({ name: '引用用数据源', filename: 'ref.csv', content_base64: Buffer.from('k,v\na,1\nb,2\n').toString('base64') })
  const { fetchOverride } = hostAdapter(store)
  const { plugin } = loadClient({ fetchOverride })
  const page = applyPlugin(plugin)
  const Page = page.__slots.main.find(entry => entry.meta.key === 'xcharts-datasources').component
  const overlay = page.__slots['shell.overlay'][0].component
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  const select = async () => {
    render(); await flushEffects(); render(); await flushEffects()
    await renderedElements.find(el => el.props['data-xc-select-datasource'] === source.id).props.onClick()
    render(); await flushEffects(); render(); await flushEffects()
  }
  await select()
  return { dir, source, plugin, overlay, render, select, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a datasource reference writes a versioned short marker and reuses the delivery dialog', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-ref-ui-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const data = new DataStore(dir)
  const source = await data.import({ name: '引用用数据源', filename: 'ref.csv', content_base64: Buffer.from('k,v\na,1\nb,2\n').toString('base64') })
  const opened = []
  const { fetchOverride } = hostAdapter(store)
  const { plugin } = loadClient({ fetchOverride })
  const page = applyPlugin(plugin, { uiWorkspace: { openSession: id => opened.push(id) } })
  const Page = page.__slots.main.find(entry => entry.meta.key === 'xcharts-datasources').component
  const overlay = page.__slots['shell.overlay'][0].component
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render(); await flushEffects(); render(); await flushEffects()
  await renderedElements.find(el => el.props['data-xc-select-datasource'] === source.id).props.onClick()
  render(); await flushEffects(); render(); await flushEffects()

  // The marker the composer receives: a readable label plus a versioned pointer.
  const { referenceMarker, referenceLine } = plugin.__pure
  assert.equal(referenceMarker({ kind: 'ds', datasource_id: 's1', version: 'h1' }), '[xcharts:ds:s1@h1]')
  assert.match(referenceLine({ kind: 'ds', name: '引用用数据源', rows: 2, datasource_id: 's1', version: 'h1' }), /^@引用用数据源（2 行）\[xcharts:ds:s1@h1\]$/)

  const reference = renderedElements.find(el => el.props['data-xc-reference-source'] === source.id)
  assert.ok(reference, 'a selected source offers one reference action')
  assert.equal(reference.props.title, '在对话中使用')
  await reference.props.onClick()
  const sessions = { byId: { 'session-a': { id: 'session-a', title: '会话 A' } } }
  const overlayHtml = renderToString(React.createElement(overlay, { useSessions: selector => selector(sessions) }))
  assert.ok(overlayHtml.includes('引用到对话'), 'the reference opens a target-session dialog')
  const insert = renderedElements.find(el => el.props['data-xc-reference-insert'])
  assert.ok(insert, 'the dialog offers one insert action')
  await insert.props.onClick()
  assert.deepEqual(opened, ['session-a'], 'the reference targets the chosen conversation')
})

test('the row menu offers the same reference action as the header', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-ref-menu-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const data = new DataStore(dir)
  const source = await data.import({ name: '菜单引用', filename: 'm.csv', content_base64: Buffer.from('k,v\na,1\n').toString('base64') })
  const { fetchOverride } = hostAdapter(store)
  const { plugin } = loadClient({ fetchOverride })
  const page = applyPlugin(plugin, {})
  const Page = page.__slots.main.find(entry => entry.meta.key === 'xcharts-datasources').component
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render(); await flushEffects(); render(); await flushEffects()
  await renderedElements.find(el => el.props['data-xc-datasource-actions'] === source.id).props.onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 200, bottom: 24 }) } })
  render(); await flushEffects(); render()
  const entry = renderedElements.find(el => el.props['data-xc-reference-datasource'] === source.id)
  assert.ok(entry, 'the row menu can reference the source without selecting it first')
  await entry.props.onClick()
  assert.ok(renderToString(React.createElement(page.__slots['shell.overlay'][0].component, {})).includes('引用到对话'))
})
test('a result reference offers the same action', async t => {
  const env = await mountDataSourcePage()
  t.after(env.cleanup)
  await renderedElements.find(el => el.props['data-xc-run-query']).props.onClick()
  env.render(); await flushEffects(); env.render(); await flushEffects()
  await renderedElements.find(el => el.props['data-xc-data-tab'] === 'result').props.onClick()
  env.render(); await flushEffects(); env.render()
  const resultReference = renderedElements.find(el => el.props['data-xc-reference-result'])
  assert.ok(resultReference, 'a result can be referenced too')
  await resultReference.props.onClick()
  assert.ok(renderToString(React.createElement(env.overlay, {})).includes('引用到对话'))
})
test('the usage menu opens a dialog listing the cards and conversations that used a source', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'xc-usage-ui-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new CanvasStore(dir)
  const data = new DataStore(dir)
  const source = await data.import({ name: '被引用源', filename: 'u.csv', content_base64: Buffer.from('k,v\na,1\n').toString('base64') })
  const result = data.query(source.id, { metrics: [{ op: 'count', as: 'n' }] })
  const canvas = store.createCanvas({ name: '使用画布' })
  const added = data.addToCanvas(store, { result_id: result.id, canvas_id: canvas.id, type: 'table', title: '计数表' })
  new ReferenceService(dir).record({ kind: 'ds', id: source.id, version: source.content_hash }, 'context', { session_id: 'session-x', outcome: 'linked' })
  const { fetchOverride } = hostAdapter(store)
  const { plugin } = loadClient({ fetchOverride })
  const Page = applyPlugin(plugin).__slots.main.find(entry => entry.meta.key === 'xcharts-datasources').component
  const render = () => renderToString(React.createElement(Page, { locale: 'zh' }))
  render(); await flushEffects(); render(); await flushEffects()
  const trigger = renderedElements.find(el => el.props['data-xc-datasource-actions'] === source.id)
  await trigger.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 200, bottom: 24 }) } })
  render(); await flushEffects(); render()
  const usageEntry = renderedElements.find(el => el.props['data-xc-usage-datasource'] === source.id)
  assert.ok(usageEntry, 'the row menu owns the usage detail')
  await usageEntry.props.onClick()
  render(); await flushEffects(); render(); await flushEffects()
  const dialog = renderedElements.find(el => el.props['data-xc-usage-dialog'] === source.id)
  assert.ok(dialog, 'the usage dialog opens')
  assert.ok(renderedElements.find(el => el.props['data-xc-usage-card'] === added.card_id), 'the card that used the source is listed')
  const session = renderedElements.find(el => el.props['data-xc-usage-session'] === 'session-x')
  assert.ok(session, 'the conversation that used the source is listed')
  assert.equal(typeof session.props.onClick, 'function')
})