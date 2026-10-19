/**
 * Tool definitions exposed to the model.
 *
 * Division of labour (the core design decision of this plugin):
 *   the harness already gives the agent file access and code execution, so the
 *   plugin does NOT ship a query engine or a statistics library. The agent reads
 *   and computes the data itself, then calls these tools to turn results into a
 *   durable canvas. Every tool here is about the canvas — nothing else.
 *
 * All tools are thin: they resolve the store, call one method, and return a
 * small canonical JSON value. No data rows travel back to the model.
 *
 * @module lib/tools
 */

import { CanvasStore, CanvasError, RevisionConflict, MANUAL_SOURCE_MARKER, SOURCE_RELINK_MARKER } from './store.js'
import { tidyArrange, COLS } from './grid.js'

/**
 * Build a raw JSON Schema for a tool's parameters.
 *
 * Why hand-built instead of the `defineTool` DSL: this plugin registers through
 * the raw `ctx.tools.register()`, which inserts the definition verbatim and
 * performs NO schema conversion. The `defineTool` DSL shorthand
 * (`{ name: { type: 'string', required: true } }`) and its `type: 'json'` node
 * are therefore invalid here — they would reach the provider as-is.
 *
 * That is not hypothetical: the first release did exactly that and the provider
 * rejected every call with
 *   Invalid schema for function 'canvas_add_card':
 *   {"type":"string","required":true,...} is not valid under ... 'anyOf'
 * because JSON Schema requires `required` to be an array of names on the object,
 * and has no `json` type. `tests/tool-schema.test.js` pins the correct shape.
 *
 * @param {Record<string, object>} properties JSON Schema per property
 * @param {string[]} [required] names of required properties
 */
function params (properties, required) {
  const schema = { type: 'object', properties, additionalProperties: false }
  if (Array.isArray(required) && required.length > 0) schema.required = [...required]
  return schema
}

/** An open object property: a free-form JSON object the model supplies. */
function jsonObject (description) {
  return { type: 'object', additionalProperties: true, description }
}

/** A plain string property. */
function str (description) {
  return { type: 'string', description }
}

/** Compact error envelope so the model can react instead of guessing. */
function fail (error, hint) {
  const code = error?.code || 'TOOL_ERROR'
  const payload = { ok: false, code, error: error?.message || String(error) }
  if (hint) payload.suggestion = hint
  if (error instanceof RevisionConflict) {
    payload.current_revision = error.current
    payload.suggestion = '重新读取画布取得当前 revision，再重试本次修改。'
  }
  return JSON.stringify(payload)
}

function ok (value) {
  return JSON.stringify({ ok: true, ...value })
}

/** Shared output declaration: every canvas tool returns one JSON string. */
const OUTPUT_JSON_STRING = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** Card summary for tool output — never the full payload. */
function cardSummary (card) {
  return {
    id: card.id,
    type: card.type,
    title: card.title,
    chart_type: card.chart_type ?? null,
    layout: card.layout,
    source: card.source ?? null,
  }
}

