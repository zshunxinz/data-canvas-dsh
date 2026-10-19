import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { parse as csvParse } from 'csv-parse/sync'

import { formatDateValue, excelSerialToDate, isDateFormat } from './date-value.js'

export const LIMITS = { bytes: 4 * 1024 * 1024, rows: 50000, columns: 100, cells: 500000 }

/** Tokens a real export uses for "no value"; matched exactly after trimming. */
export const DEFAULT_MISSING_TOKENS = ['?', 'NA', 'N/A', 'NULL', 'null', 'None', 'NaN', 'nan', 'NIL']

function check (yes, message) { if (!yes) throw new Error(message) }

export function decodeCsv (bytes, encoding = 'auto') {
  const bomEncoding = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? 'utf-8'
    : bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : null
  const candidates = encoding === 'auto'
    ? [bomEncoding, 'utf-8', 'gb18030', 'windows-1252'].filter((value, index, all) => value && all.indexOf(value) === index)
    : [encoding]
  check(candidates.every(value => ['utf-8', 'gb18030', 'windows-1252', 'utf-16le', 'utf-16be'].includes(value)), '编码支持自动识别、UTF-8、GB18030、Windows-1252 或 UTF-16')
  let lastError
  for (const candidate of candidates) {
    try { return { text: new TextDecoder(candidate, { fatal: true }).decode(bytes), encoding: candidate } } catch (error) { lastError = error }
  }
  throw new Error(`无法识别 CSV 文件编码，请另存为 UTF-8 或选择正确编码（${lastError?.message || '解码失败'}）`)
}

/** The separator a single line actually uses, so `;`/tab exports import without options. */
export function detectDelimiter (text) {
  const first = String(text).split(/\r?\n/).find(line => line.trim() !== '') || ''
  const structural = first.replace(/"(?:[^"]|"")*"/g, '""')
  let best = ',', bestCount = 0
  for (const candidate of [',', ';', '\t', '|']) {
    const count = structural.split(candidate).length - 1
    if (count > bestCount) { best = candidate; bestCount = count }
  }
  return { delimiter: best, ambiguous: bestCount === 0 }
}

// Delegate quoting/newlines to csv-parse; our layer only applies product limits.
export function parseCsv (text, delimiter = ',') {
  check([',', ';', '\t', '|'].includes(delimiter), '分隔符只支持逗号、分号、制表符、竖线，或设为 auto 自动识别')
  let count = 0, cells = 0
  return csvParse(text, { delimiter, bom: true, relax_column_count: true, max_record_size: 2 * 1024 * 1024,
    on_record: row => { count++; cells += row.length; check(count <= LIMITS.rows + 100 && row.length <= LIMITS.columns && cells <= LIMITS.cells + 10000, 'CSV 超过行列或单元格限制'); return row } })
}

function missingTokens (options) {
  const configured = options.missing_values
  if (configured === 'keep') return new Set()
  if (Array.isArray(configured)) {
    check(configured.length <= 50 && configured.every(value => typeof value === 'string' && value.length <= 24), '缺失值标记需为最多 50 个短字符串')
    return new Set(configured.map(value => value.trim()))
  }
  check(configured === undefined || configured === 'auto', '缺失值设置只支持 auto、keep 或字符串数组')
  return new Set(DEFAULT_MISSING_TOKENS)
}

const isBlank = value => value === null || value === undefined || (typeof value === 'string' && value.trim() === '')

/** A cell counts as missing when blank or an explicit token such as `?` / `NA`. */
function isMissing (value, tokens) {
  if (value === null || value === undefined) return true
  if (typeof value === 'number') return false
  const text = String(value).trim()
  return text === '' || tokens.has(text)
}

/**
 * Tolerant numeric read: thousands separators, currency marks, accounting
 * parentheses and a leading plus all resolve; identifiers with leading zeros and
 * integers outside the safe range stay text.
 */
export function coerceNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (!text) return null
  let sign = 1
  text = text.replace(/^[¥$€£￥]\s*/, '')
  if (/^\(.*\)$/.test(text)) { sign = -1; text = text.slice(1, -1).trim() } else if (text.startsWith('-') || text.startsWith('−')) { sign = -1; text = text.slice(1) } else if (text.startsWith('+')) text = text.slice(1)
  text = text.replace(/[\s\u00a0\u202f]/g, '')
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '')
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null
  // Preserve leading-zero identifiers and integers outside JS exact range.
  if (/^0\d/.test(text)) return null
  const number = Number(text)
  if (!Number.isFinite(number)) return null
  if (Number.isInteger(number) && !Number.isSafeInteger(number)) return null
  return sign * number
}

