/**
 * Canvas storage.
 *
 * Everything lives under one directory so a canvas is trivial to back up,
 * inspect, or copy to another machine:
 *
 *   <root>/
 *     index.json            canvas catalog (id, name, card count, timestamps)
 *     canvases/<id>.json    one canvas: metadata + cards
 *     tmp/                  staging for atomic writes
 *
 * Design rules
 *   - JSON only, no private binary format: a canvas stays readable even if this
 *     plugin is gone.
 *   - Every write is atomic (write to tmp, then rename) so a crash mid-write can
 *     never truncate a canvas.
 *   - Every canvas carries a monotonically increasing `revision`; a write states
 *     the revision it read, so two concurrent writers cannot silently clobber
 *     each other. Callers that do not care may pass `expectedRevision: null`.
 *
 * @module lib/store
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { COLS, EXTENT_COLS_CEIL, clampLayout, findFreeSlot, smartSize, overlaps } from './grid.js'
import { normalizeTheme, PALETTES } from './themes.js'
import { salesExample } from './examples.js'
import { applyLineage, resolveVersion, portableLineage } from './lineage.js'
import { currentExecution } from './execution-context.js'

export const CANVAS_SCHEMA_VERSION = 1
export const CARD_TYPES = ['chart', 'table', 'kpi', 'text', 'code']
/**
 * Canvas-level display settings, all boolean and all defaulting to false.
 *
 * `badges` shows the card-type label in each card header. It is off by default
 * because the label is redundant for a reader who can see the card content, and
 * it competed with the title for a narrow header.
 *
 * The list is a whitelist: `setSettings` rejects unknown keys, and every reader
 * that reconstructs settings spreads this default so an older canvas (written
 * before a key existed) reads as off rather than undefined.
 */
export const CANVAS_SETTINGS = ['snap', 'wide', 'badges']
export function defaultSettings (settings) {
  const resolved = {}
  for (const key of CANVAS_SETTINGS) resolved[key] = settings?.[key] === true
  return resolved
}
const PORTABLE_CARD_FIELDS = ['type', 'title', 'layout', 'show_header', 'collapsed', 'note', 'color', 'chart_type', 'chart_spec', 'echarts_option', 'table_data', 'presentation_spec', 'text_content', 'language']

/**
 * Accent colours a card may carry. A closed set rather than free-form CSS: the
 * value is written into a style attribute, so anything but a literal colour
 * would be an injection surface.
 */
export const ALLOWED_COLORS = new Set([
  'default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray',
])

/** Raised when a write is based on a stale revision. */
export class RevisionConflict extends Error {
  constructor (current, expected) {
    super(`canvas revision conflict: expected ${expected}, found ${current}`)
    this.name = 'RevisionConflict'
    this.code = 'REVISION_CONFLICT'
    this.current = current
    this.expected = expected
  }
}

/** Raised when a canvas/field does not exist or is invalid. */
export class CanvasError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'CanvasError'
    this.code = code
  }
}

function nowIso () {
  return new Date().toISOString()
}

function readJson (path, fallback) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new CanvasError('CORRUPT_JSON', `cannot parse ${path}: ${error.message}`)
  }
}

/** Write `data` as JSON atomically (temp file + rename). */
function writeJsonAtomic (path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw error
  }
}

// ── Card construction ───────────────────────────────────────────────────────

/**
 * Normalise a card definition and give it a slot on the canvas.
 * `anchor` (a layout rect) asks the placer to cluster next to an existing card.
 */
const SOURCE_FIELDS = ['dataset', 'query', 'note']
export const MANUAL_SOURCE_MARKER = '手工/无外部数据源'
export const SOURCE_RELINK_MARKER = '来源待重新关联'

function normalizeSource (source, { partial = false } = {}) {
  const value = source == null ? {} : source
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CanvasError('INVALID_SOURCE', 'source must be an object')
  }
  const unknown = Object.keys(value).filter(field => !SOURCE_FIELDS.includes(field))
  if (unknown.length) throw new CanvasError('INVALID_SOURCE', 'unsupported source fields: ' + unknown.join(', '))
  const normalized = {}
  for (const field of SOURCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === undefined) {
      if (!partial) normalized[field] = null
      continue
    }
    const item = value[field]
    if (item !== null && (typeof item !== 'string' || item.length > 20000)) {
      throw new CanvasError('INVALID_SOURCE', 'source.' + field + ' must be a string of at most 20000 characters or null')
    }
    normalized[field] = item
  }
  return normalized
}

function hasTraceableSource (card, source, cardNote = card.note) {
  if (!['chart', 'table', 'kpi'].includes(card.type)) return true
  const completeSource = typeof source.dataset === 'string' && source.dataset.trim().length > 0
    && typeof source.query === 'string' && source.query.trim().length > 0
  const notes = [cardNote, source.note].filter(note => typeof note === 'string')
  return completeSource || notes.some(note => note.includes(MANUAL_SOURCE_MARKER) || note.includes(SOURCE_RELINK_MARKER))
}

function withRelinkMarker (input) {
  const source = normalizeSource({
    dataset: input.source_dataset ?? input.dataset,
    query: input.source_query ?? input.query,
    note: input.source_note,
  })
  if (hasTraceableSource({ type: input.type, note: input.note }, source)) return input
  return { ...input, source_note: [source.note, SOURCE_RELINK_MARKER].filter(Boolean).join('；') }
}

export function makeCard (input, existingCards, anchor, colBound = COLS) {
  const type = String(input.type || 'chart')
  if (!CARD_TYPES.includes(type)) {
    throw new CanvasError('INVALID_CARD_TYPE', `unknown card type: ${type} (expected one of ${CARD_TYPES.join(', ')})`)
  }
  if (!input.title || typeof input.title !== 'string') {
    throw new CanvasError('INVALID_CARD', 'card requires a non-empty title')
  }

  const chartType = input.chart_type ? String(input.chart_type) : (type === 'chart' ? 'bar' : null)
  const size = input.layout
    ? { w: input.layout.w, h: input.layout.h }
    : smartSize(chartType || type)

  const layout = input.layout
    ? clampLayout({ ...input.layout }, colBound)
    : findFreeSlot(existingCards, size.w, size.h, anchor, colBound)

  const card = {
    id: randomUUID().replace(/-/g, '').slice(0, 32),
    type,
    title: input.title,
    layout,
    // Per-card presentation state, all persisted so the view has a value to
    // read instead of keeping it in memory only.
    show_header: input.show_header !== false,
    collapsed: input.collapsed === true,
    note: input.note ?? '',
    color: normalizeColor(input.color),
    created_at: nowIso(),
    updated_at: nowIso(),
  }

  if (type === 'chart') {
    card.chart_type = chartType
    // Either a full ECharts option, or a semantic spec the caller assembles later.
    card.echarts_option = input.echarts_option ?? null
    card.chart_spec = input.chart_spec ?? null
  }
  if (type === 'table') card.table_data = input.table_data ?? null
  if (type === 'kpi') card.presentation_spec = input.presentation_spec ?? null
  if (type === 'text') card.text_content = input.text_content ?? ''
  if (type === 'code') {
    card.text_content = input.text_content ?? ''
    card.language = input.language ? String(input.language).slice(0, 24) : null
  }

  // Provenance: what produced this card. Kept so a card can always answer
  // "where did these numbers come from?".
  card.source = normalizeSource({
    dataset: input.source_dataset ?? input.dataset ?? null,
    query: input.source_query ?? input.query ?? null,
    note: input.source_note ?? null,
  })
  if (input.binding) card.binding = structuredClone(input.binding)
  if (input.calculation_ref) card.calculation_ref = structuredClone(input.calculation_ref)
  if (input.copied_from) card.copied_from = structuredClone(input.copied_from)
  if (input.lineage_import) card.lineage_import = structuredClone(input.lineage_import)
  return card
}

