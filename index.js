/**
 * data-canvas-dsh — Host half.
 *
 * Gives the agent a durable place to keep analysis results: several canvases,
 * each holding chart / table / KPI / text cards on a 96-column grid that the
 * user can rearrange and come back to.
 *
 * Scope note: this plugin deliberately does NOT provide query or statistics
 * tools. The harness already gives the agent file access and code execution
 * (the bundled runtime ships Python with pandas), so the agent computes the
 * numbers itself and calls these tools to persist the result. Fewer moving
 * parts, no second engine to keep in sync.
 *
 * @module index.js
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { canvasToolDefinitions } from './lib/tools.js'
import { dataToolDefinitions } from './lib/data-tools.js'
import { CanvasStore } from './lib/store.js'
import { createApiHandler } from './lib/routes.js'
import { withExecution, currentExecution } from './lib/execution-context.js'
import { TraceService } from './lib/trace-service.js'
import { traceToolDefinitions } from './lib/trace-tools.js'
import { referenceToolDefinitions } from './lib/reference-tools.js'
import { ReferenceService } from './lib/reference-service.js'
import { captureExecution } from './lib/execution-evidence.js'

export const name = 'data-canvas-dsh'

/** `tools` is the only service this plugin cannot work without. */
export const inject = ['tools']

/**
 * @typedef {object} Config
 * @property {string} [storagePath] directory holding canvases; defaults to
 *   `$DSH_HOME/storages/xcharts-canvas`（历史路径，保持数据兼容）
 */

export function apply (ctx, config = {}) {
  const resolveRoot = () => {
    if (config.storagePath) return config.storagePath
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'storages', 'xcharts-canvas')
  }

  const services = () => ({ sessionQuery: ctx.get?.('sessionQuery'), workspaceRegistry: ctx.get?.('workspaceRegistry') })
  let registered = 0
  for (const definition of [...canvasToolDefinitions(resolveRoot), ...dataToolDefinitions(resolveRoot), ...traceToolDefinitions(resolveRoot, services), ...referenceToolDefinitions(resolveRoot, services)]) {
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: definition.output,
      execute: (args, exec) => withExecution(exec, async () => {
        if (args?.followup_id) {
          try {
            const trace = new TraceService(resolveRoot(), services())
            const reference = await trace.context(args.followup_id)
            const caller = currentExecution()
            if (reference.target_session_id && reference.target_session_id !== caller.session_id) throw new Error('追问引用属于另一个会话')
            caller.followup_id = args.followup_id
            caller.derived_from = { canvas_id: reference.canvas.id, card_id: reference.card.id, data_version_id: reference.version.id, followup_id: args.followup_id }
          } catch (error) { return JSON.stringify({ ok: false, code: 'INVALID_FOLLOWUP', error: error.message }) }
        }
        return definition.execute(args, exec)
      }),
    })
    registered++
  }

  ctx.on?.('tools/result', (exec, result) => {
    try { captureExecution(resolveRoot(), exec, result) }
    catch (error) { ctx.logger?.warn?.(`[data-canvas-dsh] execution evidence unavailable: ${error.code || 'WRITE_ERROR'}`) }
  })

  // One short instruction, only about the reference markers a user message can
  // carry; without it a model may treat them as decoration.
  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'xcharts-references',
      order: 60,
      text: '消息中出现 [xcharts:ds/res/card:…] 引用时，先用 xcharts_context 按引用读取；卡片追问的 [xcharts:<id>] 用 canvas_followup_context。不要凭引用旁边的文字猜测数据内容。数据库数据源用 datasource_query 的 sql 字段执行只读查询（自动限行与超时）；结果可能随时间变化，回答时说明是实时查询。不要索要或输出数据库密码、连接串。',
    }), 'xcharts-canvas: reference prompt')
  })

  ctx.logger?.info?.(`[data-canvas-dsh] ${registered} canvas tools registered; storage at ${resolveRoot()}`)

  // Graceful degradation: a broken storage directory must not take the whole
  // plugin tree down — the tools will report the error per call instead.
  try {
    const store = new CanvasStore(resolveRoot())
    store.readIndex()
    // First-run example: one canvas showing each chart type with business
    // context, so the shape catalogue is visible before the agent writes.
    store.seedExampleIfEmpty()
  } catch (error) {
    ctx.logger?.warn?.(`[data-canvas-dsh] storage not readable yet (${resolveRoot()}): ${String(error)}`)
  }

  // ── browser-facing JSON API ────────────────────────────────────────────────
  //
  // Deferred injection on purpose: plugins load before the web server publishes
  // its service, so reading `ctx.get('webServer')` at apply time would answer
  // `undefined` and the routes would silently never mount. `ctx.inject` pends
  // until the service exists and re-runs if it is replaced.
  const mountPath = '/api/xcharts-canvas'
  ctx.inject(['webServer'], scoped => {
    const handler = createApiHandler(
      () => new CanvasStore(resolveRoot()),
      mountPath,
      // Read the connection service lazily: the web composition may publish it
      // after this plugin loads. When present, its admission decision (trust
      // fence + browser-auth cookie) governs this surface too, so the plugin's
      // routes are never weaker than the app's own `/api` routes.
      () => ctx.get('connection'),
      services,
    )
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: mountPath, handler }),
      'xcharts-canvas: api routes',
    )
    ctx.logger?.info?.(`[data-canvas-dsh] canvas API mounted at ${mountPath}`)
  })
}

