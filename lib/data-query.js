import { CanvasError } from './store.js'
import { dateBucket, formatDateValue, isGranularity, GRANULARITY_LABELS } from './date-value.js'
const assert = (ok, message) => { if (!ok) throw new CanvasError('INVALID_QUERY', message) }
const object = x => x && typeof x === 'object' && !Array.isArray(x)

/** A bounded declarative query, never evaluated as JavaScript or SQL. */
export function queryTable (data, query = {}) {
  assert(object(query), '查询必须是对象')
  assert(Object.keys(query).every(k => ['select', 'filters', 'group_by', 'metrics', 'order_by', 'limit'].includes(k)), '查询包含未知参数')
  const index = name => { const i = data.columns.findIndex(c => c.name === name); assert(i >= 0, `不存在字段：${name}`); return i }
  const list = (x, max) => { assert(Array.isArray(x) && x.length <= max, '查询列表无效或过长'); return x }
  // Grouping accepts a bare column name or `{ column, granularity }`; a date
  // column collapses to day by default so a timestamp column is still groupable.
  const groupSpecs = list(query.group_by ?? [], 5).map(group => {
    if (typeof group === 'string') {
      const i = index(group)
      const granularity = data.columns[i].type === 'date' ? 'day' : null
      return { i, granularity, name: group }
    }
    assert(object(group) && Object.keys(group).every(k => ['column', 'granularity'].includes(k)), '分组配置无效')
    assert(typeof group.column === 'string' && group.column, '分组字段无效')
    const i = index(group.column)
    assert(group.granularity === undefined || isGranularity(group.granularity), '分组粒度只支持 day/month/quarter/year')
    const granularity = group.granularity ?? (data.columns[i].type === 'date' ? 'day' : null)
    assert(!granularity || data.columns[i].type === 'date', `字段 ${group.column} 不是日期，不能控制分组粒度`)
    return { i, granularity, name: granularity && granularity !== 'day' ? `${group.column}(${GRANULARITY_LABELS[granularity]})` : group.column }
  })
  assert(new Set(groupSpecs.map(group => group.name)).size === groupSpecs.length, '分组字段不能重复')
  const metrics = list(query.metrics ?? [], 10).map(m => {
    assert(object(m) && Object.keys(m).every(k => ['column', 'op', 'as'].includes(k)), '指标配置无效')
    assert(['count', 'sum', 'avg', 'min', 'max'].includes(m.op), '聚合只支持 count/sum/avg/min/max')
    const i = m.column ? index(m.column) : -1
    const type = i >= 0 ? data.columns[i].type : null
    const dateAggregable = (m.op === 'min' || m.op === 'max') && type === 'date'
    assert(m.op === 'count' || type === 'number' || dateAggregable, `指标 ${m.op} 需要数值列${dateAggregable ? '' : '（min/max 也支持日期列）'}`)
    const name = m.as ?? `${m.op}_${m.column || 'rows'}`
    assert(typeof name === 'string' && name.trim() && name.length <= 120, '指标别名无效')
    return { ...m, i, name, type }
  })
  assert(!groupSpecs.length || metrics.length, '分组查询需至少一个指标')
  assert(!(metrics.length && query.select), '聚合查询不能同时 select 原始列')
  const filters = list(query.filters ?? [], 20).map(f => {
    assert(object(f) && Object.keys(f).every(k => ['column', 'op', 'value'].includes(k)), '过滤配置无效')
    const i = index(f.column)
    const type = data.columns[i].type
    assert(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null', 'not_null'].includes(f.op), '过滤操作无效')
    if (['is_null', 'not_null'].includes(f.op)) return { ...f, i }
    assert(f.op !== 'contains' || type === 'string' || type === 'date', '包含过滤仅用于文本或日期')
    if (type === 'date') {
      assert(typeof f.value === 'string', `过滤值类型必须匹配 ${f.column}；空值请用 is_null`)
      const normalized = formatDateValue(f.value)
      assert(normalized !== null, `${f.column} 的过滤值需要日期，例如 2024-01-02`)
      return { ...f, i, value: normalized }
    }
    assert(f.value !== null && typeof f.value === type && (typeof f.value !== 'number' || Number.isFinite(f.value)), `过滤值类型必须匹配 ${f.column}；空值请用 is_null`)
    return { ...f, i }
  })
  const matched = data.rows.filter(row => filters.every(f => {
    const v = row[f.i]
    if (f.op === 'is_null') return v === null
    if (f.op === 'not_null') return v !== null
    if (v === null) return false
    switch (f.op) {
      case 'eq': return v === f.value
      case 'ne': return v !== f.value
      case 'gt': return v > f.value
      case 'gte': return v >= f.value
      case 'lt': return v < f.value
      case 'lte': return v <= f.value
      case 'contains': return v.includes(f.value)
    }
  }))
  let columns, rows
  if (metrics.length) {
    columns = [
      ...groupSpecs.map(group => ({ name: group.name, type: group.granularity && group.granularity !== 'day' ? 'string' : data.columns[group.i].type })),
      ...metrics.map(m => ({ name: m.name, type: (m.op === 'min' || m.op === 'max') && m.type === 'date' ? 'date' : 'number' })),
    ]
    const buckets = new Map()
    const bucket = keys => { const key = JSON.stringify(keys); if (!buckets.has(key)) buckets.set(key, { keys, values: metrics.map(() => ({ n: 0, sum: 0, min: null, max: null })) }); return buckets.get(key) }
    if (!groupSpecs.length) bucket([])
    for (const row of matched) {
      const b = bucket(groupSpecs.map(group => group.granularity ? dateBucket(row[group.i], group.granularity) : row[group.i]))
      metrics.forEach((m, j) => {
        const value = m.i < 0 ? 1 : row[m.i], a = b.values[j]
        if (value === null) return
        a.n++
        if (m.op === 'count') return
        // Comparison (not Math.*) so ISO date text aggregates with min/max too.
        if (m.op === 'min') a.min = a.min === null || value < a.min ? value : a.min
        if (m.op === 'max') a.max = a.max === null || value > a.max ? value : a.max
        if (m.op === 'sum' || m.op === 'avg') { a.sum += value; assert(Number.isFinite(a.sum), '聚合结果超出数值范围') }
      })
    }
    rows = [...buckets.values()].map(b => [...b.keys, ...metrics.map((m, i) => {
      const a = b.values[i]
      return m.op === 'count' ? a.n : !a.n ? null : m.op === 'avg' ? a.sum / a.n : a[m.op]
    })])
  } else {
    const selected = query.select === undefined ? data.columns.map(c => c.name) : list(query.select, 100)
    assert(selected.length > 0 && new Set(selected).size === selected.length, '选择列不能为空或重复')
    const si = selected.map(index); columns = si.map(i => data.columns[i]); rows = matched.map(row => si.map(i => row[i]))
  }
  assert(new Set(columns.map(c => c.name)).size === columns.length, '输出列名重复，请调整指标别名或分组粒度')
  const order = list(query.order_by ?? [], 5).map(o => {
    assert(object(o) && Object.keys(o).every(k => ['column', 'direction'].includes(k)), '排序配置无效')
    const i = columns.findIndex(c => c.name === o.column)
    assert(i >= 0 && ['asc', 'desc'].includes(o.direction), '排序字段或方向无效')
    return { i, dir: o.direction === 'desc' ? -1 : 1 }
  })
  rows.sort((a, b) => {
    for (const o of order) {
      const x = a[o.i], y = b[o.i]
      if (x === y) continue
      if (x === null) return 1
      if (y === null) return -1
      return (x < y ? -1 : 1) * o.dir
    }
    return 0
  })
  const limit = query.limit ?? 1000
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 5000, '结果上限应为 1～5000')
  return { columns: columns.map(({ name, type }) => ({ name, type })), rows: rows.slice(0, limit), input_rows: data.rows.length, matched_rows: matched.length,
    total_rows: rows.length, materialized_rows: Math.min(rows.length, limit), coverage: rows.length > limit ? 'partial' : 'complete', truncated: rows.length > limit }
}
