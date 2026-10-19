    // ── Styles (theme-variable driven so a scheme switch keeps working) ─────

    // ── Styles ──────────────────────────────────────────────────────────────
    //
    // Numbers here are copied from the shell's own sidebar CSS rather than
    // invented, so the panel sits on the app's type scale instead of a larger
    // one. Measured from `dsh-client-ui-sidebar`:
    //   .hHd-Xa_root        font-size: 14px
    //   .hHd-Xa_iconButton  28x28, --dsw-radius-sm, border:none, background:0 0,
    //                       colour --dsw-alias-label-secondary,
    //                       hover background --dsw-alias-interactive-bg-hover
    //   .hHd-Xa_panelRow    min-height 36px, padding 7px 8px, gap 8px,
    //                       line-height 22px, --dsw-radius-md
    //   .hHd-Xa_panelList   gap 4px, margin-bottom 8px
    //   .hHd-Xa_panelTitle  ellipsis, no extra weight
    // Fixed sizes rather than the `--dsw-font-base-16-*` token: that token's
    // name carries its own size (16px), which rendered visibly larger than the
    // shell's 13–14px chrome. The shell's sidebar root is 14px, so use 13px for
    // body text and 12px for secondary.
    const FS = '13px'
    const FS_SM = '12px'
    // Fallbacks are the shell's real token values (measured in
    // `dsh-client-ui-theme`): sm 8 / md 12 / lg 16. The earlier 6/8/10 were the
    // fallbacks copied into the design doc as if they were the token values,
    // which is how a hard-coded 6px row radius crept into the datasource list.
    const RADIUS = {
      sm: 'var(--dsw-radius-sm, 8px)',
      md: 'var(--dsw-radius-md, 12px)',
      lg: 'var(--dsw-radius-lg, 16px)',
    }
    // Translucent surfaces. The `--dsw-alias-bg-layer-*` tokens are opaque theme
    // fills (measured: rgb(255,255,255)), which hid the board behind each card,
    // so the card surface is built from an alpha channel instead.
    const SURFACE = {
      // 更淡更透明（用户反馈）：卡片只蒙一层 2.5% 的墨色，hover/选中 6%/8%。
      card: 'color-mix(in srgb, var(--dsw-alias-label-primary, #888) 2.5%, transparent)',
      cardHover: 'color-mix(in srgb, var(--dsw-alias-label-primary, #888) 6%, transparent)',
      selected: 'color-mix(in srgb, var(--dsw-alias-label-primary, #888) 8%, transparent)',
      hover: 'color-mix(in srgb, var(--dsw-alias-label-primary, #888) 5%, transparent)',
    }

    /**
     * Accent colours a card can carry. Kept in step with `ALLOWED_COLORS` in
     * `lib/store.js`, which rejects anything outside this set — the value is
     * written into a style attribute, so free-form input would be an injection
     * surface.
     */
    const ACCENTS = {
      default: null,
      red: '#e5484d',
      orange: '#f76b15',
      yellow: '#e8b339',
      green: '#30a46c',
      blue: '#0091ff',
      purple: '#8e4ec6',
      gray: '#8b8d98',
    }
    const accentHex = name => (name && ACCENTS[name]) || null

    // ── Page skeleton ───────────────────────────────────────────────────────
    //
    // Both workspaces are the same three pieces: one full-width header, one
    // collapsible side list, one content pane. The numbers are the shell's own
    // (48px header with a 16px/500 title, 36px section row, 38px "new" card
    // button, 28x28 ghost icon buttons, 12px radius rows) so the two pages
    // cannot drift apart again — the previous 240 vs 220 wide lists and the
    // 18px vs 13px headers came from each page inventing its own value.
    const SIDE_LIST_WIDTH = 240
    const PAGE_HEADER_HEIGHT = 48
    // Two-line list row: 5 + 18 + 2 + 15 + 5. Fixed rather than min-height so a
    // long name and a short one occupy the same box in both lists.
    const LIST_ROW_HEIGHT = 45
    // A search box only earns its place once the list stops fitting; one
    // threshold for both lists, so the two toolbars appear at the same moment.
    const LIST_SEARCH_MIN = 8
    // User request (2026-10-17): the list identity line shows only its name — the
    // row count next to it is temporarily hidden on both pages. The pages still
    // pass `count`, so restoring it is this one flag.
    const SHOW_LIST_COUNT = false
    // User request (2026-10-17, follow-up): hide the whole identity line as well.
    // Both pages already name themselves in the page header, so a second copy
    // above the list carried nothing new. The list keeps its accessible name
    // (`aria-label`) either way; restoring the visible line is this flag.
    const SHOW_LIST_TITLE = false

    const S = {
      // One outer frame: the page never scrolls, only its panes do.
      pageShell: {
        height: '100%', width: '100%', display: 'flex', flexDirection: 'column',
        boxSizing: 'border-box', overflow: 'hidden', minHeight: 0,
      },
      // The header spans BOTH columns: its rule has no break where the side list
      // begins, and its width no longer depends on whether the list is folded.
      pageHeader: {
        flex: '0 0 auto', height: `${PAGE_HEADER_HEIGHT}px`, display: 'flex', alignItems: 'center',
        gap: '8px', padding: '0 16px', flexWrap: 'nowrap', overflow: 'hidden', minWidth: 0,
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      pageTitle: {
        margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: '22px',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        minWidth: 0, flex: '0 1 auto',
      },
      headerMeta: {
        fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, inherit)',
        whiteSpace: 'nowrap', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums',
      },
      headerSpacer: { flex: '1 1 auto', minWidth: '4px' },
      // Side list and content, separated by one full-height 1px rule.
      split: { display: 'flex', gap: 0, flex: '1 1 auto', minHeight: 0, minWidth: 0 },
      sideList: (collapsed, withHeader = true) => ({
        width: collapsed ? '0px' : `${SIDE_LIST_WIDTH}px`,
        flex: collapsed ? '0 0 0px' : `0 0 ${SIDE_LIST_WIDTH}px`,
        display: 'flex', flexDirection: 'column',
        // Without a header line the first control owns the top rhythm, so the
        // pane keeps the same 8px breathing room under the header rule.
        padding: collapsed ? 0 : (withHeader ? '4px 0 8px' : '8px 0 8px'),
        overflow: 'hidden',
        // Out of the tab order while folded: a 0-wide pane must not be reachable.
        visibility: collapsed ? 'hidden' : 'visible',
        boxSizing: 'border-box',
        borderRight: collapsed ? 'none' : '1px solid var(--dsw-alias-border-l1)',
        transition: `width var(--ds-transition-duration, 160ms) var(--ds-ease-in-out, ease), flex-basis var(--ds-transition-duration, 160ms) var(--ds-ease-in-out, ease)`,
      }),
      // List identity line: `数据源 3` / `分析画布 12`, same slot on both pages.
      listHeaderRow: {
        flex: '0 0 auto', height: '36px', display: 'flex', alignItems: 'center',
        gap: '6px', padding: '0 8px', minWidth: 0,
      },
      // 8 + 10 keeps the title on the same 18px line as the row text below it.
      listHeaderTitle: {
        paddingLeft: '10px', fontSize: '12px', fontWeight: 500, lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 0 auto',
      },
      listHeaderCount: {
        fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontVariantNumeric: 'tabular-nums', flex: '0 0 auto',
      },
      // The create entry and the rows share ONE padded column: they used to be
      // inset separately, and the scroll area also reserved a stable scrollbar
      // gutter, so the selected row was a scrollbar narrower than the button even
      // when nothing scrolled. Now the wrapper owns the 8px inset and the
      // scrollbar lives inside it.
      listBody: {
        flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 8px',
      },
      listTools: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '4px', padding: '0 0 6px',
      },
      // Clone of the shell's own "new session" button: a bordered raised card,
      // not a brand-filled primary. Both pages create one thing, so both use it.
      listPrimary: {
        fontFamily: 'inherit', flex: '0 0 auto', boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        height: '38px', padding: '8px 12px', margin: '0 0 8px',
        border: '.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.28))',
        borderRadius: RADIUS.md,
        background: 'var(--dsw-alias-button-elevated-fill, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '14px', fontWeight: 500, lineHeight: '22px',
        cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden',
      },
      listScroll: {
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column', gap: '4px',
      },
      // The row is a wrapper so the fill also covers the trailing ⋯ button; the
      // clickable part is a real <button> (the old canvas list used a div, which
      // no keyboard could reach).
      listRow: {
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center',
        gap: '4px', borderRadius: RADIUS.md, position: 'relative', minWidth: 0,
      },
      listRowMain: {
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '2px',
        height: `${LIST_ROW_HEIGHT}px`, padding: '5px 10px', boxSizing: 'border-box',
        border: 0, borderRadius: RADIUS.md, background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer',
        font: 'inherit', textAlign: 'left', width: '100%', minWidth: 0,
      },
      listRowTitle: {
        fontSize: FS, fontWeight: 500, lineHeight: '18px',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      listRowMeta: {
        fontSize: '11px', lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      listRowAction: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '2px', marginRight: '4px',
      },
      // In-place rename occupies exactly one row box, so the list does not jump
      // when a name is edited — the same contract on both pages.
      listRowInput: {
        gridColumn: '1 / -1', width: '100%', minWidth: 0, boxSizing: 'border-box',
        height: `${LIST_ROW_HEIGHT}px`, padding: '5px 10px', font: 'inherit', fontSize: FS,
        color: 'var(--dsw-alias-label-primary, inherit)', textAlign: 'left',
        background: 'transparent', borderRadius: RADIUS.md,
        border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.28))',
        outlineOffset: '-2px',
      },
      // Secondary strip under the header (selection tools / view tabs): same
      // 16px inset as the header, so the two lines share one left edge.
      subToolbar: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '4px',
        flexWrap: 'wrap', padding: '0 16px 6px',
      },
      // Content is full-bleed on both pages (user request, 2026-10-17): the table
      // brings its own cell/pager padding, and the canvas board brings its own
      // inner padding, so an outer gutter only ate width. The rules the panes meet
      // (page header, side list) are the only chrome between them.
      content: {
        flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', padding: 0, boxSizing: 'border-box',
      },
      emptyBox: { padding: '24px 12px' },
      // The board is full-bleed now, so it carries no outline and no radius: a
      // 16px radius would show notches against the header/side rules, and a 1px
      // border would stack with them into a 2px line. The translucent fill alone
      // keeps the "paper" reading; the inner 12px keeps cards off the edges.
      board: {
        flex: '1 1 auto', minWidth: 0, minHeight: 0, position: 'relative',
        background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #888) 18%, transparent)',
        overflow: 'auto', padding: '12px',
        boxSizing: 'border-box',
      },
      row: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', flexWrap: 'wrap' },
      toolbarSep: { width: '1px', height: '16px', flex: '0 0 auto', margin: '0 4px', background: 'var(--dsw-alias-border-l1)' },
      // Off-screen compass: an icon + count in the header, with its list
      // absolutely positioned so opening it never adds a second line.
      compass: { position: 'relative', flex: '0 0 auto' },
      compassSummary: {
        display: 'inline-flex', alignItems: 'center', gap: '2px',
        height: '28px', padding: '0 4px', borderRadius: RADIUS.sm,
        cursor: 'pointer', listStyle: 'none', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      compassBadge: {
        fontSize: '11px', lineHeight: '14px', minWidth: '14px',
        textAlign: 'center', borderRadius: '7px', padding: '0 4px',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))',
      },
      compassList: {
        position: 'absolute', top: '100%', right: 0, zIndex: 30,
        minWidth: '180px', maxHeight: '220px', overflow: 'auto', padding: '4px',
        borderRadius: RADIUS.lg,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
        background: 'var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay, #222))',
        boxShadow: 'var(--dsw-elevation-panel, 0 10px 30px rgba(0,0,0,.28))',
      },
      // Ghost button: transparent until hovered, like the shell's own controls.
      btn: {
        fontFamily: 'inherit',
        fontSize: FS_SM,
        lineHeight: '18px',
        height: '28px',
        padding: '0 10px',
        borderRadius: RADIUS.sm,
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },
      btnPrimary: {
        fontFamily: 'inherit',
        fontSize: FS_SM,
        lineHeight: '18px',
        height: '28px',
        padding: '0 12px',
        borderRadius: RADIUS.sm,
        cursor: 'pointer',
        border: 'none',
        background: 'var(--dsw-alias-button-primary-fill, #4a7)',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },
      // Verbatim clone of .hHd-Xa_iconButton.
      btnIcon: {
        fontFamily: 'inherit',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '28px', height: '28px', padding: 0,
        borderRadius: RADIUS.sm,
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        flex: '0 0 auto',
      },
      // Cards stay translucent so the board reads through them.
      card: {
        position: 'absolute',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.20))',
        borderRadius: RADIUS.md,
        padding: '6px 8px',
        // Visible, not hidden: an in-card dropdown is positioned against this
        // card (its own `backdrop-filter` makes the card a containing block for
        // fixed/absolute descendants), and `overflow: hidden` would clip the
        // panel to the card. Content clipping is the body's job — `cardBody`
        // keeps its own `overflow: auto` — so nothing else changes.
        overflow: 'visible',
        background: SURFACE.card,
        backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(12px))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        display: 'flex', flexDirection: 'column', gap: '4px',
        boxSizing: 'border-box',
        transition: 'box-shadow var(--ds-transition-duration-fast, 120ms), border-color var(--ds-transition-duration-fast, 120ms), background var(--ds-transition-duration-fast, 120ms)',
      },
      cardDragging: {
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.22))',
        zIndex: 20,
      },
      cardInvalid: {
        // Shown while dragging over an occupied slot, so an adjusted drop is
        // not a surprise.
        borderColor: 'var(--dsw-alias-state-warn-label, #e8a33d)',
      },
      cardTitle: {
        fontSize: FS,
        fontWeight: 500,
        lineHeight: '18px',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      cardBadge: {
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        flex: '0 0 auto',
      },
      cardBody: { flex: '1 1 auto', overflow: 'auto', fontSize: FS_SM, lineHeight: 1.5, opacity: 0.92 },
      muted: { fontSize: FS_SM, color: 'var(--dsw-alias-label-tertiary, inherit)' },
      mutedSmall: { fontSize: '11px', lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary, inherit)' },
      table: { borderCollapse: 'collapse', fontSize: '11px', width: '100%' },
      th: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22))',
        padding: '2px 5px', textAlign: 'left', fontWeight: 500,
      },
      td: { border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.16))', padding: '2px 5px' },
      kpiVal: { fontSize: '20px', fontWeight: 600, lineHeight: 1.15 },
      kpiLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, inherit)' },
      errorBox: {
        padding: '8px 10px',
        borderRadius: RADIUS.md,
        fontSize: FS_SM,
        border: '1px solid var(--dsw-alias-state-warn-label, #c33)',
        color: 'var(--dsw-alias-state-warn-label, #c33)',
      },
      // Context menu, on the shell's own menu surface tokens.
      menu: {
        position: 'fixed', zIndex: 1000, minWidth: '164px', padding: '4px',
        borderRadius: RADIUS.lg,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
        background: 'var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay, #222))',
        backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
        boxShadow: 'var(--dsw-elevation-panel, 0 10px 30px rgba(0,0,0,.28))',
      },
      menuItem: danger => ({
        display: 'flex', alignItems: 'center', gap: '8px',
        height: '28px', padding: '0 8px',
        borderRadius: RADIUS.sm,
        cursor: 'pointer',
        fontSize: FS_SM,
        color: danger
          ? 'var(--dsw-alias-state-warn-label, #d9534f)'
          : 'var(--dsw-alias-label-primary, inherit)',
        whiteSpace: 'nowrap',
      }),
      menuSep: {
        height: '1px', margin: '4px 6px',
        background: 'var(--dsw-alias-border-l2, rgba(127,127,127,.22))',
      },
      menuLabel: {
        padding: '4px 8px 2px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
      },
    }

    /**
     * The shell's own sidebar-toggle glyph, reproduced from its markup.
     *
     * Copied verbatim rather than approximated so the affordance is identical to
     * the built-in one; `currentColor` lets the surrounding button drive colour.
     */
    function ToggleSidebarIcon ({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1,
      },
      h('path', {
        d: 'M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z',
        stroke: 'currentColor',
      }),
      h('path', { d: 'M5.5 1.5V14.5', stroke: 'currentColor' }))
    }

    /**
     * Single-line header budget.
     *
     * The header must never wrap, so controls that do not fit move into a ⋯
     * menu instead. Widths are ESTIMATES (a 28px icon button, a select with its
     * own padding, a truncated title) rather than measurements: the browser half
     * has no CSS layout pass to query, and guessing slightly small only means one
     * extra item lands in ⋯ rather than an overflowing row.
     *
     * Two tiers keep this predictable:
     *   1. `TOOLBAR_FOLD_ORDER` — the secondary actions (refresh, exports, the
     *      card-count meta, palette, arrange) fold first, least valuable first.
     *   2. `TOOLBAR_CORE_FOLD_ORDER` — only if even the folded core cannot fit,
     *      the reading/navigation controls fold too. Undo, search, zoom and the
     *      settings entry are the last things to go, so the header always keeps
     *      its primary affordances reachable for as long as they physically fit.
     *
     * The title shrinks from full to minimum before anything folds at all — it is
     * the one element that loses width without losing function.
     *
     * `planToolbar(Infinity)` — the un-measured case — keeps everything inline,
     * so a host that never reports a width still renders the full toolbar.
     */
    const TOOLBAR_ITEMS = ['toggle', 'title', 'meta', 'palette', 'undo', 'redo', 'arrange',
      'search', 'zoom', 'fit', 'templates', 'export-png', 'export-html', 'backup', 'refresh',
      'compass', 'settings']
    const TOOLBAR_COST = {
      toggle: 28, meta: 92, palette: 78, undo: 28, redo: 28, arrange: 28, search: 28,
      zoom: 66, fit: 28, templates: 28, 'export-png': 28, 'export-html': 28, backup: 28,
      refresh: 28, compass: 46, settings: 28, more: 28,
    }
    const TOOLBAR_TITLE_FULL = 118
    const TOOLBAR_TITLE_MIN = 56
    const TOOLBAR_GAP = 4
    // Least valuable first. `refresh`/`backup`/`meta` go before the exports, and
    // the reading/navigation controls (fit, compass, settings) never fold at
    // all — a narrow header that cannot reach its own content is worse than a
    // crowded one.
    const TOOLBAR_FOLD_ORDER = ['refresh', 'backup', 'meta', 'export-html', 'export-png',
      'arrange', 'fit', 'templates', 'redo', 'undo', 'search']
    // Selects whose own hooks tests drive with onChange, plus the structural
    // controls, always stay inline.
    const TOOLBAR_NEVER_FOLDS = ['toggle', 'title', 'palette', 'zoom', 'compass', 'settings']

    function planToolbar (width) {
      const folded = new Set()
      const total = titleWidth => {
        const names = TOOLBAR_ITEMS.filter(name => !folded.has(name))
        let sum = 0
        for (const name of names) sum += name === 'title' ? titleWidth : (TOOLBAR_COST[name] || 0)
        sum += Math.max(0, names.length - 1) * TOOLBAR_GAP
        if (folded.size) sum += TOOLBAR_GAP + TOOLBAR_COST.more
        return sum
      }
      const fits = () => total(TOOLBAR_TITLE_FULL) <= width || total(TOOLBAR_TITLE_MIN) <= width
      for (const name of TOOLBAR_FOLD_ORDER) {
        if (fits()) break
        if (TOOLBAR_NEVER_FOLDS.includes(name)) continue
        folded.add(name)
      }
      return {
        inline: new Set(TOOLBAR_ITEMS.filter(name => !folded.has(name))),
        overflow: folded,
      }
    }

    /**
     * Toolbar glyphs, as inline SVG.
     *
     * Hand-drawn on a 16x16 grid with `stroke: currentColor` so every icon
     * inherits the button's own colour and follows the host theme. Deliberately
     * NOT text glyphs: an emoji or a PUA codepoint renders differently per
     * platform/font (and a missing glyph shows as a box), which is exactly the
     * fragility the header cannot afford.
     */
    const ICON_PATHS = {
      undo: 'M6 4 3 7l3 3M3 7h5.4a3.6 3.6 0 0 1 0 7.2H6.4',
      redo: 'M10 4l3 3-3 3M13 7H7.6a3.6 3.6 0 0 0 0 7.2H9.6',
      arrange: 'M3 3h4.2v4.2H3zM8.8 3H13v4.2H8.8zM3 8.8h4.2V13H3zM8.8 8.8H13V13H8.8z',
      search: 'M7 11.8a4.8 4.8 0 1 0 0-9.6 4.8 4.8 0 0 0 0 9.6zM10.5 10.5 13.6 13.6',
      fit: 'M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3M6.4 6.4 9.6 9.6M9.6 6.4 6.4 9.6',
      refresh: 'M13.2 8a5.2 5.2 0 1 1-1.7-3.9M13.2 3v3.1h-3.1',
      download: 'M8 2.8v7.4M5.2 7.6 8 10.4l2.8-2.8M3.2 12.8h9.6',
      upload: 'M8 4.2v7.2M5.2 7 8 4.2 10.8 7M3.2 13.2h9.6',
      plus: 'M8 3.4v9.2M3.4 8h9.2',
      layout: 'M3 3h10v10H3zM3 6.6h10M6.9 6.6V13',
      archive: 'M3.2 5.6h9.6V13H3.2zM2.6 2.8h10.8v2.8H2.6zM6.6 8.4h2.8',
      compass: 'M8 2.4v2.6M8 11v2.6M2.4 8h2.6M11 8h2.6M8 12.1a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2z',
      settings: 'M3 5.6h10M3 10.4h10M6.4 3.4v4.4M10.6 8.2v4.4',
      more: 'M3.6 8h.01M8 8h.01M12.4 8h.01',
      caret: 'M4.4 6.6 8 10.2l3.6-3.6',
      close: 'M4 4l8 8M12 4l-8 8',
      // Context-menu glyphs. Kept here rather than as text so a missing emoji
      // font cannot turn a destructive action into a tofu box.
      expand: 'M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3',
      collapse: 'M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3',
      pencil: 'M11.4 2.9 13.1 4.6 5.6 12.1 3.2 12.8l.7-2.4z',
      copy: 'M5.8 5.8h6.4v6.4H5.8zM3.8 10.2V3.8h6.4',
      link: 'M6.6 9.4a2.6 2.6 0 0 0 3.7 0l1.9-1.9a2.6 2.6 0 1 0-3.7-3.7l-1 1M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.8 8.5a2.6 2.6 0 1 0 3.7 3.7l1-1',
      panel: 'M2.8 3.4h10.4v9.2H2.8zM2.8 6.6h10.4',
      trash: 'M3.2 4.6h9.6M6.2 4.6V3.2h3.6v1.4M4.6 4.6l.7 8.2h5.4l.7-8.2M6.8 6.8v3.8M9.2 6.8v3.8',
      circle: 'M8 12.4a4.4 4.4 0 1 0 0-8.8 4.4 4.4 0 0 0 0 8.8z',
      open: 'M9.2 3h3.8v3.8M13 3 7.6 8.4M11.4 9.6V13H3V4.6h3.4',
      check: 'M3.4 8.4 6.4 11.4 12.6 5',
    }

    function ToolIcon ({ name, size = 16 }) {
      const d = ICON_PATHS[name]
      if (!d) return null
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', focusable: 'false',
        stroke: 'currentColor',
        // The ⋯ glyph is three round-capped dots, so it needs the heavier pen.
        strokeWidth: name === 'more' ? 2 : 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d }))
    }

    /**
     * Inline hover fill.
     *
     * The bundle has no stylesheet of its own, so every hoverable element used
     * to repeat a pointerenter/pointerleave pair — and three of them drifted
     * (different tokens, a missing leave). One helper keeps the shell's hover
     * token in one place.
     */
    function hoverable (token = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))', base = 'transparent') {
      return {
        onPointerEnter: event => { event.currentTarget.style.background = token },
        onPointerLeave: event => { event.currentTarget.style.background = base },
      }
    }

    /**
     * A ghost icon button with the shell's hover treatment.
     */
    function IconButton ({ title, onClick, children, buttonProps = {} }) {
      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        style: S.btnIcon,
        onClick,
        ...hoverable(),
        ...buttonProps,
      }, children)
    }
