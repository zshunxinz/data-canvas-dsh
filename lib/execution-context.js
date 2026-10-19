import { AsyncLocalStorage } from 'node:async_hooks'

// Scope belongs to the calling tool, never a mutable global 'current session'.
const execution = new AsyncLocalStorage()
export const currentExecution = () => execution.getStore() || {}
export function withExecution (exec, operation) {
  const context = exec?.agent?.id ? { session_id: String(exec.agent.id), call_id: String(exec.callId || ''), tool: String(exec.name || '') } : {}
  return execution.run(context, operation)
}
