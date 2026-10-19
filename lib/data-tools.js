import { CanvasStore, CanvasError, RevisionConflict } from './store.js'
import { DataStore } from './data-store.js'
import { testConnection } from './db/adapter.js'
import { readSecret, maskHost } from './secrets.js'

function params (properties, required) {
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required?.length) schema.required = [...required]
  return schema
}
const str = description => ({ type: 'string', description })
const json = description => ({ type: 'object', additionalProperties: true, description })
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const ok = value => JSON.stringify({ ok: true, ...value })
function fail (error) {
  const payload = { ok: false, code: error?.code || 'TOOL_ERROR', error: error?.message || String(error) }
  if (error instanceof RevisionConflict) {
    payload.current_revision = error.current
    payload.suggestion = '重新读取画布取得当前 revision，再重试本次修改。'
  }
  return JSON.stringify(payload)
}

export function dataToolDefinitions (getRoot) {
  const data = () => new DataStore(getRoot())
  const canvas = () => new CanvasStore(getRoot())
  return [
    {
      name: 'datasource_list',
      description: '列出当前插件保存的数据源及其字段摘要。仅返回元数据，不返回完整数据行。',
      parameters: params({}), output,
      async execute () {
        try {
          // Credentials never reach the model: no secret ref, host masked.
          const items = data().list().map(item => {
            if (item.kind !== 'database') return item
            const { catalog: _catalog, secret_ref: _secret, ...rest } = item
            return { ...rest, connection: { ...rest.connection, host: maskHost(rest.connection?.host) }, has_secret: Boolean(item.secret_ref) }
          })
          return ok({ count: items.length, datasources: items })
        } catch (error) { return fail(error) }
      },
    },
    {
      name: 'datasource_import',
      description: '将当前会话获得的 CSV 或 XLSX 内容保存为本地数据源。必须传入文件内容的 base64，不要传本机路径。',
      parameters: params({
        name: str('业务名称'), filename: str('原始文件名，支持 .csv 或 .xlsx'),
        content_base64: str('文件内容的 base64'), options: json('解析配置：encoding、delimiter、sheet、header_row、types（number/string/date）、missing_values（auto/keep/标记数组）'),
         source: json('来源元数据：type、attachment_id、receipt_id、filename'), conversation: json('对话锚点：conversation_id、message_id、turn_id、title、prompt_excerpt'),
      }, ['name', 'filename', 'content_base64']), output,
      async execute (args) { try { return ok({ datasource: await data().import(args) }) } catch (error) { return fail(error) } },
    },
    {
      name: 'datasource_describe',
      description: '读取一个数据源的分页预览和字段信息。',
      parameters: params({ datasource_id: str('数据源 id'), offset: { type: 'number' }, limit: { type: 'number' } }, ['datasource_id']), output,
      async execute (args) { try { return ok({ datasource: data().describe(args.datasource_id, args.offset ?? 0, args.limit ?? 20) }) } catch (error) { return fail(error) } },
    },
    {
      name: 'datasource_query',
      description: '对已保存数据源执行查询。文件源用结构化查询（选择/过滤/分组/聚合/排序，日期可 {column, granularity} 分组）；数据库源用 sql 传一条只读 SQL（仅 SELECT/WITH/EXPLAIN/SHOW，自动限行与超时）。不会执行写操作。不要向用户索要数据库密码。',
      parameters: params({ datasource_id: str('数据源 id'), query: json('文件源的结构化查询对象'), sql: str('数据库源的只读 SQL'), limit: { type: 'number' }, timeout_ms: { type: 'number' }, conversation: json('本次分析的对话锚点') }, ['datasource_id']), output,
      async execute (args) {
        try {
          const source = data().get(args.datasource_id)
          const spec = source.kind === 'database'
            ? { ...(args.sql ? { sql: args.sql } : {}), ...(args.query && typeof args.query === 'object' ? args.query : {}), ...(args.limit ? { limit: args.limit } : {}), ...(args.timeout_ms ? { timeout_ms: args.timeout_ms } : {}), ...(args.conversation ? { conversation: args.conversation } : {}) }
            : (args.query && typeof args.query === 'object' ? { ...args.query, ...(args.conversation ? { conversation: args.conversation } : {}) } : args.query)
          const result = await data().query(args.datasource_id, spec)
          return ok({ result: { ...result, rows: result.rows.slice(0, 20) } })
        } catch (error) { return fail(error) }
      },
    },
    {
      name: 'datasource_test_connection',
      description: '测试一个已保存数据库数据源的连通性。只接受数据源 id，不接受主机/密码；返回版本与延迟，不返回凭据。',
      parameters: params({ datasource_id: str('数据库数据源 id') }, ['datasource_id']), output,
      async execute (args) {
        try {
          const store = data()
          const record = store.get(args.datasource_id)
          if (record.kind !== 'database') throw new CanvasError('INVALID_SOURCE', '该数据源不是数据库连接')
          const secret = readSecret(store.root, record.secret_ref)
          return ok({ connection: await testConnection(record.format, { ...record.connection, format: record.format }, secret) })
        } catch (error) { return fail(error) }
      },
    },
    {
      name: 'analysis_read_result',
      description: '读取一次查询结果的分页数据及其源版本、查询口径和完整性状态。',
      parameters: params({ result_id: str('结果 id'), offset: { type: 'number' }, limit: { type: 'number' } }, ['result_id']), output,
      async execute (args) { try { return ok({ result: data().readResult(args.result_id, args.offset ?? 0, args.limit ?? 20) }) } catch (error) { return fail(error) } },
    },
    {
      name: 'canvas_add_result',
      description: '从已执行的结果快照生成图表、表格或指标卡并放入画布。图表不会重新接受模型填入的数据数组。',
      parameters: params({
        canvas_id: str('画布 id'), result_id: str('结果 id'), followup_id: str('可选，用户消息中的 xcharts 引用 id，用于关联原卡版本'), type: { type: 'string', enum: ['chart', 'table', 'kpi'] },
        title: str('卡片标题'), chart_type: { type: 'string', enum: ['bar', 'line', 'pie'] },
        x: str('图表分类列'), y: str('图表数值列'), expected_revision: { type: 'number' },
      }, ['canvas_id', 'result_id', 'type', 'title']), output,
      async execute (args) { try { return ok(data().addToCanvas(canvas(), args)) } catch (error) { return fail(error) } },
    },
  ]
}

export { CanvasError }
