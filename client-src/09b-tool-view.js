    // ── Conversation tool card: the chart where the user is looking ─────────
    //
    // The agent creates cards through `canvas_add_card` / `canvas_update_card`,
    // and until now the only place to see one was the canvas panel — the
    // conversation showed a generic tool row with the raw arguments. The host
    // dispatches every wire tool name through the keyed `tool.call.toolview`
    // slot, so this registers a real card view for our own two tool names.
    //
    // The chart comes from the CALL ARGUMENTS (`block.argsRaw`), not from the
    // draft API: the model passes the complete ECharts option, while the draft
    // projection deliberately trims series to 8 points for the panel's sample
    // preview (`lib/store.js` `publicDraft`). Rendering the arguments means full
    // fidelity with no extra request per card — and never a misleading sample.
    //
    // The view is read-only and expanded: it is a look at the result, not a
    // second place to edit it. Confirming still happens in the canvas panel.

    /** Wire tool names that render as a card in the conversation. */
    const TOOL_CARD_NAMES = ['canvas_add_card', 'canvas_update_card', 'canvas_add_result']

    /**
     * `canvas_add_result` carries no option: the card is built on the host from the
     * result snapshot and written straight into the canvas (no draft). So that call
     * fetches the saved card instead — full fidelity again, and it proves the write
     * really landed rather than showing a preview of one.
     */
    const TOOL_CARD_FETCHES = ['canvas_add_result']

    /** The card fields our tools take as arguments. */
    const TOOL_CARD_FIELDS = ['type', 'title', 'chart_type', 'echarts_option', 'table_data',
      'presentation_spec', 'text_content', 'code_content', 'color']

    /** An update call sends only the changed fields, so the type is inferred. */
    function inferCardType (args) {
      if (args.echarts_option) return 'chart'
      if (args.table_data) return 'table'
      if (args.presentation_spec) return 'kpi'
      if (args.code_content) return 'code'
      if (args.text_content) return 'text'
      return null
    }

    /** The dispatched arguments as a card spec; a partial or malformed prefix yields null. */
    function toolCardArgs (block) {
      const raw = typeof block?.argsRaw === 'string'
        ? block.argsRaw
        : (typeof block?.call?.argsRaw === 'string' ? block.call.argsRaw : '')
      if (!raw.trim()) return null
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return null
        const card = {}
        for (const field of TOOL_CARD_FIELDS) {
          if (parsed[field] !== undefined) card[field] = parsed[field]
        }
        const type = card.type || inferCardType(card)
        return type ? { ...card, type } : null
      } catch { return null }
    }

    /** The settled result, parsed as JSON when it is one (our tools answer with JSON). */
    function toolCardResult (block) {
      if (!block || block.kind !== 'tool-result') return null
      const text = (Array.isArray(block.content) ? block.content : [])
        .map(part => (part && typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim()
      if (!text) return {}
      try {
        const parsed = JSON.parse(text)
        return parsed && typeof parsed === 'object' ? parsed : { message: text }
      } catch { return { message: text } }
    }

    // One line of status, in the user's words. A pending card is not an error and
    // not a success: it is waiting for a decision in the canvas panel.
    const TOOL_CARD_TONES = {
      busy: 'var(--dsw-alias-label-tertiary, inherit)',
      pending: 'var(--dsw-alias-state-warn-label, #e8a33d)',
      error: 'var(--dsw-alias-state-warn-label, #c33)',
      done: 'var(--dsw-alias-label-tertiary, inherit)',
    }

    function toolCardStatus (phase, block, result, written = false) {
      if (phase === 'preparing') return { tone: 'busy', text: '正在准备卡片…' }
      if (phase !== 'result') return { tone: 'busy', text: '正在生成预览…' }
      if (block?.isError) return { tone: 'error', text: '创建失败' }
      if (written) return { tone: 'done', text: '已写入画布' }
      if (result?.status === 'pending_confirmation') return { tone: 'pending', text: '等待在分析画布确认' }
      return { tone: 'done', text: result?.message || '已处理' }
    }

    /** One settled card, when the call wrote it instead of carrying it in its arguments. */
    function useWrittenCard (toolName, phase, block, result) {
      const [card, setCard] = useState(null)
      const [missing, setMissing] = useState(false)
      const canvasId = result?.canvas_id
      const cardId = result?.card_id
      const settled = phase === 'result' && !block?.isError
      const [canvasName, setCanvasName] = useState('')
      const [newer, setNewer] = useState(false)
      const versionId = result?.version_id
      useEffect(() => {
        if (!TOOL_CARD_FETCHES.includes(toolName) || !settled || !canvasId || !cardId) return undefined
        let alive = true
        const request = versionId ? getCardVersion(canvasId, cardId, versionId) : getCanvas(canvasId)
        request.then(payload => {
          if (!alive) return
          const found = versionId ? payload.version?.card : (payload?.canvas?.cards || payload?.cards || []).find(item => item.id === cardId)
          if (found) setCard(found)
          else setMissing(true)
          setCanvasName(payload?.canvas?.name || payload?.name || '')
          setNewer(!!versionId && payload.current_version_id !== versionId)
        }).catch(() => { if (alive) setMissing(true) })
        return () => { alive = false }
      }, [toolName, settled, canvasId, cardId, versionId])
      return { card, missing, canvasName, newer }
    }

    /**
     * The card view itself.
     *
     * Purely presentational: everything it needs arrives in `phase`/`block`, plus
     * one read of the canvas for a call that wrote its card on the host. It never
     * throws on odd input — a tool card that disappears is worse than one that
     * falls back to a line of text.
     */
    function CardToolView ({ phase, block, toolName, t, sessionId, onOpenCanvas, onOpenDatasource, onOpenSession, onAsk }) {
      const holderRef = useRef(null)
      // No canvas context here, so the palette is the default one; the chrome
      // still follows the host tokens, read from our own container because the
      // shell defines --dsw-* on deep wrappers rather than on :root.
      const palette = 'classic'
      const [theme, setTheme] = useState(() => resolveTheme(palette, null))
      useLayoutEffect(() => { setTheme(resolveTheme(palette, holderRef.current)) }, [palette])

      const result = toolCardResult(block)
      const written = useWrittenCard(toolName, phase, block, result)
      // `canvas_add_result` arguments describe the call, not the card: they carry
      // only type/title/x/y, so the saved card read back from the canvas is the
      // only complete spec. Prefer it, and never paint an empty chart box while
      // the read is still in flight.
      const argsCard = toolCardArgs(block)
      const card = (TOOL_CARD_FETCHES.includes(toolName) ? written.card || null : null) || argsCard || written.card
      const complete = !!card && (card.echarts_option || card.table_data || card.presentation_spec || card.text_content || card.code_content)
      const status = toolCardStatus(phase, block, result, !!written.card)
      const type = card?.type || 'chart'
      const title = card?.title || result?.title || '未命名卡片'
      const tall = complete && (type === 'chart' || type === 'table')
      const pending = phase === 'result' && result?.status === 'pending_confirmation'
      const [actionError, setActionError] = useState('')
      const [traceOpen, setTraceOpen] = useState(false)
      let callArgs = {}
      try { callArgs = JSON.parse(block?.argsRaw || block?.call?.argsRaw || '{}') } catch { /* streaming prefix */ }
      const canvasId = result?.canvas_id || callArgs.canvas_id
      const cardId = result?.card_id || callArgs.card_id
      const sourceId = written.card?.binding?.source_id
      const act = action => () => { setActionError(''); Promise.resolve().then(action).catch(error => setActionError(error.message)) }
      const ask = () => onAsk({ canvas_id: canvasId, card_id: cardId, version_id: result?.version_id || written.card?.data_version_id, title }, sessionId)

      return h('div', {
        ref: holderRef,
        'data-xc-tool-card': true,
        'data-xc-tool-phase': phase,
        'data-xc-tool-status': status.tone,
        style: {
          display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0,
          padding: '8px 10px',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: RADIUS.md,
          background: SURFACE.card,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
        h(EllipsisText, { text: title, style: { fontSize: FS, fontWeight: 500, flex: '0 1 auto' } }),
        card ? h('span', { style: { ...S.mutedSmall, flex: '0 0 auto' } }, t(`card.${type}`)) : null,
        h('span', { style: { flex: '1 1 auto', minWidth: '4px' } }),
        h('span', {
          'data-xc-tool-status-text': status.tone,
          style: { ...S.mutedSmall, flex: '0 0 auto', color: TOOL_CARD_TONES[status.tone] },
        }, status.text)),
      // The chart first: it is the reason this card exists. 300px is the smallest
      // height at which a two-axis chart keeps readable labels.
      complete ? h('div', { style: tall ? { height: '300px', minWidth: 0 } : { minWidth: 0 } },
        h(CardBody, { card, t, theme })) : null,
      block?.isError
        ? h('div', { style: S.errorBox }, block.error?.reason || block.error?.code || '卡片创建失败。')
        : null,
      !complete && !block?.isError && phase === 'result'
        ? h('div', { 'data-xc-tool-body-missing': true, style: S.mutedSmall },
          written.missing
            ? (result?.message || '卡片已写入画布，但没能读回它的配置。')
            : (TOOL_CARD_FETCHES.includes(toolName) && !written.card ? '正在读取已写入的卡片…' : (result?.message || '这条调用没有可预览的卡片。')))
        : null,
      canvasId && onOpenCanvas ? h('div', { 'data-xc-tool-actions': true, style: { ...S.row, flexWrap: 'wrap', minWidth: 0 } },
        h(EllipsisText, { text: written.canvasName || '分析画布', style: { ...S.mutedSmall, flex: '1 1 100px' } }),
        written.newer ? h('span', { style: S.mutedSmall }, '有更新') : null,
        h('button', { type: 'button', style: S.btn, onClick: act(() => onOpenCanvas(canvasId, cardId, result?.version_id)) }, pending ? '打开预览' : '打开画布'),
        sourceId && onOpenDatasource ? h('button', { type: 'button', style: S.btn, onClick: act(() => onOpenDatasource(sourceId)) }, '数据源') : null,
        cardId ? h('button', { type: 'button', style: S.btn, onClick: () => setTraceOpen(true) }, '溯源') : null,
        cardId && onAsk && !pending ? h('button', { type: 'button', style: S.btn, onClick: act(ask) }, '追问') : null) : null,
      actionError ? h('div', { role: 'alert', style: S.errorBox }, actionError) : null,
      traceOpen ? h(TraceDialog, { canvasId, cardId, versionId: result?.version_id, t,
        onClose: () => setTraceOpen(false), onOpenCanvas, onOpenDatasource, onOpenSession,
        onAsk: onAsk ? input => onAsk(input, sessionId).then(() => setTraceOpen(false)) : undefined }) : null,
      written.card ? h('span', { 'data-xc-tool-written': 'true', style: { display: 'none' } }, '已保存') : null)
    }
