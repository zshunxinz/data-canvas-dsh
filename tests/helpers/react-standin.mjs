/**
 * Renders the browser half's component tree in Node, with a tiny React stand-in.
 *
 * Why: the bundle is a hand-written ModuleLoader factory, so nothing executes it
 * until a real browser does — and props mistakes (the `t is not a function`
 * crash) slip past every static check. This stand-in calls the component tree,
 * keeps hook slots per component path, and checks hook order/count on updates.
 * It models effect dependencies and class children, but not React's scheduler,
 * error-boundary recovery, or browser layout. Tests drive re-renders explicitly.
 *
 * Usage: imported by client-render.test.js
 */

let hookState = new Map()
let hookIndex = 0
let rerenderDepth = 0
// Effects collected during the last render, run by `flushEffects`.
let pendingEffects = []
let componentStates = new Map()
let activeComponent = null
export const renderedElements = []

export function resetRenderState () {
  hookState = new Map()
  hookIndex = 0
  rerenderDepth = 0
  pendingEffects = []
  componentStates = new Map()
  activeComponent = null
  renderedElements.length = 0
  __attachedRefs.clear()
}

function hookSlot (kind) {
  const id = hookIndex++
  if (!hookState.has(id)) hookState.set(id, { kind })
  const slot = hookState.get(id)
  if (slot.kind !== kind) throw new Error(`Hook order changed in ${activeComponent.name}`)
  return slot
}

const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

/** Test-only view of the hook slots, for debugging render tests. */
export const __getHookState = () => hookState

/**
 * Run the effects the last render registered.
 *
 * A workspace's data load happens inside useEffect, so a render without this
 * never leaves the loading state — which is exactly why the first version of
 * this helper reported "no cards render" while the real page worked.
 */
export async function flushEffects () {
  for (let round = 0; round < 20; round++) {
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) effect()
    // Effects schedule async work (fetch chains); let microtasks settle. A
    // settle round can register the next round of effects (a re-render
    // schedules its own), so the loop only stops when nothing new appeared.
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
    if (pendingEffects.length === 0) {
      // One extra settle before declaring quiescence: the last completed
      // microtask may still have queued work without registering an effect.
      await new Promise(resolve => setImmediate(resolve))
      if (pendingEffects.length === 0) break
    }
  }
}

export const React = {
  createElement (type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity) }
  },
  Fragment: Symbol.for('react.fragment'),
  // Minimal class base so bundles can define error boundaries. The stand-in
  // never runs React's reconciliation, so only the constructor shape matters.
  Component: class Component {
    constructor (props) { this.props = props }
    setState (patch) { Object.assign(this.state ??= {}, typeof patch === 'function' ? patch(this.state) : patch) }
    render () { return null }
  },
  useState (initial) {
    const slot = hookSlot('state')
    if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial
    return [slot.value, next => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
    }]
  },
  useEffect (effect, deps) {
    // Collect instead of running: hooks fire during render, and effects must
    // run after it. flushEffects() drives them between renders.
    const slot = hookSlot('effect')
    if (!sameDeps(slot.deps, deps)) {
      slot.deps = deps
      pendingEffects.push(() => {
        slot.cleanup?.()
        slot.cleanup = effect()
      })
    }
  },
  useLayoutEffect (effect, deps) { React.useEffect(effect, deps) },
  useMemo (fn, deps) {
    const slot = hookSlot('memo')
    if (!sameDeps(slot.deps, deps)) {
      slot.value = fn()
      slot.deps = deps
    }
    return slot.value
  },
  useRef (initial) {
    const slot = hookSlot('ref')
    if (!('value' in slot)) slot.value = { current: initial }
    return slot.value
  },
  useCallback (fn, deps) { return React.useMemo(() => fn, deps) },
}

/**
 * A fake DOM element: enough surface for echarts' init and the tests.
 *
 * `width` mirrors a realistic desktop by default. The BOARD is the exception:
 * the drag tests derive their expected grid columns from it (400 - 16 = 384,
 * 384 / 96 = 4px per column), so the ref walk hands it a narrow element and
 * leaves every other container roomy. That keeps the header un-folded in tests
 * unless one asks for a narrow pane explicitly.
 */
