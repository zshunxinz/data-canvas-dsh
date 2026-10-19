import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

/**
 * Static guards for the browser half.
 *
 * The client bundle has no build step and is never executed by the Node test
 * suite, so a whole class of mistakes can only be caught here or in a browser.
 * Two already reached the user:
 *
 *   1. ReferenceError: Cannot access 'onCreate' before initialization
 *        at CanvasWorkspace
 *      `const onCreate = useCallback(..., [onCreate, ...])` reads the variable
 *      inside its own temporal dead zone, so the component threw on first render
 *      and the panel rendered blank while the HTTP API was perfectly healthy.
 *
 *   2. SyntaxError: Unexpected token ')'
 *        data-canvas-dsh: import failed
 *      A mismatched parenthesis in a deeply nested `h(...)` tree shipped a
 *      bundle that could not be parsed at all. Every other test still passed,
 *      because none of them PARSED the file — the first assertion below exists
 *      specifically to close that hole.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = readFileSync(join(here, '..', 'client.js'), 'utf8')
const INTERACTION_SOURCE = readFileSync(join(here, '..', 'client-src', '06-card-interactions.js'), 'utf8')

test('the bundle parses as JavaScript (a syntax error ships a dead plugin)', () => {
  // Parses without executing, so the browser globals this file uses are fine.
  assert.doesNotThrow(() => new vm.Script(CLIENT, { filename: 'client.js' }))
})

function interactionFunction (name, globals = {}) {
  const start = INTERACTION_SOURCE.indexOf('    function ' + name + ' ')
  assert.ok(start >= 0, 'expected interaction helper: ' + name)
  const open = INTERACTION_SOURCE.indexOf('{', start)
  let depth = 0
  for (let i = open; i < INTERACTION_SOURCE.length; i++) {
    if (INTERACTION_SOURCE[i] === '{') depth++
    if (INTERACTION_SOURCE[i] === '}') depth--
    if (depth === 0) {
      const source = INTERACTION_SOURCE.slice(start, i + 1)
      return new vm.Script('(' + source + ')', { filename: '06-card-interactions.js' }).runInNewContext(globals)
    }
  }
  assert.fail('unterminated interaction helper: ' + name)
}

test('keyboard actions move with arrows, resize with Shift, respect grid bounds, and ignore editors', () => {
  const action = interactionFunction('keyboardAction')
  const layout = interactionFunction('dragLayout', { COLS: 96, MIN_W: 16, MIN_H: 2 })
  const apply = (rect, key, shift = false, ignoredTarget = false) => {
    const intent = action(key, shift, ignoredTarget)
    return intent ? JSON.parse(JSON.stringify(layout(rect, intent.mode, intent.dx, intent.dy, 96))) : null
  }

  assert.deepEqual(apply({ x: 5, y: 5, w: 20, h: 8 }, 'ArrowLeft'), { x: 4, y: 5, w: 20, h: 8 })
  assert.deepEqual(apply({ x: 5, y: 5, w: 20, h: 8 }, 'ArrowDown'), { x: 5, y: 6, w: 20, h: 8 })
  assert.deepEqual(apply({ x: 5, y: 5, w: 20, h: 8 }, 'ArrowRight', true), { x: 5, y: 5, w: 21, h: 8 })
  assert.deepEqual(apply({ x: 5, y: 5, w: 20, h: 8 }, 'ArrowUp', true), { x: 5, y: 5, w: 20, h: 7 })
  assert.deepEqual(apply({ x: 0, y: 0, w: 16, h: 2 }, 'ArrowLeft'), { x: 0, y: 0, w: 16, h: 2 })
  assert.deepEqual(apply({ x: 80, y: 0, w: 16, h: 2 }, 'ArrowRight', true), { x: 80, y: 0, w: 16, h: 2 })
  assert.equal(apply({ x: 0, y: 0, w: 20, h: 8 }, 'Escape'), null)
  assert.equal(apply({ x: 0, y: 0, w: 20, h: 8 }, 'ArrowRight', false, true), null)
})

test('cards expose keyboard focus, shortcut instructions, live status, and retain pointer controls', () => {
  const start = INTERACTION_SOURCE.indexOf("const header = h('div', {")
  const end = INTERACTION_SOURCE.indexOf('\n      headerVisible', start)
  assert.ok(start >= 0 && end > start, 'expected the card header block')
  const header = INTERACTION_SOURCE.slice(start, end)
  assert.match(header, /role: 'group'/)
  assert.match(header, /tabIndex: 0/)
  assert.ok(header.includes("'aria-label':") && header.includes('Shift+方向键调整大小'))
  assert.ok(header.includes("'aria-keyshortcuts':") && header.includes('Shift+ArrowRight'))
  assert.match(header, /onKeyDown: onKeyboardAdjust/)
  assert.match(header, /onPointerDown: e => startDrag\(e, 'move'\)/)
  assert.match(INTERACTION_SOURCE, /onPointerDown: e => startDrag\(e, edge\)/, 'resize pointer handles must remain')
  assert.match(INTERACTION_SOURCE, /keyboardFocused \? \{ outline:/, 'keyboard focus must have a visible ring')
  assert.match(INTERACTION_SOURCE, /role: 'status', 'aria-live': 'polite', 'aria-atomic': true/)
  assert.match(INTERACTION_SOURCE, /target !== event\.currentTarget/)
  assert.match(INTERACTION_SOURCE, /target\?\.isContentEditable/)
  assert.match(INTERACTION_SOURCE, /INPUT\|TEXTAREA\|SELECT/)
  assert.match(INTERACTION_SOURCE, /dragLayout\(base, action\.mode, action\.dx, action\.dy, colBound\)/)
  assert.match(INTERACTION_SOURCE, /commitRef\.current\(next, null\)/)
})

/** Every `const NAME = useCallback(` … `}, [deps])` in the bundle. */
function useCallbackBlocks (source) {
  const blocks = []
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*useCallback\s*\(/g
  let match
  while ((match = re.exec(source)) !== null) {
    const name = match[1]
    const start = match.index
    // find the dependency array that closes this call: `}, [ ... ])`
    const tail = source.slice(start)
    const depMatch = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(tail)
    blocks.push({ name, deps: depMatch ? depMatch[1] : null })
  }
  return blocks
}

test('no useCallback lists itself in its own dependency array (the crash)', () => {
  const blocks = useCallbackBlocks(CLIENT)
  assert.ok(blocks.length > 0, 'expected to find useCallback declarations in client.js')

  const offenders = []
  for (const { name, deps } of blocks) {
    if (deps === null) continue
    const names = deps.split(',').map(d => d.trim()).filter(Boolean)
    if (names.includes(name)) offenders.push(`${name} -> [${deps.trim()}]`)
  }
  assert.deepEqual(
    offenders, [],
    `a useCallback must not depend on itself (temporal dead zone): ${offenders.join('; ')}`,
  )
})

test('the bundle registers through the documented ModuleLoader shape', () => {
  assert.match(CLIENT, /window\.__ModuleLoader__\.load\(/)
  assert.match(CLIENT, /id:\s*'data-canvas-dsh'/)
  assert.match(CLIENT, /factory:\s*require\s*=>/)
})

test('echarts loads through the package-local chunk, not a bare require', () => {
  // Measured: the host's client require only resolves the module table; a bare
  // require('echarts') throws "missed the module table". The supported path is
  // require.async over a package-local client.*.js chunk.
  assert.equal(/require\(\s*'echarts'\s*\)/.test(CLIENT), false, 'bare require("echarts") cannot work in the client')
  assert.match(CLIENT, /require\.async\('\.\/client\.echarts\.js'\)/, 'echarts must load via the package-local chunk')
  // The loader is lazy: the first *executable* chunk request must sit inside
  // requestEcharts, not at bundle top level (comments mention the file name, so
  // search for the call itself).
  const execIndex = CLIENT.indexOf("require.async('./client.echarts.js')")
  const fnIndex = CLIENT.indexOf('function requestEcharts')
  assert.ok(execIndex > 0 && fnIndex > 0 && execIndex >= fnIndex,
    `the chunk request must be inside requestEcharts (call at ${execIndex}, fn at ${fnIndex})`)
})

test('every hook the bundle calls is destructured from React', () => {
  const destructure = /const\s*\{([^}]+)\}\s*=\s*React/.exec(CLIENT)
  assert.ok(destructure, 'expected a React destructuring line')
  const available = new Set(destructure[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean))

  const used = new Set([...CLIENT.matchAll(/\b(use[A-Z][A-Za-z]*)\s*\(/g)].map(m => m[1]))
  // Hooks we define ourselves are not React's to import; only an undefined React
  // hook (a forgotten destructure) crashes the bundle at load time.
  const local = new Set([...CLIENT.matchAll(/function\s+(use[A-Z][A-Za-z]*)\s*\(/g)].map(m => m[1]))
  for (const hook of used) {
    if (local.has(hook)) continue
    assert.ok(available.has(hook), `${hook}() is called but not destructured from React`)
  }
  // Local hooks: changelog fetch, tool-card result, and the reusable toast stack.
  assert.ok((CLIENT.match(/function use[A-Z]/g) || []).length <= 3, 'keep local hooks rare and named')
})

test('the table rail behaves like a navigator, not a SQL writer', () => {
  // 单击展开字段、双击看数据、右键出菜单；不再有默认联表按钮、彩条与插入 SQL。
  assert.match(CLIENT, /'data-xc-db-table': table.name, title: tableTitle\(table\)/)
  assert.match(CLIENT, /onClick: \(\) => onTableClick\(table\)/)
  assert.match(CLIENT, /onDoubleClick: \(\) => onTableDouble\(table\)/)
  assert.match(CLIENT, /'data-xc-table-menu-view': tableMenu.table.name/)
  assert.match(CLIENT, /'data-xc-table-menu-join': tableMenu.table.name/)
  assert.match(CLIENT, /'data-xc-table-menu-schema': tableMenu.table.name/)
  assert.match(CLIENT, /'data-xc-create-sql': true/)
  assert.match(CLIENT, /'data-xc-schema-tab': 'fields'/)
  assert.match(CLIENT, /'data-xc-schema-tab': 'sql'/)
  assert.match(CLIENT, /'data-xc-join-generate': true/)
  assert.doesNotMatch(CLIENT, /'data-xc-db-table-star'/)
  assert.doesNotMatch(CLIENT, /'data-xc-join-tables': true/)
  assert.doesNotMatch(CLIENT, /borderLeft: sqlTableNames/)
  assert.doesNotMatch(CLIENT, /const insertAtCursor/)
})

test('the tokens the bundle sends match what the route layer expects', () => {
  // The API prefix and the endpoints are a wire contract between the two halves;
  // drift here shows up as a dead panel rather than a failing test.
  assert.match(CLIENT, /const API = '\/api\/xcharts-canvas'/)
  for (const call of ['/canvases', '/layout', '/arrange']) {
    assert.ok(CLIENT.includes(call), `client should call ${call}`)
  }
})

test('the sidebar entry id matches the main panel key (kernel contract)', () => {
  // Per the slot contract: "Each list id addresses the matching main panel; the
  // sidebar owns the button and resolves its label from list metadata." A
  // mismatch leaves a visible button that selects nothing.
  const key = /name:\s*'main'\s*,\s*key:\s*([A-Za-z_$][\w$]*)/.exec(CLIENT)
  assert.ok(key, 'expected a main-slot registration with a key')

  const id = /name:\s*'sidebar\.panellist'\s*,\s*id:\s*([A-Za-z_$][\w$]*)/.exec(CLIENT)
  assert.ok(id, 'expected a sidebar.panellist registration with an id')

  assert.equal(id[1], key[1], 'sidebar.panellist id must be the same identifier as main key')
})

test('the sidebar entry is ordered just below the built-in plugins entry', () => {
  // The plugins panel registers at order 15; a larger order renders below it.
  const block = /sidebar\.panellist'[\s\S]{0,200}?order:\s*(\d+)/.exec(CLIENT)
  assert.ok(block, 'expected an order on the sidebar entry')
  assert.ok(Number(block[1]) > 15, `expected order > 15 to sit below plugins, got ${block[1]}`)
})

test('the page fills its container instead of a fixed height', () => {
  assert.ok(CLIENT.includes("height: '100%'"), 'the page should stretch to fill the content area')
  assert.equal(/maxHeight:\s*'5\d\dp/.test(CLIENT), false, 'a clamped height would stop the page filling')
})

test('data preview uses host theme tokens and fills its available height', () => {
  assert.match(CLIENT, /background: 'var\(--dsw-alias-bg-base, Canvas\)'/)
  assert.match(CLIENT, /['"]data-xc-data-table-scroll['"]: true/)
  assert.match(CLIENT, /flex: '1 1 0%', minHeight: 0, minWidth: 0, overflowX: 'scroll', overflowY: 'auto'/)
  assert.doesNotMatch(CLIENT, /maxHeight: '340px'/)
})

test('data import errors do not render as a disconnected plugin API', () => {
  assert.match(CLIENT, /const \[connectionError, setConnectionError\] = useState\(''\)/)
  assert.match(CLIENT, /const listEmpty = connectionError\s*\n\s*\?/)
})

test('the browser half does not import the host-only grid module', () => {
  // `lib/grid.js` is a Node-side module; the bundle may only require what the
  // shell provides. A real import here would fail at load time (there is no
  // build step to catch it), so assert on the statement form, not the substring
  // "from" — which also appears inside ordinary prose in comments.
  assert.equal(/require\(\s*'[^']*grid/.test(CLIENT), false, 'must not require lib/grid.js')
  assert.equal(
    /^\s*import\s[\s\S]*?from\s/m.test(CLIENT),
    false,
    'the hand-written bundle uses require(), not ESM import statements',
  )
})

test('every canvas API helper targets the mounted prefix', () => {
  for (const helper of ['listCanvases', 'getCanvas', 'createCanvas', 'deleteCanvas', 'saveLayout', 'arrange', 'renameCard', 'duplicateCard', 'deleteCard']) {
    assert.ok(CLIENT.includes(`const ${helper} =`), `missing API helper: ${helper}`)
  }
  // The per-card endpoints are what the context menu drives.
  assert.ok(CLIENT.includes('/cards/${cardId}'), 'card endpoints should be built from the card id')
  assert.ok(CLIENT.includes('/duplicate'), 'the duplicate endpoint should be wired')
})

test('the context menu exposes the actions it claims to', () => {
  for (const action of ['rename', 'duplicate', 'delete']) {
    assert.ok(CLIENT.includes(`id: '${action}'`), `context menu is missing the ${action} action`)
  }
  assert.ok(CLIENT.includes('ContextMenu'), 'a menu component should exist')
})

test('the canvas list can be collapsed and expanded', () => {
  assert.ok(CLIENT.includes('listCollapsed'), 'the list needs a collapsed state')
  assert.ok(CLIENT.includes('data-xc-toggle-list'), 'there must be a control that toggles the list')
})

test('the pane carries no subtitle line', () => {
  // The user removed it: the canvas name is already in the toolbar and the
  // active sidebar row identifies the page, so a second line of boilerplate
  // only consumed vertical space.
  assert.equal(CLIENT.includes('canvas.subtitle'), false, 'the subtitle string should be gone entirely')
  assert.equal(
    /h\('div',\s*\{\s*style:\s*S\.mutedSmall\s*\},\s*t\('canvas\.title'\)\)/.test(CLIENT),
    false,
    'the page heading should not be rendered above the panes',
  )
})

test('the initial load marks the opened canvas as selected', () => {
  // Measured regression: the first load called loadCanvas() but never
  // setSelectedId(), so the panel opened on a canvas while marking no row as
  // active — the selected style never applied.
  const initial = /Initial load[\s\S]*?\}, \[reloadList, loadCanvas[^\]]*\]\)/.exec(CLIENT)
  assert.ok(initial, 'expected the initial-load effect')
  assert.match(initial[0], /setSelectedId\(/, 'the initial load must set the selection, not only the canvas')
})

test('mutations state the CURRENT revision, not one captured in a closure', () => {
  // Regression cover for a real error the user hit:
  //   canvas revision conflict: expected 82, found 83
  // Every mutation passed `canvas.revision` from the closure — the value
  // captured when the callback was created. Two actions before a re-render both
  // sent the same stale revision, so the second was refused.
  assert.match(CLIENT, /const revisionRef = useRef\(/, 'a revision ref must track the newest known revision')
  assert.match(CLIENT, /withCurrentRevision/, 'mutations should run through the revision-aware helper')

  // The stale pattern must not come back: no mutation may read canvas.revision
  // directly when calling an API helper.
  const offenders = [...CLIENT.matchAll(/await (arrange|saveLayout|renameCard|duplicateCard|deleteCard)\([^)]*canvas\.revision[^)]*\)/g)]
    .map(m => m[0])
  assert.deepEqual(offenders, [], `mutations must not pass canvas.revision directly: ${offenders.join('; ')}`)
})

test('a revision conflict retries instead of surfacing as a user error', () => {
  // A 409 here is usually another write from this same client (a queued drag) or
  // the agent editing the same canvas — not something the user did wrong.
  assert.ok(CLIENT.includes('REVISION_CONFLICT'), 'the client should recognise the conflict code')
  assert.match(CLIENT, /withCurrentRevision[\s\S]{0,900}?REVISION_CONFLICT/, 'the helper should handle the conflict')
})

test('layout commits are serialised so a queued drag cannot race the previous one', () => {
  assert.match(CLIENT, /commitChain/, 'commits should be queued behind each other')
})

test('a dropped card stays at its landing position until the server confirms', () => {
  // Regression cover for the flicker the user reported: the pointer-up handler
  // used to clear the preview immediately, so the card snapped back to its old
  // position for a frame or more while the PATCH + reload round-tripped. A
  // `landed` bridge now keeps the dropped position on screen.
  assert.match(CLIENT, /const \[landed, setLanded\] = useState\(null\)/, 'a landing bridge state is required')

  // pointer-up must render the landing before committing.
  assert.match(CLIENT, /const onUp[\s\S]*?setLanded\(current\)[\s\S]*?commitRef\.current\(current, drag\.groupLayouts\)/)

  // The bridge clears exactly when the parent hands back a fresh card object.
  assert.match(INTERACTION_SOURCE, /useEffect\(\(\) => \{\s*keyboardLayoutRef\.current = card\.layout\s*setLanded\(null\)\s*\}, \[card\.layout\]\)/, 'keyboard ref and landed clear on reload')
})

test('drag listeners are registered once, not on every state change', () => {
  // Listener churn used to add latency to every move. The drag lifecycle runs
  // through refs, so the effect has an empty dependency array.
  const effect = /useEffect\(\(\) => \{[\s\S]*?addEventListener\('pointermove'[\s\S]*?\}, \[\]\)/.exec(CLIENT)
  assert.ok(effect, 'the pointermove effect must have an empty dependency array')
})

test('buttons and surfaces use the shell design tokens, not hard-coded colours', () => {
  // The panel must follow the active theme, so colours come from --dsw-*.
  assert.ok(CLIENT.includes('--dsw-alias-button-primary-fill'), 'primary buttons should use the shell token')
  assert.ok(CLIENT.includes('--dsw-alias-border-l2'), 'borders should use the shell token')
  assert.ok(CLIENT.includes('--dsw-radius-md'), 'radii should use the shell token')

  // A hard-coded hex outside a var() fallback would not follow the theme.
  const suspicious = [...CLIENT.matchAll(/background:\s*'(#[0-9a-fA-F]{3,8})'/g)].map(m => m[1])
  assert.deepEqual(suspicious, [], `hard-coded backgrounds found: ${suspicious.join(', ')}`)
})

// ── conversation tool card ──────────────────────────────────────────────────

test('the card tools claim a conversation view, keyed by their wire names', () => {
  // The host dispatches `tool.call.toolview` by wire tool name and allows any
  // name, including a package's own tools (live slot catalog). A typo there would
  // silently render nothing, so the names come from one list.
  assert.match(CLIENT, /const TOOL_CARD_NAMES = \['canvas_add_card', 'canvas_update_card', 'canvas_add_result'\]/)
  assert.match(CLIENT, /const TOOL_CARD_FETCHES = \['canvas_add_result'\]/, 'the write path reads its card back')
  assert.match(CLIENT, /ctx\.slots\.inject\('tool\.call\.toolview'/)
  assert.match(CLIENT, /name: 'tool\.call\.toolview',\s*\n\s*key: toolName,/)
  assert.equal((CLIENT.match(/for \(const toolName of TOOL_CARD_NAMES\)/g) || []).length, 1)
  // The card row and its chart surface carry test hooks, and a failure keeps a row.
  assert.match(CLIENT, /'data-xc-tool-card': true/)
  assert.match(CLIENT, /'data-xc-tool-status': status\.tone/)
  assert.match(CLIENT, /'data-xc-echart': 'true'/)
  // Rendering from the call arguments is the point: the draft projection samples.
  assert.match(CLIENT, /const raw = typeof block\?\.argsRaw === 'string'/)
  assert.match(CLIENT, /catch \{ return null \}/, 'malformed arguments never throw')
  assert.match(CLIENT, /h\(CardBody, \{ card, t, theme \}\)/)
})

// ── one skeleton for both workspaces ────────────────────────────────────────

test('both workspaces share one skeleton spec: one width, one header, one row box', () => {
  // One source of truth for the geometry, declared once.
  assert.equal((CLIENT.match(/const SIDE_LIST_WIDTH = /g) || []).length, 1)
  assert.match(CLIENT, /const SIDE_LIST_WIDTH = 240/)
  assert.match(CLIENT, /const PAGE_HEADER_HEIGHT = 48/)
  assert.match(CLIENT, /const LIST_ROW_HEIGHT = 45/)
  assert.equal((CLIENT.match(/const LIST_SEARCH_MIN = /g) || []).length, 1)
  assert.equal((CLIENT.match(/> LIST_SEARCH_MIN\b/g) || []).length, 2, 'both lists show search at the same threshold')
  // The row count beside each list name is hidden for now, and so is the whole
  // identity line (one flag each, both pages).
  assert.match(CLIENT, /const SHOW_LIST_COUNT = false/)
  assert.match(CLIENT, /SHOW_LIST_COUNT && count !== undefined && count !== null/)
  assert.match(CLIENT, /const SHOW_LIST_TITLE = false/)
  assert.match(CLIENT, /const showHeader = SHOW_LIST_TITLE/)
  assert.match(CLIENT, /showHeader\s*\n\s*\? h\('div', \{ 'data-xc-list-header': 'true'/)
  // A hidden title must not cost the region its name.
  assert.match(CLIENT, /role: 'navigation',\s*\n\s*'aria-label': title,/)
  assert.match(CLIENT, /style: S\.sideList\(collapsed, showHeader\)/)
  assert.equal((CLIENT.match(/countData: \{ 'data-xc-list-count': 'true' \}/g) || []).length, 2, 'both pages still pass the count, so the flag is the only switch')
  // The per-page numbers that caused the drift must not come back.
  assert.doesNotMatch(CLIENT, /'0 0 220px'/)
  assert.doesNotMatch(CLIENT, /borderRadius: 6[^0-9]/)
  assert.doesNotMatch(CLIENT, /fontSize: 18[^0-9]/)

  // Both pages mount the same three pieces (and nothing else does).
  assert.equal((CLIENT.match(/h\(PageShell, \{/g) || []).length, 2, 'both workspaces use PageShell')
  assert.equal((CLIENT.match(/h\(PageHeader, \{/g) || []).length, 2, 'both workspaces use PageHeader')
  assert.equal((CLIENT.match(/h\(SideList, \{/g) || []).length, 2, 'both workspaces use SideList')
  assert.equal((CLIENT.match(/h\(ListPrimaryAction, \{/g) || []).length, 2, 'each list has exactly one create entry')

  // Radius fallbacks are the shell's real token values (8/12/16), not our old
  // guesses (6/8/10) — the guesses were how a 6px row got shipped.
  assert.match(CLIENT, /sm: 'var\(--dsw-radius-sm, 8px\)'/)
  assert.match(CLIENT, /md: 'var\(--dsw-radius-md, 12px\)'/)
  assert.match(CLIENT, /lg: 'var\(--dsw-radius-lg, 16px\)'/)

  // Focus rings follow the shell's token (`ui-theme/focus.css`), never our own.
  assert.match(CLIENT, /2px solid var\(--dsw-alias-state-business-primary/)
  assert.doesNotMatch(CLIENT, /outline:2px solid var\(--dsw-alias-brand-primary\)/)

  // Hover is the shell's one token, wrapped once instead of repeated per control.
  assert.equal((CLIENT.match(/function hoverable/g) || []).length, 1)
  assert.ok((CLIENT.match(/\.\.\.hoverable\(/g) || []).length >= 3, 'the ghost controls share one hover helper')
})

test('the list alignment invariants hold numerically', () => {
  const number = (re, what) => {
    const m = re.exec(CLIENT)
    assert.ok(m, `expected ${what}`)
    return Number(m[1])
  }
  // Row text and the identity line must share one left edge (18px from the list).
  const listPad = number(/listBody: \{[\s\S]*?padding: '0 (\d+)px'/, 'the list body padding')
  const rowPad = number(/listRowMain: \{[\s\S]*?padding: '5px (\d+)px'/, 'the row padding')
  const identityPad = number(/listHeaderTitle: \{[\s\S]*?paddingLeft: '(\d+)px'/, 'the identity line padding')
  assert.equal(listPad + rowPad, 18, 'row text starts 18px from the list edge')
  assert.equal(listPad + identityPad, 18, 'the identity line shares that exact edge')

  // The create entry and the rows are the same width: one padded column owns the
  // inset, and neither the button nor the scroll area adds its own.
  assert.match(CLIENT, /listPrimary: \{[\s\S]*?margin: '0 0 8px',/, 'no horizontal margin on the create entry')
  assert.equal(/listScroll: \{[^}]*padding:/.test(CLIENT), false, 'the scroll area adds no padding of its own')
  assert.equal(/listScroll: \{[^}]*scrollbar-gutter/.test(CLIENT), false, 'a stable gutters would make the rows narrower than the button')
  assert.match(CLIENT, /'data-xc-list-body': 'true', style: S\.listBody/, 'both live in the shared padded column')

  // Row height is the sum of its parts, not a magic number.
  const rowHeight = number(/const LIST_ROW_HEIGHT = (\d+)/, 'the row height constant')
  const pad = number(/listRowMain: \{[\s\S]*?padding: '(\d+)px/, 'the vertical row padding')
  const gap = number(/listRowMain: \{[\s\S]*?gap: '(\d+)px'/, 'the row line gap')
  const titleLine = number(/listRowTitle: \{[\s\S]*?lineHeight: '(\d+)px'/, 'the title line height')
  const metaLine = number(/listRowMeta: \{[\s\S]*?lineHeight: '(\d+)px'/, 'the meta line height')
  assert.equal(pad * 2 + titleLine + gap + metaLine, rowHeight, 'the row box is exactly its contents')

  // The identity line is 36px and the create entry 38px, as in the shell.
  assert.equal(number(/listHeaderRow: \{[^}]*height: '(\d+)px'/, 'the identity line height'), 36)
  assert.equal(number(/listPrimary: \{[\s\S]*?height: '(\d+)px'/, 'the create entry height'), 38)

  // The header is 48px tall with a 16px inset and an 8px gap: one left edge for
  // the toggle glyph, the title and everything after them.
  assert.equal(number(/const PAGE_HEADER_HEIGHT = (\d+)/, 'the header height constant'), 48)
  assert.match(CLIENT, /pageHeader: \{[\s\S]*?height: `\$\{PAGE_HEADER_HEIGHT\}px`/, 'the header height comes from that constant')
  assert.match(CLIENT, /pageHeader: \{[\s\S]*?gap: '8px', padding: '0 16px'/, 'the header uses one gap and one inset')
  assert.match(CLIENT, /marginLeft: '-6px'/, 'the toggle glyph lands on the 16px grid line')
})

// ── visual scale: match the shell instead of inventing a larger one ─────────

test('type scale does not exceed the shell body size (KPI figures and the page title excepted)', () => {
  // Regression cover for a real complaint: buttons and text rendered visibly
  // larger than the surrounding app. The shell's sidebar root is 14px, so no
  // *chrome* text should declare a larger size. Two deliberate exceptions:
  // a KPI card's headline figure (content, not chrome), and the page title,
  // which is 16px/500 because that is what the shell's own 48px panel header
  // uses (`dsh-client-ui-settings-account .header` → 16px/500).
  const CHROME_EXCEPTIONS = new Set(['kpiVal', 'pageTitle'])

  const offenders = []
  const matches = [...CLIENT.matchAll(/(\w+):\s*\{[^}]*fontSize:\s*'(\d+)px'/g)]
  for (const m of matches) {
    const [, key, size] = m
    if (Number(size) <= 14) continue
    if (CHROME_EXCEPTIONS.has(key)) continue
    offenders.push(`${key}: ${size}px`)
  }
  assert.deepEqual(offenders, [], `font sizes above the shell scale: ${offenders.join(', ')}`)

  // Headings must not be bold-heavy either.
  const weights = [...CLIENT.matchAll(/fontWeight:\s*(\d+)/g)].map(m => Number(m[1]))
  const tooHeavy = weights.filter(n => n > 600)
  assert.deepEqual(tooHeavy, [], `font weights above the shell scale: ${tooHeavy.join(', ')}`)
})

test('list row names are not bold', () => {
  // The user asked specifically for this: a list name must not read as a
  // heading. Both lists now share one style, so this covers them together.
  const style = /listRowTitle:\s*\{[\s\S]*?\n      \}/.exec(CLIENT)
  assert.ok(style, 'expected the shared list row title style')
  assert.match(style[0], /fontWeight:\s*500/, 'row names use the shell’s medium weight, not bold')
  assert.equal(/fontWeight:\s*(600|700|800|900|'bold')/.test(style[0]), false, 'list row names must not be bold')
})

test('icon buttons are 28x28 ghosts with no border (shell .iconButton)', () => {
  const btnIcon = /btnIcon:\s*\{[\s\S]*?\n      \}/.exec(CLIENT)
  assert.ok(btnIcon, 'expected an icon button style')
  const block = btnIcon[0]
  assert.match(block, /width:\s*'28px'/, 'icon buttons are 28px wide in the shell')
  assert.match(block, /height:\s*'28px'/, 'icon buttons are 28px tall in the shell')
  assert.match(block, /border:\s*'none'/, 'shell icon buttons have no border')
  assert.match(block, /background:\s*'transparent'/, 'shell icon buttons are transparent until hover')
})

test('the sidebar toggle reuses the shell glyph and classes', () => {
  // The user supplied the shell's exact markup; keep it recognisably the same.
  assert.ok(CLIENT.includes('hHd-Xa_iconButton'), 'should carry the shell icon-button class')
  assert.ok(CLIENT.includes('hHd-Xa_toggle'), 'should carry the shell toggle class')
  assert.ok(CLIENT.includes('M13.5 1.5H2.5C1.94772'), 'should draw the shell sidebar glyph path')
  assert.ok(CLIENT.includes('M5.5 1.5V14.5'), 'should draw the shell divider path')
  assert.ok(CLIENT.includes('aria-keyshortcuts'), 'should advertise the shell shortcut')
})

test('cards keep a translucent surface', () => {
  const card = /card:\s*\{[\s\S]*?\n      \}/.exec(CLIENT)
  assert.ok(card, 'expected a card style')
  const block = card[0]

  // Measured regression: `--dsw-alias-bg-layer-1` resolves to an OPAQUE theme
  // fill (rgb(255,255,255)), so using it as the card background hid the board
  // behind every card. The card surface must therefore come from an alpha
  // channel, not from an opaque layer token.
  assert.equal(
    /background:\s*'var\(--dsw-alias-bg-layer/.test(block),
    false,
    'cards must not use an opaque layer token as their background',
  )
  assert.match(block, /SURFACE\.card|rgba\(|color-mix\(/, 'cards should stay translucent')
  assert.match(block, /backdropFilter:\s*'var\(--dsw-menu-backdrop-filter/, 'cards should carry the shell backdrop treatment')
})

test('font sizes are fixed values, not the --dsw-font-base-16 token', () => {
  // Measured regression: `--dsw-font-base-16-font-size` resolves to 16px, so
  // chrome text rendered larger than the shell's 13-14px. Body sizes must be
  // declared literally.
  assert.equal(
    /fontSize:\s*'var\(--dsw-font-base/.test(CLIENT),
    false,
    'do not use the base-16 font token for chrome text',
  )
  assert.match(CLIENT, /const FS = '\d+px'/, 'the body size should be a literal')
})

test('the selected row uses a translucent fill that is actually applied', () => {
  const css = /const XC_UI_CSS = `([\s\S]*?)`/.exec(CLIENT)
  assert.ok(css, 'expected the shared chrome stylesheet')
  const block = css[1]
  // Measured regression: pointing at --dsw-alias-interactive-bg-hover-accent
  // resolved to transparent in this theme, so selection was invisible.
  assert.equal(
    /background:\s*active\s*\?\s*'var\(--dsw-alias-interactive/.test(CLIENT),
    false,
    'selection must not rely on a token that can resolve to transparent',
  )
  // One rule now paints the selected row of BOTH lists.
  assert.match(
    block,
    /\[data-xc-list-row\]\[data-selected="true"\]\{background:color-mix\(in srgb,var\(--dsw-alias-label-primary\) 8%,transparent\)\}/,
    'selection should be the translucent surface fill',
  )
  assert.equal(/border-left:\s*2px solid/.test(block), false, 'selection should not add a leading colour bar')
  assert.equal(/inset 2px 0 0/.test(CLIENT), false, 'selection should not add a heavy outline')
})

test('card rendering covers header, body, provenance and a resize grip', () => {
  assert.ok(CLIENT.includes('data-xc-resize'), 'cards need a resize grip')
  assert.ok(CLIENT.includes('onContextMenu'), 'cards need a context menu handler')
  assert.ok(CLIENT.includes('onDoubleClick'), 'double-click should offer a shortcut')
})

test('every card type the store accepts has a renderer in the view', () => {
  const types = ['chart', 'table', 'kpi', 'text']
  for (const type of types) {
    assert.ok(
      CLIENT.includes(`card.type === '${type}'`),
      `client.js has no branch for card type "${type}"`,
    )
  }
})

test('datasource list fully collapses and its toggle stays fixed at the top-left', () => {
  // Both pages fold through the shared `SideList`, so the collapsed state is one
  // implementation (`width: 0`, hidden, out of the tab order) and not two.
  assert.match(CLIENT, /'data-xc-side-list': collapsed \? 'collapsed' : 'expanded'/)
  assert.match(CLIENT, /visibility: collapsed \? 'hidden' : 'visible'/)
  assert.match(CLIENT, /h\(SideList, \{\s*\n\s*collapsed: sourcesCollapsed/)
  assert.match(CLIENT, /'data-xc-page-header': 'true'/)
  assert.match(CLIENT, /'aria-label': sourcesCollapsed \? '展开数据源列表' : '收起数据源列表'/)
  assert.equal((CLIENT.match(/'data-xc-toggle-datasource-list': true/g) || []).length, 1)
  assert.doesNotMatch(CLIENT, /data-xc-collapsed-expand/)
  assert.ok(CLIENT.indexOf("'data-xc-page-header'") < CLIENT.indexOf("'data-xc-toggle-datasource-list'") && CLIENT.indexOf("'data-xc-toggle-datasource-list'") < CLIENT.indexOf("'data-xc-data-detail'"))
  assert.match(CLIENT, /'data-xc-data-detail': true/)
})

test('datasource previews and query results load complete paged data', () => {
  assert.match(CLIENT, /const PAGE_SIZE = 100/)
  assert.match(CLIENT, /getDatasource = \(id, offset = 0, limit = 100\)/)
  assert.match(CLIENT, /readDatasourceResult = \(id, offset = 0, limit = 100\)/)
  assert.match(CLIENT, /data-xc-data-table-scroll/)
  assert.match(CLIENT, /data-xc-table-pager/)
  assert.ok(CLIENT.indexOf("'data-xc-data-table-scroll'") < CLIENT.indexOf("'data-xc-table-pager'"), 'the pager docks below the scroll area')
  assert.match(CLIENT, /overflowWrap: 'anywhere'/)
  assert.match(CLIENT, /每页 \$\{PAGE_SIZE\} 行/)
})

test('the datasource page keeps the unified single-frame skeleton', () => {
  // The geometry lives in the shared pieces now, so this test asserts the page
  // *uses* them and no longer carries a private header, width or title size.
  assert.match(CLIENT, /h\(PageShell, \{\s*\n\s*className: 'xc-ui xc-ds-page'/)
  assert.match(CLIENT, /h\(PageHeader, \{\s*\n\s*data: \{ 'data-xc-datasource-header': 'true' \}/)
  assert.match(CLIENT, /h\(SideList, \{\s*\n\s*collapsed: sourcesCollapsed/)
  assert.doesNotMatch(CLIENT, /fontSize: 18, fontWeight: 600/, 'the page title follows the shared 16px/500 scale')
  assert.doesNotMatch(CLIENT, /'240px minmax\(0, 1fr\)'/, 'the side list width comes from SIDE_LIST_WIDTH')
  // One full-height rule between the columns, drawn by the side list itself.
  assert.match(CLIENT, /borderRight: collapsed \? 'none' : '1px solid var\(--dsw-alias-border-l1\)'/)
  // The table keeps its sticky header rule under separate borders.
  assert.match(CLIENT, /borderCollapse: 'separate', borderSpacing: 0/)
  assert.match(CLIENT, /borderBottom: '1px solid var\(--dsw-alias-border-l1\)',\s*\n\s*color: 'var\(--dsw-alias-label-secondary, inherit\)', fontWeight: 500/)
})

test('adding a query result requires selecting and confirming a canvas in a dialog', () => {
  assert.match(CLIENT, /title: '选择目标画布'/)
  assert.match(CLIENT, /role: 'radiogroup'/)
  assert.match(CLIENT, /onClick: confirmAddToCanvas/)
  assert.match(CLIENT, /disabled: busy \|\| !canvasTargetId \|\| !addReady/)
})

test('the canvas list has one action and rows mirror the datasource list', () => {
  // Exactly one control in the list header: the new-canvas button.
  assert.doesNotMatch(CLIENT, /'data-xc-list-menu': 'true'/)
  assert.doesNotMatch(CLIENT, /const listMenuItems/)
  assert.match(CLIENT, /primaryAction: h\(ListPrimaryAction, \{\s*\n\s*label: t\('canvas\.new'\), icon: 'plus', onClick: onCreate,/)
  // Restoring a backup lives with the canvas-level actions instead.
  assert.match(CLIENT, /data: \{ 'data-xc-backup-import': 'true' \}, text: t\('canvas\.backupImport'\), iconName: 'archive', onSelect: openBackupPicker/)
  // Rows ARE the shared row component — the two lists cannot drift again.
  assert.match(CLIENT, /h\(ListRow, \{\s*\n\s*key: c\.id,\s*\n\s*title: c\.name,/)
  assert.match(CLIENT, /h\(ListRow, \{\s*\n\s*key: item\.id,\s*\n\s*title: item\.name,/)
  // Both lists name themselves in the same slot, with a count.
  assert.match(CLIENT, /title: t\('canvas\.title'\),\s*\n\s*count: canvases\.length,/)
  assert.match(CLIENT, /title: '数据源',\s*\n\s*count: items\.length,/)
  // The row box geometry is declared once, in the shared style block.
  assert.match(CLIENT, /const LIST_ROW_HEIGHT = 45/)
  assert.equal((CLIENT.match(/height: `\$\{LIST_ROW_HEIGHT\}px`/g) || []).length, 2, 'the row and its rename input share one box height')
})

test('the multi-select strip is compact and token-only', () => {
  assert.match(CLIENT, /'data-xc-selection-divider': true/)
  assert.match(CLIENT, /'data-xc-align': mode, title: t\(`canvas\.\$\{mode\}`\)/)
  assert.match(CLIENT, /style: \{ \.\.\.S\.btn, height: 24, fontSize: '12px' \}/)
  // The resize handles keep their hit areas and cursors but paint nothing:
  // the corner grip is gone, only the cursor signals that an edge resizes.
  assert.match(CLIENT, /'data-xc-resize-edge': edge/)
  assert.match(CLIENT, /cursor: edge\.length === 1 \? \(edge === 'n' \|\| edge === 's' \? 'ns-resize' : 'ew-resize'\)/)
  assert.doesNotMatch(CLIENT, /borderRight: '2px solid/)
  assert.doesNotMatch(CLIENT, /borderBottom: '2px solid var\(--dsw-alias-label-tertiary/)
})

test('an empty canvas explains itself in the middle of the board', () => {
  assert.match(CLIENT, /'data-xc-board-empty': 'true'/)
  assert.match(CLIENT, /'canvas\.emptyCardsHint': '在对话里让 Agent 把分析放到这里/)
  assert.match(CLIENT, /'canvas\.emptyCardsHint': 'Ask the agent to put an analysis here/)
  assert.doesNotMatch(CLIENT, /'canvas\.emptyCardsNote'/)
  assert.doesNotMatch(CLIENT, /canvas\.cards\.length === 0\n\s*\? h\('div', \{ style: S\.muted \}, t\('canvas\.emptyCards'\)\)/)
})

test('the query pane keeps one docs row and the page offers a skip link', () => {
  // Help text and the interface diagnostic share one disclosure.
  assert.match(CLIENT, /label: '说明与诊断', data: \{ 'data-xc-query-docs': true \}/)
  assert.match(CLIENT, /'data-xc-interface-diagnostics': true/)
  assert.match(CLIENT, /'data-xc-query-help-toggle': true/)
  // A keyboard user can jump straight to the table.
  assert.match(CLIENT, /'data-xc-skip-to-content': true/)
  assert.match(CLIENT, /const focusTable = \(\) => \{/)
  assert.match(CLIENT, /querySelector\?\.\('\[data-xc-data-table-scroll\]'\)/)
})

test('field selection is chips plus search-to-add, not a wall of checkboxes', () => {
  assert.match(CLIENT, /'data-xc-field-chips': true/)
  assert.match(CLIENT, /'data-xc-field-chip': name/)
  assert.match(CLIENT, /'data-xc-field-search': true/)
  assert.match(CLIENT, /'data-xc-field-add': c\.name/)
  assert.match(CLIENT, /const fieldNeedle = fieldSearch\.trim\(\)\.toLocaleLowerCase\(\)/)
  assert.match(CLIENT, /尚未选择字段：在上方搜索添加/)
  // The old always-on checkbox list for 原始字段 is gone.
  assert.doesNotMatch(CLIENT, /'data-xc-field-options': true/)
})

test('empty results and long canvas lists guide the user instead of dead-ending', () => {
  // A query with no matching rows explains itself and offers the way back.
  assert.match(CLIENT, /'data-xc-table-empty': tableKey/)
  assert.match(CLIENT, /tableKey === 'result' \? '无匹配行' : '没有可预览的行'/)
  assert.match(CLIENT, /label: '清除筛选并重新配置'/)
  // Both lists grow a search field once they no longer fit, at the same count.
  assert.match(CLIENT, /const listNeedsSearch = canvases\.length > LIST_SEARCH_MIN/)
  assert.match(CLIENT, /const listNeedsSearch = items\.length > LIST_SEARCH_MIN/)
  assert.match(CLIENT, /'data-xc-list-search': 'true'/)
  assert.match(CLIENT, /'data-xc-list-empty': 'true'/)
  assert.match(CLIENT, /'canvas\.searchEmpty': '没有匹配的画布。'/)
  assert.match(CLIENT, /'canvas\.searchList': 'Search canvases'/)
})

// ── one fact, one place ─────────────────────────────────────────────────────

test('the datasource page states each fact once', () => {
  // The open source's identity (name · format · rows · columns) is stated in the
  // page header only: the content pane no longer paints its own copy.
  assert.doesNotMatch(CLIENT, /h\('strong', \{ style: \{ minWidth: 0, overflowWrap: 'anywhere' \} \}/, 'no second copy of the source name')
  assert.match(CLIENT, /'data-xc-data-toolbar': true, style: S\.subToolbar/, 'one tool row per pane')
  // Both panes are full-bleed: the table and the board bring their own padding,
  // so the content box has none, and the board drops outline/radius (a radius
  // would notch against the header rule, a border would stack with it).
  assert.match(CLIENT, /content: \{\s*\n\s*flex: '1 1 auto'[\s\S]*?padding: 0, boxSizing: 'border-box'/)
  assert.match(CLIENT, /'data-xc-data-detail': true, style: S\.content \}/, 'the table pane has no outer padding')
  assert.equal((CLIENT.match(/style: S\.content \}/g) || []).length, 3, 'both canvas branches and the table pane are the same flush box')
  assert.match(CLIENT, /board: \{\s*\n\s*flex: '1 1 auto'[\s\S]*?background: 'color-mix\(in srgb, var\(--dsw-alias-bg-base, #888\) 18%, transparent\)',\s*\n\s*overflow: 'auto', padding: '12px'/)
  assert.doesNotMatch(CLIENT, /borderRadius: RADIUS\.lg,\s*\n\s*background: 'color-mix\(in srgb, var\(--dsw-alias-bg-base, #888\)/, 'the board keeps no radius of its own')
  assert.match(CLIENT, /chosen\.deleted \? `\$\{chosen\.name\}（已删除）` : chosen\.read_only \? `\$\{chosen\.name\}（计算时版本）` : chosen\.name/, 'the header is where the identity lives')

  // Row/column totals: the pager owns the row range, the result bar owns the
  // shape (rows · columns); the preview does not repeat the column count.
  assert.doesNotMatch(CLIENT, /tableKey === 'result' \? `\$\{columns\.length\} 列` : null/)
  assert.match(CLIENT, /'data-xc-table-goto': tableKey/)

  // One control per action: the preview is reached through its tab.
  assert.doesNotMatch(CLIENT, /data-xc-back-to-preview/)
  assert.doesNotMatch(CLIENT, /查询结果已就绪/)
  assert.doesNotMatch(CLIENT, /data-xc-result-provenance/)

  // The stored 口径 is printed only when it is no longer what is configured —
  // otherwise the summary line (pane closed) or the pane itself already says it.
  assert.match(CLIENT, /summarizeStoredQuery\(result\.query\) !== datasourceQuerySummary\(queryConfig\)/)

  // Diagnostics (query snapshot + source hash) live with the diagnostics.
  assert.match(CLIENT, /diagnostics: diagnosticsNode/)
  assert.match(CLIENT, /diagnostics \|\| null/)
  assert.match(CLIENT, /'data-xc-copy-diagnostics': true,/)

  // 24 identical chips said nothing the label did not: all-selected collapses.
  assert.match(CLIENT, /const allFieldsSelected = queryColumns\.length > 0 && config\.select\.length === queryColumns\.length/)
  assert.match(CLIENT, /const showFieldBody = !allFieldsSelected \|\| fieldsOpen/)
  assert.match(CLIENT, /label: allFieldsSelected \? `原始字段 · 全部 \$\{queryColumns\.length\} 列`/)
  assert.match(CLIENT, /'data-xc-field-adjust': true/)
  // 全选 is a no-op once everything is selected, so the same slot offers
  // 调整字段 instead of a button that would change nothing.
  assert.match(CLIENT, /allFieldsSelected\s*\n\s*\? h\(LinkButton, \{ key: 'adjust', label: fieldsOpen \? '收起字段' : '调整字段'/)
})


test('the result dialog offers table, chart and KPI cards with kind-specific columns', () => {
  assert.match(CLIENT, /'data-xc-add-card-type': value/)
  assert.match(CLIENT, /\[\['table', '表格'\], \['chart', '图表'\], \['kpi', '指标卡'\]\]/)
  assert.match(CLIENT, /'data-xc-add-chart-type': value/)
  assert.match(CLIENT, /\[\['bar', '柱状'\], \['line', '折线'\], \['pie', '饼图'\]\]/)
  assert.match(CLIENT, /columnSelect\('分类轴'/)
  assert.match(CLIENT, /columnSelect\('数值轴'/)
  assert.match(CLIENT, /columnSelect\('数值列'/)
  assert.match(CLIENT, /'data-xc-add-hint': true/)
  // The submitted body only carries the fields that kind needs.
  assert.match(CLIENT, /if \(addCard\.type === 'chart'\) \{ body\.chart_type = addCard\.chartType; body\.x = addCard\.x; body\.y = addCard\.y \}/)
  assert.match(CLIENT, /if \(addCard\.type === 'kpi'\) body\.y = addCard\.y/)
  // A failed query keeps its configuration and returns focus to the action.
  assert.match(CLIENT, /requestAnimationFrame\(\(\) => runQueryRef\.current\?\.focus\(\)\)/)
})

test('quiet chrome: hover-only card tools, provenance behind the menu, grouped toolbar, selection bars', () => {
  // No provenance strip is painted on the card at all; the card menu owns it.
  assert.doesNotMatch(CLIENT, /data-xc-source-details/)
  assert.match(CLIENT, /data: \{ 'data-xc-source-menu': card\.id \}/)
  // Provenance now lives in the shared trace dialog (data / calculation / session),
  // not in a workspace-local text dump.
  assert.match(CLIENT, /h\(TraceDialog, \{/)
  assert.doesNotMatch(CLIENT, /'data-xc-source-dialog': sourceCard\.id/)
  // The focus tool is invisible until the card is hovered or focused.
  assert.match(CLIENT, /opacity: hovered \|\| keyboardFocused \? 1 : 0, pointerEvents: hovered \|\| keyboardFocused \? 'auto' : 'none'/)
  assert.match(CLIENT, /onPointerEnter: \(\) => setHovered\(true\)/)
  // Canvas toolbar states units and groups its controls. The title slot carries
  // the page identity; the canvas name and its counts ride in the meta slot.
  assert.match(CLIENT, /`\$\{canvas\.name\} · \$\{canvas\.cards\.length\} \$\{t\('canvas\.cardCount'\)\} · \$\{t\('canvas\.revision'\)\} \$\{canvas\.revision\}`/)
  assert.match(CLIENT, /'data-xc-toolbar-sep': 'palette'/)
  assert.match(CLIENT, /'data-xc-toolbar-sep': 'view'/)
  assert.match(CLIENT, /'data-xc-toolbar-sep': 'io'/)
  // Both lists select the shell way: a subtle rounded fill, no leading colour bar.
  assert.match(CLIENT, /\[data-xc-list-row\]\[data-selected="true"\]\{background:color-mix\(in srgb,var\(--dsw-alias-label-primary\) 8%,transparent\)\}/)
  assert.doesNotMatch(CLIENT, /inset 2px 0 0 var\(--dsw-alias-brand-primary\)/)
  // The query-pane collapsibles (汇总 / 更多设置 / 接口诊断) plus the saved-result history.
  // Saved SQL is a popover now, so it no longer counts as a Disclosure.
  assert.equal((CLIENT.match(/h\(Disclosure, \{ label:/g) || []).length, 4, 'every collapsible reuses Disclosure')
})

test('the query pane is on demand, draggable, and never replaces the raw preview', () => {
  assert.match(CLIENT, /const \[queryPaneOpen, setQueryPaneOpen\] = useState\(false\)/, 'the pane must start closed')
  assert.match(CLIENT, /'data-xc-query-pane-toggle': true/)
  assert.match(CLIENT, /'data-xc-query-pane-resizer': true/)
  assert.match(CLIENT, /role: 'separator'/)
  assert.match(CLIENT, /'aria-valuenow': paneWidth/)
  assert.match(CLIENT, /event\.key === 'ArrowLeft'/)
  assert.match(CLIENT, /xc-datasource-query-pane-width/, 'the width must be remembered')
  assert.match(CLIENT, /'data-xc-data-tab': 'preview'/)
  assert.match(CLIENT, /'data-xc-data-tab': 'result'/)
  // The tabs (and the whole tool row) are result-guarded: with no result there is
  // nothing to switch between, so the default view is the table alone.
  assert.match(CLIENT, /const dataToolbar = result\s*\n\s*\? h\('div', \{ 'data-xc-data-toolbar': true, style: S\.subToolbar \}/)
  assert.match(CLIENT, /'data-xc-data-tabs': 'true'/)
  assert.match(CLIENT, /dataView === 'result' && result\s*\n\s*\? h\(DataTablePane/, 'raw preview stays the default view')
  // One control per action: the preview is reached through its tab, so there is
  // no second "back to preview" button; and the identity lives in the page
  // header, so the content pane does not restate it.
  assert.doesNotMatch(CLIENT, /data-xc-back-to-preview/)
  assert.doesNotMatch(CLIENT, /查询结果已就绪/)
  assert.match(CLIENT, /'data-xc-data-toolbar': true, style: S\.subToolbar/)
  assert.match(CLIENT, /@media\(max-width:1100px\)\{\.xc-ds-page \[data-xc-query-pane\]\{position:absolute/, 'narrow windows overlay the pane')
})

test('structured query help explains its limit and announces live status records', () => {
  assert.match(CLIENT, /最多保存 5,000 行/)
  assert.match(CLIENT, /'data-xc-query-builder': true/)
  assert.match(CLIENT, /queryDatasource\(selected, query\)/)
  assert.match(CLIENT, /'data-xc-query-help-toggle': true/)
  assert.match(CLIENT, /queryHelpOpen \? h\('div', \{ role: 'note', 'data-xc-query-help': true/)
  assert.match(CLIENT, /'aria-expanded': queryHelpOpen/)
  assert.doesNotMatch(CLIENT, /title: '读取全部字段的原始行/)
  assert.match(CLIENT, /data-xc-query-status/)
  assert.match(CLIENT, /'aria-live': 'polite'/)
  assert.match(CLIENT, /查询已完成，匹配/)
})

// ── menus and dialogs: one control per meaning, one surface per layer ───────

test('no native dialog or native dropdown survives in the browser half', () => {
  // The greppable acceptance line for the whole menu/dialog plan.
  assert.equal((CLIENT.match(/window\.(prompt|confirm)\s*\(/g) || []).length, 0,
    'every confirmation and prompt goes through the themed components')
  assert.equal((CLIENT.match(/h\('select'/g) || []).length, 0, 'no native <select> is left')
  assert.equal((CLIENT.match(/h\('option'/g) || []).length, 0, 'no native <option> is left')
  // ...and the hooks the tests and the layout depend on are still there.
  for (const hook of ['data-xc-theme-palette', 'data-xc-zoom', 'data-xc-table-column',
    'data-xc-table-value', 'data-xc-query-selector', 'data-xc-add-column']) {
    assert.ok(CLIENT.includes(hook), `${hook} must survive the Select migration`)
  }
  assert.match(CLIENT, /'data-xc-select-panel': 'true'/, 'the themed listbox must exist')
  assert.match(CLIENT, /role: 'combobox'/, 'a Select is a combobox')
  assert.match(CLIENT, /role: 'listbox'/)
  assert.match(CLIENT, /aria-activedescendant/, 'the highlight is announced, not just painted')
})

test('dialogs keep their original surface and gain a three-section skeleton', () => {
  // The mask and the panel fill are deliberately the PREVIOUS values: the user
  // rejected the translucent menu surface here (a menu-sized surface reads as a
  // see-through dialog), so this pair is a regression guard, not a preference.
  assert.match(CLIENT, /background: 'rgba\(0,0,0,\.35\)'/, 'the original mask stays')
  assert.match(CLIENT, /background: 'var\(--dsw-alias-bg-base, #fff\)'/, 'the original opaque panel fill stays')
  assert.equal(INTERACTION_SOURCE.includes('0 12px 60px'), false, 'the shadow follows the shell elevation token')
  const dialogBlock = /const DIALOG = \{[\s\S]*?\n    \}/.exec(INTERACTION_SOURCE)
  assert.ok(dialogBlock, 'expected the dialog token block')
  assert.equal(/--dsw-menu-surface-fill/.test(dialogBlock[0]), false,
    'the dialog must not take the translucent menu surface')
  assert.equal(/borderRadius: '\d+px'/.test(dialogBlock[0]), false, 'no literal dialog radius')
  assert.match(CLIENT, /boxShadow: 'var\(--dsw-elevation-panel/)
  assert.match(CLIENT, /borderRadius: RADIUS\.lg/)
  // The body is the only scrolling section, so the title never leaves.
  assert.match(CLIENT, /'data-xc-dialog-header': true/)
  assert.match(CLIENT, /'data-xc-dialog-body': true/)
  assert.match(CLIENT, /'data-xc-dialog-footer': true/)
  assert.match(CLIENT, /body: \{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '16px' \}/)
  // One shared close affordance with a translated label, not a hard-coded pair.
  assert.match(CLIENT, /'data-xc-dialog-close': true/)
  assert.doesNotMatch(CLIENT, /关闭 \/ Close/)
})

test('confirmation and naming are the only modals, and danger never wears the brand colour', () => {
  assert.match(CLIENT, /function ConfirmDialog/)
  assert.match(CLIENT, /function PromptDialog/)
  assert.match(CLIENT, /'data-xc-confirm-cancel': true/)
  assert.match(CLIENT, /'data-xc-confirm-ok': true/)
  assert.match(CLIENT, /'data-xc-prompt-input': true/)
  assert.match(CLIENT, /state-error-primary, #d9534f/, 'a danger confirm is filled with the error token')
  // Undoable removals report through the status strip instead of asking.
  assert.match(CLIENT, /'data-xc-notice': true/)
  assert.match(CLIENT, /'canvas\.deletedCards': '已删除 \{n\} 张卡片 · Ctrl\+Z 撤销'/)
})

test('the menus are grouped, icon-consistent, honest about shortcuts and scrollable', () => {
  // The overflow menu is built from groups with one divider between them.
  assert.match(CLIENT, /const overflowGroups = \[/)
  assert.match(CLIENT, /index > 0 && group\.length \? \[\{ separator: true \}, \.\.\.group\] : group/)
  // Only shortcuts that exist are advertised.
  assert.match(CLIENT, /hint: 'Ctrl\+Z'/)
  assert.match(CLIENT, /hint: 'Ctrl\+Shift\+Z'/)
  assert.match(CLIENT, /event\.altKey && !ctrl && !event\.shiftKey && key === 'b'/)
  assert.doesNotMatch(CLIENT, /hint: 'Control\+Alt\+B'/, 'the toggle keeps its shortcut in aria-keyshortcuts only')
  // Icon semantics: one glyph per meaning.
  assert.match(CLIENT, /id: 'export-html'.*iconName: 'open'/, 'export HTML uses the open glyph, not the layout one')
  assert.match(CLIENT, /id: 'templates'.*iconName: 'layout'/)
  // A menu that outgrows the window scrolls instead of leaving it.
  assert.match(CLIENT, /maxHeight: pos\.maxHeight, overflowY: 'auto'/)
  assert.match(CLIENT, /function placePopupAt/)
  assert.match(CLIENT, /function placePopup/)
})

test('a card no longer clips its own popups', () => {
  const card = /card:\s*\{[\s\S]*?\n      \}/.exec(CLIENT)
  assert.ok(card, 'expected a card style')
  assert.match(card[0], /overflow: 'visible'/, 'a dropdown inside a card must escape the card box')
  assert.match(card[0], /backdropFilter: 'var\(--dsw-menu-backdrop-filter/)
})

