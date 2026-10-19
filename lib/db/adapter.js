import { CanvasError } from '../store.js'
import { formatDateValue } from '../date-value.js'
import { maskHost, redactText } from '../secrets.js'
import { prepareReadOnlyQuery } from './guard.js'

/** Engines we implement today; adding one is one entry plus the adapter branches. */
export const ENGINES = {
  postgres: { id: 'postgres', label: 'PostgreSQL', defaultPort: 5432, driver: 'pg' },
  mysql: { id: 'mysql', label: 'MySQL', defaultPort: 3306, driver: 'mysql2/promise' },
}
export const DATABASE_FORMATS = Object.keys(ENGINES)

export function engineOf (format) {
  const engine = ENGINES[format]
  if (!engine) throw new CanvasError('UNSUPPORTED_ENGINE', `暂不支持的数据库类型：${String(format)}`)
  return engine
}

async function loadDriver (format) {
  const engine = engineOf(format)
  try { return await import(engine.driver) } catch { throw new CanvasError('DRIVER_MISSING', `缺少 ${engine.label} 驱动，请安装 ${engine.driver} 后重启 DSH`) }
}

export function normalizeConnection (input) {
  if (!input || typeof input !== 'object') throw new CanvasError('INVALID_CONNECTION', '连接配置无效')
  const format = String(input.format || '')
  const engine = engineOf(format)
  const host = String(input.host || '').trim()
  if (!host || host.length > 255 || /[\s/]/.test(host)) throw new CanvasError('INVALID_CONNECTION', '主机地址无效')
  const port = input.port === undefined || input.port === null || input.port === '' ? engine.defaultPort : Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CanvasError('INVALID_CONNECTION', '端口应为 1～65535')
  const database = String(input.database || '').trim()
  if (!database || database.length > 128) throw new CanvasError('INVALID_CONNECTION', '数据库名无效')
  const user = String(input.user || '').trim()
  if (!user || user.length > 128) throw new CanvasError('INVALID_CONNECTION', '用户名无效')
  return { format, host, port, database, user, ssl: input.ssl === true, label: String(input.label || '').trim().slice(0, 40) }
}

/** Error text safe to show a user and a model: no secret, no raw host. */
export function safeDatabaseError (error, secret, connection) {
  let text = redactText(error?.message || String(error), secret)
  if (connection?.host) text = text.split(connection.host).join(maskHost(connection.host))
  text = text.replace(/password\s*=\s*\S+/gi, 'password=***').replace(/:\/\/[^@\s]+@/g, '://***@')
  return text.slice(0, 500)
}

async function withPostgres (connection, secret, work) {
  const { default: pg } = await loadDriver('postgres')
  const client = new pg.Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: secret,
    ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
    application_name: 'dsh-xcharts-canvas',
  })
  try {
    await client.connect()
    return await work(client)
  } finally { try { await client.end() } catch { /* already closed */ } }
}

async function withMysql (connection, secret, work) {
  const mysql = await loadDriver('mysql')
  const createConnection = mysql.default?.createConnection || mysql.createConnection
  const client = await createConnection({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: secret,
    ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 5000,
    multipleStatements: false,
    dateStrings: false,
  })
  try { return await work(client) } finally { try { await client.end() } catch { /* already closed */ } }
}

/** Connect, read one value, close. Used by the dialog's 测试连接 and by save. */
export async function testConnection (format, input, secret) {
  const connection = normalizeConnection(input)
  const started = Date.now()
  try {
    const version = format === 'postgres'
      ? await withPostgres(connection, secret, async client => (await client.query('SELECT version() AS version')).rows[0]?.version)
      : await withMysql(connection, secret, async client => {
        const [rows] = await client.query('SELECT VERSION() AS version')
        return rows[0]?.version
      })
    return {
      ok: true,
      engine: engineOf(format).label,
      server_version: String(version || '').split(' ').slice(0, 2).join(' ').slice(0, 60),
      latency_ms: Date.now() - started,
      host: maskHost(connection.host),
    }
  } catch (error) {
    throw new CanvasError('CONNECTION_FAILED', safeDatabaseError(error, secret, connection))
  }
}