/**
 * Turn a raw matrix into { columns, rows, warnings }.
 *
 * Header handling is forgiving in the way real exports require: leading blank
 * lines are skipped when the header row is not named, empty header cells and
 * duplicates are repaired with a warning, and data wider than the header gains
 * generated names instead of failing the whole import.
 */
export function normalizeTable (matrix, options = {}) {
  const tokens = missingTokens(options)
  const warnings = []
  const headerOption = options.header_row
  let firstRow = 0
  if (headerOption === undefined) {
    while (firstRow < matrix.length && matrix[firstRow].every(isBlank)) firstRow++
  }
  const header = headerOption ?? firstRow + 1
  check(Number.isInteger(header) && header >= 1 && header <= 100, '表头行应为 1～100')

  const sourceNames = (matrix[header - 1] || []).slice()
  let width = sourceNames.length
  while (width > 0 && isBlank(sourceNames[width - 1])) width--
  check(width > 0 && width <= LIMITS.columns, '请指定包含列名的表头行（最多 100 列）')

  const data = []
  for (let r = header; r < matrix.length; r++) {
    const row = matrix[r]
    if (row.every(isBlank)) continue
    let end = row.length
    while (end > 0 && isBlank(row[end - 1])) end--
    data.push(row.slice(0, Math.max(end, width)))
  }
  const dataWidth = data.reduce((max, row) => Math.max(max, row.length), width)
  check(dataWidth <= LIMITS.columns, `数据超过 ${LIMITS.columns} 列，请检查表头行或分隔符`)
  if (dataWidth > width) {
    warnings.push(`数据比表头多 ${dataWidth - width} 列，已按「列N」补齐；请检查表头行或分隔符`)
    width = dataWidth
  }

  const names = []
  const seen = new Set()
  const renames = []
  for (let index = 0; index < width; index++) {
    const raw = sourceNames[index]
    const clean = typeof raw === 'string'
      ? raw.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\u2060]/g, '').trim()
      : String(raw ?? '').trim()
    let name = clean || `列${index + 1}`
    if (!clean) renames.push(`空表头 → 「${name}」`)
    const base = name
    let suffix = 1
    while (seen.has(name)) { suffix++; name = `${base}_${suffix}` }
    if (name !== base) renames.push(`重名「${base}」→ 「${name}」`)
    seen.add(name)
    names.push(name)
  }
  check(names.every(name => name.length <= 120), '列名不能超过 120 字')
  if (renames.length) warnings.push(`表头已修正：${renames.slice(0, 3).join('；')}${renames.length > 3 ? ` 等 ${renames.length} 处` : ''}`)

  check(data.length <= LIMITS.rows && data.length * width <= LIMITS.cells, '超过 50,000 行或 500,000 单元格，请拆分文件')
  const types = options.types ?? {}
  check(types && typeof types === 'object' && !Array.isArray(types), '列类型配置无效')
  check(Object.keys(types).every(name => names.includes(name)), '类型配置包含未知列')

  const columns = names.map((name, index) => {
    const values = []
    const missingTokensSeen = new Map()
    for (const row of data) {
      const value = row[index]
      if (isMissing(value, tokens)) {
        const token = typeof value === 'string' ? value.trim() : ''
        if (token) missingTokensSeen.set(token, (missingTokensSeen.get(token) || 0) + 1)
        continue
      }
      values.push(value)
    }
    const forced = Object.hasOwn(types, name)
    // Numbers first, then dates, then booleans, then text — the order a sheet's author expects.
    const inferred = values.length > 0 && values.every(value => coerceNumber(value) !== null)
      ? 'number'
      : values.length > 0 && values.every(value => formatDateValue(value) !== null)
        ? 'date'
        : values.length > 0 && values.every(value => typeof value === 'boolean') ? 'boolean' : 'string'
    const type = forced ? types[name] : inferred
    check(['number', 'string', 'date', 'boolean'].includes(type), `列 ${name} 只支持数值、文本、日期或布尔`)
    const token = [...missingTokensSeen.entries()].sort((a, b) => b[1] - a[1])[0]
    return {
      name,
      type,
      null_count: data.length - values.length,
      ...(token ? { missing_token: token[0] } : {}),
    }
  })

  const tokensSeen = columns.filter(column => column.missing_token)
  if (tokensSeen.length) {
    const parts = tokensSeen.slice(0, 3).map(column => `「${column.name}」${column.null_count} 个「${column.missing_token}」`)
    warnings.push(`${parts.join('；')}${tokensSeen.length > 3 ? ` 等 ${tokensSeen.length} 列` : ''} 视为缺失值`)
  }

  const rows = data.map((row, r) => columns.map((column, c) => {
    const value = row[c]
    if (isMissing(value, tokens)) return null
    check(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean', `第 ${r + header + 1} 行单元格类型不支持`)
    check(String(value).length <= 20000, `第 ${r + header + 1} 行文本过长`)
    if (column.type === 'string') return String(value)
    if (column.type === 'boolean') return value === true || value === 'true'
    if (column.type === 'date') {
      const date = formatDateValue(value)
      check(date !== null, `第 ${r + header + 1} 行「${column.name}」不是可识别的日期（支持 2024-01-02、2024/1/2、2024年1月2日）`)
      return date
    }
    const number = coerceNumber(value)
    check(number !== null, `第 ${r + header + 1} 行「${column.name}」不是可安全表示的数值，请改为文本或修正数据`)
    return number
  }))
  return { columns, rows, warnings }
}

