import { CanvasError } from '../store.js'

/**
 * SQL the plugin will run for a database source: one statement, read-only verbs,
 * no data-modifying keyword, and always a bounded result set. This is a second
 * line of defence — the real boundary is the database account's privileges and
 * the read-only transaction the adapter opens.
 */
const ALLOWED_START = /^(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC|VALUES|TABLE)\b/i
const BLOCKED = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|DO|COPY|LOAD|SET|RESET|VACUUM|ANALYZE|REINDEX|COMMENT|IMPORT|EXPORT|ATTACH|PRAGMA|LOCK|UNLOCK|HANDLER|INTO\s+(OUTFILE|DUMPFILE)|FOR\s+UPDATE|FOR\s+SHARE)\b/i

/** Remove string literals and comments so keyword checks cannot be fooled by them. */
function stripQuoted (sql) {
  let out = ''
  let state = 'plain'
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]
    const next = sql[index + 1]
    if (state === 'plain') {
      if (char === "'") { state = 'single'; out += ' '; continue }
      if (char === '"') { state = 'double'; out += ' '; continue }
      if (char === '`') { state = 'backtick'; out += ' '; continue }
      if (char === '-' && next === '-') { state = 'line'; out += ' '; index++; continue }
      if (char === '/' && next === '*') { state = 'block'; out += ' '; index++; continue }
      out += char
      continue
    }
    if (state === 'single' && char === "'" && next === "'") { index++; continue }
    if (state === 'single' && char === "'") { state = 'plain'; continue }
    if (state === 'double' && char === '"') { state = 'plain'; continue }
    if (state === 'backtick' && char === '`') { state = 'plain'; continue }
    if (state === 'line' && char === '\n') { state = 'plain'; continue }
    if (state === 'block' && char === '*' && next === '/') { state = 'plain'; index++; continue }
  }
  return out
}

export function normalizeSql (sql) {
  if (typeof sql !== 'string') throw new CanvasError('INVALID_SQL', 'SQL 必须是文本')
  if (sql.length > 100000) throw new CanvasError('INVALID_SQL', 'SQL 过长')
  return sql.trim()
}

export function assertReadOnlySql (sql) {
  const text = normalizeSql(sql)
  if (!text) throw new CanvasError('INVALID_SQL', 'SQL 不能为空')
  const stripped = stripQuoted(text).trim()
  // One statement only: a semicolon may end the statement, never start another.
  const body = stripped.replace(/[;\s]+$/, '')
  if (body.includes(';')) throw new CanvasError('INVALID_SQL', '只允许执行单条 SQL')
  if (!ALLOWED_START.test(body)) throw new CanvasError('INVALID_SQL', '只允许只读查询（SELECT / WITH / EXPLAIN / SHOW / DESCRIBE）')
  if (BLOCKED.test(body)) throw new CanvasError('INVALID_SQL', '查询包含写操作或高风险语句，已被拒绝')
  return text
}

/** Wrap a read-only query so the server can never hand back an unbounded result. */
export function withRowLimit (sql, limit) {
  const text = normalizeSql(sql).replace(/[;\s]+$/, '')
  const bounded = Number.isInteger(limit) && limit > 0 ? limit : 5000
  return `SELECT * FROM (${text}) AS __xcharts_limit LIMIT ${bounded + 1}`
}

/** The function the route/tool calls: guard first, then bound where the verb allows it. */
export function prepareReadOnlyQuery (sql, limit) {
  const guarded = assertReadOnlySql(sql)
  const verb = guarded.trim().split(/\s+/)[0].toUpperCase()
  // SHOW / DESCRIBE / EXPLAIN / TABLE cannot be nested in a subquery; their own
  // result is small and the caller still slices to the limit.
  return ['SELECT', 'WITH', 'VALUES'].includes(verb) ? withRowLimit(guarded, limit) : guarded
}
