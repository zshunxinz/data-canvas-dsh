import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { CanvasError, CanvasStore } from './store.js'
import { DataStore } from './data-store.js'
import { TraceService } from './trace-service.js'
import { currentExecution } from './execution-context.js'
import { appendUsage } from './usage-log.js'
import { maskHost } from './secrets.js'

const KINDS = new Set(['ds', 'res', 'card'])
const REFERENCE = /\[xcharts:(ds|res|card):([^\]@]+)(?:@([^\]]+))?\]/
const MAX_SAMPLE = 20
const MAX_STATS_ROWS = 50000
const MAX_STATS_COLUMNS = 40
const MAX_USAGE_SESSIONS = 20

/** Parse a short reference written into a user message; `kind:id@version` is also accepted. */
export function parseReference (value) {
  const text = typeof value === 'string' ? value : ''
  const match = REFERENCE.exec(text)
  if (match) return { kind: match[1], id: match[2].trim(), ...(match[3] ? { version: match[3].trim() } : {}) }
  const loose = /^\s*(ds|res|card):([^\s@]+)(?:@(\S+))?\s*$/.exec(text)
  if (loose) return { kind: loose[1], id: loose[2], ...(loose[3] ? { version: loose[3] } : {}) }
  throw new CanvasError('INVALID_REFERENCE', '引用格式无效')
}
export function referenceMarker (kind, id, version) {
  if (!KINDS.has(kind)) throw new CanvasError('INVALID_REFERENCE', '引用类型无效')
  return `[xcharts:${kind}:${id}${version ? `@${version}` : ''}]`
}

function statsOf (columns, rows) {
  const scanned = Math.min(rows.length, MAX_STATS_ROWS)
  const result = []
  for (let index = 0; index < Math.min(columns.length, MAX_STATS_COLUMNS); index++) {
    const column = columns[index]
    let nulls = 0, min = null, max = null, sum = 0, numbers = 0
    const distinct = new Set()
    for (let row = 0; row < scanned; row++) {
      const value = rows[row][index]
      if (value === null || value === undefined) { nulls++; continue }
      if (column.type === 'number' && typeof value === 'number') {
        numbers++; sum += value
        min = min === null ? value : Math.min(min, value)
        max = max === null ? value : Math.max(max, value)
      } else if (distinct.size < 50) distinct.add(String(value))
    }
    result.push({ name: column.name, type: column.type, nulls, ...(column.type === 'number' && numbers
      ? { numbers, min, max, mean: sum / numbers }
      : { distinct_sample: distinct.size, distinct_capped: distinct.size >= 50 }) })
  }
  return { columns: result, scanned_rows: scanned, truncated: rows.length > scanned || columns.length > MAX_STATS_COLUMNS }
}

/** Bounded read of a datasource/result/card reference plus durable usage records. */
export class ReferenceService {
  constructor (root, services = {}) {
    this.root = root
    this.services = services
    this.usages = join(root, 'usages')
    this.store = new CanvasStore(root)
    this.data = new DataStore(root)
    this.trace = new TraceService(root, services)
  }

  /** Append one usage fact; append-only, no data rows, bounded by month files. */
  record (ref, action, extra = {}) {
    const context = currentExecution()
    const sessionId = extra.session_id ?? context.session_id
    const record = {
      ref: { kind: ref.kind, id: ref.id, ...(ref.version ? { version: ref.version } : {}) },
      action,
      ...(extra.source_id ? { source_id: extra.source_id } : {}),
      ...(extra.result_id ? { result_id: extra.result_id } : {}),
      ...(sessionId ? { session_id: String(sessionId) } : {}),
      ...(extra.call_id ?? context.call_id ? { call_id: String(extra.call_id ?? context.call_id) } : {}),
      ...(context.tool && !extra.call_id ? { tool: String(context.tool) } : {}),
      at: new Date().toISOString(),
      ...(extra.outcome ? { outcome: extra.outcome } : {}),
    }
    try { appendUsage(this.root, record) } catch { /* redacted above */ }
    return record
  }