/** Read a Parquet file into plain rows; nested values are flattened to text. */
async function parseParquet (bytes) {
  let lib
  try { lib = await import('hyparquet') } catch { throw new Error('当前安装缺少 Parquet 支持（hyparquet），请安装后重试') }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const file = { byteLength: buffer.byteLength, slice: (start, end) => buffer.slice(start ?? 0, end ?? buffer.byteLength) }
  const metadata = lib.parquetMetadata(buffer)
  const rowCount = Number(metadata?.num_rows ?? 0)
  check(rowCount <= LIMITS.rows, 'Parquet 超过 50,000 行，请先裁剪或拆分')
  const rows = await lib.parquetReadObjects({ file, rowStart: 0, rowEnd: Math.min(rowCount, LIMITS.rows) })
  const names = rows.length ? Object.keys(rows[0]) : []
  check(names.length > 0 && names.length <= LIMITS.columns, 'Parquet 没有可导入的列或超过列上限')
  return { names, rows }
}

function parquetCell (value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return formatDateValue(value)
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

function parquetMatrix ({ names, rows }) {
  return [names, ...rows.map(row => names.map(name => parquetCell(row[name])))]
}

/** A file-level cell coercion: dates become ISO text, formula/error cells become null. */
function cellValue (value, address, state, numFmt, date1904) {
  // A midnight Date is a date cell in Excel; keep the day, drop a meaningless time.
  if (value instanceof Date) { const iso = value.toISOString(); return iso.slice(11, 19) === '00:00:00' ? iso.slice(0, 10) : iso.slice(0, 19) }
  if (typeof value === 'number' && isDateFormat(numFmt)) {
    const serial = excelSerialToDate(value, date1904)
    if (serial !== null) return serial
    state.serials.push(address)
    return null
  }
  if (value && typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) {
      const result = value.result
      if (result === undefined || result === null) { state.formulas.push(address); return null }
      if (typeof result === 'object' && result !== null && 'error' in result) { state.errors.push(address); return null }
      if (typeof result === 'number' && isDateFormat(numFmt)) return excelSerialToDate(result, date1904)
      if (result instanceof Date) { const iso = result.toISOString(); return iso.slice(11, 19) === '00:00:00' ? iso.slice(0, 10) : iso.slice(0, 19) }
      return result
    }
    if (value.richText) return value.richText.map(part => part.text).join('')
    if (typeof value.text === 'string') return value.text
    if (typeof value.error === 'string') { state.errors.push(address); return null }
    throw new Error(`单元格 ${address} 包含不支持的值`)
  }
  return value
}