const MAX_TABLES = 300
const MAX_COLUMNS = 100

/** Table/column catalogue; no row data is read. */
export async function introspect (format, input, secret) {
  const connection = normalizeConnection(input)
  const rows = format === 'postgres'
    ? await withPostgres(connection, secret, async client => (await client.query(
      `SELECT table_schema AS schema_name, table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name, ordinal_position`)).rows)
    : await withMysql(connection, secret, async client => {
      const [result] = await client.query(
        `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type
           FROM information_schema.columns
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`, [connection.database])
      return result
    })
  const tables = []
  const index = new Map()
  for (const row of rows) {
    const key = `${row.schema_name}.${row.table_name}`
    let table = index.get(key)
    if (!table) {
      if (tables.length >= MAX_TABLES) continue
      table = { schema: row.schema_name, name: row.table_name, columns: [] }
      index.set(key, table)
      tables.push(table)
    }
    if (table.columns.length < MAX_COLUMNS) table.columns.push({ name: row.column_name, type: String(row.data_type || '').toLowerCase() })
  }
  return { engine: engineOf(format).label, database: connection.database, tables, table_count: tables.length }
}

function coerce (value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return formatDateValue(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

function typeOfColumn (values) {
  const present = values.filter(value => value !== null && value !== undefined)
  if (!present.length) return 'string'
  if (present.every(value => typeof value === 'number')) return 'number'
  if (present.every(value => typeof value === 'boolean')) return 'boolean'
  if (present.every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/.test(value))) return 'date'
  return 'string'
}

function tableOf (names, records, limit) {
  const columns = names.map(name => ({ name, type: 'string' }))
  const rows = []
  for (const record of records) {
    if (rows.length >= limit) break
    rows.push(names.map(name => coerce(record?.[name])))
  }
  columns.forEach((column, position) => { column.type = typeOfColumn(rows.map(row => row[position])) })
  return { columns, rows }
}

/** Execute one guarded, bounded, read-only query in a read-only transaction. */
export async function runQuery (format, input, secret, sql, options = {}) {
  const connection = normalizeConnection(input)
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 5000) : 5000
  const timeoutMs = Number.isInteger(options.timeout_ms) && options.timeout_ms > 0 ? Math.min(options.timeout_ms, 60000) : 15000
  const bounded = prepareReadOnlyQuery(sql, limit)
  const started = Date.now()
  try {
    if (format === 'postgres') {
      return await withPostgres(connection, secret, async client => {
        await client.query('BEGIN READ ONLY')
        try {
          await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`)
          const result = await client.query(bounded)
          const names = (result.fields || []).map(field => field.name)
          const table = tableOf(names.length ? names : Object.keys(result.rows[0] || {}), result.rows, limit)
          return { ...table, truncated: result.rows.length > limit, duration_ms: Date.now() - started }
        } finally { try { await client.query('ROLLBACK') } catch { /* aborted */ } }
      })
    }
    return await withMysql(connection, secret, async client => {
      await client.query('SET SESSION TRANSACTION READ ONLY')
      await client.query('START TRANSACTION READ ONLY')
      try {
        const [records] = await client.query({ sql: bounded, timeout: timeoutMs })
        const rows = Array.isArray(records) ? records : []
        const names = rows.length ? Object.keys(rows[0]) : []
        const table = tableOf(names, rows, limit)
        return { ...table, truncated: rows.length > limit, duration_ms: Date.now() - started }
      } finally { try { await client.query('ROLLBACK') } catch { /* aborted */ } }
    })
  } catch (error) {
    if (error instanceof CanvasError) throw error
    throw new CanvasError('QUERY_FAILED', safeDatabaseError(error, secret, connection))
  }
}
