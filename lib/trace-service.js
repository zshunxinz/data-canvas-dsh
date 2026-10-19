import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { CanvasError, CanvasStore } from './store.js'
import { DataStore } from './data-store.js'
import { queryTable } from './data-query.js'
import { resolveVersion } from './lineage.js'
import { readExecution } from './execution-evidence.js'

import { maskHost } from './secrets.js'
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const clone = value => value === undefined ? undefined : structuredClone(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const tableHash = data => hash({ columns: data.columns, rows: data.rows })
const resultHash = data => hash({ columns: data.columns, rows: data.rows, query: data.query, source_hash: data.source_hash })
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
function freeze (value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
function redact (value) {
  if (typeof value === 'string') return value.replace(/\b(Bearer\s+)[\w.+/=-]+/gi, '$1[redacted]').replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|secret|token|api[_-]?key|authorization/i.test(key) ? '[redacted]' : redact(item)]))
  return value
}
function legacy (card) { try { const parsed = JSON.parse(card.source?.query); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} } }
function refs (card) { const old = legacy(card); return { old, result_id: card.binding?.result_id ?? old.result_id, source_id: card.binding?.source_id ?? (uuid(card.source?.dataset) ? card.source.dataset : undefined) } }
function optional (fn) { try { return fn() } catch (error) { if (['DATA_NOT_FOUND', 'SOURCE_VERSION_NOT_FOUND', 'VERSION_NOT_FOUND'].includes(error.code)) return null; throw error } }
function readRef (path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw new CanvasError('CORRUPT_FOLLOWUP', '追问引用损坏，请恢复备份') } }
function writeRef (path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(tmp, JSON.stringify(value), { flag: 'wx' }); renameSync(tmp, path) }
  finally { try { unlinkSync(tmp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
}
function identifier (value, field) { if (typeof value !== 'string' || !/^[\w-]{1,160}$/.test(value)) throw new CanvasError('INVALID_FOLLOWUP', `${field} 格式无效`); return value }
function refId (value) { if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new CanvasError('INVALID_FOLLOWUP', '追问引用格式无效'); return value }
function equalNumbers (a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b))
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equalNumbers(v, b[i]))
  return same(a, b)
}
function presentation (card, result) {
  const binding = card.binding
  if (binding && (binding.type !== card.type || (card.type === 'chart' && binding.chart_type !== card.chart_type))) return { status: 'fail', message: '卡片类型与结果绑定不一致' }
  if (card.type === 'table') return { status: same(card.table_data?.columns, result.columns) && same(card.table_data?.rows, result.rows) ? 'pass' : 'fail', message: '逐列逐行比较表格与结果快照' }
  if (card.type === 'kpi') {
    const y = binding?.y ?? card.presentation_spec?.label
    const i = result.columns.findIndex(c => c.name === y && c.type === 'number')
    if (i < 0) return { status: 'unknown', message: '指标字段未绑定，无法验证' }
    return { status: result.rows.length === 1 && result.total_rows === 1 && card.presentation_spec?.value === result.rows[0][i] ? 'pass' : 'fail', message: '指标值严格对应单行数值结果' }
  }
  if (card.type !== 'chart') return { status: 'unknown', message: '此卡片没有可验证的数据展示' }
  const option = card.echarts_option, series = option?.series
  if (!Array.isArray(series) || !series.length || option.dataset || option.baseOption || option.options || option.media) return { status: 'unknown', message: '图表使用未支持的转换或配置，无法证明数据对应关系' }
  if (!series.every(s => ['bar', 'line', 'pie'].includes(s.type) && Array.isArray(s.data) && !s.encode && !s.datasetIndex && !s.transform)) return { status: 'unknown', message: '存在无法验证的图表系列' }
  let candidates = result.columns.map((c, i) => i)
  if (binding) candidates = candidates.filter(i => result.columns[i].name === binding.x)
  const axes = option.xAxis == null ? [] : Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis]
  const matching = candidates.some(x => {
    const labels = result.rows.map(row => String(row[x] ?? '（空）'))
    return series.every(s => {
      let ys = result.columns.map((c, i) => i).filter(i => result.columns[i].type === 'number')
      if (binding) ys = ys.filter(i => result.columns[i].name === binding.y)
      else if (s.name) ys = ys.filter(i => result.columns[i].name === s.name)
      if (s.type !== 'pie') {
        const axis = axes[s.xAxisIndex ?? 0]
        if (!axis || (axis.type && axis.type !== 'category') || !same(axis.data, labels)) return false
      }
      return ys.some(y => same(s.data, s.type === 'pie' ? result.rows.map((r, i) => ({ name: labels[i], value: r[y] })) : result.rows.map(r => r[y])))
    })
  })
  return { status: matching ? 'pass' : 'fail', message: '逐一比较所有系列的真实值、分类标签与绑定字段' }
}

