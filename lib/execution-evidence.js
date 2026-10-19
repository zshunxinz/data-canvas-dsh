import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export function redactEvidence (value) {
  if (typeof value === 'string') return value.replace(/(Bearer\s+)[\w.+/=-]+/gi, '$1[redacted]').replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?)[^\s,"';]+/gi, '$1[redacted]')
  if (Array.isArray(value)) return value.map(redactEvidence)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|secret|token|authorization|api[_-]?key/i.test(key) ? '[redacted]' : redactEvidence(item)]))
  return value
}
const keyFor = ref => createHash('sha256').update(`${ref.session_id}\n${ref.call_id}`).digest('hex')
export function captureExecution (root, exec, result) {
  if (!exec?.agent?.id || !['bash', 'pwsh', 'execute_python', 'datasource_query'].includes(exec.name)) return
  const context = { session_id: String(exec.agent.id), call_id: String(exec.callId) }
  const dir = join(root, 'executions'), path = join(dir, `${keyFor(context)}.json`)
  if (existsSync(path)) return
  const args = redactEvidence(exec.arguments)
  const raw = typeof args === 'object' ? args?.command ?? args?.code ?? JSON.stringify(args) : String(args || '')
  const content = redactEvidence((result.content || []).filter(p => typeof p.text === 'string').map(p => p.text).join('\n'))
  const record = { id: keyFor(context), context, tool: exec.name, status: result.isError ? 'failed' : 'completed', method: String(raw).slice(0, 12000), method_truncated: String(raw).length > 12000, output: content.slice(0, 12000), output_truncated: content.length > 12000, created_at: new Date().toISOString(), binding: 'declared' }
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(record), { flag: 'wx' }); renameSync(tmp, path)
}
export function readExecution (root, ref) {
  if (!ref || typeof ref.session_id !== 'string' || typeof ref.call_id !== 'string') return null
  const path = join(root, 'executions', `${keyFor(ref)}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}
