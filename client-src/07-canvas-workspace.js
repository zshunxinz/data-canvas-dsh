    // ── Workspace ───────────────────────────────────────────────────────────

    function CanvasWorkspace (props) {
      const t = makeT(props?.locale)
      const assetApi = useCallback((path, options) => localAssetApi(path, options, t), [t])

      const [canvases, setCanvases] = useState([])
      const [selectedId, setSelectedId] = useState(null)
      const [canvas, setCanvas] = useState(null)
      const [status, setStatus] = useState('loading') // loading | ready | error
      const [error, setError] = useState(null)
      // One status strip for every operation result (copy, delete, rename): a
      // single polite line that clears itself. Never a stack of toasts, never a
      // modal for something the undo stack already covers.
      const [notice, setNotice] = useState('')
      // Dialog state. Both are plain descriptors — the workspace owns the
      // wording and the action, the components own the chrome.
      const [confirmState, setConfirmState] = useState(null)
      const [promptState, setPromptState] = useState(null)
      // In-place naming: the card (or canvas row) whose title is currently an
      // input. Naming is the one action that must never cost a modal.
      const [renamingCardId, setRenamingCardId] = useState('')
      const [renamingCanvas, setRenamingCanvas] = useState(null) // { id, created }
      const creatingRef = useRef(false)
      const [sourceCard, setSourceCard] = useState(null)
      const [pendingDrafts, setPendingDrafts] = useState([])
      const [draftActionId, setDraftActionId] = useState(null)
      const [draftActionError, setDraftActionError] = useState('')
      const draftMutationRef = useRef(0)
      const [saveState, setSaveState] = useState('idle') // idle | saving | saved | failed
      const [addingExample, setAddingExample] = useState(false)
      const [boardWidth, setBoardWidth] = useState(760)
      // Measured header width. `null` means "not measured yet", which keeps the
      // full toolbar rendered — the collapse only ever follows a real
      // measurement, never a guess.
      const [toolbarWidth, setToolbarWidth] = useState(null)
      const [menu, setMenu] = useState(null)          // { x, y, items }
      const [listCollapsed, setListCollapsed] = useState(false)
      const [listQuery, setListQuery] = useState('')
      const [settingsOpen, setSettingsOpen] = useState(false)
      // Recent updates ride in the settings dialog: one muted version line plus one button.
      const changelog = useChangelog(3)
      const [focusId, setFocusId] = useState(null)
      const [searchOpen, setSearchOpen] = useState(false)
      const [searchQuery, setSearchQuery] = useState('')
      const [zoom, setZoom] = useState(1)
      const [exporting, setExporting] = useState(false)
      const [appearanceVersion, setAppearanceVersion] = useState(0)
      const [groupPreview, setGroupPreview] = useState(null)
      const [templatesOpen, setTemplatesOpen] = useState(false)
      const [templates, setTemplates] = useState([])
      const [templatePreview, setTemplatePreview] = useState(null)
      const [templateBusy, setTemplateBusy] = useState(false)
      const templateLock = useRef(false)
      const importLock = useRef(false)
      const [outsideCards, setOutsideCards] = useState([])
      const [draftFeedback, setDraftFeedback] = useState({})
      const [draftFeedbackNotice, setDraftFeedbackNotice] = useState('')
      const requestDraftRevision = async draft => {
        const feedback = String(draftFeedback[draft.id] || '').trim()
        if (!feedback) { setDraftFeedbackNotice('请先填写修改意见。'); return }
        const prompt = `请为画布「${draft.canvas_name}」（${draft.canvas_id}）重新生成「${draft.card?.title}」的待确认预览。${draft.operation === 'update' ? `请用 canvas_update_card 更新已有卡片 ${draft.card.id}。` : '请用 canvas_add_card 新增卡片。'}修改意见：${feedback}。请先读取最新画布版本，再生成新预览。`
        try {
          await navigator.clipboard.writeText(prompt)
          const cancelled = await onDraftAction(draft, 'cancel')
          setDraftFeedbackNotice(cancelled ? '修改请求已复制，请粘贴到对话发送以生成新预览；旧预览已取消。' : '修改请求已复制；旧预览取消失败，请先处理下方错误后重试。')
        } catch (error) { setDraftFeedbackNotice('复制修改请求失败，请手动将修改意见发送到对话：' + error.message) }
      }
      const workspaceRef = useRef(null)
      const backupInputRef = useRef(null)
      const settings = { snap: false, wide: false, badges: false, ...canvas?.settings }
      const colBound = settings.wide ? EXTENT_COLS_CEIL : COLS
      const visibleCards = (canvas?.cards || []).map(card => groupPreview?.[card.id] ? { ...card, layout: groupPreview[card.id] } : card)
      const contentCols = Math.min(EXTENT_COLS_CEIL, Math.max(COLS, ...visibleCards.map(c => c.layout.x + c.layout.w)) + (settings.wide ? COLS : 0))
      const contentHeight = Math.max(240, maxRow(visibleCards) * 22 + 20)
      // Alignment guides for the card being dragged: grid-unit positions drawn
      // as absolute lines across the board (phase 3). One drag feeds these at a
      // time; null clears the overlay.
      const [snapLines, setSnapLines] = useState(null)
      // Multi-select: ids of the selected cards + the live marquee rectangle
      // (pixels, board-relative) while a rubber-band drag is active.
      const [selection, setSelection] = useState(() => new Set())
      const [marquee, setMarquee] = useState(null)
      // Chart theme: { palette: 'classic'|… }. The chrome always follows the
      // host's own light/dark decision (user request: 浅色/深色两档 Remove —
      // the fixed variants drifted from the real shell colours).
      const [theme, setThemeState] = useState(() => normalizeTheme(null))
      const boardRef = useRef(null)
      const boardInnerRef = useRef(null)
      // The right-hand pane: its width is stable regardless of how the header
      // folds, so it is what the header measures itself against. Measuring the
      // header itself would feed back into its own collapse decision.
      const headerRef = useRef(null)
      const rowPitch = 22
      const closeSettings = useCallback(() => setSettingsOpen(false), [])
      const closeFocus = useCallback(() => setFocusId(null), [])
      const closeSearch = useCallback(() => setSearchOpen(false), [])
      const closeTemplates = useCallback(() => setTemplatesOpen(false), [])
      const toggleSelection = useCallback(id => setSelection(previous => {
        const next = new Set(previous)
        if (next.has(id)) next.delete(id); else next.add(id)
        return next
      }), [])
      useEffect(() => { setFocusId(null); setSearchOpen(false); setSettingsOpen(false); setZoom(1); setGroupPreview(null) }, [canvas?.id])
      useEffect(() => { if (!settings.snap) setSnapLines(null) }, [settings.snap])
      useEffect(() => {
        if (typeof MutationObserver !== 'function' || !document.documentElement) return
        const observer = new MutationObserver(() => setAppearanceVersion(value => value + 1))
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-theme-source', 'style', 'class'] })
        return () => observer.disconnect()
      }, [])
      useEffect(() => {
        const available = new Set((canvas?.cards || []).map(c => c.id))
        setSelection(previous => [...previous].some(id => !available.has(id)) ? new Set([...previous].filter(id => available.has(id))) : previous)
      }, [canvas?.cards])
      // A status line is feedback, not a log: it retires itself.
      useEffect(() => {
        if (!notice || typeof setTimeout !== 'function') return
        const timer = setTimeout(() => setNotice(''), 8000)
        return () => clearTimeout(timer)
      }, [notice])

      // The theme resolves on every render of the workspace: the chrome always
      // follows the host's own light/dark decision, and the --dsw-* tokens are
      // read from the mounted board (or its ancestors) because the shell defines
      // them on deep wrappers, not :root. Before the board mounts the resolver
      // falls back to :root/body and the light defaults — fine for the loading
      // frame. This hook sits with the others BEFORE any conditional return:
      // hook order must not vary between renders (React #310).
      const themeObj = useMemo(
        () => resolveTheme(theme.palette, boardRef.current),
        [theme, canvas, appearanceVersion],
      )

      const reloadList = useCallback(async () => {
        const res = await listCanvases()
        setCanvases(res.canvases || [])
        return res.canvases || []
      }, [])

      const loadCanvas = useCallback(async id => {
        const data = await getCanvas(id)
        setCanvas(data)
        // Adopt the canvas's persisted theme choice.
        if (data?.theme) setThemeState(normalizeTheme(data.theme))
        return data
      }, [])

      const loadPendingDrafts = useCallback(async epoch => {
        const result = await api('/drafts')
        const drafts = Array.isArray(result.drafts) ? result.drafts : []
        if (epoch === undefined || epoch === draftMutationRef.current) setPendingDrafts(drafts)
        return drafts
      }, [])

      const onDraftAction = useCallback(async (draft, action) => {
        if (draftActionId !== null) return
        draftMutationRef.current++
        setDraftActionId(draft.id)
        setDraftActionError('')
        try {
          await api(`/drafts/${encodeURIComponent(draft.id)}/${action}`, { method: 'POST', body: '{}' })
          const epoch = ++draftMutationRef.current
          await loadPendingDrafts(epoch)
          if (action === 'confirm') {
            await reloadList()
            if (canvas?.id === draft.canvas_id) {
              const fresh = await loadCanvas(draft.canvas_id)
              revisionRef.current = fresh.revision
            }
          }
          return true
        } catch (error) {
          setDraftActionError(error?.payload?.code === 'REVISION_CONFLICT'
            ? '画布已发生变化，此预览尚未写入。请取消旧预览，并在对话中要求读取最新版本后重新生成。'
            : error?.payload?.code === 'DRAFT_NOT_FOUND'
              ? '预览已过期或插件已重启，请在对话中重新生成预览。'
              : error?.message || String(error))
          return false
        } finally {
          draftMutationRef.current++
          setDraftActionId(null)
        }
      }, [draftActionId, loadPendingDrafts, reloadList, canvas?.id, loadCanvas])

      // The model-side tool creates drafts while this workspace is already open.
      // Poll the read-only preview endpoint so only a rendered user button can
      // reach the confirm route. Draft IDs are never returned by canvas tools.
      useEffect(() => {
        let disposed = false
        let inFlight = false
        let refreshQueued = false
        const refresh = async () => {
          if (disposed) return
          if (inFlight) { refreshQueued = true; return }
          inFlight = true
          const epoch = draftMutationRef.current
          try {
            const result = await api('/drafts')
            if (!disposed && epoch === draftMutationRef.current) {
              // Replace the snapshot, never merge it: the server omits superseded drafts.
              setPendingDrafts(Array.isArray(result.drafts) ? result.drafts : [])
            }
          } catch { /* a transient preview-list failure must not break the canvas */ }
          finally {
            inFlight = false
            if (refreshQueued && !disposed) { refreshQueued = false; refresh() }
          }
        }
        refresh()
        const timer = typeof setInterval === 'function' ? setInterval(refresh, 1000) : null
        return () => { disposed = true; if (timer !== null) clearInterval(timer) }
      }, [])

      // Initial load, including navigation from a datasource result.
      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const list = await reloadList()
            if (cancelled) return
            if (props?.preferredCanvasId) {
              if (!list.some(item => item.id === props.preferredCanvasId)) throw new Error('目标画布已不存在，请刷新画布列表。')
              setSelectedId(props.preferredCanvasId)
              await loadCanvas(props.preferredCanvasId)
            } else if (list.length > 0) {
              setSelectedId(list[0].id)
              await loadCanvas(list[0].id)
            } else {
              setSelectedId(null)
            }
            if (!cancelled) setStatus('ready')
          } catch (e) {
            if (!cancelled) {
              setError(e.message)
              setStatus('error')
            }
          }
        })()
        return () => { cancelled = true }
      }, [reloadList, loadCanvas, props?.preferredCanvasId])

      // Track the board width so grid → pixel geometry stays correct on resize
      useEffect(() => {
        const measure = () => {
          const el = boardRef.current
          if (!el) return
          setBoardWidth(Math.max(160, el.clientWidth - 16))
        }
        measure()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (boardRef.current) observer?.observe(boardRef.current)
        window.addEventListener('resize', measure)
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
      }, [canvas?.id, listCollapsed])

      // Track the header width so the single-line toolbar can decide which
      // secondary actions fold into the ⋯ menu. Measured on the pane, not the
      // header: the header's own width changes as it folds, which would make the
      // decision oscillate. A missing ResizeObserver leaves toolbarWidth null,
      // and `planToolbar(Infinity)` keeps every control inline.
      useEffect(() => {
        const el = headerRef.current
        if (!el) return
        const measure = () => setToolbarWidth(el.clientWidth || null)
        measure()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        observer?.observe(el)
        window.addEventListener('resize', measure)
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
      }, [canvas?.id, listCollapsed])

      // The revision a commit should state.
      //
      // `canvas.revision` from the closure is a SNAPSHOT taken when the callback
      // was created. Two drags in quick succession therefore both sent the same
      // "expected" value: the first bumped the canvas to 83, the second still
      // claimed 82 and the server refused it with
      //   canvas revision conflict: expected 82, found 83
      // A ref always holds the newest revision the client has seen, so a commit
      // reflects the current state instead of a stale render.
      const revisionRef = useRef(0)
      useEffect(() => {
        if (canvas && typeof canvas.revision === 'number') revisionRef.current = canvas.revision
      }, [canvas])
      // Serialises commits so a queued layout write cannot start before the
      // previous one has been acknowledged and the revision updated.
      const commitChain = useRef(Promise.resolve())

      const onSelect = useCallback(async id => {
        setSelectedId(id)
        setSaveState('idle')
        try {
          await loadCanvas(id)
        } catch (e) {
          setError(e.message)
          setStatus('error')
        }
      }, [loadCanvas])

      const commitLayout = useCallback(async layout => {
        if (!canvas) return
        const canvasId = canvas.id
        const layoutMap = layout.groupLayouts || { [layout.cardId]: layout.rect }
        const save = revision => layout.groupLayouts
          ? batchCards(canvasId, { operation: 'layout', card_ids: Object.keys(layoutMap), layouts: layoutMap }, revision)
          : saveLayout(canvasId, layoutMap, revision)

        // Queue behind any in-flight commit. Two rapid drags both used to fire at
        // once, so the second carried a revision the first had already consumed.
        const run = async () => {
          setSaveState('saving')
          try {
            await save(revisionRef.current)
            const fresh = await loadCanvas(canvasId)
            if (typeof fresh?.revision === 'number') revisionRef.current = fresh.revision
            setSaveState('saved')
            await reloadList()
          } catch (e) {
            // A 409 here is not a user error: it means another write landed
            // between our read and our write (a queued drag, or the agent
            // editing the same canvas). Re-read and retry once against the
            // authoritative revision rather than showing a red box.
            if (e?.payload?.code === 'REVISION_CONFLICT') {
              try {
                const fresh = await loadCanvas(canvasId)
                if (typeof fresh?.revision === 'number') revisionRef.current = fresh.revision
                await save(revisionRef.current)
                const settled = await loadCanvas(canvasId)
                if (typeof settled?.revision === 'number') revisionRef.current = settled.revision
                setSaveState('saved')
                await reloadList()
                return
              } catch (retryError) {
                setSaveState('failed')
                setError(retryError.message)
                return
              }
            }
            setSaveState('failed')
            setError(e.message)
            try { await loadCanvas(canvasId) } catch { /* keep the old view */ }
          }
        }

        commitChain.current = commitChain.current.then(run, run).finally(() => setGroupPreview(null))
        return commitChain.current
      }, [canvas, loadCanvas, reloadList])

      // NOTE: the dependency array must not name this callback itself. A `const`
      // arrow is in its temporal dead zone while `useCallback` reads the array,
      // so a self-reference throws "Cannot access 'onCreate' before
      // initialization" and takes the whole slot entry down with it (the panel
      // rendered blank because of exactly that).
      // Creating is in-place: the canvas is made with a placeholder name and its
      // row opens as an input (see the list pane). No modal and no focus
      // round-trip — and Escape removes the empty canvas it just made, which is
      // the only way "cancel" can mean "as if I never asked".
      const onCreate = useCallback(async () => {
        if (creatingRef.current) return
        creatingRef.current = true
        try {
          const created = await createCanvas(t('canvas.untitled'))
          await reloadList()
          await onSelect(created.canvas_id)
          setRenamingCanvas({ id: created.canvas_id, created: true })
        } catch (e) {
          setError(e.message)
        } finally { creatingRef.current = false }
      }, [onSelect, reloadList, t])

      const commitCanvasRename = useCallback(async (id, name) => {
        setRenamingCanvas(null)
        const title = String(name ?? '').trim()
        const target = canvases.find(c => c.id === id)
        if (!title || title === target?.name) return
        try {
          // Only the canvas on screen has a revision this client can vouch for;
          // renaming another row states no expectation rather than a stale one.
          await renameCanvas(id, title, canvas?.id === id ? revisionRef.current : null)
          const list = await reloadList()
          if (canvas?.id === id) {
            const fresh = await loadCanvas(id)
            if (typeof fresh?.revision === 'number') revisionRef.current = fresh.revision
          } else if (!list.some(item => item.id === selectedId)) {
            setSelectedId(list[0]?.id ?? null)
          }
          setNotice(t('canvas.renamedCanvas'))
        } catch (e) { setError(e.message) }
      }, [canvases, canvas?.id, selectedId, reloadList, loadCanvas, t])

      const cancelCanvasRename = useCallback(async () => {
        const pending = renamingCanvas
        setRenamingCanvas(null)
        if (!pending?.created) return
        try {
          await deleteCanvas(pending.id)
          const list = await reloadList()
          if (list.length > 0) await onSelect(list[0].id)
          else { setCanvas(null); setSelectedId(null) }
        } catch (e) { setError(e.message) }
      }, [renamingCanvas, reloadList, onSelect])

      const onCreateExample = useCallback(async () => {
        if (addingExample) return
        setAddingExample(true)
        setSaveState('saving')
        setError(null)
        try {
          const created = await createExampleCanvas(t)
          await reloadList()
          await onSelect(created.canvas_id)
          setSaveState('saved')
        } catch (e) {
          setSaveState('failed')
          setError(e.message)
        } finally {
          setAddingExample(false)
        }
      }, [reloadList, onSelect, addingExample, t])

      const removeCanvas = useCallback(async id => {
        try {
          await deleteCanvas(id)
          const list = await reloadList()
          if (list.length > 0) await onSelect(list[0].id)
          else { setCanvas(null); setSelectedId(null) }
        } catch (e) {
          setError(e.message)
        }
      }, [onSelect, reloadList])

      // Deleting a whole canvas is the one removal with no undo behind it, so it
      // is also the one that asks first.
      const onDelete = useCallback(id => {
        setConfirmState({
          title: t('canvas.deleteCanvas'),
          tone: 'danger',
          confirmLabel: t('canvas.delete'),
          body: t('canvas.deleteConfirm'),
          onConfirm: () => { setConfirmState(null); removeCanvas(id) },
        })
      }, [removeCanvas, t])

      /**
       * Run a canvas mutation against the CURRENT revision.
       *
       * Every mutation used to pass `canvas.revision` straight from the closure,
       * which is the value captured when the callback was created — not the
       * value on the server now. Any second action before a re-render sent a
       * stale revision and came back as
       *   canvas revision conflict: expected 82, found 83
       * Reads `revisionRef` instead, and on a 409 refreshes and retries once so
       * a benign race does not surface as an error.
       *
       * @param {(revision: number) => Promise<any>} action
       */
      const withCurrentRevision = useCallback(action => {
        const run = async () => {
          const canvasId = canvas?.id
          if (!canvasId) return
          try {
            const result = await action(revisionRef.current)
            const fresh = await loadCanvas(canvasId)
            if (typeof fresh?.revision === 'number') revisionRef.current = fresh.revision
            return result
          } catch (e) {
            if (e?.payload?.code !== 'REVISION_CONFLICT') throw e
            const fresh = await loadCanvas(canvasId)
            if (typeof fresh?.revision === 'number') revisionRef.current = fresh.revision
            const result = await action(revisionRef.current)
            const settled = await loadCanvas(canvasId)
            if (typeof settled?.revision === 'number') revisionRef.current = settled.revision
            return result
          }
        }
        const pending = commitChain.current.then(run, run)
        commitChain.current = pending.catch(() => {})
        return pending
      }, [canvas, loadCanvas])

      // History actions share the revision-aware helper so a queued drag does
      // not race them. Nothing-to-undo is a normal click, not an error box.
      const onUndo = useCallback(async () => {
        if (!canvas) return
        setSaveState('saving')
        try {
          await withCurrentRevision(rev => undoCanvas(canvas.id, rev))
          setSaveState('saved')
        } catch (e) {
          setSaveState('failed')
          // Expected no-op: tell the user gently instead of a red box.
          setError(e?.payload?.code === 'NOTHING_TO_UNDO' ? t('canvas.nothingToUndo') : e.message)
        }
      }, [canvas, withCurrentRevision, t])

      const onRedo = useCallback(async () => {
        if (!canvas) return
        setSaveState('saving')
        try {
          await withCurrentRevision(rev => redoCanvas(canvas.id, rev))
          setSaveState('saved')
        } catch (e) {
          setSaveState('failed')
          setError(e?.payload?.code === 'NOTHING_TO_REDO' ? t('canvas.nothingToRedo') : e.message)
        }
      }, [canvas, withCurrentRevision, t])

      // Undo/redo keyboard shortcuts. Guarded to the workspace being ready and
      // no text field focused — Ctrl+Z inside a rename input must keep its
      // native text-editing meaning. Declared after onUndo/onRedo: the effect
      // body reads them, so a TDZ reference would crash the workspace render
      // (the same class of bug the render stand-in exists to catch).
      useEffect(() => {
        const onKey = event => {
          if (status !== 'ready' || !canvas) return
          if (settingsOpen || focusId || searchOpen || templatesOpen || !workspaceRef.current?.contains?.(document.activeElement)) return
          const ctrl = event.ctrlKey || event.metaKey
          const key = event.key.toLowerCase()
          // The list toggle advertises Ctrl+Alt+B in `aria-keyshortcuts`, so it
          // has to work: a declared shortcut that does nothing misleads exactly
          // the users who rely on being told about it.
          if (event.altKey && !ctrl && !event.shiftKey && key === 'b') {
            event.preventDefault()
            setListCollapsed(value => !value)
            return
          }
          if (!ctrl) return
          if (key !== 'z' && key !== 'y') return
          const tag = document.activeElement?.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return
          const shift = event.shiftKey
          if (key === 'z' && !shift) { event.preventDefault(); onUndo() }
          else if ((key === 'z' && shift) || key === 'y') { event.preventDefault(); onRedo() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [status, canvas, onUndo, onRedo, settingsOpen, focusId, searchOpen, templatesOpen])

      const runExportBackup = useCallback(async () => {
        if (!canvas || exporting) return
        setExporting(true)
        setError(null)
        try {
          await commitChain.current
          const backup = await assetApi(`/canvases/${canvas.id}/backup`)
          const latest = backup.canvas
          const content = JSON.stringify(backup, null, 2)
          if (new Blob([content]).size > 8 * 1024 * 1024) {
            setError(t('canvas.backupExportTooLarge'))
            return
          }
          const safeName = String(latest.name || 'canvas').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
          downloadArtifact({
            name: `xcharts-canvas-backup-${safeName}.json`,
            content,
            type: 'application/json;charset=utf-8',
          })
        } catch (e) {
          setError(`${t('canvas.exportFailed')}: ${e.message}`)
        } finally {
          setExporting(false)
        }
      }, [canvas, exporting, t, assetApi])

      // Writing a file the user then has to keep safe, and reading one into this
      // store, are both irreversible from here — the two confirms that survive.
      const onExportBackup = useCallback(() => {
        if (!canvas || exporting) return
        setConfirmState({
          title: t('canvas.backupExport'),
          confirmLabel: t('canvas.export'),
          body: t('canvas.backupExportConfirm'),
          onConfirm: () => { setConfirmState(null); runExportBackup() },
        })
      }, [canvas, exporting, runExportBackup, t])

      const runImportBackup = useCallback(async file => {
        if (importLock.current) return
        importLock.current = true
        setError(null)
        try {
          if (file.size > 8 * 1024 * 1024) throw new Error(t('canvas.backupTooLarge'))
          const backup = JSON.parse(await file.text())
          const result = await importCanvasBackup(backup, t)
          await reloadList()
          await onSelect(result.canvas_id)
        } catch (e) {
          setError(`${t('canvas.backupImportFailed')}: ${e.message}`)
        } finally { importLock.current = false }
      }, [onSelect, reloadList, t])

      const onImportBackupFile = useCallback(event => {
        const input = event.currentTarget
        const file = input.files?.[0]
        input.value = ''
        if (!file || importLock.current) return
        setConfirmState({
          title: t('canvas.backupImport'),
          confirmLabel: t('canvas.backupImport'),
          body: t('canvas.backupImportConfirm'),
          onConfirm: () => { setConfirmState(null); runImportBackup(file) },
        })
      }, [runImportBackup, t])
      const openBackupPicker = useCallback(() => backupInputRef.current?.click(), [])
      const refreshTemplates = useCallback(async () => {
        const result = await assetApi('/canvases/templates')
        setTemplates(result.templates)
      }, [assetApi])
      const templateAction = useCallback(async action => {
        if (templateLock.current) return
        templateLock.current = true
        setTemplateBusy(true); setError(null)
        try { await action() } catch (error) { setError(error.message) }
        finally { templateLock.current = false; setTemplateBusy(false) }
      }, [])
      const openTemplates = useCallback(() => {
        setTemplatesOpen(true); setTemplatePreview(null)
        return templateAction(refreshTemplates)
      }, [templateAction, refreshTemplates])
      const saveTemplate = useCallback(() => {
        setPromptState({
          title: t('canvas.saveTemplate'), submitLabel: t('canvas.save'),
          defaultValue: '', placeholder: t('canvas.templateName'),
          onSubmit: name => { setPromptState(null); return templateAction(async () => {
            await commitChain.current
            await assetApi('/canvases/templates', { method: 'POST', body: JSON.stringify({ canvas_id: canvas.id, name }) })
            await refreshTemplates()
          }) },
        })
      }, [canvas, templateAction, refreshTemplates, t, assetApi])
      const previewTemplate = useCallback(id => templateAction(async () => {
        setTemplatePreview(await assetApi(`/canvases/templates/preview/${id}`))
      }), [templateAction, assetApi])
      const cloneTemplate = useCallback(() => {
        if (!templatePreview) return
        setPromptState({
          title: t('canvas.templateClone'), submitLabel: t('canvas.create'),
          defaultValue: templatePreview.name,
          onSubmit: name => { setPromptState(null); return templateAction(async () => {
            const result = await assetApi(`/canvases/templates/clone/${templatePreview.id}`, { method: 'POST', body: JSON.stringify({ name }) })
            await reloadList(); await onSelect(result.canvas_id); setTemplatesOpen(false)
          }) },
        })
      }, [templatePreview, templateAction, onSelect, reloadList, t, assetApi])
      const deleteTemplate = useCallback(() => {
        if (!templatePreview) return
        setConfirmState({
          title: t('canvas.templateDelete'), tone: 'danger', confirmLabel: t('canvas.delete'),
          body: t('canvas.templateDeleteConfirm'),
          onConfirm: () => { setConfirmState(null); return templateAction(async () => {
            await assetApi(`/canvases/templates/delete/${templatePreview.id}`, { method: 'DELETE' })
            setTemplatePreview(null); await refreshTemplates()
          }) },
        })
      }, [templatePreview, templateAction, refreshTemplates, t, assetApi])
      const renameTemplate = useCallback(() => {
        if (!templatePreview) return
        setPromptState({
          title: t('card.rename'), submitLabel: t('canvas.save'),
          defaultValue: templatePreview.name || '',
          onSubmit: name => { setPromptState(null); return templateAction(async () => {
            setTemplatePreview(await assetApi(`/canvases/templates/rename/${templatePreview.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }))
            await refreshTemplates()
          }) },
        })
      }, [templatePreview, templateAction, refreshTemplates, t, assetApi])
      const backupPicker = h('input', {
        ref: backupInputRef,
        type: 'file',
        accept: 'application/json,.json',
        'aria-label': t('canvas.backupImport'),
        style: { display: 'none' },
        onChange: onImportBackupFile,
      })

      const onExport = useCallback(async format => {
        if (!canvas || exporting) return
        setExporting(true)
        setError(null)
        try {
          const artifacts = await exportArtifacts(canvas, themeObj, format === 'html' ? 'html' : 'png', boardWidth)
          for (const artifact of artifacts) downloadArtifact(artifact)
        } catch (e) {
          setError(`${t('canvas.exportFailed')}: ${e.message}`)
        } finally { setExporting(false) }
      }, [canvas, t, themeObj, exporting, boardWidth])

      const onArrange = useCallback(async () => {
        if (!canvas) return
        setSaveState('saving')
        try {
          await withCurrentRevision(rev => arrange(canvas.id, rev))
          setSaveState('saved')
        } catch (e) {
          setSaveState('failed')
          setError(e.message)
        }
      }, [canvas, withCurrentRevision])

      // ── card operations behind the context menu ──

      const withSaving = useCallback(async action => {
        setSaveState('saving')
        try {
          await withCurrentRevision(action)
          setSaveState('saved')
          await reloadList()
          return true
        } catch (e) {
          setSaveState('failed')
          setError(e.message)
          return false
        }
      }, [withCurrentRevision, reloadList])

      const setTheme = useCallback(next => {
        return withSaving(rev => api(`/canvases/${canvas.id}`, { method: 'PATCH', body: JSON.stringify({ theme: next, expected_revision: rev }) }))
      }, [canvas, withSaving])

      // Renaming happens in the card's own header (see Card): this only receives
      // the committed value. No prompt, no modal, no focus round-trip.
      const onRenameCard = useCallback((card, next) => {
        setRenamingCardId('')
        const title = String(next ?? '').trim()
        if (!title || title === card.title) return
        withSaving(rev => renameCard(canvas.id, card.id, title, rev))
      }, [canvas, withSaving])
      const startRenameCard = useCallback(id => setRenamingCardId(id), [])
      const cancelRenameCard = useCallback(() => setRenamingCardId(''), [])

      const onDuplicateCard = useCallback(card => {
        withSaving(rev => duplicateCard(canvas.id, card.id, rev))
      }, [canvas, withSaving])

      // Deleting a card is undoable (one Ctrl+Z restores a whole batch), so it
      // does not ask — it reports, and names the way back.
      const onDeleteCard = useCallback(async card => {
        if (await withSaving(rev => deleteCard(canvas.id, card.id, rev))) {
          setNotice(t('canvas.deletedCards').replace('{n}', '1'))
        }
      }, [canvas, withSaving, t])

      const onToggleHeader = useCallback(card => {
        const next = card.show_header === false
        withSaving(rev => setCardHeader(canvas.id, card.id, next, rev))
      }, [canvas, withSaving])

      const onCopySource = useCallback(async card => {
        const source = card.source || {}
        const text = [source.dataset && `dataset: ${source.dataset}`, source.query && `query: ${source.query}`, source.note && `note: ${source.note}`]
          .filter(Boolean).join('\n')
        if (!text) return
        setNotice('')
        try {
          if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
            throw new Error('Clipboard API unavailable')
          }
          await navigator.clipboard.writeText(text)
          setNotice(t('card.copySourceSuccess'))
        } catch {
          setNotice(t('card.copySourceFailed'))
        }
      }, [t])

      const changeSetting = useCallback((name, value) => {
        setSnapLines(null)
        return withSaving(rev => patchSettings(canvas.id, { [name]: value }, rev))
      }, [canvas, withSaving])
      const onAlign = useCallback(mode => {
        try {
          const chosen = canvas.cards.filter(c => selection.has(c.id))
          const layouts = alignGroup(chosen, mode)
          return withSaving(rev => batchCards(canvas.id, { operation: 'layout', card_ids: chosen.map(c => c.id), layouts }, rev))
        } catch (error) { setError(error.message) }
      }, [canvas, selection, withSaving])
      const fitAll = useCallback(() => {
        if (!canvas?.cards.length || !boardRef.current) { setZoom(1); return }
        const maxX = Math.max(...canvas.cards.map(c => c.layout.x + c.layout.w))
        const width = maxX * boardWidth / COLS + 20
        const height = maxRow(canvas.cards) * rowPitch + 20
        setZoom(Math.min(1, Math.max(1, boardRef.current.clientWidth - 16) / width, Math.max(1, boardRef.current.clientHeight - 16) / height))
      }, [canvas, boardWidth])
      useEffect(() => {
        const id = props.preferredCardId
        if (!id || !canvas || canvas.id !== props.preferredCanvasId) return
        if (!canvas.cards.some(card => card.id === id)) { setError('目标卡片已不存在'); return }
        if (props.preferredVersionId) setSourceCard({ id, traceVersionId: props.preferredVersionId })
        const frame = requestAnimationFrame(() => boardInnerRef.current?.querySelector?.(`[data-xc-card="${id}"]`)?.scrollIntoView?.({ block: 'center', inline: 'center' }))
        return () => cancelAnimationFrame(frame)
      }, [canvas?.id, props.preferredCanvasId, props.preferredCardId, props.preferredVersionId])
      const locateCard = useCallback(id => {
        setSearchOpen(false)
        setSelection(new Set([id]))
        requestAnimationFrame(() => boardInnerRef.current?.querySelector?.(`[data-xc-card="${id}"]`)?.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'smooth' }))
      }, [])
      useEffect(() => {
        const el = boardRef.current
        if (!settings.wide || !el || !canvas) { setOutsideCards([]); return }
        let frame = 0
        const update = () => {
          const left = (el.scrollLeft || 0) / zoom, top = (el.scrollTop || 0) / zoom
          const right = left + (el.clientWidth - 16) / zoom, bottom = top + (el.clientHeight - 16) / zoom
          setOutsideCards(canvas.cards.filter(card => {
            const g = geometry(card.layout, boardWidth, rowPitch)
            return g.left + g.width <= left || g.left >= right || g.top + g.height <= top || g.top >= bottom
          }).map(card => {
            const g = geometry(card.layout, boardWidth, rowPitch)
            return { id: card.id, title: card.title, direction: `${g.left >= right ? '→' : g.left + g.width <= left ? '←' : ''}${g.top >= bottom ? '↓' : g.top + g.height <= top ? '↑' : ''}` }
          }))
        }
        const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update() }) }
        update(); el.addEventListener('scroll', schedule); window.addEventListener('resize', schedule)
        return () => { if (frame) cancelAnimationFrame(frame); el.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule) }
      }, [canvas, settings.wide, boardWidth, zoom])

      /**
       * Build the menu for one card. Order follows the project-wide rule:
       * view → content → group → danger last in its own group (a double-click on
       * the header no longer routes here — it edits the title in place).
       */
      const openCardMenu = useCallback((event, card) => {
        const x = event.clientX ?? 0
        const y = event.clientY ?? 0
        const source = card.source || {}
        const items = [
          { id: 'focus', text: t('canvas.focus'), iconName: 'expand', onSelect: () => setFocusId(card.id) },
          { id: 'rename', text: t('card.rename'), iconName: 'pencil', onSelect: () => startRenameCard(card.id) },
          { id: 'duplicate', text: t('card.duplicate'), iconName: 'copy', onSelect: () => onDuplicateCard(card) },
          { separator: true },
          {
            id: 'source-details',
            text: '溯源',
            iconName: 'link',
            data: { 'data-xc-source-menu': card.id },
            onSelect: () => setSourceCard(card),
          },
          {
            id: 'ask-card', text: '追问', iconName: 'open',
            disabled: typeof props.onAsk !== 'function',
            onSelect: () => props.onAsk({ canvas_id: canvas.id, card_id: card.id, version_id: card.data_version_id, title: card.title }).catch(error => setError(error.message)),
          },
          {
            id: 'toggle-header',
            text: card.show_header === false ? t('card.showHeader') : t('card.hideHeader'),
            iconName: 'panel',
            onSelect: () => onToggleHeader(card),
          },
          { separator: true },
          { id: 'delete', text: t('card.delete'), iconName: 'trash', danger: true, onSelect: () => onDeleteCard(card) },
        ].filter(item => !item.disabled || item.separator)

        setMenu({ x, y, items })
      }, [t, startRenameCard, onDuplicateCard, onDeleteCard, onToggleHeader, canvas, props.onAsk])

      const closeMenu = useCallback(() => setMenu(null), [])
      const closeSourceDialog = useCallback(() => setSourceCard(null), [])

      // ── Multi-select rubber band ──────────────────────────────────────────
      //
      // Pressing empty board space starts a marquee; cards whose boxes intersect
      // the final rectangle join the selection. Ignore presses inside cards,
      // including their bodies (only drag handles stop propagation).
      // Hooks live before the conditional returns below: React #310 fires when
      // the hook count varies between renders (loading frame has no canvas).
      const marqueeRef = useRef(null)
      useEffect(() => {
        setSelection(new Set())
        setMarquee(null)
        return () => {
          marqueeRef.current?.cleanup()
          marqueeRef.current = null
        }
      }, [canvas?.id, status])
      const onBoardPointerDown = useCallback(event => {
        if (event.button !== 0 || !canvas || event.target?.closest?.('[data-xc-card]')) return
        const el = boardInnerRef.current
        if (!el) return
        marqueeRef.current?.cleanup()
        // The inner board is the cards' coordinate space. Its live bounds
        // include padding and scrolling, unlike the scroll container's bounds.
        const point = e => {
          const rect = el.getBoundingClientRect()
          return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom }
        }
        const origin = point(event)
        const initialRect = { left: origin.x, top: origin.y, width: 0, height: 0 }
        marqueeRef.current = { origin, rect: initialRect, cleanup: () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onCancel)
        } }
        // A fresh rubber band always starts a new selection.
        setSelection(new Set())
        setMarquee(initialRect)

        const onMove = moveEvent => {
          const state = marqueeRef.current
          if (!state) return
          const { x, y } = point(moveEvent)
          state.rect = {
            left: Math.min(origin.x, x),
            top: Math.min(origin.y, y),
            width: Math.abs(x - origin.x),
            height: Math.abs(y - origin.y),
          }
          setMarquee(state.rect)
        }

        const onUp = () => {
          const state = marqueeRef.current
          state?.cleanup()
          marqueeRef.current = null
          setMarquee(null)
          if (!state || state.rect.width < 4 || state.rect.height < 4) return
          // Intersect the final marquee (pixels) with card boxes (grid → pixels).
          const box = state.rect
          const hits = new Set()
          for (const card of canvas.cards) {
            const cardBox = geometry(card.layout, boardWidth, rowPitch)
            const intersects = box.left < cardBox.left + cardBox.width
              && box.left + box.width > cardBox.left
              && box.top < cardBox.top + cardBox.height
              && box.top + box.height > cardBox.top
            if (intersects) hits.add(card.id)
          }
          if (hits.size > 0) setSelection(hits)
        }
        const onCancel = () => {
          marqueeRef.current?.cleanup()
          marqueeRef.current = null
          setMarquee(null)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onCancel)
      }, [canvas, boardWidth, rowPitch, zoom])

      const onBatchDelete = useCallback(async () => {
        if (!canvas || selection.size === 0) return
        const count = selection.size
        setSaveState('saving')
        try {
          await withCurrentRevision(rev => batchCards(canvas.id, { operation: 'delete', card_ids: [...selection] }, rev))
          setSelection(new Set())
          setSaveState('saved')
          await reloadList()
          setNotice(t('canvas.deletedCards').replace('{n}', String(count)))
        } catch (e) {
          setSaveState('failed')
          setError(e.message)
        }
      }, [canvas, selection, withCurrentRevision, reloadList, t])

      const templateDialog = templatesOpen ? h(Dialog, { title: t('canvas.templates'), onClose: closeTemplates, closeLabel: t('canvas.close') },
          error ? h('div', { style: S.errorBox }, error) : null,
          h('p', { style: S.mutedSmall }, t('canvas.templateNote')),
          h('button', { type: 'button', style: S.btn, disabled: templateBusy || !canvas, 'data-xc-template-save': true, onClick: saveTemplate }, t('canvas.saveTemplate')),
          templateBusy ? h('p', { style: S.muted }, t('canvas.loading')) : null,
          templates.length ? templates.map(template => h('button', { key: template.id, type: 'button', style: { ...S.btn, flexShrink: 0, justifyContent: 'flex-start' }, disabled: templateBusy,
            'data-xc-template-item': template.id, onClick: () => previewTemplate(template.id) }, `${template.name} · ${template.card_count}`)) : h('p', { style: S.muted }, t('canvas.templateEmpty')),
          templatePreview ? h('div', { 'data-xc-template-preview': templatePreview.id },
            h('h3', null, templatePreview.name),
            h('svg', { role: 'img', 'aria-label': t('canvas.templatePreview'), viewBox: `0 0 ${Math.max(96, ...templatePreview.cards.map(c => c.layout.x + c.layout.w))} ${Math.max(20, ...templatePreview.cards.map(c => (c.layout.y + c.layout.h) * 2.2))}`,
              style: { width: '100%', maxHeight: '220px', border: '1px solid #8884' } },
              ...templatePreview.cards.map((c, i) => h('g', { key: i },
                h('rect', { x: c.layout.x + 0.3, y: c.layout.y * 2.2 + 0.3, width: c.layout.w - 0.6, height: c.layout.h * 2.2 - 0.6, fill: 'var(--dsw-alias-brand-primary, #3b82f6)', opacity: 0.15 }),
                h('text', { x: c.layout.x + 1, y: c.layout.y * 2.2 + 3, fontSize: 2.8, fill: 'currentColor' }, t(`card.${c.type}`))))),
            h('button', { type: 'button', style: S.btnPrimary, disabled: templateBusy, 'data-xc-template-clone': true, onClick: cloneTemplate }, t('canvas.templateClone')),
            h('button', { type: 'button', style: S.btn, disabled: templateBusy, 'data-xc-template-rename': true, onClick: renameTemplate }, t('card.rename')),
            h('button', { type: 'button', style: S.btn, disabled: templateBusy, 'data-xc-template-delete': true, onClick: deleteTemplate }, t('canvas.templateDelete'))) : null) : null

      const draftPreviewContent = card => {
        if (card.type === 'chart') {
          const option = card.echarts_option || card.chart_spec || {}
          return JSON.stringify({
            chart_type: card.chart_type,
            categories: Array.isArray(option.xAxis?.data) ? option.xAxis.data.slice(0, 8) : undefined,
            series: (Array.isArray(option.series) ? option.series : []).slice(0, 5).map(series => ({
              name: series.name, type: series.type,
              sample: Array.isArray(series.data) ? series.data.slice(0, 8) : series.data,
              total_points: series.total_points ?? (Array.isArray(series.data) ? series.data.length : undefined),
            })),
          }, null, 2)
        }
        if (card.type === 'table') {
          const table = card.table_data || {}
          const columns = Array.isArray(table.columns) ? table.columns.map(column => typeof column === 'string' ? column : column?.name) : []
          return JSON.stringify({ columns, sample_rows: (table.rows || []).slice(0, 5), total_rows: table.total_rows ?? table.rows?.length ?? 0 }, null, 2)
        }
        if (card.type === 'kpi') return JSON.stringify(card.presentation_spec || {}, null, 2)
        return String(card.text_content || '').slice(0, 2400) + (card.text_truncated ? '\n…' : '')
      }
      const pendingDraftPanel = h(Fragment, null,
        draftFeedbackNotice ? h('div', { role: 'status', 'aria-live': 'polite' }, draftFeedbackNotice) : null,
        draftActionError ? h('div', { role: 'alert', style: S.errorBox }, draftActionError) : null,
        pendingDrafts.length ? h('section', {
        role: 'region', 'aria-label': '待确认卡片预览', 'data-xc-pending-drafts': true,
        style: { flex: '0 0 auto', maxHeight: '38vh', overflowY: 'auto', marginBottom: '8px', padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l1, #8884)', borderRadius: '8px', background: 'var(--dsw-alias-surface-l1, rgba(127,127,127,.06))' },
      },
      h('strong', { style: { display: 'block', marginBottom: '8px' } }, `待确认的卡片（${pendingDrafts.length}）`),
      draftActionError ? h('div', { role: 'alert', style: { ...S.errorBox, marginBottom: '8px' } }, draftActionError) : null,
      ...pendingDrafts.map(draft => {
        const card = draft.card || {}
        const source = card.source || {}
        const target = canvases.find(item => item.id === draft.canvas_id)?.name || draft.canvas_name || draft.canvas_id
        return h('article', {
          key: draft.id, 'data-xc-draft-preview': draft.id,
          style: { padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l1, #8884)' },
        },
        h('div', { style: S.row },
          h('strong', null, card.title || '未命名卡片'),
          h('span', { style: S.mutedSmall }, `${t(`card.${card.type || 'chart'}`)}${card.chart_type ? ` · ${card.chart_type}` : ''}`),
          h('span', { style: { ...S.mutedSmall, marginLeft: 'auto' } }, `目标画布：${target} · ${draft.operation === 'update' ? '更新已有卡片' : '新增卡片'}`)),
        h('div', { style: { ...S.mutedSmall, marginTop: '4px', overflowWrap: 'anywhere' } },
          `数据集：${source.dataset || '无外部数据源'} · 查询：${source.query || '未提供'} · 备注：${source.note || card.note || '无'}`),
        ['chart', 'table', 'kpi'].includes(card.type) ? h('div', { 'aria-label': '卡片样本预览（仅部分数据）', style: { height: 180, overflow: 'auto' } }, h(CardBody, { card, t, theme })) : null,
        h('pre', { style: { margin: '6px 0', padding: '8px', maxHeight: '140px', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', borderRadius: '4px', background: 'rgba(127,127,127,.08)', fontSize: '11px' } }, draftPreviewContent(card)),
        h('label', { style: { display: 'block', marginTop: 6 } }, '修改意见', h('textarea', { 'aria-label': `修改意见：${card.title || '未命名卡片'}`, value: draftFeedback[draft.id] || '', disabled: draftActionId !== null, onChange: event => setDraftFeedback(current => ({ ...current, [draft.id]: event.target.value })), style: { width: '100%', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)' } })),
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.btn, 'data-xc-draft-revise': draft.id, disabled: draftActionId !== null || !draftFeedback[draft.id]?.trim(), onClick: () => requestDraftRevision(draft) }, '复制修改请求并取消旧预览'),
          h('button', { type: 'button', style: S.btnPrimary, disabled: draftActionId !== null, 'data-xc-draft-confirm': draft.id, onClick: () => onDraftAction(draft, 'confirm') }, draftActionId === draft.id ? '处理中…' : draft.operation === 'update' ? '确认并更新' : '确认并添加'),
          h('button', { type: 'button', style: S.btn, disabled: draftActionId !== null, 'data-xc-draft-cancel': draft.id, onClick: () => onDraftAction(draft, 'cancel') }, '取消')))
      })) : null)

      if (status === 'loading') return h('div', { style: S.muted }, t('canvas.loading'))
      if (status === 'error') {
        return h('div', null,
          h('div', { style: S.errorBox }, `${t('canvas.error')}: ${error}`),
          h('button', { type: 'button', style: { ...S.btn, marginTop: '8px' }, onClick: () => window.location.reload() }, t('canvas.retry')))
      }

      // Keep every hook above ALL render branches. Loading an empty catalog,
      // deleting the last canvas, and creating one must use the same sequence.
      // Guard canvas.cards below without skipping the marquee/batch hooks.
      if (!canvas) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
          backupPicker,
          templateDialog,
          // The template dialog can name and delete from here too, so the
          // confirm/prompt surfaces must exist on this branch as well.
          confirmState ? h(ConfirmDialog, {
            title: confirmState.title, tone: confirmState.tone, confirmLabel: confirmState.confirmLabel,
            cancelLabel: t('canvas.cancel'), onConfirm: confirmState.onConfirm, onCancel: () => setConfirmState(null),
          }, confirmState.body ? h('div', { style: { lineHeight: 1.6 } }, confirmState.body) : null) : null,
          promptState ? h(PromptDialog, {
            title: promptState.title, defaultValue: promptState.defaultValue, placeholder: promptState.placeholder,
            submitLabel: promptState.submitLabel || t('canvas.save'), cancelLabel: t('canvas.cancel'),
            emptyLabel: t('canvas.notEmpty'), onSubmit: promptState.onSubmit, onCancel: () => setPromptState(null),
          }) : null,
          pendingDraftPanel,
          error ? h('div', { style: { ...S.errorBox, margin: 0, padding: '6px 16px', borderRadius: 0, flex: '0 0 auto' } }, error) : null,
          h('div', { style: { ...S.board, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '1 1 auto' } },
            h('div', { style: { textAlign: 'center', maxWidth: '420px' } },
              h('div', { style: { ...S.muted, marginBottom: '8px' } }, t('canvas.noCanvas')),
              h('button', { type: 'button', style: S.btnPrimary, onClick: onCreate }, `+ ${t('canvas.new')}`),
              h('button', { type: 'button', style: { ...S.btn, marginLeft: '8px' }, onClick: openBackupPicker }, t('canvas.backupImport')),
              h('button', { type: 'button', style: S.btn, 'data-xc-templates': true, onClick: openTemplates }, t('canvas.templates')),
              canvases.length === 0 ? h('button', {
                type: 'button', style: { ...S.btn, marginLeft: '8px' },
                'data-xc-add-example': 'true', disabled: addingExample,
                onClick: onCreateExample,
              }, t(addingExample ? 'canvas.addingExample' : 'canvas.addExample')) : null)))
      }

      // Built as named pieces rather than one deeply nested expression: the
      // nested form had a mismatched parenthesis that shipped a broken bundle
      // (the parser only complained at runtime), and counting parens by eye is
      // exactly the kind of thing that should not be load-bearing.
      // A search field only earns its space once the list stops fitting.
      const listNeedsSearch = canvases.length > LIST_SEARCH_MIN
      const listMatches = listQuery.trim()
        ? canvases.filter(c => String(c.name || '').toLowerCase().includes(listQuery.trim().toLowerCase()))
        : canvases
      // One menu array per row, used by both entry points (the trailing ⋯ and the
      // context menu), so the two can never drift apart. `rowId` is what lets the
      // ⋯ report `aria-expanded` for its own row only.
      const canvasRowItems = c => [
        { id: 'open', text: t('canvas.open'), iconName: 'open', onSelect: () => onSelect(c.id) },
        { id: 'rename-canvas', text: t('canvas.rename'), iconName: 'pencil',
          data: { 'data-xc-rename-canvas': c.id }, onSelect: () => setRenamingCanvas({ id: c.id, created: false }) },
        { separator: true },
        { id: 'delete-canvas', text: t('canvas.delete'), iconName: 'trash', danger: true, onSelect: () => onDelete(c.id) },
      ]
      const canvasRows = listMatches.map(c => renamingCanvas?.id === c.id
        // Naming in place: the row the user just created (or asked to rename)
        // becomes an input of exactly the row's box, so the list never jumps.
        // Enter commits, Escape on a brand-new canvas takes it away again, blur
        // commits — the same contract as the datasource list.
        ? h(ListRowInput, {
          key: c.id,
          defaultValue: c.name,
          ariaLabel: t('canvas.newName'),
          data: { 'data-xc-canvas-item': c.id, 'data-xc-canvas-rename': c.id },
          onKeyDown: event => {
            if (event.key === 'Enter') { event.preventDefault(); commitCanvasRename(c.id, event.currentTarget.value) }
            else if (event.key === 'Escape') { event.preventDefault(); cancelCanvasRename() }
          },
          onBlur: event => commitCanvasRename(c.id, event.currentTarget.value),
        })
        : h(ListRow, {
          key: c.id,
          title: c.name,
          meta: `${c.card_count ?? 0} ${t('canvas.cards')} · ${String(c.updated_at || '').slice(0, 10)}`,
          selected: c.id === selectedId,
          data: { 'data-xc-canvas-item': c.id },
          onClick: () => onSelect(c.id),
          onContextMenu: event => {
            // Canvas-level menu, so the list is not a dead-end when the toolbar
            // is out of reach.
            event.preventDefault()
            event.stopPropagation()
            setMenu({ x: event.clientX, y: event.clientY, rowId: c.id, items: canvasRowItems(c) })
          },
          actions: [h(IconButton, {
            key: 'menu',
            title: t('canvas.more'),
            buttonProps: {
              'data-xc-canvas-actions': c.id,
              'data-xc-canvas-menu': c.id,
              'aria-haspopup': 'menu',
              'aria-expanded': menu?.rowId === c.id ? 'true' : 'false',
            },
            onClick: event => {
              const rect = event.currentTarget.getBoundingClientRect?.() || { right: 0, bottom: 0 }
              setMenu({ x: Math.max(8, rect.right - 176), y: rect.bottom + 4, rowId: c.id, items: canvasRowItems(c) })
            },
          }, h(ToolIcon, { name: 'more' }))],
        }))

      const listPane = h(SideList, {
        collapsed: listCollapsed,
        title: t('canvas.title'),
        count: canvases.length,
        countData: { 'data-xc-list-count': 'true' },
        data: { 'data-xc-canvas-list': 'true' },
        tools: listNeedsSearch
          ? h('input', {
            type: 'search',
            value: listQuery,
            'aria-label': t('canvas.searchList'),
            placeholder: t('canvas.searchList'),
            'data-xc-list-search': 'true',
            onChange: event => setListQuery(event.target.value),
            style: { ...S.btn, flex: '1 1 auto', minWidth: 0, fontWeight: 'normal', height: '26px' },
          })
          : null,
        primaryAction: h(ListPrimaryAction, {
          label: t('canvas.new'), icon: 'plus', onClick: onCreate,
          data: { 'data-xc-new-canvas': 'true' },
        }),
        empty: canvases.length > 0 && listMatches.length === 0
          ? h(EmptyState, { 'data-xc-list-empty': 'true', title: t('canvas.searchEmpty') })
          : h(EmptyState, { title: t('list.empty'), hint: t('canvas.emptyHint') }),
      }, canvasRows)

      // ── Header ────────────────────────────────────────────────────────────
      //
      // One line, always. The pane width is measured (see the headerRef effect)
      // and `planToolbar` decides which controls fold into the ⋯ menu, least
      // valuable first. Every item the planner reports as inline is rendered;
      // everything else stays reachable through ⋯ (or the list's context menu
      // for canvas-level actions), so nothing becomes unreachable.
      const toolbarPlan = planToolbar(toolbarWidth ?? Infinity)
      const inline = toolbarPlan.inline
      const saveLabel = saveState === 'saving'
        ? t('canvas.saving')
        : saveState === 'saved' ? t('canvas.saved') : t('canvas.saveFailed')

      // The palette and zoom dropdowns are the themed `Select`: the native
      // `<option>` popup cannot be styled at all, so it stayed a light system
      // panel inside a dark shell. The test hooks ride on the trigger.
      const paletteSelect = h(Select, {
        value: theme.palette,
        options: PALETTE_NAMES.map(name => ({ value: name, label: t(`theme.palette.${name}`) })),
        onChange: next => setTheme({ ...theme, palette: next }),
        ariaLabel: t('theme.palette'),
        dataAttrs: { 'data-xc-theme-palette': 'true' },
        triggerStyle: { height: '28px', padding: '0 6px' },
      })

      const zoomSelect = h(Select, {
        value: String(zoom),
        options: [...new Set([0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, zoom])].sort((a, b) => a - b)
          .map(value => ({ value: String(value), label: `${Math.round(value * 100)}%` })),
        // The caller keeps its own type conversion, exactly as before.
        onChange: next => setZoom(Number(next)),
        ariaLabel: 'Zoom',
        title: t('canvas.zoom'),
        dataAttrs: { 'data-xc-zoom': true },
        triggerStyle: { height: '28px', padding: '0 4px' },
      })

      // Off-screen cards: an icon + count. The list is a <details> child so it
      // stays in the tree (keyboard reachable) and is absolutely positioned, so
      // opening it never grows the header to a second line.
      const compass = settings.wide && outsideCards.length
        ? h('details', { style: S.compass, 'data-xc-compass': true },
          h('summary', { style: S.compassSummary, title: t('canvas.outside'), 'aria-label': t('canvas.outside') },
            h(ToolIcon, { name: 'compass' }),
            h('span', { style: S.compassBadge }, String(outsideCards.length))),
          h('div', { style: S.compassList, role: 'menu' },
            ...outsideCards.map(c => h('button', {
              key: c.id, type: 'button', role: 'menuitem',
              style: { ...S.menuItem(false), width: '100%' },
              'data-xc-compass-card': c.id,
              onClick: () => locateCard(c.id),
            }, `${c.direction} ${c.title}`))))
        : null

      // The ⋯ menu mirrors whatever folded, so the two can never drift: each
      // entry is emitted only when its inline counterpart is absent.
      const overflowGroups = [
        [
          !inline.has('export-png') && { id: 'export-png', data: { 'data-xc-export': 'true' }, iconName: 'download',
            text: exporting ? t('canvas.exporting') : t('canvas.export'), onSelect: () => onExport() },
          !inline.has('export-html') && { id: 'export-html', data: { 'data-xc-export-html': true }, iconName: 'open',
            text: t('canvas.exportHtml'), onSelect: () => onExport('html') },
          !inline.has('backup') && { id: 'export-backup', data: { 'data-xc-export-backup': true }, iconName: 'archive',
            text: t('canvas.backupExport'), onSelect: onExportBackup },
        ],
        [
          !inline.has('refresh') && { id: 'refresh', data: { 'data-xc-refresh': true }, iconName: 'refresh',
            text: t('canvas.refresh'), onSelect: () => loadCanvas(canvas.id) },
          !inline.has('arrange') && { id: 'arrange', data: { 'data-xc-arrange-menu': true }, iconName: 'arrange',
            text: t('canvas.arrange'), onSelect: onArrange },
          !inline.has('fit') && { id: 'fit', data: { 'data-xc-fit-menu': true }, iconName: 'fit',
            text: t('canvas.fit'), onSelect: fitAll },
          !inline.has('templates') && { id: 'templates', data: { 'data-xc-templates-menu': true }, iconName: 'layout',
            text: t('canvas.templates'), onSelect: openTemplates },
          !inline.has('search') && { id: 'search', data: { 'data-xc-search-menu': true }, iconName: 'search',
            text: t('canvas.search'), onSelect: () => { setSearchQuery(''); setSearchOpen(true) } },
        ],
        [
          // The hint names a shortcut that really exists (see the undo/redo
          // handler) — a menu must never advertise a key that does nothing.
          !inline.has('undo') && { id: 'undo', data: { 'data-xc-undo-menu': true }, iconName: 'undo', hint: 'Ctrl+Z',
            text: t('canvas.undo'), onSelect: onUndo },
          !inline.has('redo') && { id: 'redo', data: { 'data-xc-redo-menu': true }, iconName: 'redo', hint: 'Ctrl+Shift+Z',
            text: t('canvas.redo'), onSelect: onRedo },
        ],
      ].map(group => group.filter(Boolean))
      // One divider between groups, never two in a row.
      const overflowMenuItems = overflowGroups
        .flatMap((group, index) => (index > 0 && group.length ? [{ separator: true }, ...group] : group))
      const openToolbarMenu = event => {
        const rect = event.currentTarget.getBoundingClientRect()
        setMenu({ x: Math.max(8, rect.right - 180), y: rect.bottom + 4, items: overflowMenuItems })
      }

      // The header is the shared `PageHeader`: same 48px line, same 16px inset,
      // same 16px/500 title and the same full-width rule as the datasource page.
      // The canvas name rides in the meta slot, so the page identity (`分析画布`)
      // and the document identity both stay visible.
      const headerActions = [
      saveState !== 'idle' ? h('span', { style: S.headerMeta, 'data-xc-save-state': saveState }, saveLabel) : null,
      inline.has('palette') ? paletteSelect : null,
      inline.has('palette') && (inline.has('undo') || inline.has('redo')) ? h('span', { 'data-xc-toolbar-sep': 'palette', style: S.toolbarSep }) : null,
      inline.has('undo') ? h(IconButton, { title: `${t('canvas.undo')} (Ctrl+Z)`, onClick: onUndo, buttonProps: { 'data-xc-undo': 'true' } }, h(ToolIcon, { name: 'undo' })) : null,
      inline.has('redo') ? h(IconButton, { title: `${t('canvas.redo')} (Ctrl+Shift+Z)`, onClick: onRedo, buttonProps: { 'data-xc-redo': 'true' } }, h(ToolIcon, { name: 'redo' })) : null,
      (inline.has('undo') || inline.has('redo')) && (inline.has('arrange') || inline.has('search') || inline.has('zoom') || inline.has('fit')) ? h('span', { 'data-xc-toolbar-sep': 'view', style: S.toolbarSep }) : null,
      inline.has('arrange') ? h(IconButton, { title: t('canvas.arrange'), onClick: onArrange, buttonProps: { 'data-xc-arrange': 'true' } }, h(ToolIcon, { name: 'arrange' })) : null,
      inline.has('search') ? h(IconButton, { title: t('canvas.search'), onClick: () => { setSearchQuery(''); setSearchOpen(true) }, buttonProps: { 'data-xc-search': 'true' } }, h(ToolIcon, { name: 'search' })) : null,
      inline.has('zoom') ? zoomSelect : null,
      inline.has('fit') ? h(IconButton, { title: t('canvas.fit'), onClick: fitAll, buttonProps: { 'data-xc-fit': 'true' } }, h(ToolIcon, { name: 'fit' })) : null,
      inline.has('templates') ? h(IconButton, { title: t('canvas.templates'), onClick: openTemplates, buttonProps: { 'data-xc-templates': 'true' } }, h(ToolIcon, { name: 'layout' })) : null,
      (inline.has('arrange') || inline.has('search') || inline.has('zoom') || inline.has('fit') || inline.has('templates')) && (inline.has('export-png') || inline.has('export-html') || inline.has('backup') || inline.has('refresh')) ? h('span', { 'data-xc-toolbar-sep': 'io', style: S.toolbarSep }) : null,
      inline.has('export-png')
        ? h(IconButton, { title: exporting ? t('canvas.exporting') : t('canvas.export'), onClick: () => onExport(), buttonProps: { 'data-xc-export': 'true', disabled: exporting } }, h(ToolIcon, { name: 'download' }))
        : null,
      inline.has('export-html')
        ? h(IconButton, { title: t('canvas.exportHtml'), onClick: () => onExport('html'), buttonProps: { 'data-xc-export-html': 'true', disabled: exporting } }, h(ToolIcon, { name: 'layout' }))
        : null,
      inline.has('backup')
        ? h(IconButton, { title: t('canvas.backupExport'), onClick: onExportBackup, buttonProps: { 'data-xc-export-backup': 'true', disabled: exporting } }, h(ToolIcon, { name: 'archive' }))
        : null,
      inline.has('refresh')
        ? h(IconButton, { title: t('canvas.refresh'), onClick: () => loadCanvas(canvas.id), buttonProps: { 'data-xc-refresh': 'true' } }, h(ToolIcon, { name: 'refresh' }))
        : null,
      inline.has('compass') ? compass : null,
      // The ⋯ only appears once something actually folded, so a wide header
      // stays uncluttered.
      toolbarPlan.overflow.size
        ? h(IconButton, { title: t('canvas.more'), onClick: openToolbarMenu, buttonProps: { 'data-xc-more': 'true', 'aria-haspopup': 'menu' } }, h(ToolIcon, { name: 'more' }))
        : null,
      h(IconButton, { title: t('canvas.settings'), onClick: () => setSettingsOpen(true), buttonProps: { 'data-xc-settings': 'true' } }, h(ToolIcon, { name: 'settings' })),
      ].filter(Boolean)

      const toolbar = h(PageHeader, {
        headerRef,
        data: { 'data-xc-toolbar': toolbarWidth === null ? 'unmeasured' : (toolbarPlan.overflow.size ? 'compact' : 'full') },
        // Verbatim clone of the shell's sidebar toggle: same classes it uses,
        // same 28x28 ghost button, same glyph.
        toggle: h('button', {
          type: 'button',
          className: 'hHd-Xa_iconButton hHd-Xa_toggle',
          'aria-label': listCollapsed ? t('list.expand') : t('list.collapse'),
          'aria-keyshortcuts': 'Control+Alt+B',
          'aria-expanded': listCollapsed ? 'false' : 'true',
          'data-xc-toggle-list': 'true',
          style: { ...S.btnIcon, position: 'static', top: 'auto', left: 'auto', zIndex: 'auto', marginLeft: '-6px' },
          onClick: () => setListCollapsed(v => !v),
          ...hoverable(),
        }, h(ToggleSidebarIcon, { size: 16 })),
        title: t('canvas.title'),
        // `meta` folds like any other secondary control, but the canvas name is
        // never dropped: without it the header would not say which canvas this is.
        meta: inline.has('meta')
          ? `${canvas.name} · ${canvas.cards.length} ${t('canvas.cardCount')} · ${t('canvas.revision')} ${canvas.revision}`
          : canvas.name,
        actions: headerActions,
      })

      // Scroll container fills the remaining height; the inner layer carries the
      // content height so absolutely-positioned cards have something to scroll
      // against.
      const boardInner = h('div', {
        ref: boardInnerRef,
        'data-xc-board-inner': 'true',
        style: { position: 'absolute', left: 0, top: 0,
          width: `${boardWidth / COLS * contentCols}px`,
          height: `${contentHeight}px`, transform: `scale(${zoom})`, transformOrigin: 'top left' },
      },
      canvas.cards.length === 0
        ? h('div', {
          'data-xc-board-empty': 'true',
          style: {
            position: 'absolute', left: 0, top: 0, width: '100%', maxWidth: '520px',
            padding: '48px 24px', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
            textAlign: 'center', color: 'var(--dsw-alias-label-secondary)',
          },
        },
        h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } }, t('canvas.emptyCards')),
        h('div', { style: { fontSize: '12px', lineHeight: 1.6 } }, t('canvas.emptyCardsHint')))
        : canvas.cards.map(card => h(Card, {
          key: card.id,
          card,
          cards: canvas.cards,
          boardWidth,
          rowPitch,
          zoom, colBound, snapEnabled: settings.snap, showBadge: settings.badges,
          scrollElement: boardRef.current,
          group: selection.has(card.id) ? canvas.cards.filter(c => selection.has(c.id)) : [],
          override: groupPreview?.[card.id], onGroupPreview: setGroupPreview,
          onToggleSelect: toggleSelection, onFocus: setFocusId,
          t,
          theme: themeObj,
          selected: selection.has(card.id),
          onContextMenu: openCardMenu,
          renaming: renamingCardId === card.id,
          onRenameStart: startRenameCard,
          onRenameCancel: cancelRenameCard,
          onRename: title => onRenameCard(card, title),
          onCommit: (rect, groupLayouts) => commitLayout({ cardId: card.id, rect, groupLayouts }),
          onSnapLines: setSnapLines,
        })),
      // Alignment guides: full-height/width 1px lines at the snapped grid
      // positions, drawn above the cards while a drag is active.
      settings.snap && snapLines
        ? [
          ...snapLines.v.map(x => h('div', {
            key: `sv${x}`,
            'data-xc-snap': `v${x}`,
            style: {
              position: 'absolute', top: 0, bottom: 0, width: '1px',
              left: `${x * boardWidth / COLS}px`,
              background: 'var(--dsw-alias-brand-primary, #3b82f6)', opacity: 0.55,
              pointerEvents: 'none', zIndex: 5,
            },
          })),
          ...snapLines.h.map(y => h('div', {
            key: `sh${y}`,
            'data-xc-snap': `h${y}`,
            style: {
              position: 'absolute', left: 0, right: 0, height: '1px',
              top: `${y * rowPitch}px`,
              background: 'var(--dsw-alias-brand-primary, #3b82f6)', opacity: 0.55,
              pointerEvents: 'none', zIndex: 5,
            },
          })),
        ]
        : null,
      marquee
        ? h('div', {
          'data-xc-marquee': 'true',
          style: {
            position: 'absolute', left: `${marquee.left}px`, top: `${marquee.top}px`,
            width: `${marquee.width}px`, height: `${marquee.height}px`,
            border: '1px solid var(--dsw-alias-brand-primary, #3b82f6)',
            background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 8%, transparent)',
            pointerEvents: 'none', zIndex: 6,
          },
        })
        : null)

      const boardScroll = h('div', {
        ref: boardRef,
        'data-xc-board': canvas.id,
        // The theme's chrome drives the board: text colour feeds the
        // translucent card surfaces (they are color-mix of currentColor), and
        // the dark mode gets a dark base so charts stay readable.
        style: {
          ...S.board,
          border: 'none', borderRadius: 0, padding: '10px 12px',
          color: themeObj.text,
          background: S.board.background,
        },
        // Rubber-band multi-select from empty space (left button only).
        onPointerDown: onBoardPointerDown,
        // Right-clicking empty canvas space opens a canvas-level menu rather
        // than the browser's.
        onContextMenu: event => {
          event.preventDefault()
          setMenu({
            x: event.clientX,
            y: event.clientY,
            items: [
              // View → content → backup → danger last, in its own group.
              { id: 'arrange-canvas', text: t('canvas.arrange'), iconName: 'arrange', onSelect: onArrange },
              { id: 'refresh-canvas', text: t('canvas.refresh'), iconName: 'refresh', onSelect: () => loadCanvas(canvas.id) },
              { separator: true },
              { id: 'import-backup', data: { 'data-xc-backup-import': 'true' }, text: t('canvas.backupImport'), iconName: 'archive', onSelect: openBackupPicker },
              { separator: true },
              { id: 'delete-canvas', text: t('canvas.deleteCanvas'), iconName: 'trash', danger: true, onSelect: () => onDelete(canvas.id) },
              ...(selection.size > 0 ? [
                { separator: true },
                { id: 'batch-delete', text: `${t('canvas.batchDelete')}（${selection.size}）`, iconName: 'trash', onSelect: onBatchDelete },
                { id: 'clear-selection', text: t('canvas.clearSelection'), iconName: 'circle', onSelect: () => setSelection(new Set()) },
              ] : []),
            ],
          })
        },
      }, h('div', { 'data-xc-zoom-spacer': true, style: { position: 'relative',
        width: `${boardWidth / COLS * contentCols * zoom}px`,
        height: `${contentHeight * zoom}px` } }, boardInner))

      // The content column no longer owns the header: it is a sub-toolbar (only
      // while a selection exists) plus one inset content box, exactly like the
      // datasource page's view tabs plus its table.
      const boardPane = h('div', {
        'data-xc-board-pane': true,
        style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
      }, canvas ? [
        selection.size > 0 ? h('div', {
          'data-xc-selection-tools': true,
          style: S.subToolbar,
        },
        h('span', { style: { ...S.mutedSmall, marginRight: 4 } }, `${t('canvas.selected')} ${selection.size}`),
        ...['alignLeft', 'alignRight', 'alignTop', 'alignBottom', 'spaceX', 'spaceY'].map(mode => h('button', {
          key: mode, type: 'button', 'data-xc-align': mode, title: t(`canvas.${mode}`),
          disabled: selection.size < (mode.startsWith('space') ? 3 : 2),
          style: { ...S.btn, height: 24, fontSize: '12px' },
          onClick: () => onAlign(mode),
        }, t(`canvas.${mode}`))),
        h('span', { 'data-xc-selection-divider': true, style: { width: 1, height: 14, flex: '0 0 auto', margin: '0 4px', background: 'var(--dsw-alias-border-l1)' } }),
        h('button', { type: 'button', 'data-xc-batch-delete': true, style: { ...S.btn, height: 24, fontSize: '12px' }, onClick: onBatchDelete }, t('canvas.batchDelete')),
        h('button', { type: 'button', style: { ...S.btn, height: 24, fontSize: '12px' }, onClick: () => setSelection(new Set()) }, t('canvas.clearSelection'))) : null,
        h('div', { style: S.content }, boardScroll)] : h('div', { style: S.content },
        h('div', { style: { ...S.board, background: 'none' } }, h('div', { style: S.muted }, t('canvas.empty')))))

      const sourceDialog = sourceCard ? h(TraceDialog, {
        canvasId: canvas.id, cardId: sourceCard.id, versionId: sourceCard.traceVersionId || null,
        t, onClose: closeSourceDialog,
        onOpenCanvas: props.onOpenCanvas, onOpenDatasource: props.onOpenDatasource, onOpenSession: props.onOpenSession,
        onAsk: props.onAsk ? async input => { await props.onAsk(input); closeSourceDialog() } : undefined,
      }) : null
      const focusCard = canvas.cards.find(c => c.id === focusId)
      const searchResults = canvas.cards.filter(c => `${c.title} ${c.type} ${t(`card.${c.type}`)}`.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()))
      return h(PageShell, {
        className: 'xc-ui xc-canvas-page',
        data: {
          ref: workspaceRef,
          tabIndex: -1,
          'data-xc-workspace': true,
          onPointerDownCapture: event => { if (!event.target?.closest?.('input, textarea, select, button, a, [contenteditable="true"]')) workspaceRef.current?.focus?.({ preventScroll: true }) },
        },
      },
        h('style', null, XC_UI_CSS),
        backupPicker,
        sourceDialog,
        // Header first, then the page-level banners, then the split — the exact
        // order the datasource page uses.
        toolbar,
        error ? h(StatusLine, { tone: 'alert', style: { borderRadius: 0, margin: 0 } }, error) : null,
        notice ? h(StatusLine, { 'data-xc-notice': true }, notice) : null,
        pendingDraftPanel,
        h('div', { style: S.split, 'data-xc-split': true, 'data-xc-workspace-row': true }, listPane, boardPane),
        templateDialog,
        settingsOpen ? h(CanvasSettingsDialog, {
          t, settings, error, saving: saveState === 'saving',
          onChange: changeSetting, onResetZoom: () => setZoom(1), changelog, onImported: reloadList, onClose: closeSettings,
        }) : null,
        focusCard ? h(Dialog, { title: focusCard.title, onClose: closeFocus, large: true, closeLabel: t('canvas.close') },
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.btn, disabled: canvas.cards.indexOf(focusCard) === 0, onClick: () => setFocusId(canvas.cards[canvas.cards.indexOf(focusCard) - 1].id) }, t('canvas.previous')),
            h('span', { style: S.mutedSmall }, `${canvas.cards.indexOf(focusCard) + 1} / ${canvas.cards.length}`),
            h('button', { type: 'button', style: S.btn, disabled: canvas.cards.indexOf(focusCard) === canvas.cards.length - 1, onClick: () => setFocusId(canvas.cards[canvas.cards.indexOf(focusCard) + 1].id) }, t('canvas.next'))),
          h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }, 'data-xc-focus-body': focusCard.id }, h(CardBody, { card: focusCard, t, theme: themeObj }))) : null,
        searchOpen ? h(Dialog, { title: t('canvas.search'), onClose: closeSearch, closeLabel: t('canvas.close') },
          h('input', { type: 'search', value: searchQuery, placeholder: t('canvas.searchHint'), 'aria-label': t('canvas.search'), 'data-xc-search-input': true,
            style: { width: '100%', padding: '8px', boxSizing: 'border-box', background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))', borderRadius: RADIUS.sm },
            onChange: e => setSearchQuery(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && searchResults[0]) locateCard(searchResults[0].id) } }),
          searchResults.length ? searchResults.map(c => h('button', { key: c.id, type: 'button', style: { ...S.btn, justifyContent: 'flex-start', minHeight: '32px', flexShrink: 0 }, 'data-xc-search-result': c.id, onClick: () => locateCard(c.id) }, `${c.title} · ${t(`card.${c.type}`)}`)) : h('p', { style: S.muted }, t('canvas.searchEmpty'))) : null,
        // Confirmation and naming are declared here, outside every branch above,
        // so a dialog survives a canvas being deleted underneath it.
        confirmState ? h(ConfirmDialog, {
          title: confirmState.title,
          tone: confirmState.tone,
          confirmLabel: confirmState.confirmLabel,
          cancelLabel: t('canvas.cancel'),
          onConfirm: confirmState.onConfirm,
          onCancel: () => setConfirmState(null),
        }, confirmState.body ? h('div', { style: { lineHeight: 1.6 } }, confirmState.body) : null) : null,
        promptState ? h(PromptDialog, {
          title: promptState.title,
          defaultValue: promptState.defaultValue,
          placeholder: promptState.placeholder,
          submitLabel: promptState.submitLabel || t('canvas.save'),
          cancelLabel: t('canvas.cancel'),
          emptyLabel: t('canvas.notEmpty'),
          onSubmit: promptState.onSubmit,
          onCancel: () => setPromptState(null),
        }) : null,
        menu ? h(ContextMenu, { x: menu.x, y: menu.y, items: menu.items, onClose: closeMenu }) : null)
    }

    /** Tallest card bottom, in rows — used to size the scrollable board. */
