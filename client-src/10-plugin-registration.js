    function DataSourcePanelIcon ({ size }) {
      const s = typeof size === 'number' ? size : 16
      return h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, h('ellipse', { cx: 8, cy: 3.5, rx: 5.5, ry: 2 }), h('path', { d: 'M2.5 3.5v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-4M2.5 7.5v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-4' }))
    }

    /**
     * The page-level workspace.
     *
     * Rendered into the `main` slot, so it owns the whole content area rather
     * than sitting inside the settings modal.
     */
    function CanvasPage (props) {
      const [navigation, setNavigation] = useState(() => props.navigation?.snapshot() || {})
      useEffect(() => props.navigation?.subscribe(setNavigation), [props.navigation])
      // No page padding: the toolbar owns its own inset and the divider runs the
      // full height of the columns, exactly as in the datasource workspace.
      return h('div', {
        style: { height: '100%', width: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' },
      }, h(CanvasWorkspace, { ...props, preferredCanvasId: navigation.canvas_id || props.preferredCanvasId, preferredCardId: navigation.card_id, preferredVersionId: navigation.version_id }))
    }

    function DataSourceEntry (props) {
      const [navigation, setNavigation] = useState(() => props.navigation?.snapshot() || {})
      useEffect(() => props.navigation?.subscribe(setNavigation), [props.navigation])
      return h(DataSourcePage, { ...props, preferredDatasourceId: navigation.datasource_id, preferredSourceHash: navigation.source_hash })
    }

    /**
     * Sidebar button glyph. The sidebar owns the button and the click handler
     * (`ctx.layout.selectPanel(id)`), so this only paints the icon.
     */
    function CanvasPanelIcon ({ size }) {
      const s = typeof size === 'number' ? size : 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 1.5, y: 1.5, width: 5.5, height: 13, rx: 1 }),
        h('rect', { x: 9, y: 1.5, width: 5.5, height: 7.5, rx: 1 }),
        h('rect', { x: 9, y: 11, width: 5.5, height: 3.5, rx: 1 }),
      )
    }

    /**
     * Panel id. `sidebar.panellist`'s `id` must equal the `main` panel's `key`:
     * the sidebar addresses the panel by that id and resolves the button label
     * from this list entry's metadata.
     */
    const PANEL_ID = 'xcharts-canvas'

    /**
     * Class error boundary: a render crash inside the workspace (the React
     * #300/#310 family measured during development) must degrade to a retry
     * card, never take the whole main slot down — a slot entry crash also
     * removes the sidebar entry, leaving the user no way back in.
     */
    class CanvasBoundary extends React.Component {
      constructor (props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError (error) {
        return { error }
      }

      render () {
        if (this.state.error) {
          return h('div', { style: { padding: '24px', maxWidth: '520px' } },
            h('div', { style: S.errorBox }, `画布渲染出错: ${String(this.state.error?.message || this.state.error)}`),
            h('button', {
              type: 'button',
              style: { ...S.btn, marginTop: '8px' },
              onClick: () => this.setState({ error: null }),
            }, '重试'))
        }
        return this.props.children
      }
    }

    const plugin = {
      name: 'xcharts-canvas-client',
      inject,
      apply (ctx) {
        const t = makeT(localeTag(ctx))
        // Client services are published after plugin activation, so resolve them
        // lazily at click time instead of capturing an early `undefined`.
        const readService = name => { try { return ctx.get?.(name) } catch { return undefined } }
        let navigationValue = {}, navigationSeq = 0
        const navigationListeners = new Set()
        const navigation = {
          snapshot: () => navigationValue,
          subscribe: fn => { navigationListeners.add(fn); return () => navigationListeners.delete(fn) },
          request: value => { navigationValue = { ...value, seq: ++navigationSeq }; for (const fn of navigationListeners) fn(navigationValue) },
        }
        const openCanvas = async (id, cardId, versionId) => {
          const layout = readService('layout')
          if (!layout?.selectPanel) throw new Error('当前宿主暂不支持面板切换')
          const payload = await getCanvas(id)
          if (cardId && !(payload.canvas?.cards || payload.cards || []).some(card => card.id === cardId)) throw new Error('卡片已不在此画布')
          navigation.request({ canvas_id: id, card_id: cardId, version_id: versionId })
          layout.selectPanel(PANEL_ID)
        }
        const openDatasource = async (id, hash) => {
          const layout = readService('layout')
          if (!layout?.selectPanel) throw new Error('当前宿主暂不支持面板切换')
          if (hash) await api(`/datasources/${encodeURIComponent(id)}/version?hash=${encodeURIComponent(hash)}&limit=1`)
          else await getDatasource(id, 0, 1)
          navigation.request({ datasource_id: id, source_hash: hash })
          layout.selectPanel('xcharts-datasources')
        }
        const openSession = async id => {
          const workspace = readService('uiWorkspace')
          if (!workspace?.openSession) throw new Error('当前宿主暂不支持会话导航')
          workspace.openSession(id)
        }
        const broker = createFollowupBroker(id => openSession(id))
        const askCard = (input, sessionId) => broker.ask(input, sessionId)
        const askReference = input => broker.ask(input)
        const actions = { onOpenCanvas: openCanvas, onOpenDatasource: openDatasource, onOpenSession: openSession, onAsk: askCard, onAskReference: askReference }
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'xcharts-followup', order: 30 }, props => h(FollowupDock, { ...props, broker })))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'xcharts-followup-status', order: 30 }, props => h(FollowupOverlay, { ...props, broker })))
        ctx.effect?.(() => () => broker.dispose(), 'xcharts: followup lifecycle')

        // Typing `@` in the composer lists datasources and inserts the same
        // versioned marker the button writes. Optional service: older hosts just
        // do not offer the trigger.
        const names = new Map()
        const registerTrigger = triggers => {
          if (!triggers?.registerSource) return
          triggers.registerSource({
            trigger: '@',
            name: '数据源',
            order: 40,
            codec: {
              clipboardText: ref => `@${names.get(String(ref).split('@')[0]) || '数据源'}`,
              serialize: async ref => `[xcharts:ds:${ref}]`,
            },
            async candidates (session, request) {
              const payload = await listDatasources()
              const query = String(request?.query || '').trim().toLowerCase()
              return (payload.datasources || [])
                .filter(item => !query || `${item.name} ${item.filename || ''}`.toLowerCase().includes(query))
                .slice(0, 20)
                .map(item => {
                  names.set(item.id, item.name)
                  return { name: item.name, description: `${String(item.format || 'csv').toUpperCase()} · ${item.row_count ?? 0} 行`, icon: 'file', value: `${item.id}@${item.content_hash}` }
                })
            },
            onPick (pick) {
              if (pick.action !== 'pick' || !pick.candidate.value) return undefined
              return { insert: { source: '数据源', ref: pick.candidate.value, label: pick.candidate.name, appearance: 'file', clipboardText: `@${pick.candidate.name}` } }
            },
          })
        }
        const triggers = readService('inputTriggers')
        if (triggers) registerTrigger(triggers)
        else if (typeof ctx.inject === 'function') ctx.inject(['inputTriggers'], scoped => registerTrigger(scoped.get?.('inputTriggers') || scoped.inputTriggers))

        // The page itself: full-height content area, inside an error boundary.
        ctx.slots.inject('main', () =>
          ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          }, props => h(CanvasBoundary, null, h(CanvasPage, { ...props, ...actions, navigation, locale: localeTag(ctx) }))),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({
            name: 'main',
            key: 'xcharts-datasources',
            locale: NS,
          }, props => h(CanvasBoundary, null, h(DataSourceEntry, { ...props, ...actions, navigation, locale: localeTag(ctx) }))),
        )

        // Our two card tools render as real cards in the conversation, so the
        // chart is visible where the user asked for it instead of only in the
        // canvas panel. Keyed by wire tool name: an unregistered name keeps the
        // generic row, so this is purely additive, and a typo would simply never
        // render (hence the shared name list).
        for (const toolName of TOOL_CARD_NAMES) {
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register({
              name: 'tool.call.toolview',
              key: toolName,
              locale: NS,
            }, props => h(CanvasBoundary, null, h(CardToolView, { ...props, ...actions, t }))),
          )
        }

        // The sidebar button for datasource import and analysis.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'xcharts-datasources',
            order: 17,
            label: () => '数据源',
            locale: NS,
          }, props => h(DataSourcePanelIcon, { size: props?.size })),
        )

        // The sidebar button. `order: 16` places it directly below the built-in
        // "plugins" entry, which registers at order 15.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 16,
            label: () => t('nav.title'),
            locale: NS,
          }, props => h(CanvasPanelIcon, { size: props?.size })),
        )
      },
    }

    exports.name = plugin.name
    exports.inject = plugin.inject
    exports.apply = plugin.apply
    // Test surface: the pure helpers behind the card renderers. Exporting them
    // keeps the render stand-in honest (it tests the real code, not a copy).
    exports.__pure = { sortRows, nextSortDir, normalizeOption, renderMarkdown, renderCode, dragLayout, groupMove, alignGroup, snapLayout, exportHtml, exportColors, drawExportCard, exportArtifacts, maxRow, filterTableRows, tableCsv, planToolbar, TOOLBAR_COST, TOOLBAR_ITEMS, TOOLBAR_FOLD_ORDER, TOOLBAR_NEVER_FOLDS, ICON_PATHS, TOOL_CARD_NAMES, inferCardType, toolCardArgs, toolCardResult, toolCardStatus, referenceMarker, referenceLine }