/**
 * An accent colour, or null for "inherit the theme".
 *
 * Accepts only `#rgb`/`#rrggbb` and a few named states so a stored value can
 * never inject arbitrary CSS (it is written into a style attribute).
 */
export function normalizeColor (value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim().toLowerCase()
  if (ALLOWED_COLORS.has(text)) return text
  if (/^#[0-9a-f]{3}$/.test(text) || /^#[0-9a-f]{6}$/.test(text)) return text
  throw new CanvasError('INVALID_COLOR', `unsupported card colour: ${String(value).slice(0, 24)}`)
}

/** Fields a caller is allowed to change on an existing card. */
const UPDATABLE_CARD_FIELDS = [
  'title', 'chart_type', 'echarts_option', 'chart_spec',
  'table_data', 'presentation_spec', 'text_content',
  'show_header', 'collapsed', 'note', 'color', 'language', 'binding', 'calculation_ref',
]

// Use exactly the same patch semantics for an update preview and a committed edit.
function patchedCard (card, changes) {
  const next = structuredClone(card)
  const sourcePatch = changes.source === undefined ? undefined : normalizeSource(changes.source, { partial: true })
  const nextSource = sourcePatch === undefined ? undefined : { ...normalizeSource(card.source), ...sourcePatch }
  if (nextSource && !hasTraceableSource(card, nextSource, changes.note ?? card.note)) {
    throw new CanvasError('SOURCE_REQUIRED', 'data cards require dataset and query, or an explicit manual/relink source marker')
  }
  for (const field of UPDATABLE_CARD_FIELDS) {
    if (changes[field] !== undefined) next[field] = structuredClone(changes[field])
  }
  if (nextSource !== undefined) next.source = nextSource
  if (changes.layout) next.layout = clampLayout({ ...card.layout, ...changes.layout })
  next.updated_at = nowIso()
  return next
}

// Card drafts are process-local by design: they are previews, not canvas state.
// Key by the storage root so short-lived CanvasStore instances share UI drafts.
const PENDING_CARD_DRAFTS = new Map()

const DRAFT_PENDING_TTL = 24 * 60 * 60 * 1000
const DRAFT_TERMINAL_TTL = 60 * 60 * 1000
const DRAFT_LIMIT = 100
function draftsForRoot (root) {
  const now = Date.now()
  for (const [key, drafts] of PENDING_CARD_DRAFTS) {
    for (const [id, draft] of drafts) {
      if (now >= draft.expires_at) drafts.delete(id)
    }
    if (!drafts.size) PENDING_CARD_DRAFTS.delete(key)
  }
  const key = String(root)
  let drafts = PENDING_CARD_DRAFTS.get(key)
  if (!drafts) { drafts = new Map(); PENDING_CARD_DRAFTS.set(key, drafts) }
  return drafts
}

function publicDraft (draft) {
  const card = draft.card
  const preview = {
    id: card.id, type: card.type, title: card.title, layout: { ...card.layout },
    source: card.source ? { ...card.source } : null, note: card.note,
  }
  if (card.type === 'chart') {
    preview.chart_type = card.chart_type
    const option = card.echarts_option || {}
    preview.echarts_option = {
      xAxis: Array.isArray(option.xAxis?.data)
        ? { data: option.xAxis.data.slice(0, 8), total_items: option.xAxis.data.length }
        : undefined,
      series: (Array.isArray(option.series) ? option.series : []).slice(0, 5).map(series => ({
        name: series.name, type: series.type,
        data: Array.isArray(series.data) ? series.data.slice(0, 8) : series.data,
        total_points: Array.isArray(series.data) ? series.data.length : undefined,
      })),
    }
    if (card.chart_spec) preview.chart_spec = card.chart_spec
  } else if (card.type === 'table') {
    const table = card.table_data || {}
    preview.table_data = {
      columns: Array.isArray(table.columns) ? table.columns : [],
      rows: Array.isArray(table.rows) ? table.rows.slice(0, 5) : [],
      total_rows: Array.isArray(table.rows) ? table.rows.length : 0,
    }
  } else if (card.type === 'kpi') {
    preview.presentation_spec = card.presentation_spec ?? null
  } else {
    preview.text_content = String(card.text_content || '').slice(0, 2400)
    preview.text_truncated = String(card.text_content || '').length > 2400
    if (card.type === 'code') preview.language = card.language ?? null
  }
  return {
    id: draft.id,
    operation: draft.operation || 'add',
    canvas_id: draft.canvas_id,
    canvas_name: draft.canvas_name,
    expected_revision: draft.expected_revision,
    created_at: draft.created_at,
    card: preview,
  }
}

// ── Store ───────────────────────────────────────────────────────────────────

export class CanvasStore {
  /**
   * @param {string} root directory holding `index.json` and `canvases/`
   */
  constructor (root) {
    if (!root) throw new CanvasError('INVALID_ROOT', 'canvas store requires a root directory')
    this.root = root
    this.context = structuredClone(currentExecution())
    this.indexPath = join(root, 'index.json')
    this.canvasDir = join(root, 'canvases')
    // Undo snapshots live beside the canvases: a canvas is not fully "kept"
    // unless its history survives too.
    this.historyDir = join(root, 'history')
    this.templateDir = join(root, 'templates')
    this.maxHistory = 50
  }

  // ── undo history (server-side, persisted) ──

  historyPath (id) {
    return join(this.historyDir, `${id}.json`)
  }

  /**
   * Record the PRE-change state of a canvas and clear the redo stack.
   *
   * Called from `withCanvas` after a successful mutation, capturing the state
   * as it was *before* the mutator ran. Snapshots are full card copies (see
   * snapshotOf): undo must restore deletes too, and a presentation-only
   * snapshot cannot.
   */
  pushHistory (canvasBefore) {
    const path = this.historyPath(canvasBefore.id)
    const history = existsSync(path) ? readJson(path, { undo: [], redo: [] }) : { undo: [], redo: [] }
    if (!Array.isArray(history.undo) || !Array.isArray(history.redo)) {
      throw new CanvasError('CORRUPT_HISTORY', `history stacks malformed: ${path}`)
    }
    history.undo.push(this.snapshotOf(canvasBefore))
    while (history.undo.length > this.maxHistory) history.undo.shift()
    // A new action invalidates everything that could be redone.
    history.redo = []
    writeJsonAtomic(path, history)
  }

  readHistory (id) {
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      throw new CanvasError('INVALID_CANVAS_ID', `invalid canvas id: ${String(id)}`)
    }
    const path = this.historyPath(id)
    if (!existsSync(path)) return { undo: [], redo: [] }
    const history = readJson(path, { undo: [], redo: [] })
    if (!Array.isArray(history.undo) || !Array.isArray(history.redo)) {
      throw new CanvasError('CORRUPT_HISTORY', `history stacks malformed: ${path}`)
    }
    return history
  }

  /** Snapshot the CURRENT canvas: full cards, so redo can re-add removed ones. */
  snapshotOf (canvas) {
    return {
      revision: canvas.revision,
      saved_at: nowIso(),
      name: canvas.name,
      description: canvas.description ?? null,
      theme: canvas.theme ? { ...canvas.theme } : null,
      settings: defaultSettings(canvas.settings),
      // Full card copies (payloads included): redo must be able to re-create a
      // card that undo removed, and a presentation-only snapshot cannot. The
      // stack is capped at 50 and this is a single-user local store, so the
      // extra bytes are bounded in practice.
      cards: canvas.cards.map(card => structuredClone(card)),
    }
  }

  /**
   * Apply a history snapshot onto the live canvas: existing cards are restored
   * field-by-field by id; cards present in the snapshot but missing from the
   * canvas are re-created (redo of an undo that removed them); cards added
   * after the snapshot are dropped (undo of an add).
   */
  applySnapshot (canvas, snapshot) {
    const snapshotIds = new Set(snapshot.cards.map(c => c.id))
    const restored = []
    for (const snap of snapshot.cards) {
      const card = canvas.cards.find(c => c.id === snap.id)
      if (card) {
        // Replace every field the snapshot carries (it is a full card copy).
        for (const key of Object.keys(snap)) card[key] = snap[key]
      } else {
        // A card the live canvas lost: re-create it verbatim.
        canvas.cards.push(structuredClone(snap))
      }
      restored.push(snap.id)
    }
    const addedSince = canvas.cards.filter(c => !snapshotIds.has(c.id)).map(c => c.id)
    if (addedSince.length > 0) {
      canvas.cards = canvas.cards.filter(c => snapshotIds.has(c.id))
    }
    canvas.name = snapshot.name
    canvas.description = snapshot.description
    if (snapshot.theme) canvas.theme = { ...snapshot.theme }
    canvas.settings = defaultSettings(snapshot.settings)
    return { restored: restored.length, removedCards: addedSince.length }
  }

  /**
   * Undo: pop the newest pre-change snapshot, push the current state onto redo,
   * and apply the snapshot.
   */
  undo (id, expectedRevision = null) {
    let summary = null
    const canvas = this.withCanvas(id, expectedRevision, current => {
      const path = this.historyPath(id)
      const history = this.readHistory(id)
      if (history.undo.length === 0) {
        throw new CanvasError('NOTHING_TO_UNDO', 'no recorded history for this canvas')
      }
      const snapshot = history.undo.pop()
      history.redo.push(this.snapshotOf(current))
      writeJsonAtomic(path, history)
      summary = this.applySnapshot(current, snapshot)
      // Return the canvas itself: withCanvas persists whatever the mutator
      // returns, so the summary must travel out via the closure instead.
      return current
    }, { recordHistory: false })
    return { canvas, ...summary }
  }

  /**
   * Redo: pop the newest redo entry, push the current state back onto undo, and
   * apply it. Cleared by any new action (pushHistory).
   */
  redo (id, expectedRevision = null) {
    let summary = null
    const canvas = this.withCanvas(id, expectedRevision, current => {
      const path = this.historyPath(id)
      const history = this.readHistory(id)
      if (history.redo.length === 0) {
        throw new CanvasError('NOTHING_TO_REDO', 'nothing was undone for this canvas')
      }
      const snapshot = history.redo.pop()
      history.undo.push(this.snapshotOf(current))
      writeJsonAtomic(path, history)
      summary = this.applySnapshot(current, snapshot)
      return current
    }, { recordHistory: false })
    return { canvas, ...summary }
  }

  // ── catalog ──

  /**
   * Seed the gallery example canvas on first run: one card per chart type the
   * agent is asked to produce (line/bar/pie/rose/radar), plus a text card
   * explaining the business logic each shape serves. Runs only when the store
   * holds NO canvases and has never been seeded (a `.seeded` marker survives
   * deletion of every canvas, so the example never resurrects itself).
   */
  seedExampleIfEmpty () {
    const markerPath = join(this.root, '.seeded')
    if (existsSync(markerPath)) return null
    const idx = this.readIndex()
    if (idx.canvases.length > 0) {
      writeJsonAtomic(markerPath, { seeded_at: nowIso() })
      return null
    }
    const cards = [
      { type: 'text', title: '怎么选图', text_content: '**趋势** → 折线\n**对比** → 柱状\n**占比** → 饼图\n**占比（多级、强调排序）** → 玫瑰图\n**多维能力** → 雷达图\n\n每张卡的配色由右上角「系列色板」统一控制。', layout: { x: 0, y: 0, w: 24, h: 10 } },
      { type: 'chart', title: '月度营收趋势', chart_type: 'line', echarts_option: { xAxis: { type: 'category', data: ['1月', '2月', '3月', '4月', '5月', '6月'] }, yAxis: { name: '万元' }, series: [{ name: '营收', type: 'line', smooth: true, data: [82, 94, 90, 108, 121, 133] }, { name: '成本', type: 'line', smooth: true, data: [60, 66, 71, 74, 80, 86] }] }, layout: { x: 26, y: 0, w: 34, h: 10 } },
      { type: 'chart', title: '各区域销量对比', chart_type: 'bar', echarts_option: { xAxis: { type: 'category', data: ['华东', '华南', '华北', '西南', '东北'] }, yAxis: {}, series: [{ name: '销量', type: 'bar', data: [320, 280, 240, 150, 90] }] }, layout: { x: 62, y: 0, w: 34, h: 10 } },
      { type: 'chart', title: '渠道构成占比', chart_type: 'pie', echarts_option: { series: [{ type: 'pie', radius: '62%', data: [{ name: '直销', value: 42 }, { name: '渠道', value: 28 }, { name: '电商', value: 20 }, { name: '其他', value: 10 }] }] }, layout: { x: 0, y: 12, w: 30, h: 12 } },
      { type: 'chart', title: '品类销售额（玫瑰图）', chart_type: 'rose', echarts_option: { series: [{ type: 'pie', roseType: 'area', radius: ['18%', '64%'], data: [{ name: 'A 品类', value: 96 }, { name: 'B 品类', value: 72 }, { name: 'C 品类', value: 55 }, { name: 'D 品类', value: 38 }, { name: 'E 品类', value: 21 }] }] }, layout: { x: 32, y: 12, w: 30, h: 12 } },
      { type: 'chart', title: '产品能力雷达', chart_type: 'radar', echarts_option: { radar: { indicator: [{ name: '性能', max: 100 }, { name: '易用', max: 100 }, { name: '生态', max: 100 }, { name: '价格', max: 100 }, { name: '服务', max: 100 }] }, series: [{ type: 'radar', data: [{ name: '本产品', value: [86, 92, 70, 78, 84] }, { name: '竞品均值', value: [74, 80, 82, 66, 70] }] }] }, layout: { x: 64, y: 12, w: 32, h: 12 } },
      { type: 'text', title: '业务对照说明', text_content: '折线里的**成本线**用于对照营收增速；玫瑰图适合**层级占比**（二级类别悬殊时比饼图直观）；雷达图把**多维度评分**放同一坐标系，两系列叠加即可看出此消彼长。', layout: { x: 0, y: 26, w: 96, h: 6 } },
    ]
    const cardsWithDemoSource = cards.map(card => ['chart', 'table', 'kpi'].includes(card.type)
      ? { ...card, dataset: '内置模拟数据 · 非真实业务', query: '固定示例数据；仅用于体验画布功能', source_note: '仅用于体验分析画布功能' }
      : card)
    const canvas = this.createCanvas({ name: '图表类型示例', description: '常用图表形态与适用场景速览', cards: cardsWithDemoSource })
    writeJsonAtomic(markerPath, { seeded_at: nowIso() })
    return canvas
  }

  readIndex () {
    const idx = readJson(this.indexPath, { schema_version: CANVAS_SCHEMA_VERSION, canvases: [] })
    if (!Array.isArray(idx.canvases)) {
      throw new CanvasError('CORRUPT_INDEX', `index.json has no canvases array: ${this.indexPath}`)
    }
    return idx
  }

  writeIndex (idx) {
    writeJsonAtomic(this.indexPath, idx)
  }

  /** List canvases, newest-updated first. */
  listCanvases () {
    const idx = this.readIndex()
    return [...idx.canvases].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  }

  canvasPath (id) {
    return join(this.canvasDir, `${id}.json`)
  }

  getCanvas (id) {
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      throw new CanvasError('INVALID_CANVAS_ID', `invalid canvas id: ${String(id)}`)
    }
    const path = this.canvasPath(id)
    if (!existsSync(path)) {
      throw new CanvasError('CANVAS_NOT_FOUND', `canvas not found: ${id}`)
    }
    const canvas = readJson(path, null)
    if (!canvas || !Array.isArray(canvas.cards)) {
      throw new CanvasError('CORRUPT_CANVAS', `canvas has no cards array: ${id}`)
    }
    return canvas
  }

  /** Load, verify revision, then write — all writers share this path. */
  saveCanvas (canvas, context = this.context) {
    const path = this.canvasPath(canvas.id)
    const previous = existsSync(path) ? readJson(path, null) : null
    applyLineage(canvas, previous, context)
    canvas.updated_at = nowIso()
    const existed = existsSync(path)
    writeJsonAtomic(path, canvas)

    try {
      const idx = this.readIndex()
      const entry = idx.canvases.find(c => c.id === canvas.id)
      const summary = {
        id: canvas.id,      name: canvas.name,
        description: canvas.description ?? null,
        card_count: canvas.cards.length,
        created_at: canvas.created_at,
        updated_at: canvas.updated_at,
      }
      if (entry) Object.assign(entry, summary)
      else idx.canvases.push(summary)
      this.writeIndex(idx)
    } catch (error) {
      // A newly created canvas must never be left as an invisible orphan when
      // the catalog cannot be committed. Existing-canvas writes retain their
      // previous behavior because restoring an overwritten file needs a journal.
      if (!existed) {
        try { unlinkSync(path) } catch { /* preserve the original persistence error */ }
      }
      throw error
    }
    return canvas
  }

  // ── mutations ──

  createCanvas ({ name, description, cards = [], theme = null, settings = null } = {}) {
    if (!name || typeof name !== 'string') {
      throw new CanvasError('INVALID_CANVAS', 'canvas requires a non-empty name')
    }
    const id = randomUUID().replace(/-/g, '').slice(0, 32)
    const wide = settings?.wide === true
    const colBound = wide ? EXTENT_COLS_CEIL : COLS
    const canvas = {
      schema_version: CANVAS_SCHEMA_VERSION,
      id,
      name,
      description: description ?? null,
      revision: 1,
      theme: normalizeTheme(theme),
      settings: defaultSettings(settings),
      // Validate the complete initial content before persisting the canvas.
      cards: cards.reduce((result, input) => {
        const card = makeCard(input, result, undefined, colBound)
        if (!hasTraceableSource(card, card.source)) {
          throw new CanvasError('SOURCE_REQUIRED', 'data cards require dataset and query, or a manual/relink source marker')
        }
        return [...result, card]
      }, []),
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    return this.saveCanvas(canvas)
  }

  /** Import a versioned portable backup as a new canvas with newly generated IDs. */
  importCanvasBackup (backup, { validateOnly = false } = {}) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const optionalText = (value, field, max = 20000) => {
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > max)) {
        throw new CanvasError('INVALID_BACKUP', `${field} must be a string of at most ${max} characters`)
      }
    }
    if (!object(backup) || backup.format !== 'dsh-xcharts-canvas-backup' || backup.format_version !== 1 || !object(backup.canvas)) {
      throw new CanvasError('INVALID_BACKUP', 'unsupported or malformed canvas backup format')
    }
    const source = backup.canvas
    if (source.schema_version !== CANVAS_SCHEMA_VERSION) {
      throw new CanvasError('INVALID_BACKUP', `unsupported canvas schema_version: ${String(source.schema_version)}`)
    }
    if (typeof source.name !== 'string' || !source.name.trim() || source.name.length > 120) {
      throw new CanvasError('INVALID_BACKUP', 'canvas.name must be a non-empty string of at most 120 characters')
    }
    optionalText(source.description, 'canvas.description', 2000)
    if (!Array.isArray(source.cards) || source.cards.length > 500) {
      throw new CanvasError('INVALID_BACKUP', 'canvas.cards must be an array containing at most 500 cards')
    }
    if (source.settings !== undefined && !object(source.settings)) {
      throw new CanvasError('INVALID_BACKUP', 'canvas.settings must be an object')
    }
    for (const key of CANVAS_SETTINGS) {
      if (source.settings?.[key] !== undefined && typeof source.settings[key] !== 'boolean') {
        throw new CanvasError('INVALID_BACKUP', `canvas.settings.${key} must be a boolean`)
      }
    }
    const colBound = source.settings?.wide === true ? EXTENT_COLS_CEIL : COLS
    if (source.theme !== undefined && source.theme !== null && !object(source.theme)) {
      throw new CanvasError('INVALID_BACKUP', 'canvas.theme must be an object')
    }
    if (source.theme?.palette !== undefined && !Object.hasOwn(PALETTES, source.theme.palette)) {
      throw new CanvasError('INVALID_BACKUP', 'canvas.theme.palette is not supported')
    }

    const cards = source.cards.map((card, index) => {
      const label = `canvas.cards[${index}]`
      if (!object(card) || typeof card.type !== 'string' || !CARD_TYPES.includes(card.type)) {
        throw new CanvasError('INVALID_BACKUP', `${label}.type is not supported`)
      }
      if (typeof card.title !== 'string' || !card.title.trim() || card.title.length > 500) {
        throw new CanvasError('INVALID_BACKUP', `${label}.title must be a non-empty string of at most 500 characters`)
      }
      if (!object(card.layout) || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(card.layout[key]) && Math.abs(card.layout[key]) <= 100000)) {
        throw new CanvasError('INVALID_BACKUP', `${label}.layout must contain finite bounded x, y, w and h values`)
      }
      const layout = clampLayout(card.layout, colBound)
      if (['x', 'y', 'w', 'h'].some(key => layout[key] !== card.layout[key])) {
        throw new CanvasError('INVALID_BACKUP', `${label}.layout exceeds the supported canvas bounds`)
      }
      optionalText(card.note, `${label}.note`)
      optionalText(card.text_content, `${label}.text_content`)
      optionalText(card.language, `${label}.language`, 24)
      optionalText(card.chart_type, `${label}.chart_type`, 80)
      for (const key of ['show_header', 'collapsed']) {
        if (card[key] !== undefined && typeof card[key] !== 'boolean') throw new CanvasError('INVALID_BACKUP', `${label}.${key} must be boolean`)
      }
      for (const key of ['echarts_option', 'chart_spec', 'presentation_spec']) {
        if (card[key] !== undefined && card[key] !== null && !object(card[key])) throw new CanvasError('INVALID_BACKUP', `${label}.${key} must be an object`)
      }
      if (card.table_data != null) {
        const table = card.table_data
        if (!object(table) || !Array.isArray(table.columns) || !Array.isArray(table.rows)
          || !table.columns.every(c => typeof c === 'string' || (object(c) && typeof c.name === 'string'))
          || !table.rows.every(row => Array.isArray(row) && row.length <= table.columns.length)) {
          throw new CanvasError('INVALID_BACKUP', `${label}.table_data requires valid columns and row arrays`)
        }
      }
      if (card.color != null) normalizeColor(card.color)
      if (card.source !== undefined && card.source !== null && !object(card.source)) {
        throw new CanvasError('INVALID_BACKUP', `${label}.source must be an object`)
      }
      for (const key of ['dataset', 'query', 'note']) optionalText(card.source?.[key], `${label}.source.${key}`)
      const portableSource = {
        query: card.source?.query ?? null,
        note: card.source?.note ?? null,
      }
      if (card.provenance != null && (!object(card.provenance) || !Array.isArray(card.provenance.versions) || card.provenance.versions.length > 1000 || !Array.isArray(card.provenance.events) || !card.provenance.versions.every(v => object(v) && typeof v.id === 'string' && object(v.card) && CARD_TYPES.includes(v.card.type)))) {
        throw new CanvasError('INVALID_BACKUP', `${label}.provenance 无效`)
      }
      return withRelinkMarker({
        ...Object.fromEntries(PORTABLE_CARD_FIELDS.filter(key => card[key] !== undefined).map(key => [key, card[key]])),
        lineage_import: portableLineage(card.provenance),
        layout,
        source_dataset: null,
        source_query: portableSource.query,
        source_note: portableSource.note,
      })
    })

    const definition = {
      name: `${source.name.trim()}（导入）`.slice(0, 120),
      description: source.description ?? null,
      theme: source.theme,
      settings: source.settings,
      cards,
    }
    return validateOnly ? definition : this.createCanvas(definition)
  }

  exportCanvasBackup (id) {
    const canvas = this.getCanvas(id)
    const fields = PORTABLE_CARD_FIELDS
    const backup = {
      format: 'dsh-xcharts-canvas-backup', format_version: 1, exported_at: nowIso(),
      canvas: { schema_version: CANVAS_SCHEMA_VERSION, name: canvas.name, description: canvas.description ?? null,
        theme: canvas.theme ?? null, settings: canvas.settings ?? {},
        cards: canvas.cards.map(card => ({
          ...Object.fromEntries(fields.filter(key => card[key] !== undefined).map(key => [key, structuredClone(card[key])])),
          source: { query: card.source?.query ?? null, note: card.source?.note ?? null },
          provenance: portableLineage(canvas.lineage?.[card.id]),
        })),
      },
    }
    this.importCanvasBackup(backup, { validateOnly: true })
    if (Buffer.byteLength(JSON.stringify(backup, null, 2), 'utf8') > 8 * 1024 * 1024) throw new CanvasError('BODY_TOO_LARGE', 'backup exceeds 8 MiB')
    return backup
  }

  /** Save a canvas as a local layout-only template (never copies business payloads). */
  createTemplate (canvasId, name) {
    const canvas = this.getCanvas(canvasId)
    const templateName = typeof name === 'string' ? name.trim() : ''
    if (!templateName || templateName.length > 80) {
      throw new CanvasError('INVALID_TEMPLATE', 'template name must contain 1 to 80 characters')
    }
    const placeholders = { chart: '图表占位', table: '表格占位', kpi: '指标占位', text: '文本占位', code: '代码占位' }
    const id = randomUUID().replace(/-/g, '').slice(0, 32)
    const template = {
      template_version: 1,
      id,
      name: templateName,
      created_at: nowIso(),
      updated_at: nowIso(),
      theme: canvas.theme ? structuredClone(canvas.theme) : null,
      settings: defaultSettings(canvas.settings),
      cards: canvas.cards.map(card => ({
        type: card.type,
        title: placeholders[card.type] || '卡片占位',
        layout: structuredClone(card.layout),
        show_header: card.show_header !== false,
        collapsed: card.collapsed === true,
        color: card.color ?? null,
      })),
    }
    this.importCanvasBackup({ format: 'dsh-xcharts-canvas-backup', format_version: 1,
      canvas: { ...template, schema_version: CANVAS_SCHEMA_VERSION } }, { validateOnly: true })
    writeJsonAtomic(join(this.templateDir, `${id}.json`), template)
    return template
  }

  /** Import one template from a workspace backup; it gets a fresh id and dates. */
  importTemplate (template) {
    if (!template || typeof template !== 'object' || Array.isArray(template)) throw new CanvasError('INVALID_TEMPLATE', 'template must be an object')
    if (template.template_version !== 1 || !Array.isArray(template.cards)) throw new CanvasError('INVALID_TEMPLATE', 'unsupported template format')
    const name = typeof template.name === 'string' ? template.name.trim() : ''
    if (!name || name.length > 80) throw new CanvasError('INVALID_TEMPLATE', 'template name must contain 1 to 80 characters')
    if (template.cards.length > 100) throw new CanvasError('INVALID_TEMPLATE', 'template holds too many cards')
    const id = randomUUID().replace(/-/g, '').slice(0, 32)
    const saved = {
      ...structuredClone(template),
      id,
      name,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    // Reuse the canvas validation so a malformed card cannot enter the store.
    this.importCanvasBackup({ format: 'dsh-xcharts-canvas-backup', format_version: 1,
      canvas: { ...saved, schema_version: CANVAS_SCHEMA_VERSION } }, { validateOnly: true })
    writeJsonAtomic(join(this.templateDir, `${id}.json`), saved)
    return { id, name: saved.name, card_count: saved.cards.length }
  }

  listTemplates () {
    if (!existsSync(this.templateDir)) return []
    return readdirSync(this.templateDir).filter(name => /^[a-f0-9]{32}\.json$/i.test(name)).map(name => {
      const template = this.getTemplate(name.slice(0, -5))
      return { id: template.id, name: template.name, created_at: template.created_at, updated_at: template.updated_at, card_count: template.cards.length, types: template.cards.map(card => card.type) }
    }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  }

  getTemplate (id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/i.test(id)) throw new CanvasError('INVALID_TEMPLATE', 'invalid template id')
    const template = readJson(join(this.templateDir, `${id}.json`), null)
    if (!template) throw new CanvasError('TEMPLATE_NOT_FOUND', `template not found: ${id}`)
    if (template.id !== id || template.template_version !== 1 || !Array.isArray(template.cards)) throw new CanvasError('CORRUPT_TEMPLATE', `template is malformed: ${id}`)
    try {
      this.importCanvasBackup({ format: 'dsh-xcharts-canvas-backup', format_version: 1,
        canvas: { ...template, schema_version: CANVAS_SCHEMA_VERSION } }, { validateOnly: true })
    } catch (error) { throw new CanvasError('CORRUPT_TEMPLATE', `template is malformed: ${id}: ${error.message}`) }
    return template
  }

  deleteTemplate (id) {
    const template = this.getTemplate(id)
    unlinkSync(join(this.templateDir, `${id}.json`))
    return { id: template.id, deleted: true }
  }

  renameTemplate (id, name) {
    const template = this.getTemplate(id)
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new CanvasError('INVALID_TEMPLATE', 'template name must contain 1 to 80 characters')
    template.name = name.trim()
    template.updated_at = nowIso()
    writeJsonAtomic(join(this.templateDir, `${id}.json`), template)
    return template
  }

  createCanvasFromTemplate (id, name) {
    const template = this.getTemplate(id)
    const cards = template.cards.map(card => {
      if (!CARD_TYPES.includes(card.type) || !card.layout) throw new CanvasError('CORRUPT_TEMPLATE', `template card is malformed: ${id}`)
      return {
        type: card.type, title: card.title, layout: structuredClone(card.layout),
        show_header: card.show_header, collapsed: card.collapsed, color: card.color,
        ...(['chart', 'table', 'kpi'].includes(card.type) ? { source_note: MANUAL_SOURCE_MARKER + '（模板占位卡片）' } : {}),
      }
    })
    const canvasName = typeof name === 'string' && name.trim() ? name.trim() : `${template.name}（副本）`
    return this.createCanvas({ name: canvasName.slice(0, 120), cards, theme: template.theme, settings: template.settings })
  }

  createExampleCanvas () {
    return this.createCanvas(salesExample())
  }

  /**
   * Mutate a canvas under a revision check. `mutator` returns the canvas.
   *
   * Every successful mutation records the PRE-change state into the undo
   * history, so undo always reflects "one action back" regardless of which
   * entry point made the change (tools, HTTP routes, agent writes). Pass
   * `recordHistory: false` for undo/redo themselves — they manage their own
   * stacks and must not push onto them.
   */
  withCanvas (id, expectedRevision, mutator, { recordHistory = true, context = this.context } = {}) {
    const canvas = this.getCanvas(id)
    if (expectedRevision !== null && expectedRevision !== undefined && canvas.revision !== expectedRevision) {
      throw new RevisionConflict(canvas.revision, expectedRevision)
    }
    // Deep-enough copy of the pre-change layout/presentation state: the mutator
    // mutates cards in place, so a shallow reference would snapshot the AFTER.
    const before = {
      ...canvas,
      revision: canvas.revision,
      theme: canvas.theme ? { ...canvas.theme } : null,
      cards: canvas.cards.map(card => ({
        ...card,
        layout: { ...card.layout },
        source: card.source ? { ...card.source } : null,
      })),
    }
    const result = mutator(canvas)
    canvas.revision += 1
    // Recorded before the save: a failed write must not leave a phantom undo
    // step pointing at a state that never persisted.
    if (recordHistory) this.pushHistory(before)
    return this.saveCanvas(result, context)
  }

  getCardVersion (id, cardId, versionId = null) {
    return resolveVersion(this.getCanvas(id), cardId, versionId)
  }

  restoreCardVersion (id, cardId, versionId, expectedRevision) {
    const frozen = this.getCardVersion(id, cardId, versionId).version
    return this.withCanvas(id, expectedRevision, canvas => {
      const index = canvas.cards.findIndex(card => card.id === cardId)
      if (index < 0) throw new CanvasError('CARD_NOT_FOUND', '卡片已删除')
      const layout = canvas.cards[index].layout
      canvas.cards[index] = { ...structuredClone(frozen.card), id: cardId, layout, data_version_id: frozen.id, updated_at: nowIso() }
      return canvas
    })
  }

  renameCanvas (id, name, expectedRevision = null) {
    if (!name || typeof name !== 'string') {
      throw new CanvasError('INVALID_CANVAS', 'canvas requires a non-empty name')
    }
    return this.withCanvas(id, expectedRevision, canvas => {
      canvas.name = name
      return canvas
    })
  }

  /** Persist the canvas's chart theme choice (validated via normalizeTheme). */
  setTheme (id, theme, expectedRevision = null) {
    const resolved = normalizeTheme(theme)
    return this.withCanvas(id, expectedRevision, canvas => {
      canvas.theme = resolved
      return canvas
    })
  }

  setSettings (id, changes, expectedRevision = null) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)
      || Object.keys(changes).some(key => !CANVAS_SETTINGS.includes(key) || typeof changes[key] !== 'boolean')) {
      throw new CanvasError('INVALID_SETTINGS', `settings must contain boolean ${CANVAS_SETTINGS.join('/')} fields`)
    }
    return this.withCanvas(id, expectedRevision, canvas => {
      canvas.settings = { ...defaultSettings(canvas.settings), ...changes }
      // Closing the wide view recovers only off-screen cards, preserving others.
      if (!canvas.settings.wide) {
        const placed = canvas.cards.filter(card => card.layout.x + card.layout.w <= COLS)
        for (const card of canvas.cards.filter(card => card.layout.x + card.layout.w > COLS)) {
          card.layout = findFreeSlot(placed, card.layout.w, card.layout.h, undefined, COLS)
          placed.push(card)
        }
      }
      return canvas
    })
  }

  /** A group operation is validated in full before one write/history entry. */
  batchCards (id, body, expectedRevision = null) {
    return this.withCanvas(id, expectedRevision, canvas => {
      const ids = body.card_ids
      if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) {
        throw new CanvasError('INVALID_BATCH', 'card_ids must be non-empty and unique')
      }
      const selected = canvas.cards.filter(card => ids.includes(card.id))
      if (selected.length !== ids.length) throw new CanvasError('CARD_NOT_FOUND', 'one or more cards no longer exist')
      if (body.operation === 'delete') {
        canvas.cards = canvas.cards.filter(card => !ids.includes(card.id))
        return canvas
      }
      if (body.operation !== 'layout' || !body.layouts || Object.keys(body.layouts).length !== ids.length) {
        throw new CanvasError('INVALID_BATCH', 'layout operation requires every selected card layout')
      }
      const bound = canvas.settings?.wide ? EXTENT_COLS_CEIL : COLS
      const next = selected.map(card => {
        const rect = body.layouts[card.id]
        if (!rect || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(rect[key]))) {
          throw new CanvasError('INVALID_LAYOUT', 'all layout coordinates must be finite numbers')
        }
        const normalized = clampLayout(rect, bound)
        if (['x', 'y', 'w', 'h'].some(key => rect[key] !== normalized[key])) {
          throw new CanvasError('INVALID_LAYOUT', 'group layout exceeds the canvas bounds')
        }
        return { ...card, layout: normalized }
      })
      const others = canvas.cards.filter(card => !ids.includes(card.id))
      for (let i = 0; i < next.length; i++) {
        if ([...others, ...next.slice(i + 1)].some(other => overlaps(next[i].layout, other.layout))) {
          throw new CanvasError('LAYOUT_COLLISION', '所选卡片与其他卡片重叠，请先移到空白区域再对齐。')
        }
      }
      const layouts = new Map(next.map(card => [card.id, card.layout]))
      for (const card of selected) card.layout = layouts.get(card.id)
      return canvas
    })
  }

  deleteCanvas (id) {
    const path = this.canvasPath(id)
    if (!existsSync(path)) {
      throw new CanvasError('CANVAS_NOT_FOUND', `canvas not found: ${id}`)
    }
    // Remove the index row first: a canvas file without a row is invisible, and
    // an orphan file is harmless (better than a row pointing at nothing).
    const idx = this.readIndex()
    idx.canvases = idx.canvases.filter(c => c.id !== id)
    this.writeIndex(idx)
    unlinkSync(path)
    return { id, deleted: true }
  }

  /** Create an in-memory card preview without writing canvas data or revision. */
  createCardDraft (id, input, expectedRevision = null) {
    const canvas = this.getCanvas(id)
    if (expectedRevision !== null && expectedRevision !== undefined && canvas.revision !== expectedRevision) {
      throw new RevisionConflict(canvas.revision, expectedRevision)
    }
    const anchor = input.anchorCardId
      ? canvas.cards.find(card => card.id === input.anchorCardId)?.layout
      : undefined
    const colBound = canvas.settings?.wide ? EXTENT_COLS_CEIL : COLS
    const card = makeCard(input, canvas.cards, anchor, colBound)
    if (!hasTraceableSource(card, card.source)) {
      throw new CanvasError('SOURCE_REQUIRED', 'data cards require dataset and query, or an explicit manual/relink source marker')
    }

    return this.queueCardDraft(canvas, card, 'add')
  }

  /** Stage a complete updated card; keep the saved card and revision untouched. */
  createCardUpdateDraft (id, cardId, changes, expectedRevision = null) {
    const canvas = this.getCanvas(id)
    if (expectedRevision !== null && expectedRevision !== undefined && canvas.revision !== expectedRevision) {
      throw new RevisionConflict(canvas.revision, expectedRevision)
    }
    const card = canvas.cards.find(item => item.id === cardId)
    if (!card) throw new CanvasError('CARD_NOT_FOUND', `card not found: ${cardId}`)
    return this.queueCardDraft(canvas, patchedCard(card, changes), 'update')
  }

  queueCardDraft (canvas, card, operation) {
    const drafts = draftsForRoot(this.root)
    // A follow-up add on the same canvas is a replacement preview after feedback.
    const superseded = operation === 'add'
      ? [...drafts.values()].filter(draft => draft.status === 'pending' && draft.operation === 'add' && draft.canvas_id === canvas.id)
      : []
    if ([...drafts.values()].filter(draft => draft.status === 'pending').length - superseded.length >= DRAFT_LIMIT) {
      throw new CanvasError('DRAFT_LIMIT', '待确认草稿已达 100 项，请先在画布确认或取消旧预览。')
    }
    const draft = {
      id: randomUUID().replace(/-/g, '').slice(0, 32),
      operation,
      context: structuredClone(this.context),
      canvas_id: canvas.id,
      canvas_name: canvas.name,
      expected_revision: canvas.revision,
      created_at: nowIso(),
      expires_at: Date.now() + DRAFT_PENDING_TTL,
      status: 'pending',
      card,
      result: null,
    }
    for (const previous of superseded) {
      previous.status = 'superseded'
      previous.superseded_by = draft.id
      previous.expires_at = Date.now() + DRAFT_TERMINAL_TTL
      previous.card = null
    }
    drafts.set(draft.id, draft)
    const terminals = [...drafts.values()].filter(item => item.status !== 'pending')
    while (terminals.length > DRAFT_LIMIT) drafts.delete(terminals.shift().id)
    return publicDraft(draft)
  }

  /** List only drafts awaiting an explicit browser user action. */
  listCardDrafts () {
    return [...draftsForRoot(this.root).values()]
      .filter(draft => draft.status === 'pending')
      .map(publicDraft)
  }

  /** Commit a user-approved draft once; retries return the original result. */
  confirmCardDraft (draftId) {
    const drafts = draftsForRoot(this.root)
    const draft = drafts.get(draftId)
    if (!draft) throw new CanvasError('DRAFT_NOT_FOUND', `card draft not found: ${draftId}`)
    if (draft.status === 'confirmed') return { ...draft.result, idempotent: true }
    if (draft.status === 'superseded') throw new CanvasError('DRAFT_SUPERSEDED', 'a newer preview replaced this card draft')
    if (draft.status === 'cancelled') throw new CanvasError('DRAFT_CANCELLED', 'card draft was cancelled')

    const current = this.getCanvas(draft.canvas_id)
    const alreadySaved = draft.operation !== 'update' && current.cards.find(card => card.id === draft.card.id)
    if (alreadySaved) {
      draft.status = 'confirmed'
      draft.expires_at = Date.now() + DRAFT_TERMINAL_TTL
      draft.result = { draft_id: draft.id, canvas_id: current.id, card_id: alreadySaved.id, revision: current.revision, card_count: current.cards.length }
      draft.card = null
      return { ...draft.result, idempotent: true }
    }

    const card = draft.card
    const canvas = this.withCanvas(draft.canvas_id, draft.expected_revision, latest => {
      if (draft.operation === 'update') {
        const index = latest.cards.findIndex(item => item.id === card.id)
        if (index < 0) throw new CanvasError('CARD_NOT_FOUND', `card not found: ${card.id}`)
        latest.cards[index] = { ...card, updated_at: nowIso() }
      } else latest.cards.push(card)
      return latest
    }, { context: draft.context || {} })
    draft.status = 'confirmed'
    draft.expires_at = Date.now() + DRAFT_TERMINAL_TTL
    draft.result = {
      draft_id: draft.id,
      canvas_id: canvas.id,
      card_id: card.id,
      revision: canvas.revision,
      card_count: canvas.cards.length,
    }
    draft.card = null
    return { ...draft.result, idempotent: false }
  }

  /** Cancel is idempotent and never touches canvas data or revision. */
  cancelCardDraft (draftId) {
    const draft = draftsForRoot(this.root).get(draftId)
    if (!draft) throw new CanvasError('DRAFT_NOT_FOUND', `card draft not found: ${draftId}`)
    if (draft.status === 'confirmed') throw new CanvasError('DRAFT_ALREADY_CONFIRMED', 'confirmed card cannot be cancelled')
    if (draft.status === 'superseded') return { draft_id: draft.id, cancelled: true, superseded: true, idempotent: true }
    if (draft.status === 'cancelled') return { draft_id: draft.id, cancelled: true, idempotent: true }
    draft.status = 'cancelled'
    draft.expires_at = Date.now() + DRAFT_TERMINAL_TTL
    draft.card = null
    return { draft_id: draft.id, cancelled: true, idempotent: false }
  }

  addCard (id, input, expectedRevision = null) {
    return this.withCanvas(id, expectedRevision, canvas => {
      const anchor = input.anchorCardId
        ? canvas.cards.find(c => c.id === input.anchorCardId)?.layout
        : undefined
      const card = makeCard(input, canvas.cards, anchor)
      if (!hasTraceableSource(card, card.source)) {
        throw new CanvasError('SOURCE_REQUIRED', 'data cards require dataset and query, or an explicit manual/relink source marker')
      }
      canvas.cards.push(card)
      return canvas
    })
  }

  updateCard (id, cardId, changes, expectedRevision = null) {
    return this.withCanvas(id, expectedRevision, canvas => {
      const index = canvas.cards.findIndex(c => c.id === cardId)
      if (index < 0) throw new CanvasError('CARD_NOT_FOUND', `card not found: ${cardId}`)
      canvas.cards[index] = patchedCard(canvas.cards[index], changes)
      return canvas
    })
  }

  removeCard (id, cardId, expectedRevision = null) {
    return this.withCanvas(id, expectedRevision, canvas => {
      const before = canvas.cards.length
      canvas.cards = canvas.cards.filter(c => c.id !== cardId)
      if (canvas.cards.length === before) {
        throw new CanvasError('CARD_NOT_FOUND', `card not found: ${cardId}`)
      }
      return canvas
    })
  }

  /** Move/resize a single card. */
  moveCard (id, cardId, layout, expectedRevision = null) {
    return this.updateCard(id, cardId, { layout }, expectedRevision)
  }

  /**
   * Copy a card into another canvas (or the same one).
   *
   * Used by "move to canvas": the source card is removed and a copy lands on the
   * target, so provenance and presentation travel with it. Placement on the
   * target is a free slot — the source coordinates would be meaningless there.
   */
  copyCardToCanvas (fromId, cardId, toId, { removeFromSource = true, title, expectedRevision = null } = {}) {
    const source = this.getCanvas(fromId)
    const original = source.cards.find(c => c.id === cardId)
    if (!original) throw new CanvasError('CARD_NOT_FOUND', `card not found: ${cardId}`)

    const payload = withRelinkMarker({
      type: original.type,
      title: title || original.title,
      chart_type: original.chart_type,
      echarts_option: original.echarts_option,
      chart_spec: original.chart_spec,
      table_data: original.table_data,
      presentation_spec: original.presentation_spec,
      text_content: original.text_content,
      show_header: original.show_header,
      collapsed: original.collapsed,
      note: original.note,
      color: original.color,
      source_dataset: original.source?.dataset,
      source_query: original.source?.query,
      source_note: original.source?.note,
      binding: original.binding,
      calculation_ref: original.calculation_ref,
      copied_from: { canvas_id: fromId, card_id: cardId, version_id: original.data_version_id || resolveVersion(source, cardId).version.id },
      lineage_import: source.lineage?.[cardId] || { versions: resolveVersion(source, cardId).versions, events: [], current_version_id: resolveVersion(source, cardId).current_version_id },
    })

    const target = this.addCard(toId, payload, expectedRevision)
    const created = target.cards[target.cards.length - 1]
    if (removeFromSource) {
      this.withCanvas(fromId, null, current => {
        current.cards = current.cards.filter(c => c.id !== cardId)
        return current
      })
    }
    return { card: created, from: fromId, to: toId, revision: target.revision }
  }

  /** Copy every card of one canvas onto another, preserving relative layout. */
  mergeCanvasInto (fromId, toId, options = {}) {
    const source = this.getCanvas(fromId)
    if (source.id === toId) {
      throw new CanvasError('INVALID_TARGET', 'cannot merge a canvas into itself')
    }
    const target = this.getCanvas(toId)

    // Offset the incoming cards below everything already there so the merge
    // never lands on top of existing content.
    let baseY = 0
    for (const card of target.cards) {
      baseY = Math.max(baseY, card.layout.y + card.layout.h)
    }

    const incoming = source.cards.map(card => withRelinkMarker({
      type: card.type,
      title: card.title,
      chart_type: card.chart_type,
      echarts_option: card.echarts_option,
      chart_spec: card.chart_spec,
      table_data: card.table_data,
      presentation_spec: card.presentation_spec,
      text_content: card.text_content,
      show_header: card.show_header,
      collapsed: card.collapsed,
      note: card.note,
      color: card.color,
      source_dataset: card.source?.dataset,
      source_query: card.source?.query,
      source_note: card.source?.note,
      binding: card.binding,
      calculation_ref: card.calculation_ref,
      copied_from: { canvas_id: fromId, card_id: card.id, version_id: card.data_version_id || resolveVersion(source, card.id).version.id },
      lineage_import: source.lineage?.[card.id] || { versions: resolveVersion(source, card.id).versions, events: [], current_version_id: resolveVersion(source, card.id).current_version_id },
      layout: { ...card.layout, y: card.layout.y + baseY + (baseY > 0 ? 1 : 0) },
    }))

    const canvas = this.withCanvas(toId, null, current => {
      for (const payload of incoming) {
        const copied = makeCard(payload, current.cards, undefined)
        if (!hasTraceableSource(copied, copied.source)) {
          throw new CanvasError('SOURCE_REQUIRED', 'merged data cards require a complete source or an explicit manual/relink status')
        }
        current.cards.push(copied)
      }
      return current
    })

    if (options.keepSource === false) {
      this.deleteCanvas(fromId)
    }
    return { moved: incoming.length, to: toId, canvas }
  }
}
