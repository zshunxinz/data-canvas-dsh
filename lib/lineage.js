import { createHash } from 'node:crypto'

const clone = value => structuredClone(value)
export function canonical (value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
  return value
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const STYLE_KEYS = new Set(['color', 'backgroundColor', 'itemStyle', 'lineStyle', 'areaStyle', 'label', 'labelLayout', 'emphasis', 'blur', 'select', 'animation', 'animationDuration', 'animationDelay', 'textStyle', 'grid', 'legend', 'tooltip', 'toolbox', 'title'])
function semanticOption (value) {
  if (Array.isArray(value)) return value.map(semanticOption)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !STYLE_KEYS.has(key)).map(([key, item]) => [key, semanticOption(item)]))
  return value
}
export function dataSignature (card) {
  return fingerprint({ type: card.type, chart_type: card.chart_type, echarts_option: semanticOption(card.echarts_option), chart_spec: card.chart_spec, table_data: card.table_data, presentation_spec: card.presentation_spec, text_content: card.text_content, language: card.language, source: { dataset: card.source?.dataset, query: card.source?.query }, binding: card.binding, calculation_ref: card.calculation_ref })
}
function freezeCard (card) {
  const result = clone(card)
  delete result.data_version_id
  delete result.trace_context
  delete result.lineage_import
  return result
}
function versionOf (card, context, ordinal) {
  const signature = dataSignature(card)
  return { id: `v${ordinal}-${signature.slice(0, 20)}`, signature, created_at: card.updated_at || card.created_at || new Date().toISOString(), card: freezeCard(card), context: clone(context || {}) }
}
function initialRecord (card, context = {}) {
  const version = versionOf(card, context, 1)
  return { versions: [version], events: [], current_version_id: version.id }
}
// All authoritative state (payload, version, event, current pointer) shares the
// canvas's one atomic JSON replacement. There is no second file to half-commit.
export function applyLineage (canvas, previous = null, context = {}) {
  const records = clone(previous?.lineage || canvas.lineage || {})
  const oldCards = new Map((previous?.cards || []).map(card => [card.id, card]))
  for (const card of canvas.cards) {
    const old = oldCards.get(card.id)
    if (!old && context.derived_from) card.derived_from = clone(context.derived_from)
    let record = records[card.id]
    if (!record) {
      const inherited = card.lineage_import
      record = inherited ? clone(inherited) : initialRecord(old || card, old ? {} : context)
      records[card.id] = record
      if (inherited) {
        for (const version of record.versions) version.card.id = card.id
        record.events.push({ kind: 'copy', at: new Date().toISOString(), context: clone(context), from: card.copied_from || null })
      }
    }
    const signature = dataSignature(card)
    const current = record.versions.find(v => v.id === record.current_version_id)
    // An undo restores a pointer present on the saved card. Ordinary edits keep
    // the old pointer but change the signature, so they append a new version.
    const restored = record.versions.find(v => v.id === card.data_version_id && v.signature === signature)
    let chosen = restored || (current?.signature === signature ? current : null)
    if (!chosen) {
      if (context.derived_from) card.derived_from = clone(context.derived_from)
      chosen = versionOf(card, context, record.versions.length + 1)
      record.versions.push(chosen)
    }
    const kind = !old ? 'create' : current?.id !== chosen.id ? (restored ? 'restore' : 'data') : fingerprint(freezeCard(old)) !== fingerprint(freezeCard(card)) ? 'presentation' : null
    if (kind) record.events.push({ kind, at: new Date().toISOString(), version_id: chosen.id, context: clone(context) })
    record.current_version_id = chosen.id
    card.data_version_id = chosen.id
    delete card.lineage_import
    delete card.trace_context
  }
  for (const old of oldCards.values()) {
    if (!canvas.cards.some(card => card.id === old.id)) {
      records[old.id] ||= initialRecord(old)
      records[old.id].events.push({ kind: 'remove', at: new Date().toISOString(), version_id: old.data_version_id || records[old.id].current_version_id, context: clone(context) })
    }
  }
  canvas.lineage = records
  return canvas
}

export function portableLineage (record) {
  if (!record) return undefined
  const copy = clone(record)
  for (const version of copy.versions) {
    if (version.card.source) version.card.source.dataset = null
    version.context = { ...version.context, imported: true }
    version.original_signature = version.signature
    version.signature = dataSignature(version.card)
  }
  return copy
}

export function resolveVersion (canvas, cardId, versionId = null) {
  const card = canvas.cards.find(item => item.id === cardId) || null
  const record = canvas.lineage?.[cardId] || (card ? initialRecord(card) : null)
  if (!record) throw Object.assign(new Error('卡片不存在'), { code: 'CARD_NOT_FOUND' })
  const currentId = card?.data_version_id || record.current_version_id
  const version = record.versions.find(item => item.id === (versionId || currentId))
  if (!version) throw Object.assign(new Error('卡片版本不存在'), { code: 'VERSION_NOT_FOUND' })
  return clone({ card, version, versions: record.versions, events: record.events, current_version_id: currentId })
}
