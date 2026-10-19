    // ── Drag & resize on the 96-column grid ─────────────────────────────────

    const COLS = 96
    const MIN_W = 16
    const MIN_H = 2
    const EXTENT_COLS_CEIL = COLS * 16

    function dragLayout (layout, mode, dx, dy, bound = COLS) {
      const next = { ...layout }
      if (mode === 'move') {
        next.x = Math.max(0, Math.min(bound - next.w, layout.x + dx))
        next.y = Math.max(0, layout.y + dy)
      } else {
        const edge = mode === 'resize' ? 'se' : mode
        if (edge.includes('e')) next.w = Math.max(MIN_W, Math.min(COLS, bound - layout.x, layout.w + dx))
        if (edge.includes('s')) next.h = Math.max(MIN_H, Math.min(32, layout.h + dy))
        if (edge.includes('w')) {
          next.x = Math.max(0, Math.min(layout.x + layout.w - MIN_W, Math.max(layout.x + layout.w - COLS, layout.x + dx)))
          next.w = layout.x + layout.w - next.x
        }
        if (edge.includes('n')) {
          next.y = Math.max(0, Math.min(layout.y + layout.h - MIN_H, Math.max(layout.y + layout.h - 32, layout.y + dy)))
          next.h = layout.y + layout.h - next.y
        }
      }
      return next
    }

    function keyboardAction (key, shiftKey, ignoredTarget = false) {
      if (ignoredTarget) return null
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key]
      if (!delta) return null
      return { mode: shiftKey ? 'resize' : 'move', dx: delta[0], dy: delta[1] }
    }

    function groupMove (cards, dx, dy, bound = COLS) {
      dx = Math.max(-Math.min(...cards.map(c => c.layout.x)), Math.min(dx, bound - Math.max(...cards.map(c => c.layout.x + c.layout.w))))
      dy = Math.max(-Math.min(...cards.map(c => c.layout.y)), dy)
      return Object.fromEntries(cards.map(c => [c.id, { ...c.layout, x: c.layout.x + dx, y: c.layout.y + dy }]))
    }

    function alignGroup (cards, mode) {
      if (cards.length < 2) throw new Error('至少选择两张卡片 / Select at least two cards')
      const layouts = Object.fromEntries(cards.map(c => [c.id, { ...c.layout }]))
      const left = Math.min(...cards.map(c => c.layout.x)), top = Math.min(...cards.map(c => c.layout.y))
      const right = Math.max(...cards.map(c => c.layout.x + c.layout.w)), bottom = Math.max(...cards.map(c => c.layout.y + c.layout.h))
      if (mode === 'spaceX' || mode === 'spaceY') {
        if (cards.length < 3) throw new Error('等距分布至少需要三张卡片 / Select at least three cards')
        const axis = mode === 'spaceX' ? 'x' : 'y', size = axis === 'x' ? 'w' : 'h'
        const sorted = [...cards].sort((a, b) => a.layout[axis] - b.layout[axis])
        const start = sorted[0].layout[axis]
        const end = sorted.at(-1).layout[axis] + sorted.at(-1).layout[size]
        const gap = (end - start - sorted.reduce((sum, c) => sum + c.layout[size], 0)) / (cards.length - 1)
        if (gap < 0) throw new Error('空间不足，请先拉开首尾卡片 / Not enough space to distribute')
        let cursor = start
        for (const card of sorted) { layouts[card.id][axis] = Math.round(cursor); cursor += card.layout[size] + gap }
      } else {
        for (const c of cards) {
          if (mode === 'alignLeft') layouts[c.id].x = left
          if (mode === 'alignRight') layouts[c.id].x = right - c.layout.w
          if (mode === 'alignTop') layouts[c.id].y = top
          if (mode === 'alignBottom') layouts[c.id].y = bottom - c.layout.h
        }
      }
      return layouts
    }

    /** Nearest anchor per axis, with a six-screen-pixel tolerance. */
    function snapLayout (layout, cards, col, pitch, zoom, bound) {
      const next = { ...layout }, lines = { v: [], h: [] }
      for (const [axis, size, pixels, line] of [['x', 'w', col, 'v'], ['y', 'h', pitch, 'h']]) {
        let best = null
        for (const c of cards) for (const ratio of [0, 0.5, 1]) for (const own of [0, 0.5, 1]) {
          const target = c.layout[axis] + c.layout[size] * ratio
          const delta = target - layout[axis] - layout[size] * own
          const proposed = layout[axis] + delta
          if (Math.abs(delta * pixels * zoom) <= 6 && Number.isInteger(proposed) && proposed >= 0
            && (axis !== 'x' || proposed + layout.w <= bound)
            && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, target }
        }
        if (best) { next[axis] += best.delta; lines[line].push(best.target) }
      }
      return { layout: next, lines: lines.v.length || lines.h.length ? lines : null }
    }

    // ── Dialogs ─────────────────────────────────────────────────────────────
    //
    // The skeleton is header / body / footer: the BODY owns the scroll, so a
    // long list never carries the title and the close button off screen (that
    // was the previous single-section layout's real defect). The skeleton is
    // fixed; the SURFACE is not ours to redesign — the mask and the panel fill
    // stay exactly as they were (`rgba(0,0,0,.35)` over `--dsw-alias-bg-base`),
    // because a menu's translucent surface reads as a see-through dialog at
    // this size. The user asked for the previous look, so the previous values
    // are kept verbatim.
    const DIALOG = {
      overlay: {
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      },
      panel: (large, width, height) => ({
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
        borderRadius: RADIUS.lg,
        boxShadow: 'var(--dsw-elevation-panel, 0 10px 30px rgba(0,0,0,.28))',
        display: 'flex', flexDirection: 'column',
        width: width || (large ? 'min(1200px, 92vw)' : 'min(520px, 92vw)'),
        height: height || (large ? '86vh' : 'auto'), maxHeight: '90vh', minHeight: 0,
        // Hidden, not auto: the three sections clip themselves, so the body is
        // the only thing that scrolls.
        overflow: 'hidden',
      }),
      header: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px',
        minHeight: '28px', padding: '8px 8px 8px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
      },
      title: {
        flex: '1 1 auto', minWidth: 0, fontWeight: 500, fontSize: FS, lineHeight: '18px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      body: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '16px' },
      footer: {
        flex: '0 0 auto', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px',
        padding: '10px 16px',
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
      },
    }

    /**
     * Modal shell. Focus trap, Escape and focus restoration live here and are
     * unchanged from the verified implementation; only the surface and the
     * three-section skeleton are new. `initialFocus` lets a caller park the
     * first focus somewhere deliberate (a danger confirm parks it on Cancel).
     */
    function Dialog ({ title, onClose, children, footer, large = false, closeLabel = '关闭', initialFocus, width, height }) {
      const ref = useRef(null)
      useEffect(() => {
        const previous = document.activeElement
        const first = (initialFocus && ref.current?.querySelector?.(initialFocus))
          || ref.current?.querySelector?.('input[type="search"]')
          || ref.current?.querySelector?.('button, input, select, textarea, [role="combobox"]')
        first?.focus?.()
        const onKey = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
          if (event.key === 'Tab') {
            const nodes = [...(ref.current?.querySelectorAll?.('button:not(:disabled), input, select, textarea, [tabindex="0"]') || [])]
            if (!nodes.length) return
            if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus() }
            else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus() }
          }
        }
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('keydown', onKey); previous?.focus?.() }
      }, [onClose, initialFocus])
      return h('div', { style: DIALOG.overlay,
        onPointerDown: e => { if (e.target === e.currentTarget) onClose() } },
      h('section', { ref, role: 'dialog', 'aria-modal': true, 'aria-label': title, style: DIALOG.panel(large, width, height) },
        h('header', { 'data-xc-dialog-header': true, style: DIALOG.header },
          h('strong', { style: DIALOG.title }, title),
          h('button', {
            type: 'button', style: S.btnIcon, 'data-xc-dialog-close': true,
            onClick: onClose, 'aria-label': closeLabel, title: closeLabel,
          }, h(ToolIcon, { name: 'close', size: 14 }))),
        h('div', { 'data-xc-dialog-body': true, style: DIALOG.body }, children),
        footer ? h('footer', { 'data-xc-dialog-footer': true, style: DIALOG.footer }, footer) : null))
    }

    /**
     * Confirmation. The title IS the action («删除画布»), the body is reserved
     * for a consequence the user cannot see for themselves, and there is no
     * "确定要…吗？" preamble. Danger parks the initial focus on Cancel so Enter
     * (which fires the focused button) can never delete by reflex.
     */
    function ConfirmDialog ({ title, tone = 'default', confirmLabel, cancelLabel = '取消', onConfirm, onCancel, children }) {
      return h(Dialog, {
        title, onClose: onCancel, closeLabel: cancelLabel,
        initialFocus: '[data-xc-confirm-cancel]',
        footer: [
          h('button', { key: 'cancel', type: 'button', style: S.btn, 'data-xc-confirm-cancel': true, onClick: onCancel }, cancelLabel),
          h('button', {
            key: 'ok', type: 'button', 'data-xc-confirm-ok': true, onClick: onConfirm,
            style: tone === 'danger'
              ? { ...S.btnPrimary, background: 'var(--dsw-alias-state-error-primary, #d9534f)' }
              : S.btnPrimary,
          }, confirmLabel),
        ],
      }, children || null)
    }

    /**
     * Single-field prompt. Naming is a two-step action, not a four-step one: the
     * value is pre-selected so a rename is "type and Enter", the confirm button
     * is disabled while the value cannot be submitted, and the only message it
     * ever prints is a real validation failure (never a restatement of the
     * title).
     */
    function PromptDialog ({ title, defaultValue = '', placeholder, validate, onSubmit, onCancel, submitLabel = '保存', cancelLabel = '取消', emptyLabel = '不能为空。' }) {
      const inputRef = useRef(null)
      const focused = useRef(false)
      const [value, setValue] = useState(defaultValue)
      useEffect(() => {
        // Once. The Dialog re-runs its focus effect whenever `onClose` identity
        // changes, and re-selecting on every render would fight the typist.
        if (focused.current) return
        focused.current = true
        inputRef.current?.select?.()
      }, [])
      const problem = value => {
        if (String(value).trim() === '') return emptyLabel
        return typeof validate === 'function' ? validate(String(value)) : null
      }
      const message = value === defaultValue ? null : problem(value)
      const submit = () => {
        const failure = problem(value)
        if (failure) return
        onSubmit(String(value).trim())
      }
      return h(Dialog, {
        title, onClose: onCancel, closeLabel: cancelLabel,
        initialFocus: '[data-xc-prompt-input]',
        footer: [
          h('button', { key: 'cancel', type: 'button', style: S.btn, 'data-xc-prompt-cancel': true, onClick: onCancel }, cancelLabel),
          h('button', {
            key: 'ok', type: 'button', 'data-xc-prompt-ok': true, disabled: !!problem(value),
            style: problem(value) ? { ...S.btnPrimary, opacity: 0.5, cursor: 'default' } : S.btnPrimary,
            onClick: submit,
          }, submitLabel),
        ],
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('input', {
          ref: inputRef, type: 'text', value, placeholder: placeholder || '',
          'data-xc-prompt-input': true,
          'aria-label': title,
          style: { ...S.btn, width: '100%', boxSizing: 'border-box', textAlign: 'left',
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))' },
          onChange: event => setValue(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') { event.preventDefault(); submit() }
            else if (event.key === 'Escape') { event.preventDefault(); onCancel() }
          },
        }),
        message ? h('div', { role: 'alert', style: S.errorBox }, message) : null))
    }

    /**
     * Convert a card's grid layout to pixel geometry.
     *
     * Grid units are *fractions of the board width*, not fixed pixels, so the
     * board stays responsive: one column is `boardWidth / COLS`, one row a fixed
     * pixel pitch. This mirrors how the agent's layouts are authored.
     */
    function geometry (layout, boardWidth, rowPitch) {
      const col = boardWidth / COLS
      return {
        left: layout.x * col,
        top: layout.y * rowPitch,
        width: layout.w * col,
        height: layout.h * rowPitch,
      }
    }

    /**
     * Rectangle overlap, re-implemented here on purpose.
     *
     * The authoritative placement logic lives in `lib/grid.js`, but the browser
     * half may only require what the shell provides (`react`), so it cannot
     * import that module. This pair exists solely to *preview* whether a drop
     * will be adjusted — the server performs the real collision avoidance on
     * commit, so a drift between the two can only mis-colour a border, never
     * corrupt a layout.
     */
    function rectsOverlap (a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
    }

    function overlapsOther (cards, layout, excludeId) {
      for (const card of cards || []) {
        if (card.id === excludeId) continue
        if (rectsOverlap(card.layout, layout)) return true
      }
      return false
    }

    function Card ({ card, cards, boardWidth, rowPitch, onCommit, onContextMenu, t, theme, onSnapLines, selected, zoom = 1, colBound = COLS, snapEnabled = false, group = [], override, onGroupPreview, onToggleSelect, onFocus, scrollElement, showBadge = false, renaming = false, onRenameStart, onRenameCancel, onRename }) {
      // Mutable drag state lives in refs: registering window listeners once per
      // component (instead of on every drag-state change) removes the listener
      // churn that used to accompany each move.
      const dragRef = useRef(null)
      const previewRef = useRef(null)
      const metrics = useRef({ col: boardWidth / COLS, rowPitch })
      metrics.current = { col: boardWidth / COLS, rowPitch, zoom, colBound, snapEnabled, cards, group, onGroupPreview, onSnapLines, scrollElement }

      // Rendering inputs (state, so a move re-renders the card).
      const [dragging, setDragging] = useState(null) // 'move' | 'resize' | null
      const [preview, setPreview] = useState(null)
      // Grid-unit positions of the alignment lines that fired during this drag.
      // The board overlay draws them (they extend past this card's box).
      const [snaps, setSnaps] = useState(null)

      /**
       * The layout a drop committed, kept until the server confirms.
       *
       * Without this the card snapped back to its old position for one or more
       * frames between releasing the pointer and the PATCH + reload finishing —
       * the flicker the user reported. Rendering `landed` bridges that gap; the
       * effect below swaps it for the authoritative layout as soon as the parent
       * reloads, which is seamless whether or not the server adjusted the drop.
       */
      const [landed, setLanded] = useState(null)
      const [keyboardFocused, setKeyboardFocused] = useState(false)
      const [keyboardAnnouncement, setKeyboardAnnouncement] = useState('')
      const keyboardLayoutRef = useRef(card.layout)

      // The parent reloads after every commit, handing back a fresh card object;
      // at that point the server is authoritative, so drop the bridge and refresh
      // the base used by rapid repeated keyboard adjustments.
      useEffect(() => {
        keyboardLayoutRef.current = card.layout
        setLanded(null)
      }, [card.layout])

      // onCommit changes identity when the parent re-renders; the window
      // listeners below must always call the latest one.
      const commitRef = useRef(onCommit)
      commitRef.current = onCommit
      // Card tools stay out of the way until the card is hovered or focused:
      // six permanent glyphs per card read as noise on a full board.
      const [hovered, setHovered] = useState(false)

      const col = boardWidth / COLS
      const geom = geometry(override ?? preview ?? landed ?? card.layout, boardWidth, rowPitch)

      // While dragging, does the current preview overlap a sibling? Shown to the
      // user so an adjusted drop is not a surprise.
      const landingBlocked = preview ? overlapsOther(cards.filter(other => !group.some(c => c.id === other.id)), preview, card.id) : false

      const startDrag = useCallback((event, mode) => {
        if (event.button !== 0) return
        if (event.ctrlKey || event.metaKey) { event.stopPropagation(); event.preventDefault(); onToggleSelect?.(card.id); return }
        event.preventDefault()
        event.stopPropagation()
        if (typeof event.pointerId === 'number') event.currentTarget?.setPointerCapture?.(event.pointerId)
        dragRef.current = {
          mode,
          startX: event.clientX,
          startY: event.clientY,
          scrollX: scrollElement?.scrollLeft || 0,
          scrollY: scrollElement?.scrollTop || 0,
          layout: { ...card.layout },
          group: mode === 'move' && group.length > 1 ? group.map(c => ({ id: c.id, layout: { ...c.layout } })) : [],
          // Distinguish a click from a drag: a header press that never moves
          // should not count as a layout change (and must not fire a save).
          moved: false,
        }
        previewRef.current = null
        setDragging(mode)
      }, [card.layout, group, onToggleSelect, scrollElement])

      useEffect(() => {
        const onMove = event => {
          const drag = dragRef.current
          if (!drag) return
          const m = metrics.current
          const view = m.scrollElement?.getBoundingClientRect?.()
          if (view && m.scrollElement) {
            if (event.clientX > view.right - 28) m.scrollElement.scrollLeft += 18
            else if (event.clientX < view.left + 28) m.scrollElement.scrollLeft = Math.max(0, m.scrollElement.scrollLeft - 18)
            if (event.clientY > view.bottom - 28) m.scrollElement.scrollTop += 18
            else if (event.clientY < view.top + 28) m.scrollElement.scrollTop = Math.max(0, m.scrollElement.scrollTop - 18)
          }
          const dx = Math.round((event.clientX - drag.startX + (m.scrollElement?.scrollLeft || 0) - drag.scrollX) / (m.col * m.zoom))
          const dy = Math.round((event.clientY - drag.startY + (m.scrollElement?.scrollTop || 0) - drag.scrollY) / (m.rowPitch * m.zoom))
          let next = dragLayout(drag.layout, drag.mode, dx, dy, m.colBound)
          let guides = null
          if (drag.group.length > 1) {
            let layouts = groupMove(drag.group, dx, dy, m.colBound)
            if (m.snapEnabled) {
              const boxes = Object.values(layouts)
              const x = Math.min(...boxes.map(r => r.x)), y = Math.min(...boxes.map(r => r.y))
              const bounds = { x, y, w: Math.max(...boxes.map(r => r.x + r.w)) - x, h: Math.max(...boxes.map(r => r.y + r.h)) - y }
              const snapped = snapLayout(bounds, m.cards.filter(c => !drag.group.some(selected => selected.id === c.id)), m.col, m.rowPitch, m.zoom, m.colBound)
              layouts = groupMove(drag.group, layouts[card.id].x - drag.layout.x + snapped.layout.x - x, layouts[card.id].y - drag.layout.y + snapped.layout.y - y, m.colBound)
              guides = snapped.lines
            }
            next = layouts[card.id]
            drag.groupLayouts = layouts
            m.onGroupPreview?.(layouts)
          } else if (m.snapEnabled && drag.mode === 'move' && (dx || dy)) {
            const result = snapLayout(next, m.cards.filter(c => c.id !== card.id), m.col, m.rowPitch, m.zoom, m.colBound)
            next = result.layout
            guides = result.lines
          }
          if (drag.group.length < 2) m.onGroupPreview?.({ [card.id]: next })
          if (next.x !== drag.layout.x || next.y !== drag.layout.y || next.w !== drag.layout.w || next.h !== drag.layout.h) drag.moved = true
          previewRef.current = next
          setPreview(next)
          setSnaps(guides)
          m.onSnapLines?.(guides)
        }

        const onUp = () => {
          const drag = dragRef.current
          if (!drag) return
          dragRef.current = null
          setDragging(null)
          const current = previewRef.current
          previewRef.current = null
          setPreview(null)
          setSnaps(null)
          onSnapLines?.(null)
          // A press without movement is a click, not a layout change.
          if (current && drag.moved) {
            // Keep the dropped position on screen while the save round-trips.
            setLanded(current)
            keyboardLayoutRef.current = current
            commitRef.current(current, drag.groupLayouts)
          } else metrics.current.onGroupPreview?.(null)
        }

        const onCancel = () => {
          dragRef.current = null
          previewRef.current = null
          setDragging(null); setPreview(null); setSnaps(null)
          metrics.current.onSnapLines?.(null)
          metrics.current.onGroupPreview?.(null)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onCancel)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onCancel)
        }
      }, [])

      const onKeyboardAdjust = event => {
        if (event.altKey || event.ctrlKey || event.metaKey || dragRef.current) return
        const target = event.target
        const ignoredTarget = target !== event.currentTarget || target?.isContentEditable
          || /^(INPUT|TEXTAREA|SELECT)$/.test(String(target?.tagName || '').toUpperCase())
          || !!target?.closest?.('[contenteditable="true"], [role="textbox"], button')
        const action = keyboardAction(event.key, event.shiftKey, ignoredTarget)
        if (!action) return

        event.preventDefault()
        event.stopPropagation()
        const base = keyboardLayoutRef.current || card.layout
        const next = dragLayout(base, action.mode, action.dx, action.dy, colBound)
        const changed = next.x !== base.x || next.y !== base.y || next.w !== base.w || next.h !== base.h
        if (!changed) {
          setKeyboardAnnouncement(action.mode === 'move'
            ? '已到画布边界，位置未变。 / Canvas edge; position unchanged.'
            : '已到尺寸限制，尺寸未变。 / Size limit; dimensions unchanged.')
          return
        }

        keyboardLayoutRef.current = next
        setLanded(next)
        setKeyboardAnnouncement(action.mode === 'move'
          ? `已移动到第 ${next.x + 1} 列、第 ${next.y + 1} 行。 / Moved to column ${next.x + 1}, row ${next.y + 1}.`
          : `尺寸调整为 ${next.w} 列 × ${next.h} 行。 / Resized to ${next.w} columns by ${next.h} rows.`)
        commitRef.current(next, null)
      }


      // In-place rename bookkeeping. The header input commits on Enter AND on
      // blur, so a press of Enter followed by the browser's blur would otherwise
      // write the same title twice. Render-time arming (not state) keeps the
      // hook sequence unchanged: armed when the header flips into edit mode,
      // spent by whichever of the two handlers fires first.
      const renameRef = useRef({ armed: false, done: false })
      if (renaming && !renameRef.current.armed) renameRef.current = { armed: true, done: false }
      if (!renaming && renameRef.current.armed) renameRef.current = { armed: false, done: false }
      const commitRename = value => {
        if (!renaming || renameRef.current.done) return
        renameRef.current.done = true
        onRename?.(value)
      }
      const abortRename = () => {
        if (renameRef.current.done) return
        renameRef.current.done = true
        onRenameCancel?.()
      }

      const cardStyle = {
        ...S.card,
        left: `${geom.left}px`,
        top: `${geom.top}px`,
        width: `${geom.width}px`,
        height: `${geom.height}px`,
        ...(dragging ? S.cardDragging : null),
        ...(landingBlocked ? S.cardInvalid : null),
        // Multi-select highlight (phase 3): the same accent ring the drag
        // preview uses, so selected cards read as one group.
        ...(selected ? { outline: '2px solid var(--dsw-alias-brand-primary, #3b82f6)', outlineOffset: '1px' } : null),
        ...(keyboardFocused ? { outline: '2px solid var(--dsw-alias-brand-primary, #3b82f6)', outlineOffset: '2px', zIndex: 21 } : null),
      }

      // Header: drag handle, title, type badge.
      //
      // When the header is hidden the card still needs a drag handle, so the
      // same strip renders without its visible title/badge (a slim grip band
      // appears on hover) — otherwise a hidden header would make the card
      // impossible to move.
      const headerVisible = card.show_header !== false
      const header = h('div', {
        'data-xc-card-header': card.id,
        'data-xc-card-keyboard': card.id,
        role: 'group',
        tabIndex: 0,
        'aria-label': `${card.title}. 方向键移动，Shift+方向键调整大小 / Arrow keys move, Shift+arrow keys resize.`,
        'aria-keyshortcuts': 'ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown',
        style: {
          display: 'flex', alignItems: 'center', gap: '4px',
          cursor: dragging ? 'grabbing' : 'move',
          touchAction: 'none',
          flex: '0 0 auto',
          ...(headerVisible ? null : { height: '10px', opacity: 0.35 }),
        },
        onFocus: event => {
          setKeyboardFocused(true)
          if (event.target === event.currentTarget) {
            setKeyboardAnnouncement(`${card.title}: 方向键移动，Shift+方向键调整大小 / Use arrow keys to move; Shift+arrows resize.`)
          }
        },
        onBlur: event => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setKeyboardFocused(false)
            setKeyboardAnnouncement('')
          }
        },
        onKeyDown: onKeyboardAdjust,
        onPointerDown: e => startDrag(e, 'move'),
        // Double-click on the title used to open a prompt. Naming happens where
        // the name is: the title becomes an input of its own width.
        onDoubleClick: e => { e.stopPropagation(); onRenameStart?.(card.id) },
      },
      headerVisible
        ? [
          renaming
            ? h('input', {
              key: 'rename',
              type: 'text',
              defaultValue: card.title,
              autoFocus: true,
              'data-xc-card-rename-input': card.id,
              'aria-label': `${t('card.rename')}: ${card.title}`,
              style: { ...S.btn, flex: '1 1 auto', minWidth: 0, textAlign: 'left', height: '20px',
                border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))' },
              // The header is the drag handle; a press in the input is editing.
              onPointerDown: e => e.stopPropagation(),
              onClick: e => e.stopPropagation(),
              onFocus: event => event.target.select?.(),
              onKeyDown: event => {
                if (event.key === 'Enter') { event.preventDefault(); commitRename(event.currentTarget.value) }
                else if (event.key === 'Escape') { event.preventDefault(); abortRename() }
                else event.stopPropagation()
              },
              onBlur: event => commitRename(event.currentTarget.value),
            })
            : h('div', { key: 'title', style: { ...S.cardTitle, flex: '1 1 auto' }, title: card.title }, card.title),
          h('button', {
            type: 'button',
            title: t('canvas.focus'),
            'data-xc-focus': card.id,
            // Visible while the card is hovered, focused or keyboard-driven.
            style: { ...S.btnIcon, width: '22px', height: '22px', opacity: hovered || keyboardFocused ? 1 : 0, pointerEvents: hovered || keyboardFocused ? 'auto' : 'none' },
            onPointerDown: e => e.stopPropagation(),
            onClick: e => { e.stopPropagation(); onFocus(card.id) },
          }, h(ToolIcon, { name: 'expand', size: 14 })),
          // The type label is opt-in (canvas setting `badges`): for a reader who
          // can see the card it is redundant, and it competed with the title.
          showBadge ? h('span', { key: 'badge', style: S.cardBadge, 'data-xc-card-badge': card.type }, t(`card.${card.type}`)) : null,
        ]
        : null)

      return h('div', {
        // Test hook: the geometry checker selects cards by this attribute rather
        // than by style, and the resize grip is a nested div that a style-based
        // selector would wrongly pick up as a card.
        'data-xc-card': card.id,
        'data-xc-title': card.title,
        style: cardStyle,
        onPointerEnter: () => setHovered(true),
        onPointerLeave: () => setHovered(false),
        onClick: event => { if ((event.ctrlKey || event.metaKey) && !event.target?.closest?.('[data-xc-card-header], [data-xc-resize]')) { event.stopPropagation(); onToggleSelect?.(card.id) } },
        onContextMenu: event => { event.preventDefault(); event.stopPropagation(); onContextMenu(event, card) },
      },
      // Colour marker: a thin accent line the context menu's "标记颜色" writes.
      // 2px, slightly inset — readable as a tag without shouting.
      card.color && accentHex(card.color)
        ? h('div', {
          'data-xc-color-bar': card.color,
          style: {
            position: 'absolute', top: '2px', left: '6px', width: '26px', height: '2px',
            background: accentHex(card.color), borderRadius: '1px',
            opacity: 0.85, pointerEvents: 'none',
          },
        })
        : null,
      header,
      h('div', { style: S.cardBody }, h(CardBody, { card, t, theme })),
      h('div', {
        role: 'status', 'aria-live': 'polite', 'aria-atomic': true,
        'data-xc-keyboard-status': card.id,
        style: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: 0, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 },
      }, keyboardAnnouncement),
      ...['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => h('div', {
        key: edge,
        'data-xc-resize': card.id,
        'data-xc-resize-edge': edge,
        title: t('card.resize'),
        style: {
          position: 'absolute', zIndex: 3, touchAction: 'none',
          ...(edge.includes('n') ? { top: 0 } : edge.includes('s') ? { bottom: 0 } : { top: '10px', bottom: '10px' }),
          ...(edge.includes('w') ? { left: 0 } : edge.includes('e') ? { right: 0 } : { left: '10px', right: '10px' }),
          width: edge === 'n' || edge === 's' ? 'auto' : edge.length === 2 ? '12px' : '6px',
          height: edge === 'e' || edge === 'w' ? 'auto' : edge.length === 2 ? '12px' : '6px',
          cursor: edge.length === 1 ? (edge === 'n' || edge === 's' ? 'ns-resize' : 'ew-resize') : (edge === 'ne' || edge === 'sw' ? 'nesw-resize' : 'nwse-resize'),
        },
        onPointerDown: e => startDrag(e, edge),
      })))
    }