export function canvasToolDefinitions (getRoot) {
  /** One store per call: the root may change between calls (config reload). */
  const store = () => new CanvasStore(getRoot())

  return [
    {
      name: 'canvas_list',
      description:
        '列出本地所有分析画布（id、名称、卡片数、更新时间）。开始分析前先调用它，'
        + '了解用户已经有哪些画布，避免重复创建。',
      parameters: params({}),
      output: OUTPUT_JSON_STRING,
      async execute () {
        try {
          const canvases = store().listCanvases()
          return ok({ count: canvases.length, canvases })
        } catch (error) {
          return fail(error)
        }
      },
    },

    {
      name: 'canvas_create',
      description:
        '新建一个分析画布，返回其 id。之后用 canvas_add_card 往里面放图表或表格。'
        + '一个画布对应一份可长期保存、反复查看的分析成果。',
      parameters: params({
        name: str('画布名称，例如「2026 年销售分析」'),
        description: str('可选。这个画布分析什么、结论是什么。'),
      }, ['name']),
      output: OUTPUT_JSON_STRING,
      async execute (args) {
        try {
          const canvas = store().createCanvas({ name: args.name, description: args.description })
          return ok({
            canvas_id: canvas.id,
            name: canvas.name,
            revision: canvas.revision,
            hint: '用 canvas_add_card 添加第一张卡片。',
          })
        } catch (error) {
          return fail(error, '画布名称不能为空。')
        }
      },
    },

    {
      name: 'canvas_read',
      description:
        '读取一个画布的完整结构：所有卡片、它们的布局、图表配置与数据来源。'
        + '修改画布前必须先读，以便拿到最新的 revision 和卡片 id。',
      parameters: params({
        canvas_id: str('画布 id'),
        include_options: {
          type: 'boolean',
          description: '是否包含完整的图表配置（echarts_option）。默认 false，只返回摘要。',
        },
      }, ['canvas_id']),
      output: OUTPUT_JSON_STRING,
      async execute (args) {
        try {
          const canvas = store().getCanvas(args.canvas_id)
          const cards = args.include_options
            ? canvas.cards
            : canvas.cards.map(cardSummary)
          return ok({
            canvas_id: canvas.id,
            name: canvas.name,
            description: canvas.description,
            revision: canvas.revision,
            card_count: canvas.cards.length,
            cards,
          })
        } catch (error) {
          return fail(error, '先用 canvas_list 确认画布 id。')
        }
      },
    },

    {
      name: 'canvas_add_card',
      description:
        '为画布创建一张待确认的卡片预览。支持 chart（图表）、table（表格）、kpi（指标卡）、text（文字说明）、code（代码）。'
        + '图表请把聚合后的数据写成完整的 ECharts option 传入 echarts_option —— '
        + '先用代码执行把数据聚合到几百行以内再传，不要把整张大表塞进来。'
        + '常用形态与选型：趋势看 line（折线，可多系列对比）；数量对比看 bar（柱状）；'
        + '构成占比看 pie（饼图，series[].type="pie"）；层级占比悬殊或强调排序用玫瑰图'
        + '（pie 变体：series[].type="pie" 且 roseType="area"）；多维能力评分用 radar'
        + '（需 radar.indicator 数组 + series[].type="radar"）。'
        + 'type 取值含 code（text_content 传代码、language 传语言标注）。'
        + '图表、表格和指标卡必须提供 dataset 与 query；手工数据标记“手工/无外部数据源”，旧来源未关联时标记“来源待重新关联”。'
        + 'source.query 需说明数据筛选、聚合或计算口径，便于日后复核。'
        + '此工具只生成待确认草稿；预览会显示在插件画布界面，只有用户点击“确认并添加”才会写入，用户也可取消。'
        + '智能体不能确认或取消草稿。',
      parameters: params({
        canvas_id: str('画布 id'),
        followup_id: str('可选，用户卡片追问的 xcharts 引用 id；新成果关联原卡冻结版本。'),
        calculation_ref: jsonObject('可选，明确指定计算的 session_id、call_id 和事件 seq；未核对输出时仅作来源声明。'),
        type: {
          type: 'string',
          enum: ['chart', 'table', 'kpi', 'text', 'code'],
          description: '卡片类型',
        },
        title: str('卡片标题'),
        chart_type: str(
          '图表类型（type=chart 时用）：bar | line | pie | rose | radar | scatter | area | funnel | heatmap 等。',
        ),
        echarts_option: jsonObject('type=chart 时的完整 ECharts 配置对象，包含数据数组。'),
        table_data: jsonObject('type=table 时的表格数据：{ columns: [{name,type}], rows: [[...]] }。'),
        presentation_spec: jsonObject('type=kpi 时的指标配置：{ value, label, unit, target, delta }。'),
        text_content: str('type=text/code 时的正文。'),
        language: str('type=code 时的语言标注，例如 js / sql / python。'),
        dataset: str('图表/表格/指标卡的数据源名称或文件路径；手工或待重关联来源可留空并标记。'),
        query: str('数据卡必填的查询、筛选、聚合或计算口径；手工或待重关联来源可留空并标记。'),
        note: str('补充口径；来源缺失时请明确写“手工/无外部数据源”或“来源待重新关联”。'),
        anchor_card_id: str('可选。想让新卡片紧挨某张已有卡片时给出它的 id。'),
        expected_revision: {
          type: 'number',
          description: '可选。你读取画布时拿到的 revision；填了就能避免与他人修改冲突。',
        },
      }, ['canvas_id', 'type', 'title']),
      output: OUTPUT_JSON_STRING,
      async execute (args) {
        try {
          if (['chart', 'table', 'kpi'].includes(args.type)) {
            const hasDataset = typeof args.dataset === 'string' && args.dataset.trim().length > 0
            const hasQuery = typeof args.query === 'string' && args.query.trim().length > 0
            const isExplicitlyMarked = typeof args.note === 'string'
              && (args.note.includes(MANUAL_SOURCE_MARKER) || args.note.includes(SOURCE_RELINK_MARKER))
            if (!(hasDataset && hasQuery) && !isExplicitlyMarked) {
              const error = new Error('数据卡缺少可追溯来源。')
              error.code = 'SOURCE_REQUIRED'
              return fail(error, `提供 dataset 和 query；否则请明确标记“${MANUAL_SOURCE_MARKER}”或“${SOURCE_RELINK_MARKER}”。`)
            }
          }

          const draft = store().createCardDraft(args.canvas_id, {
            type: args.type,
            title: args.title,
            chart_type: args.chart_type,
            echarts_option: args.echarts_option,
            table_data: args.table_data,
            presentation_spec: args.presentation_spec,
            text_content: args.text_content,
            language: args.language,
            dataset: args.dataset,
            calculation_ref: args.calculation_ref,
            query: args.query,
            note: args.note,
            anchorCardId: args.anchor_card_id,
          }, args.expected_revision ?? null)

          // Do not return the draft ID: the model must have no confirmation handle.
          return ok({
            status: 'pending_confirmation',
            canvas_id: draft.canvas_id,
            title: draft.card.title,
            message: '预览已显示在插件画布界面，等待用户确认或取消。',
          })
        } catch (error) {
          return fail(error)
        }
      },
    },

    {
      name: 'canvas_update_card',
      description:
        '为已有卡片生成更新预览，用户在画布界面确认后才保存；可取消或填写修改意见重新预览。'
        + '只传要改的字段，未传字段和来源保留。改数据传 echarts_option / table_data；来源可传 dataset、query、source_note。'
        + '预览确认由用户操作；此工具不能移动卡片。',
      parameters: params({
        canvas_id: str('画布 id'),
        card_id: str('卡片 id（从 canvas_read 获取）'),
        followup_id: str('可选，用户卡片追问的 xcharts 引用 id'),
        calculation_ref: jsonObject('可选，指定计算 session_id、call_id、seq；不靠时间邻近推断来源'),
        title: str('新标题'),
        chart_type: str('新图表类型'),
        echarts_option: jsonObject('新的完整 ECharts 配置'),
        table_data: jsonObject('新的表格数据'),
        presentation_spec: jsonObject('新的指标卡配置'),
        text_content: str('新的正文'),
        dataset: str('新的来源数据集名称或文件路径；未传则保留现有值。'),
        query: str('新的来源查询、筛选、聚合或计算口径；未传则保留现有值。'),
        source_note: str('新的来源备注；未传则保留现有值。'),
        expected_revision: { type: 'number', description: '可选。你读取时的 revision。' },
      }, ['canvas_id', 'card_id']),
      output: OUTPUT_JSON_STRING,
      async execute (args) {
        try {
          const source = {}
          if (args.dataset !== undefined) source.dataset = args.dataset
          if (args.query !== undefined) source.query = args.query
          if (args.source_note !== undefined) source.note = args.source_note
          const draft = store().createCardUpdateDraft(args.canvas_id, args.card_id, {
            title: args.title,
            chart_type: args.chart_type,
            echarts_option: args.echarts_option,
            table_data: args.table_data,
            presentation_spec: args.presentation_spec,
            text_content: args.text_content,
            calculation_ref: args.calculation_ref,
            ...(Object.keys(source).length ? { source } : {}),
          }, args.expected_revision ?? null)
          return ok({ status: 'pending_confirmation', canvas_id: draft.canvas_id, card_id: args.card_id,
            title: draft.card.title, source: draft.card.source,
            message: '更新预览已显示在画布界面，等待用户确认；原卡片尚未修改。' })
        } catch (error) {
          if (error?.code === 'SOURCE_REQUIRED') {
            return fail(error, `提供非空 dataset 和 query；否则请将 source_note 标记为“${MANUAL_SOURCE_MARKER}”或“${SOURCE_RELINK_MARKER}”。`)
          }
          return fail(error, '先用 canvas_read 确认 card_id。')
        }
      },
    },

    {
      name: 'canvas_remove_card',
      description: '从画布中删除一张卡片。',
      parameters: params({
        canvas_id: str('画布 id'),
        card_id: str('要删除的卡片 id'),
        expected_revision: { type: 'number', description: '可选。你读取时的 revision。' },
      }, ['canvas_id', 'card_id']),
      output: OUTPUT_JSON_STRING,
      async execute (args) {
        try {
          const canvas = store().removeCard(args.canvas_id, args.card_id, args.expected_revision ?? null)
          return ok({
            canvas_id: canvas.id,
            removed: args.card_id,
            revision: canvas.revision,
            card_count: canvas.cards.length,
          })
        } catch (error) {
          return fail(error)
        }
      },
    },

    {
      name: 'canvas_arrange',
      description:
        '重新整理画布布局：把卡片对齐到规整的尺寸档位，然后按阅读顺序（先上后下、先左后右）'
        + '紧密排列，消除重叠与空隙。卡片很多、或用户觉得画布很乱时调用。',
      parameters: params({
        canvas_id: str('画布 id'),
        expected_revision: { type: 'number', description: '可选。你读取时的 revision。' },
      }, ['canvas_id']),
      output: OUTPUT_JSON_STRING,
      async execute (args) {
        try {
          let moved = 0
          const canvas = store().withCanvas(args.canvas_id, args.expected_revision ?? null, c => {
            const arranged = tidyArrange(c.cards, COLS)
            const byId = new Map(arranged.map(a => [a.id, a.layout]))
            for (const card of c.cards) {
              const next = byId.get(card.id)
              if (!next) continue
              if (card.layout.x !== next.x || card.layout.y !== next.y
                || card.layout.w !== next.w || card.layout.h !== next.h) moved++
              card.layout = next
            }
            return c
          })
          return ok({ canvas_id: canvas.id, revision: canvas.revision, moved, card_count: canvas.cards.length })
        } catch (error) {
          return fail(error)
        }
      },
    },
  ]
}

export { CanvasError }