/** Read-only provenance and bounded, durable follow-up context. Never executes external code. */
export class TraceService {
  constructor (root, services = {}) { this.root = root; this.services = services; this.store = new CanvasStore(root); this.dataStore = new DataStore(root); this.followups = join(root, 'followups') }
  resolve (canvasId, cardId, versionId) { const canvas = this.store.getCanvas(canvasId); return { canvas, ...resolveVersion(canvas, cardId, versionId ?? undefined) } }
  async session (context = {}) {
    const id = context.session_id ?? context.conversation_id
    if (!id) return { status: 'unrecorded' }
    if (context.imported) return { status: 'unrecorded', imported_id: id, reason: 'imported' }
    const base = { id, ...(context.call_id ? { call_id: context.call_id } : {}) }
    const service = this.services.sessionQuery
    if (!service?.readTitle) return { ...base, status: 'limited', reason: 'unavailable' }
    try {
      const title = await service.readTitle(id)
      if (title == null) return { ...base, status: 'missing' }
      return { ...base, title: redact(typeof title === 'string' ? title : title.title), status: 'available' }
    } catch { return { ...base, status: 'limited', reason: 'unavailable' } }
  }
  async read (canvasId, cardId, versionId = null) {
    const resolved = this.resolve(canvasId, cardId, versionId), { canvas, version } = resolved
    const card = version.card, linked = refs(card)
    const result = linked.result_id ? optional(() => this.dataStore.result(linked.result_id)) : null
    const sourceId = linked.source_id ?? result?.source_id
    const source = sourceId ? optional(() => this.dataStore.get(sourceId)) : null
    const expectedHash = result?.source_hash ?? linked.old.source_hash
    const database = source?.kind === 'database'
    const data = sourceId ? [{ id: sourceId, name: source?.name ?? result?.source_name, filename: source?.filename, row_count: source?.row_count, column_count: source?.columns?.length, ...(database ? { kind: 'database', format: source?.format, host: maskHost(source?.connection?.host), database: source?.connection?.database, table_count: source?.catalog?.table_count ?? null } : {}), content_hash: expectedHash, current_hash: source?.content_hash, status: !source ? 'missing' : database ? 'live' : !expectedHash ? 'unrecorded' : source.content_hash === expectedHash ? 'linked' : 'changed' }] : []
    const executionEvidence = card.calculation_ref ? readExecution(this.root, card.calculation_ref) : null
    const calculation = result ? { kind: result.source_kind === 'database' ? 'sql' : 'structured', method: result.source_kind === 'database' ? { kind: 'sql', sql: result.query?.sql ?? null, format: result.execution?.method?.format ?? null } : result.query, status: result.source_kind === 'database' ? 'live' : 'linked', execution: result.execution ?? null, evidence: { result_id: result.id, result_hash: result.result_hash, source_hash: result.source_hash, coverage: result.coverage } }
      : card.calculation_ref ? { kind: 'execution', method: executionEvidence?.method ?? null, status: executionEvidence ? 'pending' : 'missing', execution: card.calculation_ref, evidence: executionEvidence ? { tool: executionEvidence.tool, status: executionEvidence.status, method_truncated: executionEvidence.method_truncated, output: executionEvidence.output, output_truncated: executionEvidence.output_truncated, created_at: executionEvidence.created_at } : null }
        : { kind: 'declared', method: card.source?.query ?? null, status: linked.result_id ? 'missing' : card.source?.query ? 'pending' : 'unrecorded', execution: null }
    const sessionContext = { ...(version.context ?? {}), ...(result?.conversation ?? {}), ...(result?.execution?.context ?? {}), ...(!result && card.calculation_ref ? card.calculation_ref : {}) }
    return { canvas: { id: canvas.id, name: canvas.name }, card: freeze(clone(card)), version: { id: version.id, created_at: version.created_at, current: version.id === resolved.current_version_id }, versions: resolved.versions.map(v => ({ id: v.id, title: v.card.title, created_at: v.created_at })), events: (resolved.events ?? []).map(e => redact({ id: e.id, type: e.type ?? e.action ?? e.kind, created_at: e.created_at ?? e.at, version_id: e.version_id })), data: redact(data), calculation: redact(calculation), session: await this.session(sessionContext), placement: { canvas_id: canvas.id, card_id: cardId, layout: clone(card.layout), deleted: resolved.card === null }, ...(card.derived_from ? { derived_from: clone(card.derived_from) } : {}) }
  }
  async check (canvasId, cardId, versionId = null) {
    const { version } = this.resolve(canvasId, cardId, versionId), card = version.card, linked = refs(card)
    const result = linked.result_id ? optional(() => this.dataStore.result(linked.result_id)) : null
    const checks = [], add = (id, status, message) => checks.push({ id, status, message })
    if (!result) add('result', 'unknown', '没有可读取的结构化结果证据；来源声明不能作为验证')
    else {
      add('result_hash', result.result_hash && resultHash(result) === result.result_hash && (!linked.old.result_hash || linked.old.result_hash === result.result_hash) ? 'pass' : 'fail', '校验结果快照内容哈希与卡片记录')
      const source = optional(() => this.dataStore.get(result.source_id))
      if (source?.kind === 'database') {
        add('source_hash', 'unknown', '实时连接：结果为查询时快照，不比较源哈希（可用「复算」重新执行 SQL 比对）')
      } else add('source_hash', !source ? 'unknown' : source.content_hash === result.source_hash && tableHash(source) === result.source_hash && (!linked.old.source_hash || linked.old.source_hash === result.source_hash) ? 'pass' : 'fail', source ? '校验当前规范化输入与记录的源哈希' : '当前数据源已不可读取')
      if (card.binding && linked.source_id !== result.source_id) add('binding', 'fail', '结果与数据源绑定冲突')
      const counts = Array.isArray(result.rows) && result.materialized_rows === result.rows.length && Number.isInteger(result.total_rows) && result.total_rows >= result.rows.length && Number.isInteger(result.input_rows) && Number.isInteger(result.matched_rows) && result.matched_rows >= 0 && result.input_rows >= result.matched_rows && result.total_rows <= result.matched_rows + (result.matched_rows === 0 ? 1 : 0)
      const complete = result.coverage === 'complete' && result.total_rows === result.rows.length && result.truncated === false
      const partial = result.coverage === 'partial' && result.total_rows > result.rows.length && result.truncated === true
      add('coverage', !counts || (!complete && !partial) ? 'fail' : partial ? 'partial' : 'pass', '核对输入、匹配、总量、已保存行数与完整性标记')
      checks.push({ id: 'presentation', ...presentation(card, result) })
    }
    return { checks, checked_at: new Date().toISOString() }
  }
  async recompute (canvasId, cardId, versionId = null) {
    const { version } = this.resolve(canvasId, cardId, versionId), linked = refs(version.card)
    const result = linked.result_id ? optional(() => this.dataStore.result(linked.result_id)) : null
    if (result?.source_kind === 'database') return this.recomputeDatabase(result)
    if (!result?.query || !result.source_hash) return { status: 'unavailable', reason: '没有可复算的结构化查询与源版本' }
    let source = null
    if (typeof this.dataStore.sourceVersion === 'function') source = optional(() => this.dataStore.sourceVersion(result.source_id, result.source_hash))
    source ??= optional(() => this.dataStore.get(result.source_id))
    if (!source || source.content_hash !== result.source_hash || tableHash(source) !== result.source_hash) return { status: 'unavailable', reason: '原始规范化输入缺失或哈希已改变' }
    let computed
    try { computed = queryTable(source, clone(result.query)) } catch { return { status: 'unavailable', reason: '记录的结构化查询无法执行' } }
    const differences = []
    if (!same(result.columns, computed.columns)) differences.push('columns')
    if (!equalNumbers(result.rows, computed.rows)) differences.push('rows')
    for (const key of ['coverage', 'input_rows', 'matched_rows', 'total_rows', 'materialized_rows', 'truncated']) if (result[key] !== computed[key]) differences.push(key)
    if (result.result_hash !== resultHash(result)) differences.push('result_hash')
    return { status: differences.length ? 'different' : 'match', differences, result_id: result.id, source_hash: result.source_hash, coverage: computed.coverage, tolerance: { absolute: 1e-10, relative: 1e-10 } }
  }
  /** Re-run the recorded SQL and compare with the snapshot; clearly labelled as live. */
  async recomputeDatabase (result) {
    const sql = result.query?.sql
    if (!sql) return { status: 'unavailable', reason: '记录里没有 SQL' }
    let run
    try { run = await this.dataStore.previewDatabaseQuery(result.source_id, { sql, limit: result.query?.limit ?? 5000 }) }
    catch (error) { return { status: 'unavailable', reason: 'SQL 无法执行：' + error.message } }
    const differences = []
    if (!same(result.columns, run.columns)) differences.push('columns')
    if (!equalNumbers(result.rows, run.rows)) differences.push('rows')
    if ((result.truncated === true) !== (run.truncated === true)) differences.push('truncated')
    if (result.result_hash !== resultHash(result)) differences.push('result_hash')
    return {
      status: differences.length ? 'live_changed' : 'match',
      live: true,
      differences,
      result_id: result.id,
      sql,
      source_hash: result.source_hash,
      coverage: run.truncated ? 'partial' : 'complete',
      tolerance: { absolute: 1e-10, relative: 1e-10 },
      note: '数据库为实时连接：复算会重新执行 SQL，与查询时快照比对，不会覆盖快照',
    }
  }
  async createFollowup (canvasId, cardId, input = {}) {
    identifier(input.request_id, 'request_id')
    if (input.session_id != null) identifier(input.session_id, 'session_id')
    if (input.version_id != null) identifier(input.version_id, 'version_id')
    const id = hash(input.request_id).slice(0, 32), path = join(this.followups, `${id}.json`)
    const identity = { canvas_id: canvasId, card_id: cardId, version_id: input.version_id ?? null, session_id: input.session_id ?? null }
    const prior = readRef(path)
    if (prior) { if (!same(prior.identity, identity)) throw new CanvasError('FOLLOWUP_CONFLICT', 'request_id 已用于不同的追问目标'); return this.followupReply(prior) }
    const { canvas, version } = this.resolve(canvasId, cardId, input.version_id)
    const linked = refs(version.card)
    const result = linked.result_id ? optional(() => this.dataStore.result(linked.result_id)) : null
    const record = { id, request_id: input.request_id, identity, canvas: { id: canvas.id, name: canvas.name }, card_id: cardId, version: clone(version), result_refs: { result_id: linked.result_id, source_id: linked.source_id ?? result?.source_id, source_hash: result?.source_hash ?? linked.old.source_hash, result_hash: result?.result_hash ?? linked.old.result_hash }, session_id: input.session_id ?? null, status: 'pending', created_at: new Date().toISOString(), receipts: [] }
    mkdirSync(this.followups, { recursive: true }); writeRef(path, record)
    return this.followupReply(record)
  }
  followupReply (record) { return { id: record.id, ref_id: record.id, version_id: record.version.id, session_id: record.session_id, status: record.status, prompt: `${redact(String(record.version.card.title)).replace(/[\r\n\[\]]/g, ' ').slice(0, 200)} [xcharts:${record.id}]` } }
  async context (id, { full = false } = {}) {
    const record = readRef(join(this.followups, `${refId(id)}.json`))
    if (!record) throw new CanvasError('FOLLOWUP_NOT_FOUND', '追问引用不存在')
    if (full) return redact({ canvas: record.canvas, version: record.version, target_session_id: record.session_id })
    const card = clone(record.version.card)
    let remaining = 20, truncated = false
    const bound = value => { const count = Math.min(remaining, value.length); remaining -= count; truncated ||= count < value.length; return clone(value.slice(0, count)) }
    if (card.table_data?.rows) card.table_data.rows = bound(card.table_data.rows)
    const series = card.echarts_option?.series
    if (Array.isArray(series)) for (const s of series) if (Array.isArray(s.data)) s.data = bound(s.data)
    const axes = card.echarts_option?.xAxis
    for (const a of Array.isArray(axes) ? axes : axes ? [axes] : []) if (Array.isArray(a.data)) { truncated ||= a.data.length > 20; a.data = a.data.slice(0, 20) }
    if (card.echarts_option?.dataset) { delete card.echarts_option.dataset; truncated = true }
    if (card.chart_spec) { delete card.chart_spec; truncated = true }
    if (card.text_content?.length > 12000) { card.text_content = card.text_content.slice(0, 12000); truncated = true }
    const output = redact({ id: record.id, target_session_id: record.session_id, title: card.title, canvas: record.canvas, version: { id: record.version.id, created_at: record.version.created_at }, card, source: card.source, calculation: record.result_refs, calculation_ref: card.calculation_ref, truncated, full_version_api: `/api/xcharts-canvas/followups/${record.id}/version` })
    if (JSON.stringify(output).length > 32000) { output.card = { id: card.id, title: card.title, type: card.type }; output.source = undefined; output.truncated = true }
    return output
  }
  async ackFollowup (id, input = {}) {
    identifier(input.session_id, 'session_id')
    const stages = ['pending', 'attached', 'sent', 'acknowledged', 'completed']
    if (!stages.includes(input.status) || input.status === 'pending') throw new CanvasError('INVALID_FOLLOWUP_STATUS', '追问状态无效')
    const path = join(this.followups, `${refId(id)}.json`), record = readRef(path)
    if (!record) throw new CanvasError('FOLLOWUP_NOT_FOUND', '追问引用不存在')
    if (record.session_id && record.session_id !== input.session_id) throw new CanvasError('FOLLOWUP_SESSION_MISMATCH', '追问目标会话不匹配')
    const receipt = `${input.session_id}:${input.status}`
    if (record.receipts.includes(receipt)) return { ...this.followupReply(record), duplicate: true }
    if (stages.indexOf(input.status) < stages.indexOf(record.status)) throw new CanvasError('FOLLOWUP_CONFLICT', '追问状态不能回退')
    record.session_id = input.session_id; record.status = input.status; record.receipts.push(receipt); record.updated_at = new Date().toISOString()
    writeRef(path, record)
    return { ...this.followupReply(record), duplicate: false }
  }
}
