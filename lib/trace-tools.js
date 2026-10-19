import { TraceService } from './trace-service.js'

const str = description => ({ type: 'string', description })
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const parameters = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })
export function traceToolDefinitions (getRoot, getServices = () => ({})) {
  const service = () => new TraceService(getRoot(), getServices())
  const execute = fn => async args => {
    try { return JSON.stringify({ ok: true, ...await fn(args) }) }
    catch (error) { return JSON.stringify({ ok: false, code: error.code || 'TRACE_ERROR', error: error.message }) }
  }
  return [{
    name: 'canvas_trace',
    description: '读取指定卡片数据版本的来源、计算方法和会话；可只读校验或复算原生查询。不会执行外部脚本或修改卡片。',
    parameters: parameters({ canvas_id: str('画布 id'), card_id: str('卡片 id'), version_id: str('可选，冻结的数据版本；省略读取当前版'), action: { type: 'string', enum: ['read', 'check', 'recompute', 'version'], description: 'read 来源摘要；check 绑定校验；recompute 只读复算；version 完整历史卡片' } }, ['canvas_id', 'card_id']), output,
    execute: execute(async args => {
      const trace = service(), version = args.version_id ?? null
      if (args.action === 'check') return trace.check(args.canvas_id, args.card_id, version)
      if (args.action === 'recompute') return trace.recompute(args.canvas_id, args.card_id, version)
      if (args.action === 'version') return { version: trace.store.getCardVersion(args.canvas_id, args.card_id, version).version }
      const result = await trace.read(args.canvas_id, args.card_id, version)
      return { ...result, card: { id: result.card.id, title: result.card.title, type: result.card.type } }
    }),
  }, {
    name: 'canvas_followup_context',
    description: '解析用户消息中的 [xcharts:引用id]，读取被追问卡片的冻结版本、计算与数据引用。预览最多20点；完整卡片用 canvas_trace 的 version 动作读取。',
    parameters: parameters({ followup_id: str('消息中 xcharts 标记的引用 id'), view: { type: 'string', enum: ['summary', 'version'], description: '默认 summary 最多20点；version 读取完整冻结版本' } }, ['followup_id']), output,
    execute: execute(async args => ({ context: await service().context(args.followup_id, { full: args.view === 'version' }) })),
  }]
}