async function parse (input) {
  check(input && typeof input === 'object', '上传参数无效')
  check(typeof input.content_base64 === 'string' && input.content_base64.length <= Math.ceil(LIMITS.bytes / 3) * 4, '文件不能超过 4 MiB')
  check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content_base64), '文件编码无效')
  const bytes = Buffer.from(input.content_base64, 'base64')
  check(bytes.length > 0 && bytes.length <= LIMITS.bytes, '文件为空或超过 4 MiB')
  const options = input.options ?? {}
  let matrix, sheets = [], sheet = null, warnings = []
  if (/\.(csv|tsv)$/i.test(input.filename || '')) {
    const decoded = decodeCsv(bytes, options.encoding ?? 'auto')
    if (options.encoding === undefined && decoded.encoding !== 'utf-8') warnings.push(`文件按 ${decoded.encoding} 解码；如需指定请传入 encoding`)
    const requested = options.delimiter ?? 'auto'
    const sniffed = requested === 'auto' ? detectDelimiter(decoded.text) : { delimiter: requested }
    if (requested === 'auto' && sniffed.delimiter !== ',') warnings.push(`已自动识别为${sniffed.delimiter === '\t' ? '制表符' : sniffed.delimiter}分隔`)
    matrix = parseCsv(decoded.text, sniffed.delimiter)
    check(!(requested === 'auto' && sniffed.ambiguous && matrix.length && matrix[0].length > 1), '未能识别分隔符，请在导入设置中指定（逗号、分号、制表符或竖线）')
  } else if (/\.parquet$/i.test(input.filename || '')) {
    const table = await parseParquet(bytes)
    matrix = parquetMatrix(table)
    warnings.push('Parquet 已按快照导入：嵌套字段转为 JSON 文本，超出安全范围的大整数保留为文本')
  } else {
    check(/\.xlsx$/i.test(input.filename || ''), '支持 CSV、TSV、XLSX 和 Parquet；旧 .xls 请先另存为 .xlsx')
    const { default: ExcelJS } = await import('exceljs')
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(bytes, { ignoreNodes: ['drawing', 'picture', 'extLst'] })
    sheets = book.worksheets.map(entry => entry.name)
    const ws = options.sheet ? book.getWorksheet(options.sheet) : book.worksheets[0]
    check(ws, '指定的工作表不存在')
    sheet = ws.name
    check(ws.rowCount <= LIMITS.rows + 100 && ws.columnCount <= LIMITS.columns && ws.rowCount * ws.columnCount <= LIMITS.cells + 10000, 'Excel 工作表超过行列或单元格限制')
    const state = { formulas: [], errors: [], serials: [] }
    const date1904 = Boolean(book.properties?.date1904)
    matrix = Array.from({ length: ws.rowCount }, (_, r) => {
      const row = ws.getRow(r + 1)
      return Array.from({ length: row.cellCount }, (_, c) => {
        const cell = row.getCell(c + 1)
        return cellValue(cell.value, cell.address, state, cell.numFmt, date1904)
      })
    })
    if (state.formulas.length) {
      warnings.push(`${state.formulas.slice(0, 3).join('、')}${state.formulas.length > 3 ? ' 等' : ''} ${state.formulas.length} 个公式无缓存结果，已按空值导入；如需数值请在 Excel 中重算后保存并重新导入`)
    }
    if (state.errors.length) warnings.push(`${state.errors.slice(0, 3).join('、')}${state.errors.length > 3 ? ' 等' : ''} ${state.errors.length} 个错误单元格已按空值导入`)
    if (state.serials.length) warnings.push(`${state.serials.slice(0, 3).join('、')}${state.serials.length > 3 ? ' 等' : ''} ${state.serials.length} 个日期序列号超出范围，已按空值导入`)
    if (sheets.length > 1) warnings.push(`文件含 ${sheets.length} 个工作表，已导入「${sheet}」`)
  }
  const table = normalizeTable(matrix, options)
  return { ...table, warnings: [...warnings, ...table.warnings], sheets, sheet }
}

let active = 0
export function parseFile (input) {
  if (active >= 2) return Promise.reject(new Error('正在解析其他文件，请稍后重试'))
  active++
  return new Promise((resolve, reject) => {
    let worker
    try { worker = new Worker(new URL(import.meta.url), { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 256 } }) }
    catch (error) { active--; reject(error); return }
    const timer = setTimeout(() => { worker.terminate(); finish(new Error('文件解析超过 20 秒，请缩小文件后重试')) }, 20000)
    let finished = false
    function finish (error, data) { if (finished) return; finished = true; clearTimeout(timer); active--; worker.terminate(); error ? reject(error) : resolve(data) }
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.data))
    worker.once('error', error => finish(error))
    worker.once('exit', code => { if (!finished) finish(new Error(`文件解析进程退出 (${code})`)) })
  })
}
if (!isMainThread && parentPort) {
  parse(workerData).then(data => parentPort.postMessage({ data }), error => parentPort.postMessage({ error: error.message }))
}
