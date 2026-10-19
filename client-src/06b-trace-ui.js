    // ── Shared provenance UI: plain JS, shared concat scope ──────────────────
    const cardTracePath = (canvasId, cardId) => `/canvases/${encodeURIComponent(canvasId)}/cards/${encodeURIComponent(cardId)}`
    const cardTraceVersionQuery = versionId => versionId == null ? '' : `?version_id=${encodeURIComponent(versionId)}`
    const getCardTrace = async (canvasId, cardId, versionId = null) => {
      const capabilities = await getCapabilities()
      if (capabilities.trace_api !== 1) throw new Error('溯源服务尚未生效，请重启 DSH 后重试')
      return api(`${cardTracePath(canvasId, cardId)}/trace${cardTraceVersionQuery(versionId)}`)
    }
    const checkCardTrace = (canvasId, cardId, versionId = null) => api(`${cardTracePath(canvasId, cardId)}/trace/check`, {
      method: 'POST', body: JSON.stringify({ version_id: versionId }),
    })
    const recomputeCardTrace = (canvasId, cardId, versionId = null) => api(`${cardTracePath(canvasId, cardId)}/recompute`, {
      method: 'POST', body: JSON.stringify({ version_id: versionId }),
    })
    const getCardVersion = (canvasId, cardId, versionId = null) => api(`${cardTracePath(canvasId, cardId)}/version${cardTraceVersionQuery(versionId)}`)

    function TraceDialog ({ canvasId, cardId, versionId = null, onClose, onOpenCanvas, onOpenDatasource, onOpenSession, onAsk, t }) {
      const [trace, setTrace] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(null)
      const [errors, setErrors] = useState({})
      const [checks, setChecks] = useState(null)
      const [recomputed, setRecomputed] = useState(null)
      const [copied, setCopied] = useState(false)
      const generation = useRef(0)
      const targetVersion = useRef(versionId)
      const owner = useRef(null)
      const copyTimer = useRef(null)
      const key = JSON.stringify([canvasId, cardId])
      const text = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      const fail = (area, error) => setErrors(previous => ({ ...previous,
        [area]: String(error?.message || '操作失败，请重试').split('\n')[0].slice(0, 180),
      }))
      const clearError = area => setErrors(previous => ({ ...previous, [area]: null }))

      async function load (nextVersion) {
        const ticket = ++generation.current
        targetVersion.current = nextVersion
        setLoading(true)
        setBusy(null)
        setErrors({})
        setCopied(false)
        setChecks(null)
        setRecomputed(null)
        try {
          const result = await getCardTrace(canvasId, cardId, nextVersion)
          if (ticket !== generation.current) return
          if (!result?.card || !result?.version?.id) throw new Error('溯源记录不完整，请重试')
          owner.current = key
          setTrace(result)
        } catch (error) {
          if (ticket === generation.current) fail('read', error)
        } finally {
          if (ticket === generation.current) setLoading(false)
        }
      }
      useEffect(() => {
        load(versionId)
        return () => {
          ++generation.current
          if (copyTimer.current) clearTimeout(copyTimer.current)
        }
      }, [canvasId, cardId, versionId])

      // Failed switches retain the visible snapshot and its actual version id.
      const visible = owner.current === key ? trace : null
      const selectedVersion = visible?.version?.id ?? null
      const disabled = loading || !!busy || !visible
      const calculation = visible?.calculation || {}
      const data = Array.isArray(visible?.data) ? visible.data : []
      const session = visible?.session || {}
      const versions = Array.isArray(visible?.versions) ? visible.versions : []
      const title = visible?.card?.title || '卡片'
      const status = value => ({
        linked: '已关联', changed: '当前源已变更', missing: '已缺失',
        unrecorded: '未记录', pending: '待校验', available: '可打开', limited: '定位受限',
      })[value] || '未记录'
      const dataStatus = !data.length ? '未记录' : [...new Set(data.map(item => status(item.status)))].join('、')
      const method = text(calculation.method)
      const methodSummary = calculation.kind === 'structured' && calculation.method ? summarizeStoredQuery(calculation.method) : method
      const methodLabel = calculation.kind === 'structured' ? '结构化查询'
        : calculation.kind === 'declared' ? '声明的方法'
          : calculation.kind === 'execution'
            ? (/sql/i.test(String(calculation.evidence?.language || calculation.evidence?.kind || '')) ? '已执行 SQL'
              : /python|javascript|script|shell/i.test(String(calculation.evidence?.language || calculation.evidence?.kind || '')) ? '执行脚本' : '执行记录')
            : '方法未记录'

      async function run (area, action) {
        if (disabled) return
        const ticket = generation.current
        clearError(area)
        setBusy(area)
        try {
          await action(() => ticket === generation.current)
        } catch (error) {
          if (ticket === generation.current) fail(area, error)
        } finally {
          if (ticket === generation.current) setBusy(null)
        }
      }
      const button = (label, onClick, unavailable = false, extra = {}) => h('button', {
        type: 'button', style: S.btn, disabled: disabled || unavailable, onClick, ...extra,
      }, label)
      const feedback = (area, retry) => errors[area] ? h(StatusLine, {
        tone: 'alert', style: { padding: '6px 0' }, children: [h('span', null, errors[area])],
        actions: retry ? [button('重试', retry, false, { key: 'retry' })] : [],
      }) : null
      const detail = value => h('pre', { style: {
        margin: '8px 0', fontSize: 'inherit', whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere', maxHeight: 260, overflow: 'auto',
      } }, text(value))
      const disclosure = (label, children, keyValue) => h(Disclosure, {
        key: keyValue, label, style: { marginTop: 8 },
      }, children)
      const navigateCanvas = () => run('canvas', () => onOpenCanvas(visible.canvas.id))
      const navigateSession = () => run('session', () => onOpenSession(session.id, session))
      const ask = () => run('ask', () => onAsk({ canvas_id: canvasId, card_id: cardId, version_id: selectedVersion, title }))
      const check = () => run('check', async current => {
        const result = await checkCardTrace(canvasId, cardId, selectedVersion)
        if (current()) setChecks(result)
      })
      const recompute = () => run('recompute', async current => {
        const result = await recomputeCardTrace(canvasId, cardId, selectedVersion)
        if (current()) setRecomputed(result)
      })
      const copy = () => run('copy', async current => {
        if (!globalThis.navigator?.clipboard?.writeText) throw new Error('无法复制，请展开方法后手动复制')
        await globalThis.navigator.clipboard.writeText(method)
        if (!current()) return
        setCopied(true)
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => { if (current()) setCopied(false) }, 1800)
      })

      return h(Dialog, {
        title: `溯源 · ${title}`, large: true, onClose,
        initialFocus: '[data-xc-trace-heading]',
        footer: [
          h('span', { key: 'error', style: { flex: 1, minWidth: 0 } }, feedback('ask', onAsk ? ask : null)),
          h('button', { key: 'ask', type: 'button', style: S.btnPrimary,
            disabled: disabled || typeof onAsk !== 'function', onClick: ask }, busy === 'ask' ? '正在准备…' : '追问'),
        ],
      }, h('div', { className: 'xc-ui', 'data-xc-trace-dialog': true,
        style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 } },
        h('div', { tabIndex: 0, 'data-xc-trace-heading': true, style: { ...S.row, flexWrap: 'wrap' } },
          h('span', null, visible ? (visible.version.current ? '当前版本' : '历史版本 · 只读') : '溯源记录'),
          visible?.version?.created_at ? h('span', { style: S.mutedSmall }, visible.version.created_at) : null),
        loading ? h(StatusLine, { style: { padding: 0 }, children: ['正在读取…'] }) : null,
        errors.read ? h(StatusLine, {
          tone: 'alert', style: { padding: '6px 0' }, children: [errors.read],
          actions: [h('button', { key: 'retry', type: 'button', style: S.btn, disabled: loading,
            onClick: () => load(targetVersion.current) }, '重试')],
        }) : null,
        visible ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
          h(SectionLabel, { label: `数据 ${dataStatus} · 计算 ${status(calculation.status)} · 会话 ${status(session.status)}`,
            actions: [button(busy === 'check' ? '校验中…' : '校验', check, false, { key: 'check' })] }),
          feedback('check', check),
          checks !== null ? h('div', { role: 'status', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ...(checks.checks || []).map(item => h('div', { key: item.id, style: S.mutedSmall }, `${({ pass: '通过', fail: '不一致', partial: '部分结果', unknown: '未校验' })[item.status] || '未校验'} · ${item.message}`))) : null,
          h('section', null,
            h(SectionLabel, { label: '计算记录', actions: [button(copied ? '已复制' : '复制方法', copy, !method, { key: 'copy', 'data-xc-trace-copy': true })] }),
            h('div', { style: S.mutedSmall }, methodLabel),
            method ? h('div', { style: { marginTop: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, methodSummary) : null,
            method ? disclosure('展开方法', detail(method), 'method') : null,
            calculation.evidence ? disclosure('计算证据', detail(calculation.evidence), 'evidence') : null,
            h('div', { style: { marginTop: 8 } }, button(busy === 'recompute' ? '复算中…' : '复算', recompute, calculation.kind !== 'structured')),
            feedback('copy', method ? copy : null),
            feedback('recompute', calculation.kind === 'structured' ? recompute : null),
            recomputed !== null ? h('div', { role: 'status', style: S.mutedSmall }, ({ match: '结果一致', different: '结果不同', unavailable: '无法复算' })[recomputed.status] || '未完成', recomputed.reason ? ` · ${recomputed.reason}` : '') : null),
          !visible.version.current ? disclosure('查看历史卡片', h('div', { style: { height: 300, minWidth: 0 } }, h(CardBody, { card: visible.card, t, theme: resolveTheme('classic', null) })), 'preview') : null,
          h('section', null,
            h(SectionLabel, { label: '数据源' }),
            !data.length ? h('div', { style: S.mutedSmall }, '数据未记录') : null,
            ...data.map((source, index) => {
              const open = () => run(`data-${index}`, () => onOpenDatasource(source.id, source.content_hash))
              const meta = [source.filename, source.row_count != null && source.column_count != null
                ? `${source.row_count} 行 × ${source.column_count} 列` : null, status(source.status)].filter(Boolean).join(' · ')
              return h('div', { key: source.id || index, style: { marginTop: 6 } },
                h('div', { style: { ...S.row, flexWrap: 'wrap' } },
                  h(EllipsisText, { text: source.name || source.filename || '数据源', style: { flex: '1 1 140px' } }),
                  button('打开数据源', open, !source.id || source.status === 'missing' || source.status === 'unrecorded' || typeof onOpenDatasource !== 'function')),
                h('div', { style: S.mutedSmall }, meta), feedback(`data-${index}`, open))
            })),
          h('section', null,
            h(SectionLabel, { label: '来源会话', actions: [button('回到会话', navigateSession,
              !session.id || !['available', 'limited'].includes(session.status) || typeof onOpenSession !== 'function', { key: 'session' })] }),
            h(EllipsisText, { text: session.title || `会话${status(session.status)}` }),
            session.call_id ? h('div', { style: S.mutedSmall }, '对应计算调用') : null,
            feedback('session', navigateSession)),
          versions.length ? disclosure('历史版本', h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 } },
            ...versions.map(version => h('button', {
              key: version.id, type: 'button', style: { ...S.btn, textAlign: 'left', height: 'auto', whiteSpace: 'normal' },
              disabled: loading || !!busy || version.id === selectedVersion,
              'aria-current': version.id === selectedVersion ? 'true' : undefined,
              onClick: () => load(version.id),
            }, [version.title || '版本', version.created_at, version.id === selectedVersion ? '正在查看' : null].filter(Boolean).join(' · '))),
            button('查看当前版本', () => load(null), visible.version.current)), 'versions') : null,
          disclosure('更多', h('div', { style: { marginTop: 8 } },
            h(SectionLabel, { label: visible.canvas?.name || '画布', actions: [button('打开画布', navigateCanvas,
              !visible.canvas?.id || typeof onOpenCanvas !== 'function', { key: 'canvas' })] }),
            feedback('canvas', navigateCanvas),
            detail({ canvas_id: visible.canvas?.id, card_id: visible.card.id || cardId,
              version_id: selectedVersion, session_id: session.id, call_id: session.call_id,
              derived_from: visible.derived_from, events: visible.events })), 'more')) : null))
    }
