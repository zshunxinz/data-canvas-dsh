/**
 * dsh-xcharts-canvas — browser half.
 *
 * Generated from ordered client-src sections by scripts/build-client.mjs.
 * It preserves the host ModuleLoader contract and uses the shell-provided `react` dependency.
 *
 * What it contributes
 *   1. `main` — two panels: the canvas workspace (a list of canvases on the left,
 *      the selected canvas on the right, on the same 96-column grid the agent
 *      writes to) and the datasource workspace (import, preview, structured
 *      query). Users can drag cards, and every change is written straight back
 *      through the plugin's own HTTP routes.
 *   2. `sidebar.panellist` — the two 数据源 / 分析画布 entries.
 *   3. `tool.call.toolview` — `canvas_add_card` / `canvas_update_card` render as
 *      real cards **in the conversation**, so a chart is visible where the user
 *      asked for it instead of only in the canvas panel. The card comes from the
 *      call arguments (full fidelity), not from the sampled draft projection.
 *
 * The agent owns canvas *content*; the workspace view owns *layout* edits, which
 * is the one thing a chat message is a poor fit for.
 *
 * Data comes over the plugin's own same-origin `/api/xcharts-canvas/*` routes
 * rather than a typed Remote binding, so the browser half stays independent of
 * the kernel's remote assembly.
 */

window.__ModuleLoader__.load({
  id: 'dsh-xcharts-canvas',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } = React