  list () {
    if (!existsSync(this.usages)) return []
    const rows = []
    for (const name of readdirSync(this.usages)) {
      if (!/^\d{4}-\d{2}\.jsonl$/.test(name)) continue
      for (const line of readFileSync(join(this.usages, name), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { rows.push(JSON.parse(line)) } catch { /* skip a torn line, never fail a read */ }
      }
    }
    return rows
  }

  datasource (ref) {
    const current = (() => { try { return this.data.get(ref.id) } catch { return null } })()
    // A pinned hash may predate retained inputs (sources imported before the
    // snapshot feature). Fall back to the current content and say so, instead of
    // failing the whole read on an unretained version.
    let source = null, versionUntilRetained = false
    if (ref.version) {
      try { source = this.data.sourceVersion(ref.id, ref.version) } catch { versionUntilRetained = true }
    }
    if (!source) source = current
    const database = source?.kind === 'database'
    const status = !source ? 'missing' : database ? 'live' : !current ? 'linked' : current.content_hash === source.content_hash ? 'linked' : 'current_changed'
    return {
      reference: { kind: 'ds', id: ref.id, version: source?.content_hash ?? ref.version ?? null, ...(versionUntilRetained ? { version_retained: false } : {}) },
      status,
      identity: {
        name: source?.name ?? current?.name ?? null, filename: source?.filename ?? null, format: source?.format ?? null,
        row_count: source?.row_count ?? null, column_count: source?.columns?.length ?? null, imported_at: source?.created_at ?? null,
        content_hash: source?.content_hash ?? null, current_hash: current?.content_hash ?? null,
        ...(versionUntilRetained ? { version_note: '该版本输入未保留，按当前内容读取' } : {}),
        ...(database ? { kind: 'database', host: maskHost(source.connection?.host), database: source.connection?.database, user: source.connection?.user, table_count: source.catalog?.table_count ?? null, schema_hash: source.schema_hash ?? null, server_version: source.server_version ?? null } : {}),
      },
      columns: (source?.columns ?? []).map(column => ({ name: column.name, type: column.type })),
      ...(database ? { catalog: this.catalogSummary(source), note: '数据库为实时连接：sample 不返回行，先执行一次查询再引用结果（res）才能读取快照' } : {}),
      _source: source,
    }
  }

  /** Compact table list for a database reference; columns stay out of the prompt. */
  catalogSummary (source) {
    const tables = (source?.catalog?.tables ?? []).slice(0, 50).map(table => ({ schema: table.schema, name: table.name, columns: table.columns.length }))
    return { table_count: source?.catalog?.table_count ?? 0, tables, truncated: (source?.catalog?.table_count ?? 0) > tables.length }
  }
  result (ref) {
    const result = this.data.result(ref.id)
    const source = (() => { try { return this.data.sourceVersion(result.source_id, result.source_hash) } catch { return null } })()
    return {
      reference: { kind: 'res', id: result.id, version: result.result_hash ?? null },
      status: source ? 'linked' : 'current_changed',
      result: {
        columns: result.columns, rows_total: result.rows?.length ?? 0, query: result.query,
        input_rows: result.input_rows, matched_rows: result.matched_rows, total_rows: result.total_rows,
        materialized_rows: result.materialized_rows, coverage: result.coverage, truncated: result.truncated,
        result_hash: result.result_hash, created_at: result.created_at,
        source: { id: result.source_id, name: result.source_name, hash: result.source_hash },
        session: result.execution?.context?.session_id ?? null,
        call_id: result.execution?.context?.call_id ?? null,
      },
      _result: result,
      _source: source,
    }
  }

  async card (ref) {
    const [canvasId, cardId] = String(ref.id).split('/')
    if (!canvasId || !cardId) throw new CanvasError('INVALID_REFERENCE', '卡片引用需要画布 id 与卡片 id')
    const view = await this.trace.read(canvasId, cardId, ref.version ?? null)
    return { reference: { kind: 'card', id: ref.id, version: view.version.id }, status: 'linked', card: view }
  }

  async read (reference, view = 'summary') {
    const ref = typeof reference === 'string' ? parseReference(reference) : reference
    const kind = ref.kind ?? (ref.card_id ? 'card' : ref.result_id ? 'res' : 'ds')
    const normalized = { kind, id: ref.id ?? (kind === 'card' ? `${ref.canvas_id}/${ref.card_id}` : kind === 'res' ? ref.result_id : ref.datasource_id), ...(ref.version ? { version: ref.version } : {}) }
    if (!normalized.id) throw new CanvasError('INVALID_REFERENCE', '引用缺少目标 id')
    if (kind === 'card') return this.card(normalized)

    const base = kind === 'ds' ? this.datasource(normalized) : this.result(normalized)
    const usage = this.record({ kind, id: normalized.id, ...(normalized.version ? { version: normalized.version } : {}) }, 'context', { outcome: base.status })
    const sample = []
    let truncated = false
    const source = base._source
    const rows = base._result?.rows ?? source?.rows ?? []
    const columns = base.result?.columns ?? base.columns ?? source?.columns ?? []
    if (view === 'sample' || view === 'rows') {
      const limit = Math.min(MAX_SAMPLE, rows.length)
      for (let index = 0; index < limit; index++) sample.push(rows[index])
      truncated = rows.length > limit
    }
    const stats = view === 'stats' && rows.length && columns.length ? statsOf(columns, rows) : null
    return {
      ...base,
      _source: undefined,
      _result: undefined,
      usage_id: usage.at,
      ...(sample.length ? { sample, sample_truncated: truncated } : {}),
      ...(stats ? { stats } : {}),
      actions: kind === 'ds'
        ? [{ tool: 'datasource_query', hint: '用结构化查询聚合后再落卡', datasource_id: normalized.id }]
        : [{ tool: 'canvas_add_result', hint: '把该结果落成卡片', result_id: normalized.id }],
    }
  }

  /** Reverse lookup: which cards and conversations used this datasource. */
  async usageForSource (sourceId) {
    const records = this.list().filter(record => record.source_id === sourceId || record.ref?.id === sourceId)
    const sessions = new Map()
    for (const record of records) {
      if (!record.session_id) continue
      const entry = sessions.get(record.session_id) || { session_id: record.session_id, count: 0, last_at: record.at }
      entry.count += 1
      if (String(record.at) > String(entry.last_at)) entry.last_at = record.at
      sessions.set(record.session_id, entry)
    }
    const resolved = [...sessions.values()].sort((a, b) => String(b.last_at).localeCompare(String(a.last_at))).slice(0, MAX_USAGE_SESSIONS)
    if (this.services.sessionQuery?.readTitle) {
      await Promise.all(resolved.map(async session => {
        try {
          const title = await this.services.sessionQuery.readTitle(session.session_id)
          if (typeof title === 'string' && title) session.title = title
          else if (title?.title) session.title = title.title
        } catch { /* title is decoration; the id stays authoritative */ }
      }))
    }
    const cards = []
    for (const summary of this.store.listCanvases()) {
      let canvas
      try { canvas = this.store.getCanvas(summary.id) } catch { continue }
      for (const card of canvas.cards) {
        const linked = card.binding?.source_id === sourceId
        const legacy = !card.binding && card.source?.dataset === sourceId
        if (!linked && !legacy) continue
        cards.push({
          canvas_id: canvas.id, canvas_name: canvas.name, card_id: card.id, title: card.title,
          data_version_id: card.data_version_id ?? null, linked: linked ? 'bound' : 'legacy',
        })
      }
    }
    return {
      source_id: sourceId,
      cards,
      sessions: resolved,
      counts: { cards: cards.length, sessions: sessions.size, uses: records.length },
    }
  }
}
