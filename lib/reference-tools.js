import { ReferenceService } from './reference-service.js'

const str = description => ({ type: 'string', description })
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const parameters = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })

export function referenceToolDefinitions (getRoot, getServices = () => ({})) {
  const service = () => new ReferenceService(getRoot(), getServices())
  return [{
    name: 'xcharts_context',
    description: '解析用户消息中的 [xcharts:ds/res/card:…] 引用，按引用读取有界上下文（版本、字段、样本、统计或结果口径）。回答涉及引用时先用它读取，不要凭引用旁边的文字猜测。',
    parameters: parameters({
      reference: str('消息中的短引用，例如 [xcharts:ds:<id>@<hash>]；也可只传 ds:<id>'),
      view: { type: 'string', enum: ['summary', 'sample', 'stats'], description: 'summary 只给身份与字段；sample 附最多 20 行；stats 附列统计' },
    }, ['reference']), output,
    execute: async args => {
      try { return JSON.stringify({ ok: true, context: await service().read(args.reference, args.view ?? 'summary') }) }
      catch (error) { return JSON.stringify({ ok: false, code: error.code || 'REFERENCE_ERROR', error: error.message }) }
    },
  }]
}
