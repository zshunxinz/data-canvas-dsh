    // ── Shared UI kit ───────────────────────────────────────────────────────
    //
    // Small presentational pieces used by more than one workspace. They exist so
    // the datasource page, the query pane and the canvas cards express the same
    // pattern once: a section label with right-aligned actions, a link button, a
    // collapsible panel, an ellipsised value and a status strip.
    //
    // Everything here is theme-token only (no literal colours) and takes no
    // business decisions — that keeps the sections that own data logic readable.

    const UI = {
      label: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', fontWeight: 500 },
      ellipsis: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      column: { display: 'flex', flexDirection: 'column', gap: 6 },
    }

    /** A section heading with optional right-aligned actions on the same line. */
    function SectionLabel ({ label, actions, style }) {
      return h('div', { style: { ...UI.row, minHeight: 22, ...(style || {}) } },
        h('span', { style: UI.label }, label),
        h('span', { style: { flex: 1 } }),
        ...(actions || []))
    }

    /** Low-emphasis inline action (全选 / 清空 / 添加条件 / 移除 …). */
    function LinkButton ({ label, title, style, ...rest }) {
      return h('button', {
        type: 'button',
        className: 'xc-ui-link',
        'aria-label': rest['aria-label'] || title || label,
        title: title || label,
        // `style` is merged, not replaced: a caller that only wants to nudge the
        // layout (alignSelf …) must not lose the link look with it.
        style: { ...S.btn, border: 0, background: 'transparent', color: 'var(--dsw-alias-brand-primary)', padding: '2px 4px', height: 'auto', fontSize: '12px', ...(style || {}) },
        ...rest,
      }, label)
    }

    /** One-line value that keeps its full text available on hover. */
    function EllipsisText ({ text, title, style }) {
      return h('span', { title: title ?? text, style: { ...UI.ellipsis, ...(style || {}) } }, text)
    }

    /** Collapsible panel; the summary carries the label, the body the detail. */
    function Disclosure ({ label, children, data, style, onKeyDown }) {
      return h('details', { ...(data || {}), style: { ...UI.label, ...(style || {}) }, onKeyDown },
        h('summary', { style: { cursor: 'pointer' } }, label),
        children)
    }

    /** Page-level feedback; `tone` picks the alert vs status semantics. */
    function StatusLine ({ tone = 'status', children, actions, style, ...rest }) {
      const critical = tone === 'alert'
      return h('div', {
        ...rest,
        role: critical ? 'alert' : 'status',
        'aria-live': critical ? 'assertive' : 'polite',
        style: {
          flex: '0 0 auto',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '6px 16px',
          fontSize: '12px',
          ...(critical ? S.errorBox : null),
          ...(style || {}),
        },
      }, ...children, ...(actions || []))
    }

    /** 浮动消息：不占用布局高度，可关闭；error 常驻，info 自动消失。 */
    function ToastStack ({ items = [], onDismiss }) {
      if (!items.length) return null
      return h('div', {
        'data-xc-toasts': true,
        style: { position: 'fixed', right: '16px', bottom: '72px', zIndex: 1500, display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: 'min(440px, 92vw)' },
      }, ...items.map(item => h('div', {
        key: item.id,
        role: item.tone === 'alert' ? 'alert' : 'status',
        'aria-live': item.tone === 'alert' ? 'assertive' : 'polite',
        ...(item.data || {}),
        style: {
          display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '8px 10px', borderRadius: RADIUS.md,
          background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))', color: 'inherit',
          border: '1px solid ' + (item.tone === 'alert' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,.3))'),
          boxShadow: 'var(--dsw-elevation-panel, 0 10px 30px rgba(0,0,0,.28))', fontSize: 12, lineHeight: 1.5,
        },
      },
      h('span', { style: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' } }, item.text),
      item.actions || null,
      h('button', {
        type: 'button', 'aria-label': '关闭消息', 'data-xc-toast-close': true,
        style: { ...S.btn, height: '20px', padding: '0 6px', flex: '0 0 auto', fontSize: 12 },
        onClick: () => onDismiss?.(item.id),
      }, '×'))))
    }

    /** 一行代码接入浮动消息：页面只关心 push，渲染交给 renderToasts。 */
    function useToastStack () {
      const [toasts, setToasts] = useState([])
      const pushToast = (text, tone = 'info', data = {}, actions = null) => {
        if (!text) return
        const id = Math.random().toString(36).slice(2)
        setToasts(current => current.some(item => item.text === text) ? current : [...current, { id, text, tone, data, actions }])
        if (tone !== 'alert' && typeof setTimeout === 'function') setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), 4000)
      }
      const dismissToast = id => setToasts(current => current.filter(item => item.id !== id))
      return { toasts, pushToast, dismissToast, renderToasts: () => h(ToastStack, { items: toasts, onDismiss: dismissToast }) }
    }

    /** 表格/面板上的浮层容器：统一边框、阴影、圆角与定位。 */
    function PanelPopover ({ children, width = '220px', top = '30px', style, ...rest }) {
      return h('div', {
        ...rest,
        style: {
          position: 'absolute', right: '8px', top, zIndex: 6, width, maxHeight: '60vh', overflow: 'auto',
          background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))', color: 'inherit',
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))', borderRadius: RADIUS.sm,
          boxShadow: 'var(--dsw-elevation-panel, 0 10px 30px rgba(0,0,0,.28))', padding: '8px', display: 'flex', flexDirection: 'column', gap: '2px',
          ...(style || {}),
        },
      }, children)
    }

    /** Empty state: a heading plus one actionable line, never an illustration. */
    function EmptyState ({ title, hint, action, style, ...rest }) {
      return h('div', { ...rest, style: { ...S.emptyBox, lineHeight: 1.6, ...(style || {}) } },
        h('strong', null, title),
        hint ? h('div', { style: { ...S.muted, marginTop: 6 } }, hint) : null,
        action || null)
    }

    // ── Page skeleton ───────────────────────────────────────────────────────
    //
    // The datasource workspace and the canvas workspace are two `main` slots of
    // one product, so neither may invent its own header, list or row. These
    // pieces are that single skeleton: a page that hard-codes a width, a font
    // size or a row radius of its own is a bug, not a variation. Everything here
    // is theme-token only and takes no business decisions.

    /** Chrome shared by both pages: focus rings, row states, scrollbars. */
    const XC_UI_CSS = `
      .xc-ui button:focus-visible,.xc-ui summary:focus-visible,.xc-ui input:focus-visible,.xc-ui a:focus-visible,.xc-ui [tabindex="0"]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:2px}
      .xc-ui [data-xc-list-row]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
      .xc-ui [data-xc-list-row][data-selected="true"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
      .xc-ui [data-xc-list-row-main]:focus-visible,.xc-ui [data-xc-list-row-input]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:-2px}
      .xc-ui [data-xc-list-scroll]{scrollbar-width:thin}
      .xc-ui .xc-ui-link:hover:not(:disabled){text-decoration:underline}
      @media(max-width:640px){
        .xc-ui [data-xc-split]{flex-direction:column}
        .xc-ui [data-xc-side-list]{width:auto!important;flex:0 0 auto!important;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l1);max-height:45%}
        .xc-ui [data-xc-side-list="collapsed"]{display:none}
      }
    `

    /** Page frame: one outer box, never a second scroll container. */
    function PageShell ({ className, data, children }) {
      return h('div', { ...(data || {}), className, style: S.pageShell }, ...(children || []).filter(Boolean))
    }

    /**
     * Full-width header.
     *
     * It spans both columns on purpose: the 1px rule then runs edge to edge
     * (instead of stopping where the side list starts), and the header's width no
     * longer changes when the list folds — which is what used to unfold toolbar
     * items the moment a user collapsed the canvas list.
     */
    function PageHeader ({ toggle, title, meta, metaData, actions, data, headerRef }) {
      return h('header', { ...(data || {}), ref: headerRef, 'data-xc-page-header': 'true', style: S.pageHeader },
        toggle || null,
        h('h2', { style: S.pageTitle, title }, title),
        meta ? h('span', { ...(metaData || {}), style: S.headerMeta }, meta) : null,
        h('span', { style: S.headerSpacer }),
        ...(actions || []).filter(Boolean))
    }

    /**
     * Collapsible side list: identity line, optional tools, one create entry,
     * then the rows. Folded it keeps its place in the tree (scroll position and
     * search text survive) but is hidden and out of the tab order.
     */
    function SideList ({ collapsed, title, count, countData, headerActions, tools, primaryAction, empty, children, data, listData }) {
      const rows = (Array.isArray(children) ? children : [children]).filter(Boolean)
      const showHeader = SHOW_LIST_TITLE
      return h('div', {
        ...(data || {}),
        'data-xc-side-list': collapsed ? 'collapsed' : 'expanded',
        // A hidden title line must not cost the region its name: the list stays a
        // labelled navigation landmark either way.
        role: 'navigation',
        'aria-label': title,
        style: S.sideList(collapsed, showHeader),
      },
      showHeader
        ? h('div', { 'data-xc-list-header': 'true', style: S.listHeaderRow },
          h('span', { style: S.listHeaderTitle, title }, title),
          SHOW_LIST_COUNT && count !== undefined && count !== null
            ? h('span', { ...(countData || {}), style: S.listHeaderCount }, String(count))
            : null,
          h('span', { style: { flex: '1 1 auto', minWidth: 0 } }),
          ...(headerActions || []).filter(Boolean))
        : null,
      // One padded column holds the tools, the create entry and the rows, so the
      // button and the selected row are exactly the same width.
      h('div', { 'data-xc-list-body': 'true', style: S.listBody },
        tools ? h('div', { style: S.listTools }, ...(Array.isArray(tools) ? tools : [tools])) : null,
        primaryAction || null,
        h('div', { ...(listData || {}), 'data-xc-list-scroll': 'true', style: S.listScroll },
          rows.length ? rows : (empty || null))))
    }

    /** The one create entry of a list, in the shell's raised-card style. */
    function ListPrimaryAction ({ label, icon, onClick, disabled, data, title }) {
      return h('button', {
        type: 'button',
        disabled: disabled || undefined,
        title: title || label,
        'data-xc-list-primary': 'true',
        ...(data || {}),
        style: { ...S.listPrimary, ...(disabled ? { opacity: 0.55, cursor: 'default' } : null) },
        ...(disabled ? {} : hoverable('var(--dsw-alias-button-floating-hover, var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)))', 'var(--dsw-alias-button-elevated-fill, transparent)')),
        onClick,
      },
      icon ? h(ToolIcon, { name: icon, size: 16 }) : null,
      h('span', { style: UI.ellipsis }, label))
    }

    /**
     * One list row.
     *
     * A wrapper carries the state fill (so it also covers the trailing ⋯ button)
     * and the clickable part is a real `<button>`: the datasource list could
     * always be reached by keyboard, the canvas list could not.
     */
    function ListRow ({ title, meta, selected, onClick, onContextMenu, titleAttr, actions, data, buttonData, disabled, buttonRef }) {
      return h('div', {
        ...(data || {}),
        'data-xc-list-row': 'true',
        'data-selected': selected ? 'true' : 'false',
        style: S.listRow,
      },
      h('button', {
        type: 'button',
        ref: buttonRef,
        disabled: disabled || undefined,
        'data-xc-list-row-main': 'true',
        ...(buttonData || {}),
        'aria-current': selected ? 'true' : undefined,
        title: titleAttr === undefined ? title : titleAttr,
        style: S.listRowMain,
        onClick,
        onContextMenu,
      },
      h('span', { style: S.listRowTitle }, title),
      meta ? h('span', { style: S.listRowMeta }, meta) : null),
      (actions || []).filter(Boolean).length
        ? h('div', { style: S.listRowAction }, ...(actions || []).filter(Boolean))
        : null)
    }

    /** A row being renamed in place: same box, an input instead of the label. */
    function ListRowInput ({ value, defaultValue, ariaLabel, data, onKeyDown, onBlur, onFocus, onChange, disabled, inputRef, autoFocus = true }) {
      return h('div', { ...(data || {}), 'data-xc-list-row': 'true', 'data-selected': 'true', style: S.listRow },
        h('input', {
          type: 'text',
          ref: inputRef,
          'data-xc-list-row-input': 'true',
          value,
          defaultValue,
          autoFocus: autoFocus || undefined,
          disabled: disabled || undefined,
          'aria-label': ariaLabel,
          style: S.listRowInput,
          onFocus: onFocus || (event => event.target.select?.()),
          onKeyDown,
          onBlur,
          onChange,
        }))
    }

    // ── Popups: one placement rule for every floating surface ───────────────
    //
    // Menus and dropdowns are rendered inside the page, not inside the card that
    // opened them, and they must never leave the viewport. A popup's coordinates
    // depend on which ancestor establishes its containing block: `position:
    // fixed` is relative to the viewport UNLESS a transformed or filtered
    // ancestor intervenes (the zoomed board has `transform: scale()`, a card has
    // `backdrop-filter`). Rather than guess, the placement helper walks up from
    // the trigger, measures against the container it actually finds, and reports
    // the matching `position` value.

    let popupSeq = 0

    function styleOf (el) {
      try {
        return el && typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
      } catch { return null }
    }

    /** The nearest ancestor that makes `position: fixed` mean "inside it". */
    function popupContainer (el) {
      let node = el?.parentElement
      while (node && node.nodeType === 1) {
        const style = styleOf(node)
        if (!style) return null
        if (style.transform !== 'none' || style.filter !== 'none'
          || style.backdropFilter !== 'none' || style.perspective !== 'none') return node
        node = node.parentElement
      }
      return null
    }

    /** Scale factor a length inside `el` is multiplied by on its way to screen. */
    function elementScale (el) {
      const transform = styleOf(el)?.transform
      if (!transform || transform === 'none') return 1
      const match = /matrix\(([^)]+)\)/.exec(transform)
      if (!match) return 1
      const a = Math.abs(Number(match[1].split(',')[0]))
      return a > 0 ? a : 1
    }

    function containerScale (container) {
      let scale = 1
      let node = container
      while (node && node.nodeType === 1) {
        scale *= elementScale(node)
        node = node.parentElement
      }
      return scale > 0 ? scale : 1
    }

    function viewportSize () {
      const width = Number(globalThis?.innerWidth ?? globalThis?.window?.innerWidth) || 1024
      const height = Number(globalThis?.innerHeight ?? globalThis?.window?.innerHeight) || 768
      return { width, height }
    }

    /** Measure a trigger once: its box, its container, and the container's origin. */
    function anchorBox (el) {
      const rect = el?.getBoundingClientRect?.()
      if (!rect) return null
      const container = popupContainer(el)
      const base = container?.getBoundingClientRect?.() || null
      return { rect, container, base, scale: container && base ? containerScale(container) : 1 }
    }

    /**
     * Where to put a `width` x `height` panel so it hugs the anchor and stays
     * on screen. Returns local coordinates for the returned `position` value.
     */
    function placePopup (anchor, { width = 0, height = 0, gap = 4, align = 'start', margin = 8 } = {}) {
      const view = viewportSize()
      const scale = anchor.scale || 1
      const originX = anchor.base ? anchor.base.left : 0
      const originY = anchor.base ? anchor.base.top : 0
      const panelW = (Number(width) || 0) * scale
      const panelH = (Number(height) || 0) * scale
      let left = align === 'end' ? anchor.rect.right - panelW : anchor.rect.left
      let top = anchor.rect.bottom + gap * scale
      if (top + panelH > view.height - margin) {
        const above = anchor.rect.top - panelH - gap * scale
        top = above >= margin ? above : Math.max(margin, view.height - panelH - margin)
      }
      left = Math.max(margin, Math.min(left, view.width - panelW - margin))
      return {
        position: anchor.container ? 'absolute' : 'fixed',
        left: Math.round((left - originX) / scale),
        top: Math.round((top - originY) / scale),
        maxHeight: Math.max(96, Math.round((view.height - margin * 2) / scale)),
      }
    }

    /** Same rule for a popup that only knows a point (a context menu). */
    function placePopupAt (x, y, { width = 0, height = 0, margin = 8 } = {}) {
      const view = viewportSize()
      return {
        left: Math.max(margin, Math.min(Number(x) || 0, Math.max(margin, view.width - width - margin))),
        top: Math.max(margin, Math.min(Number(y) || 0, Math.max(margin, view.height - height - margin))),
        maxHeight: Math.max(96, view.height - margin * 2),
      }
    }

    /**
     * Self-drawn select.
     *
     * The native control cannot be themed: `<option>` popups are painted by the
     * operating system or browser, so in a dark shell they appeared as a light
     * system panel with system-blue highlighting — no stylesheet reaches them.
     * This reuses the context menu's surface, row height, and selection fill, so
     * a dropdown and a right-click menu read as one object.
     *
     * Focus stays on the trigger and the listbox is driven through
     * `aria-activedescendant`: that is what a screen reader expects from a
     * combobox, and it keeps Tab moving through the page normally.
     */
    function Select ({ value, options, onChange, ariaLabel, title, disabled = false, width, align = 'start', dataAttrs = {}, triggerStyle, emptyLabel = '' }) {
      const triggerRef = useRef(null)
      const panelRef = useRef(null)
      const idRef = useRef(null)
      if (idRef.current === null) idRef.current = `xc-select-${++popupSeq}`
      const [open, setOpen] = useState(false)
      const [active, setActive] = useState(0)
      const [pos, setPos] = useState(null)
      const items = (options || []).map(option => (
        option && typeof option === 'object' ? option : { value: option, label: String(option) }
      ))
      const same = (a, b) => String(a) === String(b)
      const current = Math.max(0, items.findIndex(item => same(item.value, value)))

      const step = (from, delta) => {
        if (!items.length) return from
        let index = from
        for (let i = 0; i < items.length; i++) {
          index = (index + delta + items.length) % items.length
          if (!items[index].disabled) return index
        }
        return from
      }
      const choose = item => {
        if (!item || item.disabled) return
        onChange?.(item.value)
        setOpen(false)
        triggerRef.current?.focus?.()
      }

      // Place once the panel has a real size; a popup that overflows the window
      // is worse than one that flips above its trigger. Laid out before paint so
      // the first frame is already in position (a `useEffect` here would flash
      // the panel at its placeholder coordinates).
      useLayoutEffect(() => {
        if (!open) return
        const place = () => {
          const anchor = anchorBox(triggerRef.current)
          const panel = panelRef.current
          if (!anchor || !panel) return
          const box = panel.getBoundingClientRect?.() || {}
          setPos(placePopup(anchor, {
            width: panel.offsetWidth || box.width || 0,
            height: panel.offsetHeight || box.height || 0,
            align,
          }))
        }
        place()
        // Any scroll would slide the trigger out from under the panel.
        const close = () => setOpen(false)
        window.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        window.addEventListener('blur', close)
        return () => {
          window.removeEventListener('scroll', close, true)
          window.removeEventListener('resize', close)
          window.removeEventListener('blur', close)
        }
      }, [open, align])

      useEffect(() => {
        if (!open) return
        const onDown = event => {
          if (triggerRef.current?.contains?.(event.target)) return
          if (panelRef.current?.contains?.(event.target)) return
          setOpen(false)
        }
        window.addEventListener('pointerdown', onDown, true)
        return () => window.removeEventListener('pointerdown', onDown, true)
      }, [open])

      // Keep the highlighted row visible without scrolling the page.
      useEffect(() => {
        if (!open) return
        panelRef.current?.children?.[active]?.scrollIntoView?.({ block: 'nearest' })
      }, [open, active])

      const onKeyDown = event => {
        if (disabled) return
        const key = event.key
        const typeAhead = () => {
          if (key.length !== 1 || !/\S/.test(key)) return false
          const hit = items.findIndex(item => String(item.label ?? '').toLowerCase().startsWith(key.toLowerCase()))
          if (hit < 0) return false
          event.preventDefault()
          if (open) setActive(hit)
          else choose(items[hit])
          return true
        }
        if (open) {
          if (key === 'ArrowDown') { event.preventDefault(); setActive(index => step(index, 1)) }
          else if (key === 'ArrowUp') { event.preventDefault(); setActive(index => step(index, -1)) }
          else if (key === 'Home') { event.preventDefault(); setActive(step(-1, 1)) }
          else if (key === 'End') { event.preventDefault(); setActive(step(0, -1)) }
          else if (key === 'Enter' || key === ' ') { event.preventDefault(); choose(items[active]) }
          else if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
          else if (key === 'Tab') setOpen(false)
          else typeAhead()
          return
        }
        if (key === 'Enter' || key === ' ' || (event.altKey && key === 'ArrowDown')) {
          event.preventDefault()
          setActive(current)
          setOpen(true)
        } else if (key === 'ArrowDown' || key === 'ArrowUp') {
          // Closed, a native select moves the value with the arrows; keep that.
          event.preventDefault()
          const next = step(current, key === 'ArrowDown' ? 1 : -1)
          if (next !== current) choose(items[next])
        } else typeAhead()
      }

      const selected = items[current] || null
      return h(Fragment, null,
        h('button', {
          ref: triggerRef,
          type: 'button',
          role: 'combobox',
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': open ? idRef.current : undefined,
          'aria-activedescendant': open ? `${idRef.current}-${active}` : undefined,
          'aria-label': ariaLabel,
          title: title || ariaLabel,
          'aria-disabled': disabled ? 'true' : undefined,
          disabled: disabled || undefined,
          'data-xc-select': 'true',
          ...(dataAttrs || {}),
          style: { ...S.btn, justifyContent: 'space-between', gap: '2px', ...(width ? { width } : null), ...(triggerStyle || {}) },
          onKeyDown,
          onClick: () => { if (!disabled) { setActive(current); setOpen(value => !value) } },
          onPointerEnter: event => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))' },
          onPointerLeave: event => { if (!open) event.currentTarget.style.background = 'transparent' },
        },
        h('span', { style: { ...UI.ellipsis, flex: '1 1 auto', textAlign: 'left' } }, selected ? selected.label : emptyLabel),
        h('span', { style: { flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', opacity: 0.7 } },
          h(ToolIcon, { name: 'caret', size: 12 }))),
        open
          ? h('div', {
            ref: panelRef,
            id: idRef.current,
            role: 'listbox',
            'aria-label': ariaLabel,
            'data-xc-select-panel': 'true',
            style: {
              ...S.menu,
              ...(pos || { left: -9999, top: -9999 }),
              minWidth: width || undefined,
              maxWidth: 'min(280px, calc(100vw - 16px))',
              maxHeight: pos?.maxHeight,
              overflowY: 'auto',
              overflowX: 'hidden',
            },
            onPointerDown: event => event.stopPropagation(),
          }, ...items.map((item, index) => {
            const isSelected = same(item.value, value)
            const isActive = index === active
            return h('div', {
              key: `${idRef.current}-opt-${index}`,
              id: `${idRef.current}-${index}`,
              role: 'option',
              'aria-selected': isSelected ? 'true' : 'false',
              'aria-disabled': item.disabled ? 'true' : undefined,
              'data-xc-option': String(item.value),
              'data-active': isActive ? 'true' : undefined,
              'data-selected': isSelected ? 'true' : undefined,
              style: {
                ...S.menuItem(false),
                ...(isSelected ? { background: SURFACE.selected, color: 'var(--dsw-alias-label-primary)' } : null),
                ...(isActive ? { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))' } : null),
                ...(item.disabled ? { opacity: 0.45, cursor: 'default' } : null),
              },
              onPointerEnter: () => setActive(index),
              onClick: () => choose(item),
            },
            h('span', { style: { ...UI.ellipsis, flex: '1 1 auto' } }, item.label),
            isSelected
              ? h('span', { style: { flex: '0 0 auto', display: 'inline-flex', alignItems: 'center' } },
                h(ToolIcon, { name: 'check', size: 12 }))
              : null)
          }))
          : null)
    }

