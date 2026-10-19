import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { CanvasError } from './store.js'
import { parseFile } from './data-parser.js'
import { queryTable } from './data-query.js'
import { currentExecution } from './execution-context.js'
import { appendUsage } from './usage-log.js'
import { putSecret, readSecret, deleteSecret } from './secrets.js'
import { normalizeConnection, introspect, runQuery, engineOf } from './db/adapter.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const validId = id => { if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new CanvasError('INVALID_ID', '数据引用无效'); return id }
const nameOf = name => { if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new CanvasError('INVALID_NAME', '名称应为 1～120 字'); return name.trim() }
function conversationOf (value) {
  if (value == null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new CanvasError('INVALID_CONVERSATION', '对话来源必须是对象')
  const pick = (key, max = 160) => value[key] == null ? undefined : String(value[key]).trim().slice(0, max)
  const conversation = { conversation_id: pick('conversation_id'), message_id: pick('message_id'), turn_id: pick('turn_id'), title: pick('title', 200), prompt_excerpt: pick('prompt_excerpt', 500) }
  for (const key of Object.keys(conversation)) if (conversation[key] === undefined || conversation[key] === '') delete conversation[key]
  if (!Object.keys(conversation).length) throw new CanvasError('INVALID_CONVERSATION', '对话来源至少需要一个有效标识')
  return conversation
}
function sourceOf (input) {
  const source = input?.source
  if (source == null) return undefined
  if (typeof source !== 'object' || Array.isArray(source)) throw new CanvasError('INVALID_SOURCE', '数据源来源必须是对象')
  const result = { type: source.type == null ? undefined : String(source.type).slice(0, 40), attachment_id: source.attachment_id == null ? undefined : String(source.attachment_id).slice(0, 160), receipt_id: source.receipt_id == null ? undefined : String(source.receipt_id).slice(0, 160), filename: source.filename == null ? undefined : String(source.filename).slice(0, 200) }
  for (const key of Object.keys(result)) if (result[key] === undefined || result[key] === '') delete result[key]
  if (!Object.keys(result).length) throw new CanvasError('INVALID_SOURCE', '数据源来源至少需要一个有效字段')
  return result
}
function write (path, value) {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new CanvasError('BODY_TOO_LARGE', '规范化数据超过 16 MiB，请拆分数据')
  const tmp = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' }); renameSync(tmp, path) }
  finally { try { unlinkSync(tmp) } catch (e) { if (e.code !== 'ENOENT') throw e } }
}
function read (path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') throw new CanvasError('DATA_NOT_FOUND', '数据源或结果不存在'); throw new CanvasError('CORRUPT_DATA', '本地数据无法读回，请恢复备份后重试') }
}

export class DataStore {
  constructor (root) { this.root = root; this.dir = join(root, 'datasources'); this.results = join(root, 'results'); this.inputs = join(root, 'inputs') }
  retainSource (data) {
    const { results, ...input } = data
    mkdirSync(this.inputs, { recursive: true })
    const path = join(this.inputs, `${validId(data.id)}-${data.content_hash}.json`)
    if (!existsSync(path)) write(path, input)
  }
  sourceVersion (id, contentHash) {
    if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) throw new CanvasError('INVALID_HASH', '数据源版本无效')
    return read(join(this.inputs, `${validId(id)}-${contentHash}.json`))
  }
  get (id) { return read(join(this.dir, `${validId(id)}.json`)) }
  result (id) { return read(join(this.results, `${validId(id)}.json`)) }
  summary (data) { const { rows, ...meta } = data; return meta }
  list () {
    let files
    try { files = readdirSync(this.dir) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    return files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => { const summary = this.summary(read(join(this.dir, f))); summary.table_count = summary.catalog?.table_count ?? null; summary.needs_secret = Boolean(summary.needs_secret); delete summary.catalog; delete summary.secret_ref; return summary }).sort((a, b) => b.created_at.localeCompare(a.created_at))
  }
  async inspect (input) {
    try { const data = await parseFile(input); return { ...data, rows: data.rows.slice(0, 20), row_count: data.rows.length, preview_rows: Math.min(20, data.rows.length) } }
    catch (error) { throw new CanvasError('INVALID_FILE', error.message) }
  }
  async import (input) {
    const name = nameOf(input.name)
    let parsed
    try { parsed = await parseFile(input) } catch (error) { throw new CanvasError('INVALID_FILE', error.message) }
    const { sheets, ...table } = parsed
    const conversation = conversationOf(input.conversation)
    const source = sourceOf(input)
    const data = { id: randomUUID(), name, filename: String(input.filename).split(/[\\/]/).pop().slice(0, 200),
      format: (/\.(csv|tsv|xlsx|parquet)$/i.exec(input.filename || '')?.[1] || 'csv').toLowerCase(),
      created_at: new Date().toISOString(), options: input.options ?? {}, file_hash: hash(Buffer.from(input.content_base64, 'base64')),
      content_hash: hash(JSON.stringify({ columns: table.columns, rows: table.rows })), row_count: table.rows.length, ...(source ? { source } : {}), ...(conversation ? { conversation } : {}), ...table }
    this.retainSource(data)
    mkdirSync(this.dir, { recursive: true }); write(join(this.dir, `${data.id}.json`), data)
    return this.summary(data)
  }
  describe (id, offset = 0, limit = 20) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new CanvasError('INVALID_PAGE', '预览偏移或页大小无效')
    const data = this.get(id)
    if (data.kind === 'database') return { ...this.summary(data), rows: [], offset, has_more: false }
    return { ...this.summary(data), rows: data.rows.slice(offset, offset + limit), offset, has_more: offset + limit < data.rows.length }
  }
  rename (id, name) { const data = this.get(id); data.name = nameOf(name); write(join(this.dir, `${validId(id)}.json`), data); return this.summary(data) }
  /** 业务备注：只存在数据源 JSON 里，随备份走，不参与查询。 */
  updateNote (id, note) {
    const data = this.get(id)
    data.note = String(note ?? '').trim().slice(0, 200)
    write(join(this.dir, `${validId(id)}.json`), data)
    return this.summary(data)
  }
  remove (id) { const data = this.get(id); unlinkSync(join(this.dir, `${validId(id)}.json`)); if (data.secret_ref) deleteSecret(this.root, data.secret_ref); return { deleted: id, note: '已保存结果与画布保留；此数据源无法再执行新查询。' } }
  query (id, query) {
    const data = this.get(id)
    if (data.kind === 'database') return this.queryDatabase(id, query)
    this.retainSource(data)
    const input = query ?? {}, conversation = conversationOf(input.conversation)
    const { conversation: _conversation, ...querySpec } = input
    const result = { id: randomUUID(), source_id: data.id, source_name: data.name, source_hash: data.content_hash, source_warnings: data.warnings,
      ...(data.source ? { source: data.source } : {}), ...(data.conversation ? { conversation: data.conversation } : {}), ...(conversation ? { conversation } : {}),
      query: querySpec, created_at: new Date().toISOString(), ...queryTable(data, querySpec) }
    result.execution = { id: result.id, status: 'completed', engine: 'xcharts-query-v1', method: querySpec, context: structuredClone(currentExecution()), input: { id: data.id, hash: data.content_hash }, output: result.id }
    result.result_hash = hash(JSON.stringify({ columns: result.columns, rows: result.rows, query: result.query, source_hash: result.source_hash }))
    return this.persistResult(data, result)
  }
  /** One read-only SQL run against a database source; the rows become a result snapshot. */
  async queryDatabase (id, query) {
    const data = this.get(id)
    if (data.kind !== 'database') throw new CanvasError('INVALID_QUERY', '该数据源不是数据库连接')
    const input = query ?? {}
    const sql = input.sql
    if (typeof sql !== 'string' || !sql.trim()) throw new CanvasError('INVALID_QUERY', '请提供 SQL')
    const limit = Number.isInteger(input.limit) ? input.limit : 5000
    const timeoutMs = Number.isInteger(input.timeout_ms) ? input.timeout_ms : 15000
    const secret = readSecret(this.root, data.secret_ref)
    const run = await runQuery(data.format, { ...data.connection, format: data.format }, secret, sql, { limit, timeout_ms: timeoutMs })
    const conversation = conversationOf(input.conversation)
    const result = { id: randomUUID(), source_id: data.id, source_name: data.name, source_hash: data.schema_hash, source_kind: 'database',
      source_warnings: data.warnings, ...(data.source ? { source: data.source } : {}), ...(data.conversation ? { conversation: data.conversation } : {}), ...(conversation ? { conversation } : {}),
      query: { sql, limit }, created_at: new Date().toISOString(),
      columns: run.columns, rows: run.rows, input_rows: null, matched_rows: run.rows.length, total_rows: run.rows.length,
      materialized_rows: run.rows.length, coverage: run.truncated ? 'partial' : 'complete', truncated: run.truncated, duration_ms: run.duration_ms }
    result.execution = { id: result.id, status: 'completed', engine: 'xcharts-sql-v1', method: { kind: 'sql', sql, format: data.format }, context: structuredClone(currentExecution()), input: { id: data.id, hash: data.schema_hash }, output: result.id }
    result.result_hash = hash(JSON.stringify({ columns: result.columns, rows: result.rows, query: result.query, source_hash: result.source_hash }))
    return this.persistResult(data, result)
  }
  /** Run a read-only query without persisting a result (used by trace recompute). */
  async previewDatabaseQuery (id, query) {
    const data = this.get(id)
    if (data.kind !== 'database') throw new CanvasError('INVALID_SOURCE', '该数据源不是数据库连接')
    const secret = readSecret(this.root, data.secret_ref)
    const run = await runQuery(data.format, { ...data.connection, format: data.format }, secret, query.sql, { limit: query.limit, timeout_ms: query.timeout_ms })
    return { columns: run.columns, rows: run.rows, truncated: run.truncated, duration_ms: run.duration_ms }
  }
  persistResult (data, result) {
    // Conversation-driven queries leave a durable usage edge (result -> session);
    // pane queries carry no session and are not recorded as conversation use.
    const context = result.execution?.context
    if (context?.session_id) {
      appendUsage(this.root, {
        ref: { kind: 'res', id: result.id, version: result.result_hash },
        action: 'query', source_id: data.id, result_id: result.id,
        session_id: context.session_id, ...(context.call_id ? { call_id: context.call_id } : {}),
        at: new Date().toISOString(), outcome: 'ok',
      })
    }
    mkdirSync(this.results, { recursive: true }); write(join(this.results, `${result.id}.json`), result)
    // Record the result on its source: the list shows "结果 N" from this array
    // instead of opening every result snapshot (which carry full row data).
    data.results = [...(data.results || []), result.id]
    write(join(this.dir, `${data.id}.json`), data)
    return this.readResult(result.id)
  }
  /** Store a verified database connection: metadata only, credential under `secrets/`. */
  writeDatabaseSource ({ name, connection, secret, catalog, server_version }) {
    const normalized = normalizeConnection(connection)
    const engine = engineOf(normalized.format)
    const secretRef = putSecret(this.root, secret)
    const data = {
      id: randomUUID(),
      name: nameOf(name),
      kind: 'database',
      format: normalized.format,
      connection: { host: normalized.host, port: normalized.port, database: normalized.database, user: normalized.user, ssl: normalized.ssl, label: normalized.label },
      secret_ref: secretRef,
      server_version: server_version || '',
      schema_hash: hash(JSON.stringify(catalog)),
      catalog,
      catalog_cached_at: new Date().toISOString(),
      columns: [],
      row_count: null,
      created_at: new Date().toISOString(),
      source: { type: 'database' },
      source_warnings: [],
      warnings: [],
    }
    mkdirSync(this.dir, { recursive: true })
    write(join(this.dir, `${data.id}.json`), data)
    return { ...this.summary(data), engine: engine.label, table_count: catalog?.table_count ?? 0 }
  }
  /** Recreate a connection record from a backup: no credential, so it waits for a password. */
  writePendingDatabaseSource ({ name, format, connection, server_version, catalog, catalog_cached_at }) {
    const normalized = connection && connection.host ? { ...connection, format } : null
    if (!normalized) throw new CanvasError('INVALID_BACKUP', '备份里的连接信息不完整')
    const data = {
      id: randomUUID(),
      name: nameOf(name || '导入的连接'),
      kind: 'database',
      format,
      connection: { host: normalized.host, port: normalized.port, database: normalized.database, user: normalized.user, ssl: normalized.ssl === true, label: normalized.label || '' },
      secret_ref: null,
      needs_secret: true,
      server_version: server_version || '',
      schema_hash: catalog ? hash(JSON.stringify(catalog)) : null,
      catalog: catalog ?? null,
      catalog_cached_at: catalog_cached_at ?? null,
      columns: [],
      row_count: null,
      created_at: new Date().toISOString(),
      source: { type: 'database' },
      source_warnings: [],
      warnings: [],
    }
    mkdirSync(this.dir, { recursive: true })
    write(join(this.dir, `${data.id}.json`), data)
    return { id: data.id, name: data.name, format: data.format, needs_secret: true }
  }
  /** Refresh one database source's table catalogue (5 minute cache). */
  async databaseSchema (id, { refresh = false } = {}) {
    const data = this.get(id)
    if (data.kind !== 'database') throw new CanvasError('INVALID_SOURCE', '该数据源不是数据库连接')
    const fresh = data.catalog_cached_at && Date.now() - Date.parse(data.catalog_cached_at) < 5 * 60 * 1000
    if (refresh || !fresh || !data.catalog) {
      const secret = readSecret(this.root, data.secret_ref)
      const catalog = await introspect(data.format, { ...data.connection, format: data.format }, secret)
      data.catalog = catalog
      data.catalog_cached_at = new Date().toISOString()
      data.schema_hash = hash(JSON.stringify(catalog))
      write(join(this.dir, `${validId(id)}.json`), data)
    }
    return { ...this.summary(data), rows: [], has_more: false }
  }
  /** Replace the stored password of a database source (write-only). */
  updateDatabaseSecret (id, password) {
    const data = this.get(id)
    if (data.kind !== 'database') throw new CanvasError('INVALID_SOURCE', '该数据源不是数据库连接')
    const previous = data.secret_ref
    data.secret_ref = putSecret(this.root, password)
    write(join(this.dir, `${validId(id)}.json`), data)
    if (previous) deleteSecret(this.root, previous)
    return { ...this.summary(data), has_secret: true }
  }
  /** Password presence without ever returning the value. */
  hasSecret (data) { return Boolean(data?.secret_ref) }
  /** Name a saved result so it can be told apart from its siblings. */
  renameResult (id, title) {
    const path = join(this.results, `${validId(id)}.json`)
    const data = read(path)
    const name = nameOf(title)
    data.title = name
    write(path, data)
    return this.resultSummary(data)
  }

  /** Compact index of a source's saved results, newest first. */
  listResults (sourceId = null, limit = 20) {
    let files
    try { files = readdirSync(this.results) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const wanted = sourceId == null ? null : validId(sourceId)
    const rows = []
    for (const entry of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(entry)) continue
      let data
      try { data = read(join(this.results, entry)) } catch { continue }
      if (wanted && data.source_id !== wanted) continue
      rows.push(this.resultSummary(data))
    }
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    return rows.slice(0, Math.max(1, Math.min(100, limit)))
  }

  /** Everything the UI needs about a result except its rows. */
  resultSummary (data) {
    const { rows, ...meta } = data
    return { ...meta, row_count: Array.isArray(rows) ? rows.length : 0 }
  }

  /** Name a saved result so it can be told apart from its siblings. */
  renameResult (id, title) {
    const path = join(this.results, `${validId(id)}.json`)
    const data = read(path)
    const name = nameOf(title)
    data.title = name
    write(path, data)
    return this.resultSummary(data)
  }

  /** Compact index of a source's saved results, newest first. */
  listResults (sourceId = null, limit = 20) {
    let files
    try { files = readdirSync(this.results) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const wanted = sourceId == null ? null : validId(sourceId)
    const rows = []
    for (const entry of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(entry)) continue
      let data
      try { data = read(join(this.results, entry)) } catch { continue }
      if (wanted && data.source_id !== wanted) continue
      rows.push(this.resultSummary(data))
    }
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    return rows.slice(0, Math.max(1, Math.min(100, limit)))
  }

  /** Everything the UI needs about a result except its rows. */
  resultSummary (data) {
    const { rows, ...meta } = data
    return { ...meta, row_count: Array.isArray(rows) ? rows.length : 0 }
  }

  readResult (id, offset = 0, limit = 20) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new CanvasError('INVALID_PAGE', '结果偏移或页大小无效')
    const data = this.result(id)
    return { ...data, rows: data.rows.slice(offset, offset + limit), preview_rows: data.rows.slice(offset, offset + limit).length, offset, has_more: offset + limit < data.rows.length }
  }
  addToCanvas (store, input) {
    const result = this.result(input.result_id)
    const type = input.type ?? 'chart', chart = input.chart_type ?? 'bar'
    if (!['chart', 'table', 'kpi'].includes(type)) throw new CanvasError('INVALID_CARD', '结果只支持图表、表格或指标卡')
    const card = { type, title: nameOf(input.title), dataset: result.source_id,
      query: JSON.stringify({ result_id: result.id, source_hash: result.source_hash, result_hash: result.result_hash, query: result.query, ...(result.source ? { source: result.source } : {}), ...(result.conversation ? { conversation: result.conversation } : {}) }),
      source_note: `来源：${result.source_name}；输入 ${result.input_rows} 行，匹配 ${result.matched_rows} 行；结果 ${result.total_rows} 行，保存 ${result.materialized_rows} 行；${result.coverage === 'complete' ? '完整查询结果' : '结果已裁剪'}；${result.created_at}。${result.conversation?.message_id ? `对话消息：${result.conversation.message_id}。` : ''}${(result.source_warnings || []).join(' ')}` }
    const column = name => { const i = result.columns.findIndex(c => c.name === name); if (i < 0) throw new CanvasError('INVALID_COLUMN', `结果没有字段 ${name}`); return i }
    if (type === 'table') card.table_data = { columns: result.columns, rows: result.rows }
    else if (type === 'kpi') {
      const i = column(input.y)
      if (result.total_rows !== 1 || result.columns[i].type !== 'number') throw new CanvasError('INVALID_KPI', '指标卡需要单行数值结果，请先汇总')
      card.presentation_spec = { label: input.y, value: result.rows[0][i] ?? '无数据' }
    } else {
      if (!['bar', 'line', 'pie'].includes(chart)) throw new CanvasError('INVALID_CHART', '目前支持柱状、折线和饼图')
      if (result.coverage !== 'complete' || result.rows.length > 500) throw new CanvasError('CHART_TOO_LARGE', '图表需要不超过 500 行的完整结果，请先分组聚合或明确过滤范围')
      const x = column(input.x), y = column(input.y)
      if (result.columns[y].type !== 'number') throw new CanvasError('INVALID_CHART', '数值轴必须为数值列')
      if (chart === 'pie' && result.rows.some(row => row[y] === null || row[y] < 0)) throw new CanvasError('INVALID_CHART', '饼图数值不能缺失或为负数')
      const labels = result.rows.map(row => String(row[x] ?? '（空）'))
      if (new Set(labels).size !== labels.length) throw new CanvasError('INVALID_CHART', '分类轴存在重复值，请先按分类分组聚合')
      card.chart_type = chart
      card.echarts_option = chart === 'pie'
        ? { tooltip: { trigger: 'item' }, series: [{ type: 'pie', data: result.rows.map((row, i) => ({ name: labels[i], value: row[y] })) }] }
        : { tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: labels }, yAxis: { type: 'value', name: input.y }, series: [{ name: input.y, type: chart, data: result.rows.map(row => row[y]) }] }
    }
    card.binding = { result_id: result.id, source_id: result.source_id, x: input.x ?? null, y: input.y ?? null, type, chart_type: type === 'chart' ? chart : null }
    const canvas = store.addCard(input.canvas_id, card, input.expected_revision ?? null)
    const cardId = canvas.cards.at(-1).id
    const sessionId = result.execution?.context?.session_id
    if (sessionId) {
      appendUsage(store.root, {
        ref: { kind: 'card', id: `${canvas.id}/${cardId}`, version: canvas.cards.at(-1).data_version_id },
        action: 'add_card', source_id: result.source_id, result_id: result.id,
        session_id: sessionId, ...(result.execution.context.call_id ? { call_id: result.execution.context.call_id } : {}),
        at: new Date().toISOString(), outcome: 'ok',
      })
    }
    return { canvas_id: canvas.id, revision: canvas.revision, card_id: cardId, version_id: canvas.cards.at(-1).data_version_id, result_id: result.id }
  }
}
