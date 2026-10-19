    function maxRow (cards) {
      let bottom = 0
      for (const card of cards || []) {
        const layout = card?.layout
        if (!layout) continue
        bottom = Math.max(bottom, layout.y + layout.h)
      }
      return bottom
    }

    const PANE_WIDTH_KEY = 'xc-datasource-query-pane-width'

    const DATASOURCE_UI_CSS = `
      .xc-ds-page .xc-ds-table-scroll{scrollbar-width:thin;scrollbar-gutter:stable}
      .xc-ds-page .xc-ds-table tbody tr:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
      .xc-ds-page .xc-ds-query fieldset{min-width:0;margin:0;padding:0;border:0}
      .xc-ds-page [data-xc-query-pane] ::-webkit-scrollbar{width:8px}
      .xc-ds-page [data-xc-query-pane-resizer]{width:6px;flex:0 0 auto;cursor:col-resize;background:transparent;touch-action:none}
      .xc-ds-page [data-xc-query-pane-resizer]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:-2px}
      .xc-ds-page[data-pane-resizing="true"]{user-select:none;cursor:col-resize}
      @media(pointer:coarse){.xc-ds-page [data-xc-query-pane-resizer]{width:12px}}
      @media(max-width:1100px){.xc-ds-page [data-xc-query-pane]{position:absolute;top:0;right:0;bottom:0;z-index:20;max-width:78%;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:var(--dsw-elevation-panel,0 10px 30px rgba(0,0,0,.28))}.xc-ds-page [data-xc-query-pane-resizer]{display:none}}
    `

    // 把数据库错误翻译成一句可操作的建议：连接 / 语法 / 超时 / 权限 / 表名。
    function describeSqlError (message) {
      const text = String(message || '')
      const withHint = hint => text + '（' + hint + '）'
      if (/timeout|超时|statement_timeout/i.test(text)) return withHint('建议加 WHERE 或 LIMIT 缩小范围后重试')
      if (/ECONNREFUSED|ENOTFOUND|connect|连接失败|Access denied|password/i.test(text)) return withHint('检查主机、端口与账号密码，或点连接徽标里的测试连接')
      if (/syntax|语法|You have an error in your SQL/i.test(text)) return withHint('检查 SQL 语法；可以先从左侧表结构点一张表生成示例')
      if (/permission|权限|denied/i.test(text)) return withHint('该账号对这张表没有读取权限，换只读账号或联系管理员')
      if (/doesn't exist|不存在|Unknown table|Unknown column/i.test(text)) return withHint('表名或列名可能有误，在左侧表结构里点选确认')
      return text
    }

    function DataSourcePage ({ onOpenCanvas, onOpenSession, onAskReference, preferredDatasourceId, preferredSourceHash } = {}) {
      // 本页文案使用本地中文表；宿主的翻译函数不含这些键，不能透传。
      const t = dsT
      const PAGE_SIZE = 100
      const [items, setItems] = useState([])
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [activeSourceHash, setActiveSourceHash] = useState(null)
      const sourcePage = (id, offset, limit, hash) => hash ? api(`/datasources/${encodeURIComponent(id)}/version?hash=${encodeURIComponent(hash)}&offset=${offset}&limit=${limit}`) : getDatasource(id, offset, limit)
      const [result, setResult] = useState(null)
      const [canvases, setCanvases] = useState([])
      const [capabilities, setCapabilities] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [connectionError, setConnectionError] = useState('')
      const [sourcesCollapsed, setSourcesCollapsed] = useState(false)
      const [listQuery, setListQuery] = useState('')
      const [previewPage, setPreviewPage] = useState(1)
      const [resultPage, setResultPage] = useState(1)
      const lastRunRef = useRef(null)
      const sqlAbortRef = useRef(null)
      const [noteDialog, setNoteDialog] = useState(null)
      // 浮动消息：错误与提示不再占用布局高度，可关闭；错误常驻到手动关闭。
      const { pushToast, renderToasts } = useToastStack()
      const [queryRun, setQueryRun] = useState(null)
      const [renamingId, setRenamingId] = useState('')
      const [renameDraft, setRenameDraft] = useState('')
      const [notice, setNotice] = useState('')
      const [addDialogOpen, setAddDialogOpen] = useState(false)
      const [canvasTargetId, setCanvasTargetId] = useState('')
      const [queryConfig, setQueryConfig] = useState({ select: [], groups: [], filters: [], metrics: [], order: [], limit: 5000 })
      const [queryPaneOpen, setQueryPaneOpen] = useState(false)
      const [dataView, setDataView] = useState('preview')
      const [paneResizing, setPaneResizing] = useState(false)
      const [paneWidth, setPaneWidth] = useState(() => {
        try {
          const stored = Number(window.localStorage?.getItem(PANE_WIDTH_KEY))
          return Number.isFinite(stored) && stored >= 280 && stored <= 560 ? stored : 360
        } catch { return 360 }
      })
      const [cellDetail, setCellDetail] = useState(null)
      const [lastAddedCanvas, setLastAddedCanvas] = useState(null)
      const [addCard, setAddCard] = useState({ type: 'table', chartType: 'bar', x: '', y: '' })
      const workspaceRef = useRef(null)
      const fileInputRef = useRef(null)
      const [history, setHistory] = useState([])
      const [historyRenameId, setHistoryRenameId] = useState('')
      const [historyDraft, setHistoryDraft] = useState('')
      const [rowMenu, setRowMenu] = useState(null)
      const [confirmState, setConfirmState] = useState(null)
      const [copiedDiagnostics, setCopiedDiagnostics] = useState(false)
      const [usage, setUsage] = useState(null)
      const [sourceDialog, setSourceDialog] = useState(false)
      const [usageOpen, setUsageOpen] = useState(null)
      const loadUsage = useCallback(async id => {
        if (!id) { setUsage(null); return }
        try { setUsage(await api(`/datasources/${encodeURIComponent(id)}/usage`)) } catch { setUsage(null) }
      }, [])
      const refresh = useCallback(async () => {
        setBusy(true); setError(''); setConnectionError('')
        try {
          let info
          try { info = await getCapabilities() } catch (e) { setConnectionError(e.message); return }
          if (info.datasource_api !== true) {
            setConnectionError('当前运行中的插件包不包含独立数据源接口，请安装新版 data-canvas-dsh 并重启 DSH。')
            return
          }
          setCapabilities(info)
          const [sources, boards] = await Promise.all([listDatasources(), listCanvases()])
          setItems(sources.datasources || []); setCanvases(boards.canvases || [])
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }, [])
      useEffect(() => { if (error) pushToast(error, 'alert', { 'data-xc-error': true }) }, [error])
      useEffect(() => {
        if (!notice) return
        pushToast(
          notice, 'info', { 'data-xc-datasource-operation-status': true },
          lastAddedCanvas && onOpenCanvas
            ? h('button', { type: 'button', style: S.btn, 'data-xc-view-result-canvas': lastAddedCanvas.id, onClick: () => { try { onOpenCanvas(lastAddedCanvas.id) } catch (openError) { setError('打开画布失败：' + openError.message) } } }, '查看画布')
            : null,
        )
      }, [notice])
      useEffect(() => {
        if (!detail?.warnings?.length) return
        pushToast('解析提示：' + detail.warnings.join('；'), 'info', { 'data-xc-source-warnings': true })
      }, [detail?.id, detail?.warnings?.join('|')])

      useEffect(() => { refresh() }, [])
      // The list toggle advertises Ctrl+Alt+B in `aria-keyshortcuts`, so it has
      // to work here exactly as it does on the canvas page: a declared shortcut
      // that does nothing misleads the users who rely on being told about it.
      useEffect(() => {
        const onKey = event => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (String(event.key).toLowerCase() !== 'b') return
          event.preventDefault()
          setSourcesCollapsed(value => !value)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])
      const refreshHistory = useCallback(async id => {
        if (!id) { setHistory([]); return }
        try { setHistory((await listSourceResults(id)).results || []) } catch { setHistory([]) }
      }, [])
      const openSavedResult = async item => {
        if (busy) return
        setBusy(true); setError('')
        try {
          const page = (await readDatasourceResult(item.id, 0, PAGE_SIZE)).result
          setResult(page)
          setResultPage(1)
          setDataView('result')
          setQueryRun({ status: 'complete', startedAt: new Date(item.created_at).toLocaleString(), message: item.title ? `已载入保存的结果：${item.title}` : '已载入保存的结果。' })
        } catch (e) { setError('载入结果失败：' + e.message) } finally { setBusy(false) }
      }
      const saveHistoryTitle = async item => {
        const title = historyDraft.trim()
        if (!title) { setError('结果名称不能为空。'); return }
        try {
          const saved = (await renameSavedResult(item.id, title)).result
          setHistory(current => current.map(entry => entry.id === item.id ? { ...entry, ...saved } : entry))
          setHistoryRenameId('')
          setNotice('结果已重命名为“' + saved.title + '”。')
        } catch (e) { setError('重命名结果失败：' + e.message) }
      }
      const sourceReadSeq = useRef(0)
      const choose = async (id, sourceHash = null) => {
        const ticket = ++sourceReadSeq.current
        setActiveSourceHash(sourceHash)
        setSelected(id); setDetail(null); setResult(null); setQueryRun(null); setError(''); setNotice(''); setLastAddedCanvas(null); setPreviewPage(1); setBusy(true)
        try {
          const source = (await sourcePage(id, 0, PAGE_SIZE, sourceHash)).datasource
          if (ticket !== sourceReadSeq.current) return
          setDetail(source)
          setQueryConfig({ select: source.columns.map(c => c.name), groups: [], groupGranularity: {}, filters: [], metrics: [], order: [], limit: 5000 })
          refreshHistory(id)
          loadUsage(id)
        }
        catch (e) { if (ticket === sourceReadSeq.current) { setDetail(null); setError(e.message); setUsage(null) } }
        finally { if (ticket === sourceReadSeq.current) setBusy(false) }
      }
      useEffect(() => { if (preferredDatasourceId) choose(preferredDatasourceId, preferredSourceHash || null) }, [preferredDatasourceId, preferredSourceHash])
      const beginRename = item => { setRenamingId(item.id); setRenameDraft(item.name); setError(''); setNotice(''); setLastAddedCanvas(null) }
      const cancelRename = () => { setRenamingId(''); setRenameDraft('') }
      const saveRename = async item => {
        const name = renameDraft.trim()
        if (!name) { setError('数据源名称不能为空。'); return }
        if (name === item.name) { cancelRename(); return }
        setBusy(true); setError(''); setNotice(''); setLastAddedCanvas(null)
        try {
          const renamed = (await api('/datasources/' + item.id + '/rename', { method: 'PATCH', body: JSON.stringify({ name }) })).datasource
          setItems(current => current.map(source => source.id === item.id ? { ...source, ...renamed } : source))
          setDetail(current => current?.id === item.id ? { ...current, ...renamed } : current)
          cancelRename()
          setNotice('数据源名称已更新为“' + renamed.name + '”。')
        } catch (e) { setError('重命名数据源失败：' + e.message) }
        finally { setBusy(false) }
      }
      const runDeleteSource = async item => {
        if (busy) return
        setBusy(true); setError(''); setNotice(''); setLastAddedCanvas(null)
        try {
          const deleted = await api('/datasources/' + item.id, { method: 'DELETE' })
          setItems(current => current.filter(source => source.id !== item.id))
          setRenamingId(current => current === item.id ? '' : current)
          if (selected === item.id) {
            setSelected(null)
            setDetail(current => current ? { ...current, deleted: true } : current)
          }
          setNotice(deleted.note || '数据源已删除；已有结果快照和画布卡片保留。')
        } catch (e) { setError('删除数据源失败：' + e.message) }
        finally { setBusy(false) }
      }
      // Deleting a source keeps its results and cards, but nothing can ever be
      // queried through it again — the one consequence worth one sentence.
      const deleteSource = item => {
        if (busy) return
        const count = usage && usage.source_id === item.id ? usage.counts : null
        setConfirmState({
          title: '删除数据源',
          tone: 'danger',
          confirmLabel: '删除',
          body: `「${item.name}」的已有查询结果和画布卡片会保留，但无法再用此数据源执行新查询。${count && (count.cards || count.sessions) ? ` 目前被 ${count.cards} 张卡片、${count.sessions} 次对话使用。` : ''}`,
          onConfirm: () => { setConfirmState(null); runDeleteSource(item) },
        })
      }
      const referenceSource = () => {
        if (!detail || detail.read_only || typeof onAskReference !== 'function') return
        onAskReference({ kind: 'ds', datasource_id: detail.id, version: detail.content_hash, name: chosen?.name || detail.name, rows: detail.row_count })
          .catch(error => setError('引用到对话失败：' + error.message))
      }
      const referenceResult = () => {
        if (!result || typeof onAskReference !== 'function') return
        onAskReference({ kind: 'res', result_id: result.id, rows: result.materialized_rows ?? result.total_rows })
          .catch(error => setError('引用到对话失败：' + error.message))
      }
      const loadPreviewPage = async page => {
        if (!selected || page < 1 || page > Math.ceil((detail?.row_count || 0) / PAGE_SIZE)) return
        setBusy(true); setError('')
        try { setDetail((await sourcePage(selected, (page - 1) * PAGE_SIZE, PAGE_SIZE, activeSourceHash)).datasource); setPreviewPage(page) }
        catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      const loadResultPage = async page => {
        if (!result?.id || page < 1 || page > Math.max(1, Math.ceil((result.materialized_rows ?? result.total_rows) / PAGE_SIZE))) return
        setBusy(true); setError('')
        try { setResult((await readDatasourceResult(result.id, (page - 1) * PAGE_SIZE, PAGE_SIZE)).result); setResultPage(page) }
        catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      const importFile = event => {
        const file = event.target.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = async () => {
          try {
            setBusy(true)
            const base64 = String(reader.result).split(',')[1]
            await importDatasource({ name: file.name.replace(/\.[^.]+$/, ''), filename: file.name, content_base64: base64, source: { type: 'browser_upload', filename: file.name } })
            await refresh()
          } catch (e) { setError(e.message) } finally { setBusy(false); event.target.value = '' }
        }
        reader.readAsDataURL(file)
      }
      const runSql = async sql => {
        if (!selected || busy || !sql?.trim()) return
        const startedAt = new Date().toLocaleTimeString()
        const controller = new AbortController()
        sqlAbortRef.current = controller
        setBusy(true); setError(''); setNotice(''); setLastAddedCanvas(null); setResult(null)
        lastRunRef.current = { kind: 'sql', sql }
        setQueryRun({ status: 'running', startedAt, message: '正在执行只读 SQL（最多 5000 行，15 秒超时）…' })
        try {
          const created = (await queryDatabaseSql(selected, { sql, limit: 5000 }, { signal: controller.signal })).result
          const firstPage = (await readDatasourceResult(created.id, 0, PAGE_SIZE)).result
          setResult(firstPage); setResultPage(1)
          setQueryRun({ status: 'complete', startedAt, message: `SQL 完成：${(created.total_rows ?? 0).toLocaleString()} 行 · ${created.duration_ms ?? 0} ms${created.truncated ? ' · 已按上限截断' : ''}` })
          refreshHistory(selected)
        } catch (sqlError) {
          const cancelled = sqlError?.name === 'AbortError' || /abort/i.test(String(sqlError?.message || ''))
          if (cancelled) {
            setQueryRun({ status: 'error', startedAt, message: '已取消这次查询' })
          } else {
            const friendly = describeSqlError(sqlError.message)
            setQueryRun({ status: 'error', startedAt, message: `SQL 失败：${friendly}` })
            setError(friendly)
          }
        } finally { sqlAbortRef.current = null; setBusy(false) }
      }
      const runConnectionTest = async () => {
        if (!selected) return
        setBusy(true); setError(''); setNotice('')
        try {
          const info = await testSavedConnection(selected)
          setNotice(`连接成功 · ${info.server_version || ''} · ${info.latency_ms} 毫秒`)
        } catch (connectError) { setError('连接失败：' + connectError.message) } finally { setBusy(false) }
      }
      const runQueryRef = useRef(null)
      const runQuery = async () => {
        if (!selected || !detail || detail.deleted || detail.read_only || busy) return
        let query
        try { query = buildDatasourceQuery(detail.columns || [], queryConfig) }
        catch (e) { setError(e.message); return }
        const startedAt = new Date().toLocaleTimeString()
        lastRunRef.current = { kind: 'query' }
        setBusy(true); setError(''); setNotice(''); setLastAddedCanvas(null); setResult(null); setQueryRun({ status: 'running', startedAt, message: `正在执行结构化查询，最多保存 ${query.limit} 行。` })
        try {
          const created = (await queryDatasource(selected, query)).result
          setQueryRun({ status: 'loading', startedAt, message: `查询已完成，匹配 ${created.total_rows.toLocaleString()} 行；正在载入结果分页。` })
          const firstPage = (await readDatasourceResult(created.id, 0, PAGE_SIZE)).result
          setResult(firstPage); setResultPage(1)
          setQueryRun({ status: 'complete', startedAt, message: `查询记录已保存：${created.total_rows.toLocaleString()} 行，${created.columns.length} 列；当前展示第 1 页，每页 ${PAGE_SIZE} 行。${created.truncated ? `结果超过 ${query.limit} 行，已按上限截取。` : ''}` })
          refreshHistory(selected)
        } catch (e) {
          setQueryRun({ status: 'error', startedAt, message: `查询失败：${e.message}` })
          setError(e.message)
          // The configuration that failed stays intact and the primary action
          // regains focus, so a retry is one keystroke away.
          requestAnimationFrame(() => runQueryRef.current?.focus())
        } finally { setBusy(false) }
      }
      const openAddDialog = () => {
        const columns = result?.columns || []
        const numeric = columns.filter(column => column.type === 'number')
        setAddCard({
          type: 'table',
          chartType: 'bar',
          x: columns.find(column => column.type !== 'number')?.name || columns[0]?.name || '',
          y: numeric[0]?.name || columns[0]?.name || '',
        })
        setCanvasTargetId('')
        setAddDialogOpen(true)
      }
      const confirmAddToCanvas = async () => {
        if (!result?.id || !canvasTargetId || busy) return
        const target = canvases.find(canvas => canvas.id === canvasTargetId)
        try {
          setBusy(true)
          const body = { canvas_id: canvasTargetId, type: addCard.type, title: `${result.source_name} 查询结果` }
          if (addCard.type === 'chart') { body.chart_type = addCard.chartType; body.x = addCard.x; body.y = addCard.y }
          if (addCard.type === 'kpi') body.y = addCard.y
          await addResultToCanvas(result.id, body)
          setAddDialogOpen(false)
          setError('')
          setLastAddedCanvas({ id: canvasTargetId, name: target?.name || '目标画布' })
          setNotice(`已将「${result.source_name} 查询结果」添加到画布「${target?.name || '目标画布'}」。`)
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      // Rows come from the shared `ListRow`, so this list and the canvas list
      // have one geometry (45px, radius md, hover/selected fill, real <button>)
      // instead of two. Renaming happens in the same box via `ListRowInput`.
      // The search slot appears on the same rule as the canvas list (only once
      // the list stops fitting), so both lists are structurally identical.
      const listNeedsSearch = items.length > LIST_SEARCH_MIN
      const listTrim = listQuery.trim().toLowerCase()
      const listMatches = listTrim
        ? items.filter(item => `${item.name} ${item.filename || ''}`.toLowerCase().includes(listTrim))
        : items
      const listRows = listMatches.map(item => renamingId === item.id
        ? h(ListRowInput, {
          key: item.id,
          value: renameDraft,
          ariaLabel: '新名称：' + item.name,
          disabled: busy,
          data: { 'data-xc-datasource-row': item.id },
          onChange: event => setRenameDraft(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') { event.preventDefault(); saveRename(item) }
            else if (event.key === 'Escape') { event.preventDefault(); cancelRename() }
          },
        })
        : h(ListRow, {
          key: item.id,
          title: item.name,
          titleAttr: item.filename,
          meta: [
            String(item.format || item.filename?.split('.').pop() || '').toUpperCase(),
            item.kind === 'database' ? (item.needs_secret ? '待填写密码' : `${item.table_count ?? 0} 张表`) : `${item.row_count.toLocaleString()} 行`,
            item.results?.length ? `结果 ${item.results.length}` : null,
          ].filter(Boolean).join(' · '),
          selected: selected === item.id,
          disabled: busy,
          data: { 'data-xc-datasource-row': item.id },
          buttonData: { 'data-xc-select-datasource': item.id },
          onClick: () => choose(item.id),
          actions: [h(IconButton, {
            key: 'menu',
            title: '数据源操作：' + item.name,
            buttonProps: {
              'data-xc-datasource-actions': item.id,
              'data-xc-datasource-menu': item.id,
              'aria-haspopup': 'menu',
              'aria-expanded': rowMenu?.id === item.id ? 'true' : 'false',
              disabled: busy,
            },
            onClick: event => {
              const rect = event.currentTarget.getBoundingClientRect?.() || { right: 0, bottom: 0 }
              setRowMenu(current => current?.id === item.id ? null : { id: item.id, x: Math.max(8, rect.right - 176), y: rect.bottom + 4 })
            },
          }, h(ToolIcon, { name: 'more' }))],
        }))

      // The list's identity line, create entry and empty states are the shared
      // ones: `数据源 3` sits exactly where `分析画布 12` sits on the other page.
      // The create entry is a real <button> (it used to be a <label> + hidden
      // input with hand-written key handling), so keyboard support comes free.
      const importControl = h(ListPrimaryAction, {
        label: busy ? '处理中…' : t('ds.addSource'),
        icon: 'upload',
        disabled: busy,
        title: t('ds.addSourceHint'),
        data: { 'data-xc-import': 'true' },
        onClick: () => setSourceDialog(true),
      })
      // Header context: which source is open, and how big it is. Same slot as the
      // canvas page's `canvas · N 张卡片 · 版本 R` — and, since the content pane
      // no longer repeats it, the single place this identity is stated.
      const chosen = detail && detail.id === selected ? detail : null
      const headerMeta = chosen
        ? [
          chosen.deleted ? `${chosen.name}（已删除）` : chosen.read_only ? `${chosen.name}（计算时版本）` : chosen.name,
          String(chosen.format || chosen.filename?.split('.').pop() || '').toUpperCase(),
          `${(chosen.row_count ?? 0).toLocaleString()} 行`,
          `${chosen.columns?.length || 0} 列`,
          chosen.note ? `${chosen.note}` : null,
        ].filter(Boolean).join(' · ')
        : `${items.length} 个数据源`
      const listEmpty = connectionError
        ? h(EmptyState, { 'data-xc-connection-error': 'true', title: '插件接口未连接', hint: connectionError })
        : items.length && !listMatches.length
          ? h(EmptyState, { 'data-xc-list-empty': 'true', title: '没有匹配的数据源。' })
          : h(EmptyState, { title: '还没有数据源', hint: '导入 CSV 或 XLSX 文件开始分析。' })
      // One status line for every run: the tab label, the time, the numbers, and
      // a retry when it failed. Success is a line too, so feedback never moves.
      const QUERY_STATUS_LABEL = { running: '查询进行中', loading: '准备结果', complete: '查询完成', error: '查询失败' }
      const queryLog = queryRun
        ? h('div', {
          role: 'status', 'aria-live': 'polite', 'data-xc-query-status': queryRun.status,
          style: {
            flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
            fontSize: 12, lineHeight: 1.5,
            color: queryRun.status === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        },
        h('strong', null, QUERY_STATUS_LABEL[queryRun.status] || '查询'),
        h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, ` · ${queryRun.startedAt} · ${queryRun.message}${result ? ' · ' + (result.columns?.length ?? 0) + ' 列' : ''}`),
        queryRun.status === 'error' && lastRunRef.current
          ? h('button', { type: 'button', style: S.btn, 'data-xc-query-retry': true, disabled: busy, onClick: () => { const run = lastRunRef.current; if (run.kind === 'sql') runSql(run.sql); else runQuery() } }, '重试')
          : null,
        null)
        : null
      const PANE_MIN = 280
      const PANE_MAX = 560
      const applyPaneWidth = value => {
        const next = Math.max(PANE_MIN, Math.min(PANE_MAX, Math.round(value)))
        setPaneWidth(next)
        try { window.localStorage?.setItem(PANE_WIDTH_KEY, String(next)) } catch { /* storage may be unavailable */ }
      }
      // Drag the divider: the pane keeps whatever width the user leaves it at.
      const startPaneResize = event => {
        event.preventDefault()
        const right = event.currentTarget.parentElement?.getBoundingClientRect?.().right
        if (!right) return
        setPaneResizing(true)
        const onMove = move => applyPaneWidth(right - move.clientX)
        const onUp = () => {
          setPaneResizing(false)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        // A drag must not select text behind the divider.
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }
      const onPaneKeyDown = event => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); applyPaneWidth(paneWidth + 24) } else if (event.key === 'ArrowRight') { event.preventDefault(); applyPaneWidth(paneWidth - 24) } else if (event.key === 'Escape') { setQueryPaneOpen(false) }
      }
      const tabStyle = active => ({
        ...S.btn,
        ...(active ? { background: 'color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)', color: 'var(--dsw-alias-label-primary)' } : null),
      })
      const historyNode = h(Disclosure, { label: `最近结果${history.length ? ' · ' + history.length : ''}`, data: { 'data-xc-result-history': true } },
        history.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 } }, ...history.map(item => historyRenameId === item.id
            ? h('div', { key: item.id, style: { display: 'flex', gap: 4, alignItems: 'center' } },
              h('input', {
                type: 'text', autoFocus: true, value: historyDraft, disabled: busy,
                'aria-label': `结果名称：${item.title || item.id}`,
                'data-xc-result-rename-input': item.id,
                onChange: event => setHistoryDraft(event.target.value),
                onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); saveHistoryTitle(item) } else if (event.key === 'Escape') { event.preventDefault(); setHistoryRenameId('') } },
                style: { ...S.btn, flex: '1 1 80px', minWidth: 0, fontWeight: 'normal', height: 24 },
              }),
              h('button', { type: 'button', style: S.btn, disabled: busy, 'data-xc-result-rename-save': item.id, onClick: () => saveHistoryTitle(item) }, '保存'),
              h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => setHistoryRenameId('') }, '取消'))
            : h('div', { key: item.id, style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('button', {
                type: 'button', 'data-xc-saved-result': item.id, title: item.title || item.id,
                style: { ...S.btn, flex: '1 1 auto', minWidth: 0, justifyContent: 'flex-start', height: 24, fontWeight: 'normal', fontSize: '12px' },
                onClick: () => openSavedResult(item),
              },
              h(EllipsisText, { text: item.title || '未命名结果' }),
              h('span', { style: { ...S.mutedSmall, marginLeft: 'auto', flex: '0 0 auto' } }, `${(item.total_rows ?? item.row_count ?? 0).toLocaleString()} 行`)),
              h(LinkButton, { label: '重命名', title: `重命名结果 ${item.title || item.id}`, disabled: busy, 'data-xc-result-rename': item.id, onClick: () => { setHistoryRenameId(item.id); setHistoryDraft(item.title || '') } }))))
          : h('div', { style: { ...S.mutedSmall, paddingTop: 4 } }, '还没有保存的查询结果。'))
      // Usage is a management detail: one menu row opens it, the default view
      // stays exactly one table.
      const usageDialog = usageOpen ? h(Dialog, {
        title: `使用情况 · ${usageOpen.name}`, closeLabel: '关闭',
        onClose: () => setUsageOpen(null),
      }, usage && usage.source_id === usageOpen.id
        ? h('div', { 'data-xc-usage-dialog': usageOpen.id, style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 } },
          h(SectionLabel, { label: '卡片' }),
          usage.cards.length
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ...usage.cards.map(card => h('button', {
              key: `card-${card.card_id}`, type: 'button', 'data-xc-usage-card': card.card_id,
              style: { ...S.btn, justifyContent: 'flex-start', height: 24, fontWeight: 'normal', fontSize: '12px', minWidth: 0 },
              title: `${card.canvas_name} · ${card.title}`,
              onClick: () => { setUsageOpen(null); try { onOpenCanvas(card.canvas_id, card.card_id, card.data_version_id) } catch (e) { setError('打开画布失败：' + e.message) } },
            }, h(EllipsisText, { text: `${card.canvas_name} · ${card.title}` }))))
            : h('div', { style: S.mutedSmall }, '没有卡片'),
          h(SectionLabel, { label: '对话' }),
          usage.sessions.length
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ...usage.sessions.map(session => h('button', {
              key: `session-${session.session_id}`, type: 'button', 'data-xc-usage-session': session.session_id,
              style: { ...S.btn, justifyContent: 'flex-start', height: 24, fontWeight: 'normal', fontSize: '12px', minWidth: 0 },
              title: session.session_id,
              onClick: () => { setUsageOpen(null); if (onOpenSession) Promise.resolve(onOpenSession(session.session_id)).catch(error => setError('打开会话失败：' + error.message)) },
            }, h(EllipsisText, { text: session.title || '会话' }))))
            : h('div', { style: S.mutedSmall }, '没有对话记录'))
        : h('div', { style: S.mutedSmall }, '正在读取…')) : null
      const diagnosticsNode = result
        ? h(LinkButton, {
          label: copiedDiagnostics ? '已复制诊断信息' : '复制诊断信息',
          title: '复制来源哈希、结果 ID 与查询快照',
          style: { alignSelf: 'flex-start' },
          'data-xc-copy-diagnostics': true,
          onClick: async () => {
            const payload = JSON.stringify({ source: result.source_name, source_hash: result.source_hash, result_id: result.id, query: result.query, created_at: result.created_at }, null, 2)
            try { await navigator.clipboard.writeText(payload); setCopiedDiagnostics(true); setNotice('诊断信息已复制。') } catch { setError('复制诊断信息失败，请检查剪贴板权限。') }
          },
        })
        : null
      // The content pane is the table and nothing else until there IS a result to
      // switch between: no identity line (that is the page header), no query
      // summary (that is the query pane), no tool strip. The query actions live in
      // the page header, so the default view is exactly one table.
      const dataToolbar = result
        ? h('div', { 'data-xc-data-toolbar': true, style: S.subToolbar },
          h('div', { role: 'tablist', 'aria-label': '数据视图', 'data-xc-data-tabs': 'true', style: { display: 'flex', alignItems: 'center', gap: 4 } },
            h('button', { type: 'button', role: 'tab', 'aria-selected': dataView === 'preview', 'data-xc-data-tab': 'preview', style: tabStyle(dataView === 'preview'), onClick: () => setDataView('preview') }, '原始数据'),
            h('button', { type: 'button', role: 'tab', 'aria-selected': dataView === 'result', 'data-xc-data-tab': 'result', style: tabStyle(dataView === 'result'), onClick: () => setDataView('result') }, '查询结果')),
          h('span', { style: { flex: 1, minWidth: '4px' } }),
          dataView === 'result' ? h('button', { type: 'button', style: S.btn, 'data-xc-reference-result': result.id, onClick: () => { referenceResult() }, disabled: busy }, '在对话中使用') : null,
          dataView === 'result' ? h('button', { type: 'button', style: S.btnPrimary, 'data-xc-add-to-canvas': true, onClick: openAddDialog, disabled: busy || !canvases.length }, '添加到画布…') : null)
        : null
      // A stored result only needs its own line when its query is no longer the
      // one configured in the pane (the user edited after running it).
      const resultNote = result && summarizeStoredQuery(result.query) !== datasourceQuerySummary(queryConfig)
        ? h('div', { 'data-xc-result-note': true, style: { ...S.mutedSmall, flex: '0 0 auto' } }, `结果口径：${summarizeStoredQuery(result.query)}`)
        : null
      const database = detail?.kind === 'database'
      // 状态与结果操作合成一条横带：同一个事实只说一次，结果区多出空间。
      const resultBar = database && result
        ? h('div', { 'data-xc-db-actions': true, style: { ...S.subToolbar, gap: '8px' } },
          h('div', { style: { flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' } },
            queryLog,
            null),
          h('button', { type: 'button', style: S.btn, 'data-xc-reference-result': result.id, disabled: busy, onClick: () => { referenceResult() } }, '在对话中使用'),
          h('button', { type: 'button', style: S.btnPrimary, 'data-xc-add-to-canvas': true, disabled: busy || !canvases.length, onClick: openAddDialog }, '添加到画布…'))
        : queryLog
      const detailView = detail ? h('div', { style: { display: 'flex', minWidth: 0, minHeight: 0, flex: 1, position: 'relative' } },
        h('div', { 'data-xc-data-main': true, style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden' } },
          database ? h(DatabasePane, { t, detail, busy, hasResult: Boolean(result), onRun: runSql, onCancel: () => sqlAbortRef.current?.abort?.(), onTest: runConnectionTest, onSecretSaved: () => choose(detail.id) }) : null,
          resultBar,
          database && !result
            ? h('div', { 'data-xc-db-empty': true, style: { ...S.mutedSmall, padding: '10px 4px' } }, '执行 SQL 后，结果会显示在这里；也可以用右上角的全屏图标查看完整表格。')
            : null,
          database ? null : dataToolbar,
          database
            ? (result ? h(DataTablePane, {
          data: result,
          tableKey: 'result',
          page: resultPage,
          totalRows: result.materialized_rows ?? result.total_rows,
          onPage: loadResultPage,
          busy,
          title: '查询结果',
          storageKey: detail.id + ':result',
          fetchRows: async (offset, limit) => (await readDatasourceResult(result.id, offset, limit))?.result?.rows || [],
        }) : null)
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, flex: '1 1 auto' } },
              resultNote,
              dataView === 'result' && result
                ? h(DataTablePane, {
          data: result,
          tableKey: 'result',
          page: resultPage,
          totalRows: result.materialized_rows ?? result.total_rows,
          onPage: loadResultPage,
          busy,
          title: '查询结果',
          storageKey: detail.id + ':result',
          fetchRows: async (offset, limit) => (await readDatasourceResult(result.id, offset, limit))?.result?.rows || [],
          onFilterValue: (column, value) => {
            setQueryConfig(current => ({ ...current, filters: [...(current.filters || []), { column, op: 'eq', value }] }))
            setQueryPaneOpen(true)
            setNotice('已添加筛选：' + column + ' = ' + String(value ?? ''))
          },
          onNotify: pushToast,
          onResetFilters: () => {
            setQueryConfig(current => ({ ...current, filters: [], groups: [], metrics: [] }))
            setQueryPaneOpen(true)
          },
        })
                : h(DataTablePane, {
          data: detail,
          tableKey: 'preview',
          page: previewPage,
          totalRows: detail.row_count,
          onPage: loadPreviewPage,
          busy,
          title: '数据预览',
          storageKey: detail.id + ':preview',
          fetchRows: async (offset, limit) => (await getDatasource(selected, offset, limit))?.datasource?.rows || [],
        }))),
        !database && queryPaneOpen ? h('div', {
          role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-label': '调整查询栏宽度',
          'aria-valuenow': paneWidth, 'aria-valuemin': PANE_MIN, 'aria-valuemax': PANE_MAX,
          'aria-controls': 'xc-ds-query-pane', 'data-xc-query-pane-resizer': true,
          onPointerDown: startPaneResize,
          onDoubleClick: () => applyPaneWidth(360),
          onKeyDown: onPaneKeyDown,
        }) : null,
        !database && queryPaneOpen ? h('aside', { id: 'xc-ds-query-pane', 'data-xc-query-pane': true, 'aria-label': '查询构建器', onKeyDown: onPaneKeyDown, style: { flex: '0 0 auto', width: paneWidth, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--dsw-alias-border-l1, #8884)' } },
          h('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1, #8884)' } },
            h('strong', { style: { fontSize: '13px' } }, '查询构建器'), h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', className: 'hHd-Xa_iconButton', 'aria-label': '关闭查询构建器', 'data-xc-query-pane-close': true, style: S.btnIcon, onClick: () => setQueryPaneOpen(false) }, '✕')),
          h('div', { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', padding: '12px' } },
            h(DataSourceQueryPane, {
              config: queryConfig, columns: detail.columns || [], busy, capabilities,
              onChange: setQueryConfig, onKeyDown: onPaneKeyDown,
              footer: historyNode,
              diagnostics: diagnosticsNode,
            }))) : null)

        : h('div', { style: { ...S.muted, padding: 12 } }, selected ? (busy ? '正在读取数据源…' : '数据源暂不可用。') : '从左侧选择数据源查看预览和执行查询。')
      const menuItem = rowMenu ? items.find(entry => entry.id === rowMenu.id) : null
      const addColumns = result?.columns || []
      const addNumeric = addColumns.filter(column => column.type === 'number')
      const addText = addColumns.filter(column => column.type !== 'number')
      const addReady = addCard.type === 'table'
        ? addColumns.length > 0
        : addCard.type === 'kpi'
          ? Boolean(addCard.y) && addNumeric.length > 0
          : Boolean(addCard.x) && Boolean(addCard.y) && addNumeric.length > 0
      const addHint = addCard.type === 'table'
        ? '表格可以保存截断结果，完整性说明随卡片保存。'
        : addCard.type === 'kpi'
          ? '指标卡需要单行数值结果：请先用分组聚合把结果收敛到一行。'
          : '图表需要完整且不超过 500 行的结果、唯一分类轴和数值列：请先过滤或聚合。'
      const columnSelect = (label, value, choices, onChange) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', minWidth: 0 } }, label,
        h(Select, {
          value,
          options: choices.map(choice => ({ value: choice.name, label: `${choice.name}（${choice.type}）` })),
          onChange,
          ariaLabel: label,
          disabled: busy,
          dataAttrs: { 'data-xc-add-column': label },
          triggerStyle: { flex: '1 1 120px', minWidth: 0, height: 26, fontWeight: 'normal' },
        }))
      const addDialog = addDialogOpen ? h(Dialog, { title: '选择目标画布', closeLabel: '关闭', onClose: () => { if (!busy) setAddDialogOpen(false) } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 12 } },
          h('div', { style: { ...S.muted, lineHeight: 1.6 } }, `将把「${result?.source_name || ''} 查询结果」作为${addCard.type === 'table' ? '表格' : addCard.type === 'kpi' ? '指标' : '图表'}卡片添加，包含 ${(result?.materialized_rows ?? result?.total_rows ?? 0).toLocaleString()} 行和 ${result?.columns?.length || 0} 列。`),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '卡片类型'),
            h('div', { role: 'radiogroup', 'aria-label': '卡片类型', style: { display: 'flex', gap: 4 } },
              ...[['table', '表格'], ['chart', '图表'], ['kpi', '指标卡']].map(([value, label]) => h('button', {
                key: value, type: 'button', role: 'radio', 'aria-checked': addCard.type === value, 'data-xc-add-card-type': value,
                style: { ...S.btn, ...(addCard.type === value ? { background: 'color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)', color: 'var(--dsw-alias-label-primary)' } : null) },
                onClick: () => setAddCard(current => ({ ...current, type: value })),
              }, label)))),
          addCard.type === 'chart'
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '图形'),
                ...[['bar', '柱状'], ['line', '折线'], ['pie', '饼图']].map(([value, label]) => h('button', {
                  key: value, type: 'button', role: 'radio', 'aria-checked': addCard.chartType === value, 'data-xc-add-chart-type': value,
                  style: { ...S.btn, ...(addCard.chartType === value ? { background: 'color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)', color: 'var(--dsw-alias-label-primary)' } : null) },
                  onClick: () => setAddCard(current => ({ ...current, chartType: value })),
                }, label))),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                columnSelect('分类轴', addCard.x, addText.length ? addText : addColumns, value => setAddCard(current => ({ ...current, x: value }))),
                columnSelect('数值轴', addCard.y, addNumeric.length ? addNumeric : addColumns, value => setAddCard(current => ({ ...current, y: value })))))
            : null,
          addCard.type === 'kpi'
            ? h('div', { style: { display: 'flex' } }, columnSelect('数值列', addCard.y, addNumeric.length ? addNumeric : addColumns, value => setAddCard(current => ({ ...current, y: value }))))
            : null,
          h('div', { style: { ...S.mutedSmall, 'data-xc-add-hint': true } }, addHint),
          canvases.length ? h('div', { role: 'radiogroup', 'aria-label': '目标画布', style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '38vh', overflow: 'auto' } }, canvases.map(canvas => h('button', { key: canvas.id, type: 'button', role: 'radio', 'aria-checked': canvasTargetId === canvas.id, onClick: () => setCanvasTargetId(canvas.id), style: { display: 'flex', alignItems: 'center', gap: 10, padding: 10, textAlign: 'left', border: `1px solid ${canvasTargetId === canvas.id ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1, #8884)'}`, borderRadius: 8, background: canvasTargetId === canvas.id ? 'color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)' : 'transparent', color: 'inherit', cursor: 'pointer' } }, h('span', { 'aria-hidden': true }, canvasTargetId === canvas.id ? '◉' : '○'), h('span', null, h('div', { style: { fontWeight: 600 } }, canvas.name), h('div', { style: S.mutedSmall }, `${canvas.card_count ?? 0} 张卡片`))))): h('div', { style: S.muted }, '目前没有可选画布，请先在分析画布页面创建一个画布。'),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 } }, h('button', { type: 'button', style: S.btn, onClick: () => setAddDialogOpen(false), disabled: busy }, '取消'), h('button', { type: 'button', style: S.btnPrimary, onClick: confirmAddToCanvas, disabled: busy || !canvasTargetId || !addReady }, busy ? '添加中…' : '确认添加')))) : null
      const focusTable = () => {
        const region = workspaceRef?.current?.querySelector?.('[data-xc-data-table-scroll]')
        if (region) region.focus()
      }
      return h(PageShell, {
        className: 'xc-ui xc-ds-page',
        data: { ref: workspaceRef },
      },
        h('style', null, XC_UI_CSS + DATASOURCE_UI_CSS),
        h('button', {
          type: 'button',
          'data-xc-skip-to-content': true,
          onClick: focusTable,
          onFocus: event => { event.currentTarget.style.left = '8px' },
          onBlur: event => { event.currentTarget.style.left = '-9999px' },
          style: { position: 'absolute', top: 6, left: -9999, zIndex: 30, ...S.btn, height: 26 },
        }, '跳到数据'),
        h(PageHeader, {
          data: { 'data-xc-datasource-header': 'true' },
          toggle: h('button', {
            type: 'button', className: 'hHd-Xa_iconButton hHd-Xa_toggle',
            'aria-label': sourcesCollapsed ? '展开数据源列表' : '收起数据源列表',
            'aria-expanded': sourcesCollapsed ? 'false' : 'true',
            'aria-keyshortcuts': 'Control+Alt+B',
            'data-xc-toggle-datasource-list': true,
            style: { ...S.btnIcon, flex: '0 0 auto', marginLeft: '-6px' },
            onClick: () => setSourcesCollapsed(value => !value),
            ...hoverable(),
          }, h(ToggleSidebarIcon, { size: 16 })),
          title: '数据源与分析',
          meta: headerMeta,
          actions: [
            !capabilities && !connectionError ? h('span', { role: 'status', style: S.headerMeta, 'data-xc-connecting': 'true' }, '正在连接…') : null,
            // The query actions belong to the page, not to a strip above the
            // table: with them in the header the content pane IS the table.
            detail && !detail.read_only && detail.kind !== 'database'
              ? h('button', { ref: runQueryRef, type: 'button', style: result ? S.btn : S.btnPrimary, 'data-xc-run-query': true, onClick: runQuery, disabled: busy || !selected || detail.deleted }, busy ? '查询中…' : '执行查询')
              : null,
            detail && !detail.read_only && detail.kind !== 'database'
              ? h(IconButton, {
                title: queryPaneOpen ? '收起查询设置' : '配置查询',
                onClick: () => setQueryPaneOpen(open => !open),
                buttonProps: { 'aria-expanded': queryPaneOpen ? 'true' : 'false', 'aria-controls': 'xc-ds-query-pane', 'data-xc-query-pane-toggle': true },
              }, h(ToolIcon, { name: 'settings' }))
              : null,
            detail && !detail.read_only && typeof onAskReference === 'function'
              ? h(IconButton, {
                title: '在对话中使用',
                onClick: () => { referenceSource() },
                buttonProps: { 'data-xc-reference-source': detail.id, disabled: busy },
              }, h(ToolIcon, { name: 'open' }))
              : null,
            detail ? h('span', { 'data-xc-toolbar-sep': 'query', style: S.toolbarSep }) : null,
            h(IconButton, { title: '刷新', onClick: refresh, buttonProps: { 'data-xc-refresh-datasources': 'true', disabled: busy } }, h(ToolIcon, { name: 'refresh' })),
          ],
        }),
        detail?.read_only ? h(StatusLine, { 'data-xc-source-version': true }, '计算时版本 · 只读') : null,
        h('div', { style: S.split, 'data-xc-split': true },
          h(SideList, {
            collapsed: sourcesCollapsed,
            title: '数据源',
            count: items.length,
            countData: { 'data-xc-list-count': 'true' },
            data: { 'data-xc-datasource-list': 'true' },
            tools: listNeedsSearch
              ? h('input', {
                type: 'search',
                value: listQuery,
                'aria-label': '搜索数据源',
                placeholder: '搜索数据源',
                'data-xc-list-search': 'true',
                onChange: event => setListQuery(event.target.value),
                style: { ...S.btn, flex: '1 1 auto', minWidth: 0, fontWeight: 'normal', height: '26px' },
              })
              : null,
            primaryAction: importControl,
            empty: listEmpty,
          }, listRows),
          h('div', { 'data-xc-data-detail': true, style: S.content }, detailView)),
        menuItem ? h(ContextMenu, {
          x: rowMenu.x, y: rowMenu.y, onClose: () => setRowMenu(null),
          items: [
            { id: 'rename', text: '重命名数据源', iconName: 'pencil', data: { 'data-xc-rename-datasource': menuItem.id }, onSelect: () => beginRename(menuItem) },
            { id: 'note', text: menuItem.note ? '编辑备注…' : '添加备注…', iconName: 'panel', data: { 'data-xc-datasource-note': menuItem.id }, onSelect: () => { setRowMenu(null); setNoteDialog({ id: menuItem.id, value: menuItem.note || '' }) } },
            typeof onAskReference === 'function'
              ? { id: 'reference', text: '在对话中使用', iconName: 'link', data: { 'data-xc-reference-datasource': menuItem.id }, onSelect: () => { onAskReference({ kind: 'ds', datasource_id: menuItem.id, version: menuItem.content_hash, name: menuItem.name, rows: menuItem.row_count }).catch(error => setError('引用到对话失败：' + error.message)) } }
              : null,
            { id: 'usage', text: '使用情况', iconName: 'search', data: { 'data-xc-usage-datasource': menuItem.id }, onSelect: () => { setRowMenu(null); setUsage(null); setUsageOpen(menuItem); loadUsage(menuItem.id) } },
            { separator: true },
            { id: 'delete', text: '删除数据源', iconName: 'trash', danger: true, data: { 'data-xc-delete-datasource': menuItem.id }, onSelect: () => deleteSource(menuItem) },
          ].filter(Boolean),
        }) : null,
        renderToasts(),
        noteDialog ? h(Dialog, { title: '数据源备注', onClose: () => setNoteDialog(null), closeLabel: '关闭' },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: S.mutedSmall }, '备注只保存在本机数据源上，随备份走，不参与查询。'),
            h('input', {
              type: 'text', value: noteDialog.value, 'data-xc-note-input': true, maxLength: 200,
              style: { ...S.btn, height: '30px', fontWeight: 'normal' },
              onChange: event => setNoteDialog(current => ({ ...current, value: event.target.value })),
            }),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
              h('button', { type: 'button', style: S.btn, onClick: () => setNoteDialog(null) }, '取消'),
              h('button', {
                type: 'button', style: S.btnPrimary, 'data-xc-note-save': true,
                onClick: async () => {
                  try {
                    await updateDatasourceNote(noteDialog.id, noteDialog.value.trim())
                    setNoteDialog(null); await refresh(); setNotice('备注已保存')
                  } catch (saveError) { setError('保存备注失败：' + saveError.message) }
                },
              }, '保存')))) : null,
        confirmState ? h(ConfirmDialog, {
          title: confirmState.title, tone: confirmState.tone, confirmLabel: confirmState.confirmLabel,
          cancelLabel: '取消', onConfirm: confirmState.onConfirm, onCancel: () => setConfirmState(null),
        }, confirmState.body ? h('div', { style: { lineHeight: 1.6 } }, confirmState.body) : null) : null,
        addDialog,
        usageDialog,
        sourceDialog ? h(AddSourceDialog, { t, onToast: pushToast, onClose: () => setSourceDialog(false), onSaved: async () => { setSourceDialog(false); await refresh(); setNotice(t('ds.imported')) } }) : null)
    }