function makeFakeElement (width = 1200) {
  return {
    tagName: 'DIV',
    style: {},
    children: [],
    clientWidth: width,
    clientHeight: 200,
    getBoundingClientRect: () => ({ x: 0, y: 0, width, height: 200, left: 0, top: 0 }),
    // Real DOM answers "is this node a descendant of me?"; the stand-in has no
    // tree, so it answers yes. That is what a shortcut scoped to the workspace
    // (`workspaceRef.contains(document.activeElement)`) needs to be exercised.
    contains: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => {},
  }
}

/** The board keeps its narrow width: drag geometry is measured from it. */
const BOARD_WIDTH = 400

/** Refs seen during the last render, wired by the ref walk in renderToString. */
export const __attachedRefs = new Set()

/**
 * Construct a class component and render it once, honouring the boundary
 * contract: if the class defines getDerivedStateFromError we still just call
 * render() — the stand-in does not simulate fault injection, so the boundary
 * renders its children.
 */
function renderClassInstance (Type, props, children) {
  const instance = new Type({ ...props, children })
  if (typeof instance.componentDidMount === 'function') {
    pendingEffects.push(() => instance.componentDidMount())
  }
  return instance.render()
}

/** Recursively "render": call component functions, walk the element tree. */
export function renderToString (node, depth = 0, path = 'root') {
  // Reset the traversal counters; each component below owns its hook sequence.
  if (depth === 0) {
    hookIndex = 0
    rerenderDepth = 0
    renderedElements.length = 0
  }
  if (depth > 40) return '<max depth>'
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, i) => renderToString(child, depth + 1, `${path}/${child?.props?.key ?? i}`)).join('')
  if (typeof node !== 'object') return ''
  if (typeof node.type === 'symbol') return renderToString(node.children, depth + 1, path)
  if (typeof node.type === 'function') {
    if (rerenderDepth++ > 200) throw new Error('render loop: a component rendered itself unboundedly')
    // Class components (error boundaries) must be constructed; plain function
    // components are called.
    const isClass = /^class\s/.test(Function.prototype.toString.call(node.type))
    let state = componentStates.get(path)
    if (!state || state.type !== node.type) {
      state = { type: node.type, name: node.type.name, hooks: new Map(), count: null }
      componentStates.set(path, state)
    }
    activeComponent = state
    hookState = state.hooks
    hookIndex = 0
    const output = isClass
      ? renderClassInstance(node.type, node.props, node.children)
      : node.type({ ...node.props, children: node.children })
    if (state.count !== null && state.count !== hookIndex) {
      throw new Error(`Hook count changed in ${state.name}: ${state.count} -> ${hookIndex}`)
    }
    state.count = hookIndex
    return renderToString(output, depth + 1, `${path}/render`)
  }
  // Element type validity: a host element's type must
  // be a non-empty string tag. An undefined/empty type here means the bundle
  // passed an uninitialised variable to h().
  if (typeof node.type !== 'string' || node.type === '') {
    throw new Error(`invalid element type (${typeof node.type})`)
  }
  renderedElements.push(node)
  // Element with a ref: attach a fake DOM node, as the real renderer would
  // attach a real one. Without this, any component whose effect reads its
  // container ref (echarts init) sees null and silently skips its setup.
  //
  // Width matters: the board must stay narrow (the drag tests derive grid
  // columns from it), while the header pane must be wide enough that the
  // single-line toolbar has room. Choosing per ref-target keeps both honest
  // without any test having to inject a width.
  if (node.props?.ref && typeof node.props.ref === 'object' && node.props.ref.current === null) {
    const isBoard = node.props['data-xc-board'] !== undefined || node.props['data-xc-board-inner'] !== undefined
    node.props.ref.current = makeFakeElement(isBoard ? BOARD_WIDTH : undefined)
    __attachedRefs.add(node.props.ref)
  }
  // Serialize data-* attributes so tests can assert on structural markers
  // (e.g. data-xc-color-bar="red") the way a real DOM would carry them.
  let attrs = ''
  for (const [key, value] of Object.entries(node.props || {})) {
    if (key.startsWith('data-') && value !== undefined && value !== null && typeof value !== 'object') {
      attrs += ` ${key}="${String(value)}"`
    }
  }
  return attrs + renderToString(node.children, depth + 1, `${path}/children`)
}
