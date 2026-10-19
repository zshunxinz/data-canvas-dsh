// ── 00-entry.js ─────────────────────────────────────────────────────────
/**
 * data-canvas-dsh — browser half.
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
  id: 'data-canvas-dsh',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } = React

// ── 01-bootstrap.js ─────────────────────────────────────────────────────────

    // ECharts loads through a package-local chunk (client.echarts.js, generated
    // from the UMD build by scripts/build-echarts-chunk.mjs). The host's client
    // require only resolves the module table — plugin npm dependencies are not
    // in it (measured) — but require.async('./client.*.js') is the supported
    // chunk escape hatch. Deferred to first chart card, and failures degrade to
    // the bar sketch rather than crashing the page.
    let echarts = null
    let echartsPromise = null
    let echartsLoadFailed = false
    function loadEcharts () {
      return echarts
    }
    function requestEcharts () {
      if (echarts || echartsLoadFailed) return Promise.resolve(echarts)
      if (!echartsPromise) {
        echartsPromise = require.async('./client.echarts.js').then(lib => {
          echarts = lib
          return lib
        }).catch(error => {
          echartsLoadFailed = true
          try { console.error('[xcharts-canvas] echarts unavailable, falling back to sketch:', error?.message) } catch { /* non-fatal */ }
          return null
        })
      }
      return echartsPromise
    }

    const NS = 'settings.xchartsCanvas'
    const inject = ['slots', 'locale']
    const API = '/api/xcharts-canvas'

// ── 02-theme-locale.js ─────────────────────────────────────────────────────────
    // ── chart themes (inline copy of lib/themes.js) ──────────────────────────
    //
    // Copied, not imported: the browser half may only require what the shell
    // provides plus echarts (see the copy-not-reference note in the README).
    // Keep the two files in step — themes.test.js pins the shared semantics.
    const PALETTES = {
      classic: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f43f5e', '#84cc16', '#64748b'],
      pastel: ['#7c9ef5', '#8fd6b4', '#f2c57c', '#f19a9a', '#c3a6f2', '#7fd4e0', '#f4a4c0', '#b5d17f', '#a8b3c5'],
      vivid: ['#2563eb', '#16a34a', '#dc2626', '#f97316', '#7c3aed', '#0891b2', '#e11d48', '#65a30d', '#94a3b8'],
      warm: ['#d97706', '#b91c1c', '#15803d', '#7c2d12', '#a16207', '#9f1239', '#4d7c0f', '#c2410c', '#78350f'],
      cool: ['#0e7490', '#155e75', '#0284c7', '#0369a1', '#14b8a6', '#2563eb', '#0891b2', '#334155', '#64748b'],
      neon: ['#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#22d3ee', '#f472b6', '#a3e635', '#94a3b8'],
    }
    const PALETTE_NAMES = Object.keys(PALETTES)
    const CHROME_MODES = ['follow-host', 'light', 'dark']

    const FIXED_CHROME = {
      light: {
        background: 'transparent', text: '#0f1115', textSecondary: '#61666b',
        gridLine: 'rgba(15, 17, 21, 0.10)',
      },
      dark: {
        background: 'transparent', text: '#e6e8eb', textSecondary: '#9ba1a8',
        gridLine: 'rgba(230, 232, 235, 0.12)',
      },
    }

    /** Read a CSS custom property, walking up from the panel if :root lacks it.
     *
     * Measured: the shell defines --dsw-* tokens on deep wrappers (body *),
     * not on :root, so a plain getComputedStyle(root) read resolves empty. The
     * panel element itself inherits the right values, so start there when
     * provided and fall back to :root.
     */
    function token (name, fallback, fromEl) {
      try {
        const probe = fromEl || document.documentElement
        const value = getComputedStyle(probe).getPropertyValue(name).trim()
        if (value) return value
        // Walk up: the closest ancestor (or the probe itself) that carries it.
        let el = fromEl?.parentElement
        while (el) {
          const v = getComputedStyle(el).getPropertyValue(name).trim()
          if (v) return v
          el = el.parentElement
        }
        return getComputedStyle(document.body || document.documentElement).getPropertyValue(name).trim() || fallback
      } catch {
        return fallback
      }
    }

    /**
     * Follow the host's own light/dark decision — the user explicitly wants the
     * canvas to track DeepSeek Harness, not its own toggle.
     *
     * Measured markers, in priority order (probe: xc-theme-probe.mjs):
     *   1. <html data-ds-theme-source="light|dark">  — the host's own attribute
     *   2. <html style="color-scheme: light|dark">   — resolved color-scheme
     *   3. prefers-color-scheme                      — OS level fallback
     * The bg-luminance heuristic is gone: it guessed from a token that resolved
     * empty in the real shell and mislabelled themes.
     */
    function isDarkRequested () {
      try {
        const root = document.documentElement
        const source = root.getAttribute('data-ds-theme-source')
        if (source === 'dark') return true
        if (source === 'light') return false
        const scheme = root.style?.colorScheme || getComputedStyle(root).getPropertyValue('color-scheme')
        if (/\bdark\b/.test(scheme)) return true
        if (/\blight\b/.test(scheme)) return false
        if (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches) return true
      } catch { /* non-DOM: default to light */ }
      return false
    }

    /**
     * Blend a hex/base colour toward transparency as a concrete rgba() string.
     * ECharts paints on canvas and cannot resolve CSS color-mix/var(), so the
     * follow-host chrome needs literal colour values computed from the tokens.
     */
    function rgbaMix (color, alpha) {
      const m = /^#([0-9a-f]{6})$/i.exec(String(color).trim())
      if (!m) return `rgba(128,128,128,${alpha})`
      const n = parseInt(m[1], 16)
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
    }

    /**
     * One theme object drives both the ECharts instance and the card chrome.
     *
     * The chrome always follows the host — light/dark toggles were removed
     * because the fixed variants drifted from the real shell colours. `fromEl`
     * is the panel element; tokens are read from it (or its ancestors), since
     * the shell defines --dsw-* on deep wrappers rather than :root.
     */
    function resolveTheme (paletteName, fromEl) {
      const series = PALETTES[paletteName] || PALETTES.classic
      const text = token('--dsw-alias-label-primary', FIXED_CHROME.light.text, fromEl)
      const textSecondary = token('--dsw-alias-label-tertiary', FIXED_CHROME.light.textSecondary, fromEl)
      const chrome = {
        background: 'transparent',
        text,
        textSecondary,
        // Computed from the text token: canvas needs a literal rgba().
        gridLine: rgbaMix(text, 0.12),
      }
      const isDark = isDarkRequested()
      return {
        ...chrome, series, isDark,
        echarts: {
          color: series,
          backgroundColor: 'transparent',
          textStyle: { color: chrome.text },
          legend: { textStyle: { color: chrome.text } },
          categoryAxis: {
            axisLine: { lineStyle: { color: chrome.gridLine } },
            axisLabel: { color: chrome.textSecondary },
            splitLine: { show: false },
          },
          valueAxis: {
            axisLine: { show: false },
            axisLabel: { color: chrome.textSecondary },
            splitLine: { lineStyle: { color: chrome.gridLine } },
          },
          tooltip: {
            backgroundColor: isDark ? 'rgba(30,32,36,.94)' : 'rgba(255,255,255,.96)',
            textStyle: { color: chrome.text },
          },
        },
      }
    }

    function normalizeTheme (stored) {
      // Chrome is always follow-host now; only the palette is user-selectable.
      const palette = PALETTES[stored?.palette] ? stored.palette : 'classic'
      return { palette }
    }

    const DICT = {
      zh: {
        'nav.title': '分析画布',
        'nav.description': '浏览与整理由对话生成的数据分析画布。',
        'canvas.title': '分析画布',
        'canvas.empty': '还没有画布。在对话里让 Agent 创建一个，例如「把这次销售分析做成一张画布」。',
        'canvas.loading': '加载中…',
        'canvas.error': '加载失败',
        'canvas.retry': '重试',
        'canvas.new': '新建画布',
        'canvas.addExample': '添加案例画布',
        'canvas.addingExample': '正在添加案例…',
        'canvas.pluginOutdated': '画布界面与宿主加载的插件版本不一致。请更新插件并重新启动 DSH，然后刷新页面。',
        'canvas.noCanvas': '还没有画布。在对话里让 Agent 创建，或点下方按钮开始。',
        'canvas.newName': '画布名称',
        'canvas.delete': '删除',
        'canvas.deleteConfirm': '删除后无法撤销。',
        'canvas.cards': '张卡片',
        'canvas.updated': '更新于',
        'canvas.revision': '版本',
        'canvas.emptyCards': '这个画布还没有卡片。',
        'canvas.emptyCardsHint': '在对话里让 Agent 把分析放到这里，或从工具栏打开布局模板。',
        'canvas.searchList': '搜索画布',
        'canvas.searchEmpty': '没有匹配的画布。',
        'canvas.arrange': '一键整理',
        'canvas.refresh': '刷新',
        'canvas.saving': '保存中…',
        'canvas.saved': '已保存',
        'canvas.saveFailed': '保存失败',
        'canvas.undo': '撤销',
        'canvas.redo': '重做',
        'canvas.nothingToUndo': '没有可撤销的操作',
        'canvas.nothingToRedo': '没有可重做的操作',
        'canvas.batchDelete': '删除所选卡片',
        'canvas.clearSelection': '取消选择',
        'canvas.export': '导出 PNG',
        'canvas.exportFailed': '导出失败',
        'canvas.backupExport': '备份 JSON',
        'canvas.backupImport': '导入备份',
        'canvas.backupExportConfirm': '备份文件会包含本画布已保存的图表、表格数据和来源说明。请将下载文件保存在可信位置。继续导出？',
        'canvas.backupImportConfirm': '导入会在本机新建一张画布，不会覆盖现有画布。文件中的卡片数据与来源说明会写入本机插件存储。继续？',
        'canvas.backupImportFailed': '备份导入失败',
        'canvas.backupTooLarge': '备份文件超过 8 MiB，无法导入。',
        'canvas.backupExportTooLarge': '备份文件超过 8 MiB，当前无法重新导入。',
        'canvas.cardCount': '张卡片',
        'card.source': '数据来源',
        'card.query': '计算方式',
        'card.noData': '（此卡片暂无数据）',
        'card.text': '文字',
        'card.kpi': '指标',
        'card.table': '表格',
        'card.chart': '图表',
        'card.code': '代码',
        'card.rename': '重命名',
        'card.duplicate': '创建副本',
        'card.copySource': '复制数据来源',
        'card.close': '关闭',
        'card.copySourceSuccess': '数据来源已复制到剪贴板',
        'card.copySourceFailed': '复制失败，请检查浏览器剪贴板权限。',
        'card.showHeader': '显示标题栏',
        'card.hideHeader': '隐藏标题栏',
        'card.collapse': '折叠内容',
        'card.expand': '展开内容',
        'card.moveTo': '移动到画布…',
        'card.copyTo': '复制到画布…',
        'card.color': '标记颜色',
        'card.colorDefault': '默认',
        'card.delete': '删除卡片',
        'card.resize': '拖动调整大小',
        'card.dataPoints': '数据点',
        'card.series': '个系列',
        'card.truncated': '仅显示前 {n} 个数据点',
        'card.rowCap': '仅显示前 {n} 行（共 {total} 行）— 可点击表头排序',
        'card.sortHint': '点击排序：升 → 降 → 原序',
        'card.target': '目标 {n}',
        'card.pickTarget': '选择目标画布',
        'card.movedTo': '已移动到「{name}」',
        'card.copiedTo': '已复制到「{name}」',
        'card.noTargets': '只有一个画布，无法移动或复制。',
        'canvas.merge': '并入其他画布…',
        'canvas.mergePick': '选择要并入的画布',
        'canvas.merged': '已并入 {n} 张卡片',
        'theme.palette': '系列色板',
        'theme.palette.classic': '经典蓝',
        'theme.palette.pastel': '柔和粉彩',
        'theme.palette.vivid': '高对比',
        'theme.palette.warm': '暖调大地',
        'theme.palette.cool': '冷调青灰',
        'theme.palette.neon': '霓虹（深底）',
        'list.title': '画布',
        'list.collapse': '收起列表',
        'list.expand': '展开列表',
        'list.empty': '还没有画布',
      },
      en: {
        'nav.title': 'Analysis Canvas',
        'nav.description': 'Browse and tidy data-analysis canvases produced in chat.',
        'canvas.title': 'Analysis Canvas',
        'canvas.empty': 'No canvases yet. Ask the agent in chat, e.g. "put this sales analysis on a canvas".',
        'canvas.loading': 'Loading…',
        'canvas.error': 'Failed to load',
        'canvas.retry': 'Retry',
        'canvas.new': 'New canvas',
        'canvas.addExample': 'Add example canvas',
        'canvas.addingExample': 'Adding example…',
        'canvas.pluginOutdated': 'The canvas UI and host plugin versions do not match. Update the plugin, restart DSH, then refresh this page.',
        'canvas.noCanvas': 'No canvases yet. Ask the agent to create one, or start below.',
        'canvas.newName': 'Canvas name',
        'canvas.delete': 'Delete',
        'canvas.deleteConfirm': 'This cannot be undone.',
        'canvas.cards': 'cards',
        'canvas.updated': 'updated',
        'canvas.revision': 'rev',
        'canvas.emptyCards': 'This canvas has no cards yet.',
        'canvas.emptyCardsHint': 'Ask the agent to put an analysis here, or open a layout template.',
        'canvas.searchList': 'Search canvases',
        'canvas.searchEmpty': 'No canvas matches.',
        'canvas.arrange': 'Tidy up',
        'canvas.refresh': 'Refresh',
        'canvas.saving': 'Saving…',
        'canvas.saved': 'Saved',
        'canvas.saveFailed': 'Save failed',
        'canvas.undo': 'Undo',
        'canvas.redo': 'Redo',
        'canvas.nothingToUndo': 'Nothing to undo',
        'canvas.nothingToRedo': 'Nothing to redo',
        'canvas.batchDelete': 'Delete selected cards',
        'canvas.clearSelection': 'Clear selection',
        'canvas.export': 'Export PNG',
        'canvas.exportFailed': 'Export failed',
        'canvas.backupExport': 'Backup JSON',
        'canvas.backupImport': 'Import backup',
        'canvas.backupExportConfirm': 'The backup includes this canvas’s saved charts, table data, and source notes. Save the downloaded file in a trusted location. Continue?',
        'canvas.backupImportConfirm': 'Import creates a new local canvas and does not replace existing canvases. Card data and source notes in the file will be stored locally by this plugin. Continue?',
        'canvas.backupImportFailed': 'Backup import failed',
        'canvas.backupTooLarge': 'The backup exceeds 8 MiB and cannot be imported.',
        'canvas.backupExportTooLarge': 'The backup exceeds 8 MiB and cannot currently be re-imported.',
        'canvas.cardCount': 'cards',
        'card.source': 'Source',
        'card.query': 'Computed by',
        'card.noData': '(no data on this card)',
        'card.text': 'Text',
        'card.kpi': 'KPI',
        'card.table': 'Table',
        'card.chart': 'Chart',
        'card.code': 'Code',
        'card.rename': 'Rename',
        'card.duplicate': 'Duplicate',
        'card.copySource': 'Copy provenance',
        'card.close': 'Close',
        'card.copySourceSuccess': 'Source copied to clipboard',
        'card.copySourceFailed': 'Copy failed. Check clipboard permission.',
        'card.showHeader': 'Show header',
        'card.hideHeader': 'Hide header',
        'card.collapse': 'Collapse',
        'card.expand': 'Expand',
        'card.moveTo': 'Move to canvas…',
        'card.copyTo': 'Copy to canvas…',
        'card.color': 'Accent colour',
        'card.colorDefault': 'Default',
        'card.delete': 'Delete card',
        'card.resize': 'Drag to resize',
        'card.dataPoints': 'points',
        'card.series': 'series',
        'card.truncated': 'showing first {n} points',
        'card.rowCap': 'showing first {n} of {total} rows — click a header to sort',
        'card.sortHint': 'Click to sort: asc → desc → natural',
        'card.target': 'target {n}',
        'card.pickTarget': 'Choose a target canvas',
        'card.movedTo': 'Moved to "{name}"',
        'card.copiedTo': 'Copied to "{name}"',
        'card.noTargets': 'Only one canvas exists — nothing to move to.',
        'canvas.merge': 'Merge another canvas…',
        'canvas.mergePick': 'Choose the canvas to merge in',
        'canvas.merged': 'Merged {n} cards',
        'theme.palette': 'Series palette',
        'theme.palette.classic': 'Classic blue',
        'theme.palette.pastel': 'Soft pastel',
        'theme.palette.vivid': 'High contrast',
        'theme.palette.warm': 'Warm earth',
        'theme.palette.cool': 'Cool teal',
        'theme.palette.neon': 'Neon (dark)',
        'list.title': 'Canvases',
        'list.collapse': 'Collapse list',
        'list.expand': 'Expand list',
        'list.empty': 'No canvases yet',
      },
    }

    Object.assign(DICT.zh, {
      'ds.addSource': '新增数据源', 'ds.addSourceHint': '导入文件或连接数据库', 'ds.sourceFile': '文件', 'ds.sourceDatabase': '数据库',
      'ds.dropHere': '拖拽文件到此处，或点击选择', 'ds.fileTypes': '支持 CSV / TSV / XLSX / Parquet', 'ds.importing': '正在导入…',
      'ds.imported': '数据源已导入', 'ds.tables': '张表', 'ds.showSchema': '表结构', 'ds.hideSchema': '收起结构',
      'ds.dbType': '类型', 'ds.dbName': '名称', 'ds.dbHost': '主机', 'ds.dbPort': '端口', 'ds.dbDatabase': '数据库', 'ds.dbUser': '用户',
      'ds.dbPassword': '密码', 'ds.dbSsl': '使用 SSL', 'ds.dbTest': '测试连接', 'ds.dbTesting': '连接中…', 'ds.dbConnected': '连接成功',
      'ds.dbSave': '保存连接', 'ds.dbNote': '密码只保存在本机加密凭据里：不会出现在界面、备份、导出文件、日志或 AI 上下文中。', 'ds.dbNeedsSecret': '这份连接来自备份，需要重新填写密码。',
      'ds.dbSecretSave': '保存密码', 'ds.dbSql': 'SQL', 'ds.dbRun': '执行', 'ds.dbRunning': '执行中…', 'ds.dbReadOnly': '只读 · 最多 5,000 行 · 15s 超时 · Ctrl+Enter 执行',      'settings.backup': '备份', 'settings.backupExport': '导出备份', 'settings.backupExportHint': '把全部画布与布局模板下载为一个 JSON 文件',
      'settings.backupImport': '导入备份', 'settings.backupImportHint': '从备份文件新建画布与模板，不覆盖现有内容',
      'settings.backupScope': '备份范围', 'settings.backupNote': '包含全部画布（卡片数据与来源说明）与布局模板；数据源原始表格不包含，需另行导入。',
      'settings.backupExported': '已导出备份', 'settings.backupImported': '已导入备份', 'settings.backupExportFailed': '导出失败', 'settings.backupImportFailed': '导入失败',
      'settings.backupTooLarge': '备份文件超过 8 MiB，无法导入', 'settings.backupCanvases': '张画布', 'settings.backupTemplates': '个模板',
      'settings.backupSkipped': '条未导入', 'settings.backupWorking': '正在处理备份…', 'settings.backupImportConfirm': '导入会新建画布与模板，不覆盖现有内容。继续？',
      'settings.cancel': '取消',      'settings.storagePath': '存储位置', 'settings.defaultPath': '默认路径', 'settings.customPath': '自定义路径',
      'settings.usageTotal': '占用合计', 'settings.files': '个文件', 'settings.copy': '复制', 'settings.copied': '已复制',
      'settings.loading': '正在读取…',      'settings.display': '显示', 'settings.storage': '存储', 'settings.about': '关于', 'settings.snapHint': '拖动卡片时显示对齐辅助线并自动吸附',
      'settings.wideHint': '画布横向扩展到 96 列，适合宽屏拼图', 'settings.badgesHint': '卡片右上角显示图表/表格/指标等类型标签',
      'settings.resetZoomHint': '把画布缩放恢复为 100%', 'settings.version': '版本', 'settings.changelog': '最近更新',
      'settings.changelogHint': '查看最近几个版本的变更', 'settings.changelogFile': '更新日志文件',
      'settings.export': '导出', 'settings.exportHint': 'PNG 保存当前布局，超长画布会分片下载；HTML 包含全部已载入表格行，可离线查看。',      'table.loaded': '已载入行数', 'canvas.settings': '画布设置', 'canvas.snap': '拖拽辅助线与吸附',
      'table.filter': '筛选已载入数据', 'table.column': '全部列', 'table.clear': '清除筛选', 'table.csv': '导出筛选结果 CSV',
      'canvas.templates': '布局模板', 'canvas.saveTemplate': '另存布局模板', 'canvas.templateName': '模板名称（仅保存布局，不含业务数据）',
      'canvas.templateEmpty': '还没有模板。从当前画布另存一份布局开始。', 'canvas.templatePreview': '布局预览',
      'canvas.templateClone': '由此模板创建画布', 'canvas.templateDelete': '删除此模板', 'canvas.templateDeleteConfirm': '删除此模板？已创建的画布不受影响。',
      'canvas.templateNote': '模板仅包含卡片类型、占位标题、尺寸、配色和设置，不带图表/表格数据及来源。',
      'canvas.outside': '视口外卡片', 'canvas.previous': '上一张', 'canvas.next': '下一张',
      'canvas.wide': '超大画布（横向扩展）', 'canvas.close': '关闭', 'canvas.focus': '放大查看',
      'canvas.badges': '显示卡片类型标签',
      'canvas.search': '搜索卡片', 'canvas.searchEmpty': '没有匹配的卡片', 'canvas.fit': '适应全部',
      'canvas.resetZoom': '重置 100%', 'canvas.exportHtml': '导出 HTML', 'canvas.exporting': '正在导出…',
      'canvas.alignLeft': '左对齐', 'canvas.alignRight': '右对齐', 'canvas.alignTop': '顶部对齐',
      'canvas.alignBottom': '底部对齐', 'canvas.spaceX': '水平等距', 'canvas.spaceY': '垂直等距',
      'canvas.selected': '已选', 'canvas.searchHint': '按标题或类型搜索', 'canvas.moveHint': '拖动任一选中卡片的标题可成组移动。',
      'canvas.exportNote': 'PNG 保存当前布局，超长画布会分片下载；HTML 包含全部已载入表格行，可离线查看。',
      'canvas.zoom': '缩放', 'canvas.more': '更多操作',
      // Dialog furniture. One label per intent: a cancel is a cancel everywhere,
      // so a new dialog never has to invent its own wording.
      'canvas.cancel': '取消', 'canvas.save': '保存', 'canvas.create': '创建',
      'canvas.notEmpty': '不能为空。',
      'canvas.untitled': '未命名画布',
      'canvas.deletedCards': '已删除 {n} 张卡片 · Ctrl+Z 撤销',
      'canvas.renamedCanvas': '画布已重命名。',
      'canvas.deleteCanvas': '删除画布',
      'canvas.open': '打开',
      'canvas.rename': '重命名画布',
      'canvas.emptyHint': '点上面的「新建画布」开始，或在对话里让 Agent 生成。',
    })
    Object.assign(DICT.en, {
      'ds.addSource': 'Add data source', 'ds.addSourceHint': 'Import a file or connect a database', 'ds.sourceFile': 'File', 'ds.sourceDatabase': 'Database',
      'ds.dropHere': 'Drop a file here, or click to choose', 'ds.fileTypes': 'CSV / TSV / XLSX / Parquet', 'ds.importing': 'Importing…',
      'ds.imported': 'Data source imported', 'ds.tables': 'tables', 'ds.showSchema': 'Schema', 'ds.hideSchema': 'Hide schema',
      'ds.dbType': 'Engine', 'ds.dbName': 'Name', 'ds.dbHost': 'Host', 'ds.dbPort': 'Port', 'ds.dbDatabase': 'Database', 'ds.dbUser': 'User',
      'ds.dbPassword': 'Password', 'ds.dbSsl': 'Use SSL', 'ds.dbTest': 'Test connection', 'ds.dbTesting': 'Connecting…', 'ds.dbConnected': 'Connected',
      'ds.dbSave': 'Save connection', 'ds.dbNote': 'The password is stored only in the local encrypted credential store: it never appears in the UI, backups, exports, logs or the model context.', 'ds.dbNeedsSecret': 'This connection came from a backup and needs its password again.',
      'ds.dbSecretSave': 'Save password', 'ds.dbSql': 'SQL', 'ds.dbRun': 'Run', 'ds.dbRunning': 'Running…', 'ds.dbReadOnly': 'Read-only · max 5,000 rows · 15s timeout · Ctrl+Enter to run',      'settings.backup': 'Backup', 'settings.backupExport': 'Export backup', 'settings.backupExportHint': 'Download every canvas and layout template as one JSON file',
      'settings.backupImport': 'Import backup', 'settings.backupImportHint': 'Create canvases and templates from a backup file; nothing is replaced',
      'settings.backupScope': 'Scope', 'settings.backupNote': 'Includes every canvas (card data and source notes) and layout templates. Raw data-source tables are not included; import those separately.',
      'settings.backupExported': 'Backup exported', 'settings.backupImported': 'Backup imported', 'settings.backupExportFailed': 'Export failed', 'settings.backupImportFailed': 'Import failed',
      'settings.backupTooLarge': 'The backup exceeds 8 MiB and cannot be imported', 'settings.backupCanvases': 'canvases', 'settings.backupTemplates': 'templates',
      'settings.backupSkipped': 'skipped', 'settings.backupWorking': 'Working on the backup…', 'settings.backupImportConfirm': 'Import creates new canvases and templates and replaces nothing. Continue?',
      'settings.cancel': 'Cancel',      'settings.storagePath': 'Storage location', 'settings.defaultPath': 'Default path', 'settings.customPath': 'Custom path',
      'settings.usageTotal': 'Total size', 'settings.files': 'files', 'settings.copy': 'Copy', 'settings.copied': 'Copied',
      'settings.loading': 'Loading…',      'settings.display': 'Display', 'settings.storage': 'Storage', 'settings.about': 'About', 'settings.snapHint': 'Show alignment guides and snap while dragging cards',
      'settings.wideHint': 'Extend the board to 96 columns for wide layouts', 'settings.badgesHint': 'Show the card type badge in the header',
      'settings.resetZoomHint': 'Restore the canvas zoom to 100%', 'settings.version': 'Version', 'settings.changelog': 'Recent updates',
      'settings.changelogHint': 'See what changed in the last releases', 'settings.changelogFile': 'Changelog file',
      'settings.export': 'Export', 'settings.exportHint': 'PNG keeps the current layout and downloads large canvases in tiles. HTML includes all loaded table rows and opens offline.',      'table.loaded': 'Loaded rows', 'canvas.settings': 'Canvas settings', 'canvas.snap': 'Drag guides and snapping',
      'table.filter': 'Filter loaded data', 'table.column': 'All columns', 'table.clear': 'Clear filters', 'table.csv': 'Export filtered CSV',
      'canvas.templates': 'Layout templates', 'canvas.saveTemplate': 'Save layout template', 'canvas.templateName': 'Template name (layout only, no business data)',
      'canvas.templateEmpty': 'No templates. Save the current canvas layout to begin.', 'canvas.templatePreview': 'Layout preview',
      'canvas.templateClone': 'Create canvas from template', 'canvas.templateDelete': 'Delete this template', 'canvas.templateDeleteConfirm': 'Delete this template? Existing canvases are unaffected.',
      'canvas.templateNote': 'Templates contain types, placeholder titles, layout, palette and settings only; no chart/table payload or provenance.',
      'canvas.outside': 'Cards outside viewport', 'canvas.previous': 'Previous card', 'canvas.next': 'Next card',
      'canvas.wide': 'Wide canvas (horizontal expansion)', 'canvas.close': 'Close', 'canvas.focus': 'Expand card',
      'canvas.badges': 'Show card type labels',
      'canvas.search': 'Find cards', 'canvas.searchEmpty': 'No matching cards', 'canvas.fit': 'Fit all',
      'canvas.resetZoom': 'Reset to 100%', 'canvas.exportHtml': 'Export HTML', 'canvas.exporting': 'Exporting…',
      'canvas.alignLeft': 'Align left', 'canvas.alignRight': 'Align right', 'canvas.alignTop': 'Align top',
      'canvas.alignBottom': 'Align bottom', 'canvas.spaceX': 'Distribute horizontally', 'canvas.spaceY': 'Distribute vertically',
      'canvas.selected': 'Selected', 'canvas.searchHint': 'Search title or type', 'canvas.moveHint': 'Drag a selected card header to move the group.',
      'canvas.exportNote': 'PNG preserves layout and downloads large canvases in tiles. HTML includes all loaded table rows and works offline.',
      'canvas.zoom': 'Zoom', 'canvas.more': 'More actions',
      'canvas.cancel': 'Cancel', 'canvas.save': 'Save', 'canvas.create': 'Create',
      'canvas.notEmpty': 'Cannot be empty.',
      'canvas.untitled': 'Untitled canvas',
      'canvas.deletedCards': 'Deleted {n} cards · press Ctrl+Z to undo',
      'canvas.renamedCanvas': 'Canvas renamed.',
      'canvas.deleteCanvas': 'Delete canvas',
      'canvas.open': 'Open',
      'canvas.rename': 'Rename canvas',
      'canvas.emptyHint': 'Use “New canvas” above, or ask the agent in chat.',
    })

    function makeT (locale) {
      const lang = String(locale || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh'
      const table = DICT[lang] || DICT.zh
      return key => table[key] ?? DICT.zh[key] ?? key
    }

    function localeTag (ctx) {
      try {
        const v = ctx?.locale?.current ?? ctx?.locale?.tag ?? ctx?.locale?.get?.()
        return typeof v === 'string' && v !== '' ? v : 'zh'
      } catch {
        return 'zh'
      }
    }

// ── 03-api-export.js ─────────────────────────────────────────────────────────
    // ── API helpers ─────────────────────────────────────────────────────────

    async function api (path, options) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const text = await response.text()
      let payload
      try { payload = text ? JSON.parse(text) : {} } catch { payload = { error: text } }
      if (!response.ok) {
        const error = new Error(payload?.error || `HTTP ${response.status}`)
        error.status = response.status
        error.payload = payload
        throw error
      }
      return payload
    }

    const getCapabilities = () => api('/capabilities')
    const getChangelog = (limit = 3) => api(`/changelog?limit=${limit}`)
    const getStorage = () => api('/storage')
    const getWorkspaceBackup = () => api('/backup')
    const importWorkspaceBackup = bundle => api('/backup/import', { method: 'POST', body: JSON.stringify(bundle) })
    const cleanStorage = target => api('/storage/cleanup', { method: 'POST', body: JSON.stringify({ target }) })
    const listCanvases = () => api('/canvases')
    const listDatasources = () => api('/datasources')
    const getDatasource = (id, offset = 0, limit = 100) => api(`/datasources/${id}?offset=${offset}&limit=${limit}`)
    const queryDatasource = (id, query) => api(`/datasources/${id}/query`, { method: 'POST', body: JSON.stringify({ query }) })
    const readDatasourceResult = (id, offset = 0, limit = 100) => api(`/results/${id}?offset=${offset}&limit=${limit}`)
    const listSourceResults = (id, limit = 20) => api(`/datasources/${id}/results?limit=${limit}`)
    const renameSavedResult = (id, title) => api(`/results/${id}/rename`, { method: 'PATCH', body: JSON.stringify({ title }) })
    const addResultToCanvas = (resultId, body) => api(`/results/${resultId}/canvas`, { method: 'POST', body: JSON.stringify(body) })
    const importDatasource = input => api('/datasources', { method: 'POST', body: JSON.stringify(input) })
    const testDatabaseConnection = input => api('/datasources/test-connection', { method: 'POST', body: JSON.stringify(input) })
    const createDatabaseSource = input => api('/datasources/database', { method: 'POST', body: JSON.stringify(input) })
    const updateDatabaseSecret = (id, password) => api(`/datasources/${id}/secret`, { method: 'PATCH', body: JSON.stringify({ password }) })
    const testSavedConnection = id => api(`/datasources/${id}/test`, { method: 'POST', body: '{}' })
    const getDatabaseSchema = (id, refresh = false) => api(`/datasources/${id}/schema${refresh ? '?refresh=1' : ''}`)
    const queryDatabaseSql = (id, body) => api(`/datasources/${id}/query`, { method: 'POST', body: JSON.stringify(body) })
    const getCanvas = id => api(`/canvases/${id}`)
    const createCanvas = name => api('/canvases', { method: 'POST', body: JSON.stringify({ name }) })
    // `expected_revision: null` means "no expectation stated", which is what an
    // in-place rename of a row that is not the open canvas must send.
    const renameCanvas = (id, name, revision = null) => api(`/canvases/${id}`, {
      method: 'PATCH', body: JSON.stringify({ name, expected_revision: revision }),
    })
    async function localAssetApi (path, options, t) {
      let capabilities
      try { capabilities = await api('/capabilities') }
      catch (error) {
        if (error.status === 404 || error.status === 405) throw new Error(t('canvas.pluginOutdated'))
        throw error
      }
      if (capabilities.local_assets !== 1) throw new Error(t('canvas.pluginOutdated'))
      return api(path, options)
    }
    const importCanvasBackup = (backup, t) => localAssetApi('/canvases/import', { method: 'POST', body: JSON.stringify(backup) }, t)
    async function createExampleCanvas (t) {
      let capabilities
      try {
        capabilities = await api('/capabilities')
      } catch (error) {
        if (error.status === 404 || error.status === 405) throw new Error(t('canvas.pluginOutdated'))
        throw error
      }
      if (capabilities.api_version !== 1 || capabilities.create_example !== true) {
        throw new Error(t('canvas.pluginOutdated'))
      }
      // The host persists the complete case in one operation. Never assume an
      // older host supports card writes and leave a half-created canvas behind.
      try {
        return await api('/canvases/example', { method: 'POST' })
      } catch (error) {
        if (error.status === 404 || error.status === 405) throw new Error(t('canvas.pluginOutdated'))
        throw error
      }
    }
    const deleteCanvas = id => api(`/canvases/${id}`, { method: 'DELETE' })
    const batchCards = (id, body, revision) => api(`/canvases/${id}/batch`, {
      method: 'POST', body: JSON.stringify({ ...body, expected_revision: revision }),
    })
    const patchSettings = (id, settings, revision) => api(`/canvases/${id}/settings`, {
      method: 'PATCH', body: JSON.stringify({ settings, expected_revision: revision }),
    })
    const saveLayout = (id, layout, revision, avoidOverlap = true) => api(`/canvases/${id}/layout`, {
      method: 'PATCH',
      body: JSON.stringify({ layout, expected_revision: revision, avoid_overlap: avoidOverlap }),
    })
    const arrange = (id, revision) => api(`/canvases/${id}/arrange`, {
      method: 'POST',
      body: JSON.stringify({ expected_revision: revision }),
    })
    const renameCard = (id, cardId, title, revision) => api(`/canvases/${id}/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, expected_revision: revision }),
    })
    const setCardHeader = (id, cardId, showHeader, revision) => api(`/canvases/${id}/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ show_header: showHeader, expected_revision: revision }),
    })
    /** Patch any updatable card field (collapsed / color / note / title / data). */
    const patchCard = (id, cardId, changes, revision) => api(`/canvases/${id}/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...changes, expected_revision: revision }),
    })
    const moveCardToCanvas = (id, cardId, targetId) => api(`/canvases/${id}/cards/${cardId}/move-to`, {
      method: 'POST',
      body: JSON.stringify({ target_canvas_id: targetId }),
    })
    const copyCardToCanvas = (id, cardId, targetId) => api(`/canvases/${id}/cards/${cardId}/copy-to`, {
      method: 'POST',
      body: JSON.stringify({ target_canvas_id: targetId }),
    })
    const mergeCanvas = (id, sourceId, keepSource = true) => api(`/canvases/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ source_canvas_id: sourceId, keep_source: keepSource }),
    })
    const patchCanvasTheme = (id, theme) => api(`/canvases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ theme }),
    })
    const undoCanvas = (id, revision) => api(`/canvases/${id}/undo`, {
      method: 'POST',
      body: JSON.stringify({ expected_revision: revision }),
    })
    const redoCanvas = (id, revision) => api(`/canvases/${id}/redo`, {
      method: 'POST',
      body: JSON.stringify({ expected_revision: revision }),
    })
    // Export is independent of view zoom/scroll. Charts render at export size,
    // with animation disabled, so a hidden or not-yet-painted card is complete.
    function exportColors (theme) {
      return { background: theme.isDark ? '#15171b' : '#f8fafc', card: theme.isDark ? '#202329' : '#ffffff',
        text: theme.text || (theme.isDark ? '#e6e8eb' : '#111827'), secondary: theme.textSecondary || '#64748b',
        border: theme.isDark ? '#49515d' : '#cbd5e1' }
    }

    function exportHtml (canvas, theme, images, width = 1200) {
      const colors = exportColors(theme)
      const col = width / COLS
      const extent = Math.max(COLS, ...canvas.cards.map(c => c.layout.x + c.layout.w)) * col
      const cards = canvas.cards.map(card => {
        const g = geometry(card.layout, width, 22)
        let body = ''
        if (card.type === 'chart') {
          if (!images[card.id]) throw new Error(`图表尚未生成 / Chart unavailable: ${card.title}`)
          body = `<img alt="${escapeHtml(card.title)}" src="${images[card.id]}" style="width:100%;height:100%;object-fit:contain">`
        } else if (card.type === 'table') {
          const data = card.table_data || {}
          body = `<table><thead><tr>${(data.columns || []).map(c => `<th>${escapeHtml(typeof c === 'string' ? c : c.name)}</th>`).join('')}</tr></thead><tbody>${(data.rows || []).map(row => `<tr>${row.map(value => `<td>${escapeHtml(formatCell(value))}</td>`).join('')}</tr>`).join('')}</tbody></table><small>已载入 / Loaded: ${(data.rows || []).length}</small>`
        } else if (card.type === 'kpi') {
          const s = card.presentation_spec || {}
          const pct = Number.isFinite(Number(s.value)) && Number.isFinite(Number(s.target)) && Number(s.target) !== 0 ? Number(s.value) / Number(s.target) * 100 : null
          body = `<strong class="value">${escapeHtml(s.value ?? '—')}</strong> ${escapeHtml(s.unit || '')}<p>${escapeHtml(s.label || '')}</p>`
            + (s.delta != null ? `<p>${Number(s.delta) > 0 ? '+' : ''}${escapeHtml(s.delta)} ${escapeHtml(s.delta_label || '')} · ${s.delta_dir === 'down' ? '↓' : '↑'}</p>` : '')
            + (pct !== null ? `<p>目标 / Target: ${escapeHtml(s.target)} · ${pct.toFixed(1)}%</p><progress max="100" value="${Math.max(0, Math.min(100, pct))}"></progress>` : '')
        } else if (card.type === 'code') body = `<pre><code>${escapeHtml(card.text_content || '')}</code></pre>`
        else body = renderMarkdown(card.text_content || '')
        const source = [card.source?.dataset, card.source?.query, card.source?.note].filter(Boolean).join(' · ')
        return `<article style="left:${g.left}px;top:${g.top}px;width:${g.width}px;height:${g.height}px">${card.show_header !== false ? `<h2>${escapeHtml(card.title)}</h2>` : ''}<div class="body">${body}</div>${source ? `<footer>${escapeHtml(source)}</footer>` : ''}</article>`
      }).join('')
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(canvas.name)}</title><style>
        :root{color-scheme:${theme.isDark ? 'dark' : 'light'}}*{box-sizing:border-box}body{margin:20px;background:${colors.background};color:${colors.text};font:14px system-ui,sans-serif}h1{font-size:20px}h2{font-size:14px;margin:0 0 8px;flex-shrink:0}main{position:relative;width:${extent}px;height:${Math.max(240, maxRow(canvas.cards) * 22)}px}article{position:absolute;padding:10px;border:1px solid ${colors.border};border-radius:8px;background:${colors.card};display:flex;flex-direction:column;overflow:hidden}.body{min-height:0;flex:1;overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{text-align:left;border-bottom:1px solid ${colors.border};padding:6px;white-space:pre-wrap}thead{position:sticky;top:0;background:${colors.card}}footer{font-size:11px;color:${colors.secondary};max-height:32px;overflow:auto;flex-shrink:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}.value{font-size:30px}p{margin:6px 0}progress{width:100%}@media print{article{overflow:visible;height:auto!important;position:static!important;margin:12px 0;break-inside:avoid}.body{overflow:visible}main{width:100%;height:auto}}
      </style></head><body><h1>${escapeHtml(canvas.name)}</h1><p>离线快照 · Offline snapshot · ${escapeHtml(canvas.description || '')}</p><main>${cards}</main></body></html>`
    }

    async function chartImages (canvas, theme, width) {
      const charts = canvas.cards.filter(c => c.type === 'chart')
      if (!charts.length) return {}
      const lib = await requestEcharts()
      if (!lib) throw new Error('图表引擎不可用，请刷新后重试 / Chart engine unavailable')
      const images = {}
      for (const card of charts) {
        if (!card.echarts_option) throw new Error(`图表配置缺失 / Missing chart option: ${card.title}`)
        const g = geometry(card.layout, width, 22)
        const container = document.createElement('div')
        container.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none'
        document.body.appendChild(container)
        let chart
        try {
          chart = lib.init(container, theme.echarts, { renderer: 'canvas', width: Math.max(40, g.width - 20), height: Math.max(40, g.height - 60), devicePixelRatio: 2 })
          const option = applyChartDefaults(normalizeOption(card.echarts_option))
          chart.setOption({ ...option, animation: false, series: option.series?.map(s => ({ ...s, animation: false })) }, true)
          images[card.id] = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: exportColors(theme).card })
        } finally { chart?.dispose(); container.remove() }
      }
      return images
    }

    function wrapExportText (ctx, text, x, y, width, bottom, lineHeight = 17) {
      let line = '', clipped = false
      for (const char of Array.from(String(text))) {
        if (char === '\n' || ctx.measureText(line + char).width > width) {
          if (y + lineHeight > bottom) { clipped = true; break }
          ctx.fillText(line, x, y); y += lineHeight; line = char === '\n' ? '' : char
        } else line += char
      }
      if (y <= bottom) ctx.fillText(line + (clipped ? '…' : ''), x, y)
      return y + lineHeight
    }

    function drawExportCard (ctx, card, theme, image, width) {
      const c = exportColors(theme), g = geometry(card.layout, width, 22)
      ctx.save(); ctx.translate(g.left, g.top)
      ctx.fillStyle = c.card; ctx.strokeStyle = c.border
      ctx.beginPath(); ctx.roundRect(0, 0, g.width, g.height, 8); ctx.fill(); ctx.stroke()
      ctx.beginPath(); ctx.rect(1, 1, g.width - 2, g.height - 2); ctx.clip()
      if (accentHex(card.color)) { ctx.fillStyle = accentHex(card.color); ctx.fillRect(8, 2, 28, 3) }
      ctx.fillStyle = c.text; ctx.font = '600 14px system-ui, sans-serif'
      let y = 22
      if (card.show_header !== false) y = wrapExportText(ctx, card.title, 9, y, g.width - 18, 42, 17)
      const sourceText = [card.source?.dataset, card.source?.query, card.source?.note].filter(Boolean).join(' · ')
      const bottom = g.height - (sourceText ? 26 : 10)
      ctx.font = '13px system-ui, sans-serif'
      if (image) ctx.drawImage(image, 8, y, g.width - 16, Math.max(12, bottom - y))
      else if (card.type === 'table') {
        const data = card.table_data || {}, columns = data.columns || [], rows = data.rows || []
        const cell = (g.width - 16) / Math.max(1, columns.length), rowHeight = 23
        const drawRow = (row, bold) => {
          ctx.font = `${bold ? '600' : '400'} 12px system-ui, sans-serif`
          row.forEach((value, i) => {
            ctx.save(); ctx.beginPath(); ctx.rect(8 + i * cell, y - 14, cell - 2, rowHeight); ctx.clip()
            ctx.fillText(formatCell(value), 10 + i * cell, y); ctx.restore()
          })
          ctx.strokeStyle = c.border; ctx.beginPath(); ctx.moveTo(8, y + 6); ctx.lineTo(g.width - 8, y + 6); ctx.stroke(); y += rowHeight
        }
        drawRow(columns.map(col => typeof col === 'string' ? col : col.name), true)
        const visible = Math.max(0, Math.floor((bottom - y - 24) / rowHeight))
        rows.slice(0, visible).forEach(row => drawRow(row, false))
        ctx.fillStyle = c.secondary; ctx.font = '11px system-ui, sans-serif'
        wrapExportText(ctx, `${Math.min(rows.length, visible)} / ${rows.length}${rows.length > visible ? ' · 完整数据见 HTML / All rows in HTML' : ''}`, 8, Math.min(bottom - 4, y + 4), g.width - 16, bottom, 13)
      } else if (card.type === 'kpi') {
        const s = card.presentation_spec || {}
        ctx.font = '700 26px system-ui, sans-serif'
        y = wrapExportText(ctx, `${s.value ?? '—'} ${s.unit || ''}`, 10, y + 16, g.width - 20, bottom, 30)
        ctx.font = '13px system-ui, sans-serif'; ctx.fillStyle = c.secondary
        y = wrapExportText(ctx, s.label || '', 10, y + 4, g.width - 20, bottom)
        if (s.delta != null) y = wrapExportText(ctx, `${Number(s.delta) > 0 ? '+' : ''}${s.delta} ${s.delta_dir === 'down' ? '↓' : '↑'} ${s.delta_label || ''}`, 10, y, g.width - 20, bottom)
        if (Number.isFinite(Number(s.target)) && Number(s.target) !== 0) {
          const pct = Number(s.value) / Number(s.target) * 100
          y = wrapExportText(ctx, `目标 / Target: ${s.target} · ${Number.isFinite(pct) ? pct.toFixed(1) : '—'}%`, 10, y, g.width - 20, bottom)
          if (y < bottom && Number.isFinite(pct)) { ctx.fillStyle = c.border; ctx.fillRect(10, y, g.width - 20, 4); ctx.fillStyle = theme.series?.[0] || '#3b82f6'; ctx.fillRect(10, y, (g.width - 20) * Math.max(0, Math.min(1, pct / 100)), 4) }
        }
      } else {
        ctx.font = card.type === 'code' ? '12px ui-monospace, monospace' : '13px system-ui, sans-serif'
        const text = card.type === 'code' ? card.text_content : String(card.text_content || '').replace(/^#{1,6}\s/gm, '').replace(/\*\*/g, '').replace(/```[^\n]*\n?/g, '')
        wrapExportText(ctx, text || '', 9, y, g.width - 18, bottom)
      }
      if (sourceText) {
        ctx.fillStyle = c.secondary; ctx.font = '10px system-ui, sans-serif'
        wrapExportText(ctx, sourceText, 8, g.height - 12, g.width - 16, g.height - 6, 12)
      }
      ctx.restore()
    }

    async function exportArtifacts (canvas, theme, format, boardWidth) {
      const width = Math.max(960, boardWidth)
      const images = await chartImages(canvas, theme, width)
      if (format === 'html') return [{ name: `${canvas.name || 'canvas'}.html`, content: exportHtml(canvas, theme, images, width), type: 'text/html;charset=utf-8' }]
      const bitmaps = {}
      for (const [id, src] of Object.entries(images)) bitmaps[id] = await new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('图表图片加载失败 / Chart image failed')); image.src = src
      })
      const extent = Math.ceil(Math.max(COLS, ...canvas.cards.map(c => c.layout.x + c.layout.w)) * width / COLS)
      const height = Math.max(240, maxRow(canvas.cards) * 22 + 20), tileSize = 4096, artifacts = []
      const count = Math.ceil(extent / tileSize) * Math.ceil(height / tileSize)
      for (let top = 0; top < height; top += tileSize) for (let left = 0; left < extent; left += tileSize) {
        const out = document.createElement('canvas'); out.width = Math.min(tileSize, extent - left); out.height = Math.min(tileSize, height - top)
        const ctx = out.getContext('2d')
        if (!ctx) throw new Error('无法创建导出图片 / Canvas unavailable')
        ctx.fillStyle = exportColors(theme).background; ctx.fillRect(0, 0, out.width, out.height); ctx.translate(-left, -top)
        for (const card of canvas.cards) {
          const g = geometry(card.layout, width, 22)
          if (g.left < left + out.width && g.left + g.width > left && g.top < top + out.height && g.top + g.height > top) drawExportCard(ctx, card, theme, bitmaps[card.id], width)
        }
        const dataUrl = out.toDataURL('image/png')
        if (!dataUrl.startsWith('data:image/png')) throw new Error('图片尺寸超出浏览器限制 / Image size unsupported')
        artifacts.push({ name: `${canvas.name || 'canvas'}${count > 1 ? `-${Math.floor(top / tileSize) + 1}-${Math.floor(left / tileSize) + 1}` : ''}.png`, dataUrl })
        out.width = 0; out.height = 0
      }
      return artifacts
    }

    function downloadArtifact (artifact) {
      const a = document.createElement('a')
      const url = artifact.dataUrl || URL.createObjectURL(new Blob([artifact.content], { type: artifact.type }))
      a.href = url; a.download = artifact.name; document.body.appendChild(a); a.click(); a.remove()
      if (!artifact.dataUrl) setTimeout(() => URL.revokeObjectURL(url), 30000)
    }

    const duplicateCard = (id, cardId, revision) => api(`/canvases/${id}/cards/${cardId}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ expected_revision: revision }),
    })
    const deleteCard = (id, cardId, revision) => api(
      `/canvases/${id}/cards/${cardId}${revision === null || revision === undefined ? '' : `?expected_revision=${revision}`}`,
      { method: 'DELETE' },
    )

// ── 04-styles-icons.js ─────────────────────────────────────────────────────────
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

// ── 04b-ui-kit.js ─────────────────────────────────────────────────────────
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

// ── 05-card-rendering.js ─────────────────────────────────────────────────────────
    // ── Card rendering ──────────────────────────────────────────────────────

    /** Pull `[value, label]` pairs out of one series' data. */
    function readSeries (entry) {
      const raw = Array.isArray(entry?.data) ? entry.data : []
      return raw.map(item => {
        if (typeof item === 'number') return { value: item, label: null }
        if (Array.isArray(item)) {
          const [a, b] = item
          // ECharts accepts [value, category] and [category, value]; treat a
          // leading number as the value in both shapes.
          if (typeof a === 'number') return { value: a, label: b ?? null }
          if (typeof b === 'number') return { value: b, label: a ?? null }
          return { value: null, label: null }
        }
        if (item && typeof item === 'object' && typeof item.value === 'number') {
          return { value: item.value, label: item.name ?? null }
        }
        return { value: null, label: null }
      })
    }

    /**
     * Render a card's series as a compact bar preview.
     *
     * The plugin deliberately does not bundle a charting library: that would add
     * hundreds of kilobytes and a build step for a view whose exact numbers the
     * user can also read. Bars scaled to the series maximum keep it honest —
     * nothing is interpolated or smoothed — and the footer states the series
     * count, the point count and any truncation, so a capped preview can never
     * be mistaken for the whole dataset.
     *
     * A line series is drawn as bars too: with no charting engine available,
     * bars communicate magnitude without implying an interpolated trend.
     */
    function SeriesPreview ({ option, t, accent }) {
      const series = Array.isArray(option?.series) ? option.series : []
      if (series.length === 0) return h('div', { style: S.muted }, '—')

      const parsed = series.map(readSeries)
      const first = parsed.find(p => p.some(pt => typeof pt.value === 'number'))
      if (!first) {
        return h('div', { style: S.muted }, `${series.length} ${t('card.series')}`)
      }

      const CAP = 80
      const shown = first.slice(0, CAP)
      const values = shown.map(p => p.value).filter(v => typeof v === 'number')
      if (values.length === 0) return h('div', { style: S.muted }, '—')

      const max = Math.max(...values.map(v => Math.abs(v)), 1)
      const color = accent || 'var(--dsw-alias-brand-primary, #4a7)'
      const truncated = first.length > CAP

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', gap: '2px' } },
        h('div', {
          style: { display: 'flex', alignItems: 'flex-end', gap: '2px', flex: '1 1 auto', minHeight: '40px' },
        },
        shown.map((point, i) => h('div', {
          key: i,
          // The native tooltip carries the exact value and its category label.
          title: point.label !== null ? `${point.label}: ${point.value ?? '—'}` : String(point.value ?? '—'),
          style: {
            flex: '1 1 0', minWidth: '2px',
            height: `${Math.max(2, Math.round((Math.abs(point.value ?? 0) / max) * 100))}%`,
            background: point.value === null ? 'var(--dsw-alias-border-l2, #8884)' : color,
            borderRadius: '1px 1px 0 0',
          },
        })),
        // Axis extremes give the bars a readable scale without drawing axes.
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, inherit)' } },
          h('span', null, '0'),
          h('span', null, String(Math.round(max)))),
        h('div', { style: { ...S.mutedSmall, display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('span', null, `${first.length} ${t('card.dataPoints')}`),
          series.length > 1 ? h('span', null, `· ${series.length} ${t('card.series')}`) : null,
          truncated ? h('span', { style: { color: 'var(--dsw-alias-state-warn-label, #e8a33d)' } },
            `· ${t('card.truncated').replace('{n}', String(CAP))}`) : null)))
    }

    const TABLE_ROW_CAP = 30

    /** True when every non-empty cell in this column is a number. */
    function isNumericColumn (rows, col) {
      return rows.every(r => {
        const v = Array.isArray(r) ? r[col] : null
        return v === null || v === undefined || v === ''
          || (typeof v === 'number' && Number.isFinite(v))
          || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
      })
    }

    /**
     * Sort rows by one column. Numeric columns compare as numbers, others as
     * locale strings; nulls sort last in BOTH directions; dir 0 returns the
     * input order (the agent's row order often carries meaning).
     */
    function sortRows (rows, col, dir) {
      if (!dir) return rows
      const numeric = isNumericColumn(rows, col)
      return [...rows].sort((a, b) => {
        const va = a[col]
        const vb = b[col]
        const emptyA = va === null || va === undefined || va === ''
        const emptyB = vb === null || vb === undefined || vb === ''
        if (emptyA && emptyB) return 0
        if (emptyA) return 1
        if (emptyB) return -1
        if (numeric) return (Number(va) - Number(vb)) * dir
        return String(va).localeCompare(String(vb)) * dir
      })
    }

    /** Header click cycles asc → desc → natural order. */
    function filterTableRows (rows, query, column = -1, exact = '') {
      const search = query.trim().toLocaleLowerCase()
      return rows.filter(row => {
        const cells = column >= 0 ? [row[column]] : row
        return (!search || cells.some(value => formatCell(value).toLocaleLowerCase().includes(search)))
          && (!exact || (column >= 0 && JSON.stringify(formatCell(row[column])) === exact))
      })
    }

    function tableCsv (columns, rows) {
      const cell = value => {
        let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
        if (typeof value === 'string' && (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text
        return `"${text.replace(/"/g, '""')}"`
      }
      return '\uFEFF' + [columns.map(c => typeof c === 'string' ? c : c.name), ...rows]
        .map(row => row.map(cell).join(',')).join('\r\n')
    }

    function nextSortDir (prev, col) {
      if (!prev || prev.col !== col) return 1
      return prev.dir === 1 ? -1 : 0
    }

    /**
     * Sortable table: click a header to cycle asc → desc → natural order.
     */
    function TableBody ({ data, t }) {
      const columns = Array.isArray(data?.columns) ? data.columns : []
      const rawRows = Array.isArray(data?.rows) ? data.rows : []
      const [sort, setSort] = useState(null) // { col, dir: 1 | -1 | 0 }
      const [page, setPage] = useState(0)
      const [query, setQuery] = useState('')
      const [column, setColumn] = useState(-1)
      const [exact, setExact] = useState('')
      useEffect(() => { setPage(0) }, [data])
      useEffect(() => { setPage(0) }, [query, column, exact])
      const filtered = useMemo(() => filterTableRows(rawRows, query, column, exact), [rawRows, query, column, exact])
      const ordered = useMemo(() => sort ? sortRows(filtered, sort.col, sort.dir) : filtered, [filtered, sort])
      const values = useMemo(() => column >= 0 ? [...new Set(rawRows.map(row => JSON.stringify(formatCell(row[column]))))].slice(0, 200) : [], [rawRows, column])
      const numericColumns = useMemo(() => columns.map((_, index) => isNumericColumn(rawRows, index)), [rawRows, columns])

      if (columns.length === 0) return h('div', { style: S.muted }, '—')

      const rows = rawRows
      const pages = Math.max(1, Math.ceil(ordered.length / TABLE_ROW_CAP))
      const currentPage = Math.min(page, pages - 1)
      const sorted = ordered.slice(currentPage * TABLE_ROW_CAP, (currentPage + 1) * TABLE_ROW_CAP)

      const clickHeader = i => {
        setSort(prev => ({ col: i, dir: nextSortDir(prev, i) }))
        setPage(0)
      }

      return h('div', null,
        h('div', { style: S.row },
          h('input', { type: 'search', value: query, placeholder: t('table.filter'), 'aria-label': t('table.filter'), 'data-xc-table-filter': true,
            style: { ...S.btn, border: '1px solid #8885', minWidth: '100px', width: '140px' }, onChange: e => { setQuery(e.target.value); setPage(0) } }),
          // Both dropdowns are the themed `Select`: a native `<select>` popup is
          // painted by the browser and stayed light in the dark shell.
          h(Select, {
            value: String(column),
            options: [{ value: '-1', label: t('table.column') },
              ...columns.map((c, i) => ({ value: String(i), label: typeof c === 'string' ? c : c.name }))],
            onChange: next => { setColumn(Number(next)); setExact(''); setPage(0) },
            ariaLabel: t('table.column'),
            dataAttrs: { 'data-xc-table-column': true },
          }),
          column >= 0 ? h(Select, {
            value: exact,
            options: [{ value: '', label: '所有值（前 200 个可选） / Values (first 200)' },
              ...values.map(value => ({ value, label: formatCell(JSON.parse(value)) }))],
            onChange: next => { setExact(next); setPage(0) },
            ariaLabel: '列值 / Column value',
            dataAttrs: { 'data-xc-table-value': true },
            triggerStyle: { maxWidth: '180px' },
          }) : null,
          h('button', { type: 'button', style: S.btn, onClick: () => { setQuery(''); setColumn(-1); setExact(''); setPage(0) }, 'data-xc-table-clear': true }, t('table.clear')),
          h('button', { type: 'button', style: S.btn, 'data-xc-table-csv': true, onClick: () => downloadArtifact({ name: 'loaded-table.csv', type: 'text/csv;charset=utf-8', content: tableCsv(columns, ordered) }) }, t('table.csv'))),
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            columns.map((c, i) => h('th', {
              key: i,
              style: { ...S.th, cursor: 'pointer', userSelect: 'none', textAlign: numericColumns[i] ? 'right' : 'left' },
              onClick: () => clickHeader(i),
              'data-xc-sort-col': String(i),
              title: t('card.sortHint'),
            },
            typeof c === 'string' ? c : c?.name ?? `col${i}`,
            sort?.col === i && sort.dir !== 0 ? h('span', { style: { opacity: 0.6, marginLeft: '2px' } }, sort.dir === 1 ? '↑' : '↓') : null)))),
          h('tbody', null, sorted.map((row, ri) => h('tr', { key: ri },
            (Array.isArray(row) ? row : []).map((cell, ci) => h('td', {
              key: ci,
              title: formatCell(cell),
              style: { ...S.td, textAlign: numericColumns[ci] ? 'right' : 'left', fontVariantNumeric: 'tabular-nums' },
            }, formatCell(cell))))))),
        h('div', { style: { ...S.row, position: 'sticky', bottom: 0, background: 'var(--dsw-alias-bg-base, #fff)' } },
          h('button', { type: 'button', style: S.btn, disabled: currentPage === 0, 'data-xc-page-prev': true, onClick: () => setPage(currentPage - 1) }, '‹'),
          h('span', { style: S.mutedSmall, 'data-xc-page-info': true }, `${currentPage + 1} / ${pages} · ${t('table.loaded')} ${rows.length} · ${ordered.length} 匹配 / matches`),
          h('button', { type: 'button', style: S.btn, disabled: currentPage + 1 >= pages, 'data-xc-page-next': true, onClick: () => setPage(currentPage + 1) }, '›')))
    }

    function formatCell (cell) {
      if (cell === null || cell === undefined) return '—'
      if (typeof cell === 'number') return String(cell)
      if (typeof cell === 'object') return JSON.stringify(cell)
      return String(cell)
    }

    /**
     * Fill in the axes a bar/line chart needs when the agent's option omits
     * them. ECharts crashes internally on `axis.get` without its axes, so a
     * series-only option (the common chat output shape) is completed here —
     * presentation robustness, not data computation: the categories are indices
     * unless the option carries them.
     */
    function normalizeOption (option) {
      if (!option || typeof option !== 'object') return option
      const type = Array.isArray(option.series) ? option.series[0]?.type : null
      const needsAxes = type === 'line' || type === 'bar'
      if (!needsAxes || (option.xAxis && option.yAxis)) return option

      // Category labels: prefer the first series' [label, value] pairs.
      const first = Array.isArray(option.series) ? option.series[0] : null
      const labels = []
      if (Array.isArray(first?.data)) {
        for (const item of first.data) {
          if (Array.isArray(item) && typeof item[0] === 'string') { labels.push(item[0]); continue }
          if (item && typeof item === 'object' && typeof item.name === 'string') { labels.push(item.name); continue }
          labels.push(null)
        }
      }
      const size = Array.isArray(first?.data) ? first.data.length : 0
      const categories = labels.some(Boolean)
        ? labels.map((l, i) => l ?? String(i + 1))
        : Array.from({ length: size }, (_, i) => String(i + 1))

      return {
        ...option,
        xAxis: option.xAxis ?? { type: 'category', data: categories },
        yAxis: option.yAxis ?? { type: 'value' },
      }
    }

    /**
     * Canvas-level chart defaults layered onto every card option (theme-aware).
     *
     * grid: tight margins — cards are small, the ECharts default (2.5%/3%+
     * 25px) wastes a fifth of a 300px card. Line charts: horizontal splitLine
     * off — at card scale the grid lines compete with the series stroke. The
     * user's own grid/xAxis settings always win (they spread after).
     */
    function applyChartDefaults (option) {
      if (!option || typeof option !== 'object') return option
      const type = Array.isArray(option.series) ? option.series[0]?.type : null
      const isLine = type === 'line'
      return {
        ...option,
        grid: {
          left: 8, right: 8, top: isLine ? 10 : 12, bottom: isLine ? 4 : 6,
          containLabel: true,
          ...(option.grid || {}),
        },
        xAxis: isLine
          ? { splitLine: { show: false }, ...(option.xAxis || {}) }
          : (option.xAxis || undefined),
      }
    }

    /**
     * A real ECharts chart.
     *
     * Lifecycle mirrors the original renderer: init once per mount, setOption on
     * every option/theme change, resize with the container (debounced via rAF —
     * the original learned that per-frame resize thrashes), dispose on unmount.
     * Falls back to the bar sketch when echarts itself could not load, so a
     * chart card never becomes a dead box.
     */
    function EChart ({ option, theme, accent }) {
      const containerRef = useRef(null)
      const chartRef = useRef(null)
      const rafRef = useRef(0)

      const [lib, setLib] = useState(loadEcharts())
      const [failed, setFailed] = useState(false)

      // Kick the chunk load once per component instance; the promise is shared.
      useEffect(() => {
        let alive = true
        requestEcharts().then(result => {
          if (!alive) return
          if (result) setLib(result)
          else setFailed(true)
        })
        return () => { alive = false }
      }, [])

      // Set when init succeeds; bumping it makes the option effect run.
      const [chartReady, setChartReady] = useState(0)

      // (Re)create the instance once the container has a real size.
      //
      // Cards are absolutely positioned on a percentage-based grid, so at first
      // effect the container may still be 0x0 — ECharts inits silently on a
      // zero-size box and never paints (measured: inner div present, no canvas).
      // A ResizeObserver waits for the first non-zero size, inits then, and
      // feeds subsequent size changes to chart.resize().
      useEffect(() => {
        const el = containerRef.current
        if (!lib || !el || typeof ResizeObserver === 'undefined') return undefined

        let chart = null
        let raf = 0
        const sizeOf = () => ({
          w: el.clientWidth || el.getBoundingClientRect().width,
          h: el.clientHeight || el.getBoundingClientRect().height,
        })

        const tryInit = () => {
          if (chart) return
          const { w, h } = sizeOf()
          if (w < 10 || h < 10) return // still laid out at zero; wait
          try {
            // The theme object carries series colours + axis/tooltip styling:
            // this is where 皮肤 reaches the chart.
            chart = lib.init(el, theme.echarts, { renderer: 'canvas', width: w, height: h })
            chartRef.current = chart
            // The option effect depends on this counter (chartRef is not
            // reactive), so init completion is what triggers the first draw.
            setChartReady(v => v + 1)
          } catch (error) {
            setFailed(true)
            try { console.error('[xcharts-canvas] echarts init failed:', error?.message) } catch { /* non-fatal */ }
          }
        }

        const observer = new ResizeObserver(() => {
          tryInit()
          if (rafRef.current) cancelAnimationFrame(rafRef.current)
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0
            try { chartRef.current?.resize() } catch { /* mid-dispose */ }
          })
        })
        observer.observe(el)
        tryInit()

        return () => {
          observer.disconnect()
          if (raf) cancelAnimationFrame(raf)
          if (rafRef.current) cancelAnimationFrame(rafRef.current)
          try { chart?.dispose() } catch { /* already gone */ }
          chartRef.current = null
        }
      }, [lib, theme])

      // Push the option. `notMerge: true` mirrors the original: a card whose
      // option loses a series must not keep showing the stale series.
      useEffect(() => {
        const chart = chartRef.current
        if (!chart || !option) return
        try {
          chart.setOption(applyChartDefaults(normalizeOption(option)), true)
        } catch (error) {
          // A malformed agent-supplied option must degrade to the sketch, not
          // crash the workspace.
          setFailed(true)
          try { console.error('[xcharts-canvas] setOption failed:', error?.message) } catch { /* non-fatal */ }
        }
      }, [option, theme, chartReady])

      // Container resize: batched into one rAF per frame.
      useEffect(() => {
        const el = containerRef.current
        if (!el || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(() => {
          if (rafRef.current) cancelAnimationFrame(rafRef.current)
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0
            try { chartRef.current?.resize() } catch { /* mid-dispose */ }
          })
        })
        observer.observe(el)
        return () => {
          observer.disconnect()
          if (rafRef.current) cancelAnimationFrame(rafRef.current)
        }
      }, [theme])

      if (failed) {
        return h(SeriesPreview, { option, t: key => key, accent })
      }
      return h('div', {
        ref: containerRef,
        'data-xc-echart': 'true',
        style: { width: '100%', height: '100%', minHeight: '60px' },
      })
    }

    /**
     * Minimal GFM-subset Markdown renderer (~50 lines, no dependency).
     *
     * Supports what an analysis note actually uses: headings, bold/italic,
     * inline code, fenced code blocks, unordered/ordered lists, blockquotes and
     * paragraphs. Anything else passes through as plain text — the output is
     * always valid, just not fancy. HTML in the source is escaped first, so a
     * card can never inject markup.
     */
    function escapeHtml (text) {
      return String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    function inlineMd (text) {
      return escapeHtml(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    }

    function renderMarkdown (source) {
      const lines = String(source || '').split('\n')
      const out = []
      let inCode = false
      let codeLang = ''
      let codeLines = []
      let listMode = null // 'ul' | 'ol'
      let listItems = []

      const flushList = () => {
        if (listMode && listItems.length > 0) {
          out.push(`<${listMode}>${listItems.map(i => `<li>${inlineMd(i)}</li>`).join('')}</${listMode}>`)
        }
        listMode = null
        listItems = []
      }

      for (const line of lines) {
        const fence = /^```(\w*)/.exec(line.trim())
        if (fence) {
          if (inCode) {
            out.push(`<pre><code${codeLang ? ` class="lang-${escapeHtml(codeLang)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
            inCode = false
            codeLines = []
            codeLang = ''
          } else {
            flushList()
            inCode = true
            codeLang = fence[1] || ''
          }
          continue
        }
        if (inCode) { codeLines.push(line); continue }

        const heading = /^(#{1,4})\s+(.*)/.exec(line)
        if (heading) {
          flushList()
          const level = heading[1].length
          out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`)
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          if (listMode !== 'ul') flushList()
          listMode = 'ul'
          listItems.push(line.replace(/^\s*[-*]\s+/, ''))
          continue
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          if (listMode !== 'ol') flushList()
          listMode = 'ol'
          listItems.push(line.replace(/^\s*\d+\.\s+/, ''))
          continue
        }
        if (/^>\s?/.test(line)) {
          flushList()
          out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`)
          continue
        }
        if (line.trim() === '') { flushList(); continue }
        // Paragraph line: accumulate into the last <p> if it was text.
        flushList()
        out.push(`<p>${inlineMd(line)}</p>`)
      }
      if (inCode) out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      flushList()
      return out.join('')
    }

    /** Keyword-tinted code display: no highlight.js, just token colouring. */
    const CODE_KEYWORDS = new Set([
      'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class',
      'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'throw',
      'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'JOIN', 'ON', 'AS', 'WITH',
      'sum', 'avg', 'count', 'min', 'max', 'def', 'self', 'None', 'True', 'False', 'print', 'import pandas',
    ])

    function renderCode (source) {
      return String(source || '').split('\n').map(line => {
        const safe = escapeHtml(line)
        // Colour a token when the whole word matches a keyword (case-sensitive
        // for SQL caps, insensitive handled by the set contents).
        return safe.replace(/([A-Za-z_][A-Za-z0-9_]*)/g, (word) => {
          if (CODE_KEYWORDS.has(word) || CODE_KEYWORDS.has(word.toUpperCase())) {
            return `<span style="color:var(--dsw-alias-brand-primary, #4a7)">${word}</span>`
          }
          if (/^\d+$/.test(word)) return `<span style="opacity:.75">${word}</span>`
          return word
        })
      }).join('\n')
    }

    function CardBody ({ card, t, theme }) {
      if (card.type === 'chart') {
        if (card.echarts_option) {
          // The accent colour tints the fallback sketch; the real chart takes
          // its series colours from the theme.
          return h(EChart, {
            option: card.echarts_option,
            theme,
            accent: accentHex(card.color),
            t,
          })
        }
        return h('div', { style: S.muted }, '—')
      }
      if (card.type === 'table') return h(TableBody, { data: card.table_data, t })
      if (card.type === 'kpi') {
        const spec = card.presentation_spec || {}
        const value = typeof spec.value === 'number' ? spec.value : Number.parseFloat(spec.value)
        const hasValue = Number.isFinite(value)
        const target = typeof spec.target === 'number' ? spec.target : Number.parseFloat(spec.target)
        const hasTarget = Number.isFinite(target) && target !== 0
        const delta = typeof spec.delta === 'number' ? spec.delta : Number.parseFloat(spec.delta)
        const hasDelta = Number.isFinite(delta)
        const dir = spec.delta_dir === 'down' ? 'down' : 'up' // which way is "good"
        const good = hasDelta && ((dir === 'up' && delta > 0) || (dir === 'down' && delta < 0))

        // Progress toward target: clamp to [0,100] so overshoot reads as done.
        const pct = hasTarget && hasValue
          ? Math.max(0, Math.min(100, Math.round((value / target) * 100)))
          : null
        const accent = accentHex(card.color)

        return h('div', null,
          h('div', { style: S.kpiVal }, hasValue ? String(spec.value) : '—'),
          spec.unit ? h('div', { style: S.kpiLabel }, spec.unit) : null,
          spec.label ? h('div', { style: S.kpiLabel }, spec.label) : null,
          // Delta chip: colored by whether the change is good for this metric.
          hasDelta
            ? h('div', {
              style: {
                marginTop: '4px', fontSize: '11px',
                color: good ? 'var(--dsw-alias-state-success-label, #16a34a)' : 'var(--dsw-alias-state-critical-label, #dc2626)',
              },
            },
            `${delta > 0 ? '+' : ''}${delta}${dir === 'up' ? ' ↑' : ' ↓'}`,
            spec.delta_label ? h('span', { style: { opacity: 0.7 } }, ` ${spec.delta_label}`) : null)
            : null,
          // Target progress bar.
          pct !== null
            ? h('div', { style: { marginTop: '6px' } }, [
              h('div', {
                key: 'bar',
                style: {
                  height: '4px', borderRadius: '2px', overflow: 'hidden',
                  background: 'color-mix(in srgb, currentColor 12%, transparent)',
                },
              }, h('div', {
                style: {
                  height: '100%', width: `${pct}%`, borderRadius: '2px',
                  background: accent || 'var(--dsw-alias-brand-primary, #4a7)',
                },
              })),
              h('div', { key: 'pct', style: { ...S.mutedSmall, marginTop: '2px' } },
                `${pct}% · ${t('card.target').replace('{n}', String(spec.target))}`),
            ])
            : null)
      }
      if (card.type === 'text') {
        // Text cards render a GFM subset; the source is escaped first so the
        // card can never inject markup.
        return h('div', {
          style: { fontSize: FS_SM, lineHeight: 1.6 },
          class: 'xc-md',
          // The markdown is already escaped and restricted to our subset tags.
          dangerouslySetInnerHTML: { __html: renderMarkdown(card.text_content) },
        })
      }
      if (card.type === 'code') {
        return h('pre', {
          style: {
            margin: 0, fontFamily: 'var(--dsw-font-family-code, monospace)', fontSize: '11px',
            lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflow: 'auto',
          },
        }, [
          card.language ? h('div', { key: 'lang', style: { ...S.mutedSmall, marginBottom: '2px' } }, card.language) : null,
          h('code', {
            key: 'code',
            // Token-coloured source; each line was escaped inside renderCode.
            dangerouslySetInnerHTML: { __html: renderCode(card.text_content) },
          }),
        ])
      }
      return h('div', { style: S.muted }, card.type)
    }

    // ── Context menu ────────────────────────────────────────────────────────

    /**
     * A small popup menu anchored at a point.
     *
     * Rendered in the page (not the card) so it is never clipped by the card's
     * own overflow, and flipped when it would run off the viewport. Closes on
     * outside click, Escape, scroll, or blur — and, unlike the first version, it
     * is fully keyboard driven: focus enters the menu, the arrows walk the
     * triggerable rows (skipping separators), Home/End jump, Enter selects, and
     * closing always hands the focus back to whatever opened it.
     */
    function ContextMenu ({ x, y, items, onClose }) {
      const ref = useRef(null)
      const [pos, setPos] = useState({ left: x, top: y })
      // Rows that actually do something. Disabled entries are filtered out by
      // the callers rather than painted grey, so this only skips furniture.
      const triggerable = []
      items.forEach((item, index) => {
        if (item && !item.separator && !item.label && item.onSelect) triggerable.push(index)
      })
      const [active, setActive] = useState(() => triggerable[0] ?? -1)
      // The key handler is registered once; it reads the highlight from a ref so
      // moving it does not tear down and re-attach the window listener.
      const activeRef = useRef(active)
      activeRef.current = active

      // Flip near the edges once the real size is known; the shared helper also
      // bounds the height so a long menu scrolls instead of leaving the screen.
      useEffect(() => {
        const el = ref.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        setPos(placePopupAt(x, y, { width: rect.width, height: rect.height }))
      }, [x, y])

      useEffect(() => {
        // Where to hand the focus back to when this closes.
        const previous = document.activeElement
        const node = active >= 0 ? ref.current?.querySelector?.(`[data-xc-menu-index="${active}"]`) : null
        node?.focus?.()
        return () => { previous?.focus?.() }
      }, [])

      useEffect(() => {
        const onDown = event => {
          if (ref.current && !ref.current.contains(event.target)) onClose()
        }
        const move = delta => {
          const at = triggerable.indexOf(activeRef.current)
          const next = (at < 0 ? (delta > 0 ? 0 : triggerable.length - 1) : at + delta + triggerable.length) % triggerable.length
          setActive(triggerable[next])
        }
        const onKey = event => {
          if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
          if (!triggerable.length) return
          if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
          else if (event.key === 'Home') { event.preventDefault(); setActive(triggerable[0]) }
          else if (event.key === 'End') { event.preventDefault(); setActive(triggerable[triggerable.length - 1]) }
          else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            const item = items[activeRef.current]
            if (item?.onSelect) { onClose(); item.onSelect() }
          }
        }
        // Capture phase: a card's own pointer handlers must not swallow this.
        window.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey)
        window.addEventListener('blur', onClose)
        window.addEventListener('resize', onClose)
        return () => {
          window.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('blur', onClose)
          window.removeEventListener('resize', onClose)
        }
      }, [onClose, items, triggerable.join(',')])

      return h('div', {
        ref,
        'data-xc-menu': 'true',
        role: 'menu',
        tabIndex: -1,
        'aria-activedescendant': active >= 0 ? `xc-menu-item-${active}` : undefined,
        style: { ...S.menu, ...pos, maxHeight: pos.maxHeight, overflowY: 'auto', overflowX: 'hidden' },
        // The board sits inside a scroll container; keep clicks here local.
        onPointerDown: event => event.stopPropagation(),
        onContextMenu: event => event.preventDefault(),
      }, items.map((item, index) => {
        if (item.separator) return h('div', { key: `sep${index}`, role: 'separator', style: S.menuSep })
        if (item.label && !item.onSelect) {
          return h('div', { key: `lbl${index}`, style: S.menuLabel }, item.label)
        }
        return h('div', {
          key: item.id,
          id: `xc-menu-item-${index}`,
          role: 'menuitem',
          tabIndex: -1,
          'data-xc-menu-item': item.id,
          'data-xc-menu-icon': item.iconName || undefined,
          'data-xc-menu-index': String(index),
          'data-active': index === active ? 'true' : undefined,
          // Callers may attach their own data-* hooks (the compass entries and
          // the collapsed toolbar mirror the same markers their inline
          // counterparts carry), so tests and styling keep one vocabulary.
          ...(item.data || {}),
          style: {
            ...S.menuItem(item.danger),
            ...(index === active ? { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))' } : null),
          },
          onClick: async () => { onClose(); await item.onSelect?.() },
          onPointerEnter: () => setActive(index),
        }, item.iconName
          ? h('span', { style: { width: '16px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: 0.8, flex: '0 0 auto' } }, h(ToolIcon, { name: item.iconName, size: 14 }))
          : item.icon
            ? h('span', { style: { width: '14px', textAlign: 'center', opacity: 0.8 } }, item.icon)
            : null, item.text,
        item.hint ? h('span', { style: { marginLeft: 'auto', paddingLeft: '16px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit))' } }, item.hint) : null)
      }))
    }

// ── 06-card-interactions.js ─────────────────────────────────────────────────────────
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

// ── 06b-trace-ui.js ─────────────────────────────────────────────────────────
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

// ── 06c-followup-ui.js ─────────────────────────────────────────────────────────
    // A resident composer adapter; no historical Turn subscriptions or DOM writes.
    // One delivery machine for two kinds of reference: a frozen card follow-up
    // (server-side ref) and a datasource/result reference (a short marker).
    function referenceMarker (input) {
      if (input.kind === 'ds') return `[xcharts:ds:${input.datasource_id}${input.version ? `@${input.version}` : ''}]`
      if (input.kind === 'res') return `[xcharts:res:${input.result_id}]`
      return null
    }
    function referenceLine (input) {
      const marker = referenceMarker(input)
      if (input.kind === 'ds') return `@${input.name || '数据源'}（${input.rows ?? '?'} 行）${marker}`
      if (input.kind === 'res') return `@结果（${input.rows ?? '?'} 行）${marker}`
      return `关于卡片「${input.title || '分析卡片'}」[xcharts:${input.ref_id}]：`
    }
    function createFollowupBroker (openSession) {
      let active = null, lastSession = null, serial = 0
      const listeners = new Set()
      const notify = () => { for (const listener of listeners) listener() }
      const receipts = new Set()
      const requestId = () => globalThis.crypto?.randomUUID?.() || `ask-${Date.now()}-${++serial}`
      const broker = {
        snapshot: () => active,
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
        observeSession: id => { if (id) lastSession = id },
        knownSession: () => active?.session_id || lastSession,
        ask: (input, sessionId) => {
          const same = active && active.input && (
            ((input.kind ?? 'card') === 'card' && active.input.canvas_id === input.canvas_id && active.input.card_id === input.card_id && active.input.version_id === input.version_id) ||
            (input.kind === 'ds' && active.input.datasource_id === input.datasource_id) ||
            (input.kind === 'res' && active.input.result_id === input.result_id))
          if (active && !['ready', 'cancelled'].includes(active.status)) {
            if (same) return active.promise
            return Promise.reject(new Error('请先处理当前引用'))
          }
          let resolve, reject
          const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
          // An explicit session (card follow-up inside a conversation) goes straight
          // through; a page-level reference asks first, so the target is visible.
          active = { request_id: requestId(), input, session_id: sessionId || null, status: 'selecting', promise, resolve, reject, ref: null, error: '' }
          notify()
          if (active.session_id) broker.start(active.session_id)
          return promise
        },
        start: async sessionId => {
          const request = active
          if (!request || request.status === 'preparing') return
          request.session_id = sessionId
          request.status = 'preparing'; request.error = ''; notify()
          try {
            const capabilities = await getCapabilities()
            if ((request.input.kind ?? 'card') === 'card') {
              if (capabilities.followup_api !== 1) throw new Error('溯源服务尚未生效，请重启 DSH 后重试')
              const ref = request.ref || await api('/followups', { method: 'POST', body: JSON.stringify({ ...request.input, request_id: request.request_id, session_id: sessionId }) })
              if (active !== request || request.status === 'cancelled') return
              request.ref = ref
              if (ref.status !== 'pending') { request.status = 'ready'; request.resolve(ref); notify(); return }
            } else {
              if (capabilities.reference_api !== 1) throw new Error('引用服务尚未生效，请重启 DSH 后重试')
              const marker = referenceMarker(request.input)
              request.ref = { id: marker, prompt: referenceLine(request.input), marker }
            }
            request.status = 'waiting_editor'; notify()
            openSession(sessionId)
          } catch (error) {
            if (active !== request) return
            request.status = 'failed'; request.error = error.message; notify()
          }
        },
        deliver: (sessionId, input, inputActions) => {
          const request = active
          if (!request || request.session_id !== sessionId || !['waiting_editor', 'retry'].includes(request.status) || !request.ref || !inputActions?.insertText) return
          if (receipts.has(request.ref.id)) { broker.ack(request); return }
          if (input.phase !== 'plain' || input.claim) return
          const occurrences = Array.isArray(input.occurrences) ? input.occurrences : []
          if (occurrences.length) { request.status = 'failed'; request.error = '草稿含引用，请先处理草稿后重试'; notify(); return }
          // With no chips, the public draft projection and TokenSpan share offsets.
          const end = String(input.draft || '').length
          const prefix = end ? '\n\n' : ''
          const marker = request.ref.marker || `[xcharts:${request.ref.id}]`
          if (String(input.draft || '').includes(marker)) { receipts.add(request.ref.id); broker.ack(request); return }
          request.status = 'delivering'; notify()
          const text = request.ref.marker ? `${prefix}${request.ref.prompt}` : `${prefix}关于卡片「${request.input.title || '分析卡片'}」${marker}：`
          const inserted = inputActions.insertText(text, { start: end, end, draftRev: input.draftRev })
          if (!inserted) { request.status = 'failed'; request.error = '草稿已变化，请重试'; notify(); return }
          // Synchronous local receipt prevents duplicate insertion before HTTP ack.
          receipts.add(request.ref.id)
          broker.ack(request)
        },
        ack: async request => {
          request.status = 'acknowledging'; notify()
          try {
            if (request.ref.marker) {
              await api('/usages', { method: 'POST', body: JSON.stringify({ reference: request.ref.marker, session_id: request.session_id }) })
            } else {
              await api(`/followups/${request.ref.id}/ack`, { method: 'POST', body: JSON.stringify({ session_id: request.session_id, status: 'attached' }) })
            }
            if (active !== request) return
            request.status = 'ready'; request.resolve(request.ref); notify()
          } catch (error) {
            if (active !== request) return
            request.status = 'failed'; request.error = `引用已追加，确认失败：${error.message}`; notify()
          }
        },
        retry: () => {
          if (!active) return
          if (active.ref && receipts.has(active.ref.id)) { broker.ack(active); return }
          if (active.ref) { active.status = 'retry'; active.error = ''; notify(); openSession(active.session_id) }
          else broker.start(active.session_id)
        },
        cancel: () => {
          if (!active) return
          active.status = 'cancelled'
          active.reject(new Error('已取消追问'))
          notify()
        },
        dispose: () => { if (active && !['ready', 'cancelled'].includes(active.status)) broker.cancel(); listeners.clear() },
      }
      return broker
    }

    function FollowupDock ({ broker, sessionId, input, inputActions }) {
      const [, refresh] = useState(0)
      useEffect(() => broker.subscribe(() => refresh(value => value + 1)), [broker])
      useEffect(() => { broker.observeSession(sessionId) }, [broker, sessionId])
      const request = broker.snapshot()
      useEffect(() => { if (input) broker.deliver(sessionId, input, inputActions) }, [broker, sessionId, input, inputActions, request?.status])
      return null
    }

    function FollowupOverlay ({ broker, useSessions: sessionsSelector }) {
      const sessionList = typeof sessionsSelector === 'function' ? sessionsSelector(value => value) : { byId: {} }
      const [, refresh] = useState(0)
      const [chosen, setChosen] = useState('')
      useEffect(() => broker.subscribe(() => refresh(value => value + 1)), [broker])
      const request = broker.snapshot()
      if (!request || ['ready', 'cancelled'].includes(request.status)) return null
      const sessions = Object.values(sessionList?.byId || {})
      const choose = !request.session_id && request.status === 'selecting'
      const waiting = ['waiting_editor', 'preparing', 'acknowledging', 'delivering', 'retry'].includes(request.status)
      const toReference = (request.input.kind ?? 'card') !== 'card'
      const options = sessions.map(item => ({ value: item.id || item.sessionId, label: item.title || item.cwd || item.id || item.sessionId }))
      const target = choose ? (chosen || broker.knownSession() || options[0]?.value || '') : request.session_id
      return h(Dialog, { title: toReference ? '引用到对话' : '追问卡片', onClose: broker.cancel,
        footer: [
          h('button', { key: 'cancel', type: 'button', style: S.btn, 'data-xc-reference-cancel': true, onClick: broker.cancel }, '取消'),
          choose
            ? h('button', { key: 'open', type: 'button', style: S.btnPrimary, 'data-xc-reference-insert': true, disabled: !target, onClick: () => broker.start(target) }, toReference ? '插入引用' : '打开会话')
            : h('button', { key: 'retry', type: 'button', style: S.btnPrimary, disabled: !request.ref && waiting, onClick: broker.retry }, waiting ? '继续' : '重试'),
        ],
      },
        choose ? h('div', null, h(SectionLabel, { label: '目标会话' }),
          h(Select, { value: target, options, onChange: setChosen, ariaLabel: '目标会话' })) : null,
        waiting ? h(StatusLine, { children: [toReference ? '正在准备会话…' : '正在准备编辑器…'] }) : null,
        request.error ? h(StatusLine, { tone: 'alert', children: [request.error] }) : null,
        request.ref ? h('button', { type: 'button', style: S.btn, onClick: async () => {
          try { await navigator.clipboard.writeText(request.ref.prompt); setChosen('已复制') }
          catch { setChosen('复制失败') }
        } }, chosen === '已复制' || chosen === '复制失败' ? chosen : '复制引用') : null)
    }

// ── 06d-changelog-ui.js ─────────────────────────────────────────────────────────
    // ── Recent updates: the bundled changelog, one click away ───────────────
    //
    // A plugin installed from a folder has no "what's new" surface: the package
    // description is a single npm line, and the user is not going to open the
    // repository. So the changelog that ships with the package is served by the
    // host and shown in a dialog from both workspaces. One fetch per page load,
    // shared through a module cache; a host without the route simply shows the
    // version line without the button.
    const CHANGELOG = { data: null, promise: null }
    function loadChangelog (limit = 3) {
      if (CHANGELOG.data) return Promise.resolve(CHANGELOG.data)
      if (!CHANGELOG.promise) {
        CHANGELOG.promise = getChangelog(limit)
          .then(payload => { CHANGELOG.data = payload; return payload })
          .catch(error => { CHANGELOG.promise = null; throw error })
      }
      return CHANGELOG.promise
    }
    function useChangelog (limit = 3) {
      const [data, setData] = useState(CHANGELOG.data)
      useEffect(() => {
        if (CHANGELOG.data) return undefined
        let alive = true
        loadChangelog(limit).then(payload => { if (alive) setData(payload) }).catch(() => { /* version line only */ })
        return () => { alive = false }
      }, [limit])
      return data
    }
    function ChangelogDialog ({ data, onClose }) {
      const entries = data?.entries || []
      return h(Dialog, { title: '最近更新', onClose, closeLabel: '关闭', large: true },
        h('div', { 'data-xc-changelog-dialog': true, style: { display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 6 } },
          entries.map(entry => h('div', { key: entry.version, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
            h('div', { style: { fontSize: '12px', fontWeight: 500 } }, `v${entry.version}${entry.date ? ` · ${entry.date}` : ''}`),
            ...entry.lines.map((line, index) => h('div', { key: index, style: { ...S.mutedSmall, lineHeight: 1.6 } }, line)))),
          entries.length ? null : h('div', { style: S.mutedSmall }, '没有可显示的更新记录。'),
          data?.current_version ? h('div', { style: { ...S.mutedSmall, paddingTop: 4 } }, `当前版本 v${data.current_version}`) : null))
    }
    /** Version line + 「最近更新」 entry, shared by both workspaces. */
    function ChangelogControl ({ data, buttonProps = {} }) {
      const [open, setOpen] = useState(false)
      const version = data?.current_version
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
        version ? h('span', { style: S.mutedSmall, 'data-xc-version': version }, `v${version}`) : null,
        version ? h('button', { type: 'button', style: { ...S.btn, height: 24, fontSize: '12px' }, 'data-xc-changelog': true, ...buttonProps, onClick: () => setOpen(true) }, '最近更新') : null,
        open ? h(ChangelogDialog, { data, onClose: () => setOpen(false) }) : null)
    }

// ── 06e-storage-ui.js ─────────────────────────────────────────────────────────
    // ── Storage: where the data lives, and how to reclaim it ────────────────
    //
    // The path always comes from the host response, never from this file: the same
    // plugin installed on another machine shows that machine's storage root
    // (`$DSH_HOME/storages/xcharts-canvas`, or the configured `storagePath`).
    const STORAGE_LABELS = {
      canvases: '画布', datasources: '数据源', results: '查询结果', history: '撤销历史',
      inputs: '版本快照', executions: '调用证据', followups: '追问引用', usages: '使用记录',
    }
    function formatStorageBytes (bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = bytes / 1024, index = 0
      while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
    }

    /** Storage pane of the settings dialog: location, per-directory size, safe cleanups. */
    function StorageSection ({ t = key => key } = {}) {
      const [usage, setUsage] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [confirm, setConfirm] = useState(null)
      const [copied, setCopied] = useState(false)
      const load = () => {
        getStorage().then(payload => setUsage(payload)).catch(loadError => setError('读取存储信息失败：' + loadError.message))
      }
      useEffect(() => { load() }, [])
      const run = async target => {
        setBusy(true); setError(''); setNotice('')
        try {
          const payload = await cleanStorage(target)
          setUsage(payload.storage)
          setNotice(`已清理${payload.label}，释放 ${formatStorageBytes(payload.freed_bytes)}`)
        } catch (cleanError) { setError('清理失败：' + cleanError.message) } finally { setBusy(false) }
      }
      return h('div', { 'data-xc-storage': true, style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
        h(SettingsRow, {
          label: t('settings.storagePath'),
          hint: usage ? (usage.source === 'custom' ? t('settings.customPath') : t('settings.defaultPath')) : t('settings.loading'),
          control: h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '58%' } },
            h('span', { 'data-xc-storage-path': usage?.storage_path || '', title: usage?.storage_path || '', style: { ...S.mutedSmall, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' } }, usage?.storage_path || ''),
            usage
              ? h('button', {
                type: 'button', 'data-xc-storage-copy': true, disabled: busy,
                style: { ...S.btn, height: 24, fontSize: '12px', flex: '0 0 auto' },
                onClick: async () => {
                  try { await navigator.clipboard.writeText(usage.storage_path); setCopied(true) } catch { setCopied(false) }
                },
              }, copied ? t('settings.copied') : t('settings.copy'))
              : null),
        }),
        h(SettingsRow, {
          label: '占用合计',
          hint: usage ? `${usage.total_files} 个文件` : '',
          control: h('span', { 'data-xc-storage-total': usage?.total_bytes ?? 0, style: S.mutedSmall }, usage ? formatStorageBytes(usage.total_bytes) : '—'),
        }),
        usage
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 } },
            ...usage.directories.filter(directory => directory.files).map(directory => h('div', { key: directory.name, 'data-xc-storage-dir': directory.name, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' } },
              h('span', { style: { ...S.mutedSmall, flex: '1 1 auto', minWidth: 0 } }, STORAGE_LABELS[directory.name] || directory.name),
              h('span', { style: { ...S.mutedSmall, flex: '0 0 auto' } }, formatStorageBytes(directory.bytes)))))
          : null,
        usage
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4 } },
            ...usage.cleanable.map(item => h('button', {
              key: item.target, type: 'button', 'data-xc-storage-clean': item.target, disabled: busy,
              style: { ...S.btn, height: 26, fontSize: '12px' },
              onClick: () => setConfirm(item),
            }, `清理${item.label}`)))
          : null,
        error ? h(StatusLine, { tone: 'alert' }, error) : null,
        notice ? h(StatusLine, { 'data-xc-storage-notice': true }, notice) : null,
        confirm
          ? h(ConfirmDialog, {
            title: `清理${confirm.label}`, tone: 'danger', confirmLabel: '清理', cancelLabel: '取消',
            onConfirm: () => { const target = confirm.target; setConfirm(null); run(target) },
            onCancel: () => setConfirm(null),
          }, h('div', { style: { lineHeight: 1.6 } }, `${confirm.hint}。此操作不可撤销。`))
          : null)
    }

// ── 06f-settings-ui.js ─────────────────────────────────────────────────────────
    // ── Settings dialog: the Harness layout, scoped to this plugin ───────────
    //
    // A left rail names the sections and the right pane holds rows of
    // label/hint + control, one divider per row. It is deliberately the same
    // shape as the host's settings dialog, so switching between them does not
    // ask the user to learn a second layout.

    /** One settings row: label and hint on the left, control on the right. */
    function SettingsRow ({ label, hint, control, children }) {
      return h('div', {
        'data-xc-settings-row': true,
        style: {
          display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0',
          borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))', minWidth: 0,
        },
      },
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', { style: { fontSize: FS } }, label),
        hint ? h('div', { style: { ...S.mutedSmall, marginTop: '2px' } }, hint) : null),
      control || children || null)
    }

    /** A switch that reads as a switch: role, state, disabled, keyboard. */
    function SettingSwitch ({ checked, disabled = false, onChange, dataAttrs = {} }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false', checked, disabled,
        ...dataAttrs,
        style: {
          flex: '0 0 auto', width: '38px', height: '22px', borderRadius: '11px', border: 'none', padding: '2px',
          cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
          background: checked ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.45))',
          display: 'flex', alignItems: 'center', justifyContent: checked ? 'flex-end' : 'flex-start',
          transition: 'background .15s ease',
        },
        onClick: () => { if (!disabled) onChange(!checked) },
      }, h('span', { style: { width: '18px', height: '18px', borderRadius: '50%', background: 'var(--dsw-alias-bg-base, #fff)', boxShadow: '0 1px 2px rgba(0,0,0,.25)' } }))
    }

    function CanvasSettingsDialog ({ t, settings, error, saving, onChange, onResetZoom, changelog, onImported, onClose }) {
      const [pane, setPane] = useState('display')
      const [changelogOpen, setChangelogOpen] = useState(false)
      const sections = [
        { id: 'display', label: t('settings.display') },
        { id: 'backup', label: t('settings.backup') },
        { id: 'storage', label: t('settings.storage') },
        { id: 'about', label: t('settings.about') },
      ]
      const display = h('div', { 'data-xc-settings-pane': 'display' },
        error ? h('div', { style: { ...S.errorBox, marginBottom: '8px' } }, error) : null,
        h(SettingsRow, { label: t('canvas.snap'), hint: t('settings.snapHint'), control: h(SettingSwitch, { checked: settings.snap, disabled: saving, onChange: value => onChange('snap', value), dataAttrs: { 'data-xc-setting': 'snap' } }) }),
        h(SettingsRow, { label: t('canvas.wide'), hint: t('settings.wideHint'), control: h(SettingSwitch, { checked: settings.wide, disabled: saving, onChange: value => onChange('wide', value), dataAttrs: { 'data-xc-setting': 'wide' } }) }),
        h(SettingsRow, { label: t('canvas.badges'), hint: t('settings.badgesHint'), control: h(SettingSwitch, { checked: settings.badges, disabled: saving, onChange: value => onChange('badges', value), dataAttrs: { 'data-xc-setting': 'badges' } }) }),
        h(SettingsRow, { label: t('canvas.resetZoom'), hint: t('settings.resetZoomHint'), control: h('button', { type: 'button', style: S.btn, 'data-xc-reset-zoom': true, onClick: onResetZoom }, t('canvas.resetZoom')) }))
      const about = h('div', { 'data-xc-settings-pane': 'about' },
        h(SettingsRow, {
          label: t('settings.version'),
          control: changelog?.current_version
            ? h('span', { 'data-xc-version': changelog.current_version, style: S.mutedSmall }, `v${changelog.current_version}`)
            : h('span', { style: S.mutedSmall }, '—'),
        }),
        h(SettingsRow, {
          label: t('settings.changelog'), hint: t('settings.changelogHint'),
          control: changelog
            ? h('button', { type: 'button', style: S.btn, 'data-xc-changelog': true, onClick: () => setChangelogOpen(true) }, t('settings.changelog'))
            : h('span', { style: S.mutedSmall }, '—'),
        }),
        h(SettingsRow, { label: t('settings.changelogFile'), control: h('span', { style: S.mutedSmall }, 'CHANGELOG.md') }),
        h(SettingsRow, { label: t('settings.export'), hint: t('settings.exportHint') }))
      return h(Dialog, {
        title: t('canvas.settings'), onClose, closeLabel: t('canvas.close'),
        width: 'min(920px, 94vw)', height: 'min(620px, 88vh)',
      },
      h('div', { 'data-xc-settings-body': true, style: {
        display: 'flex', height: '100%', minHeight: 0, margin: '-16px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))', borderRadius: RADIUS.md, overflow: 'hidden',
      } },
      h('nav', { 'aria-label': t('canvas.settings'), style: {
        flex: '0 0 168px', display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 8px',
        borderRight: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
      } },
      ...sections.map(section => h('button', {
        key: section.id, type: 'button', 'data-xc-settings-nav': section.id,
        'aria-current': pane === section.id ? 'page' : undefined,
        style: {
          ...S.btn, justifyContent: 'flex-start', height: '34px', border: 'none',
          background: pane === section.id ? 'color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)' : 'transparent',
          fontWeight: pane === section.id ? 500 : 'normal',
        },
        onClick: () => setPane(section.id),
      }, section.label))),
      h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto', padding: '12px 18px' }, 'data-xc-settings-content': pane },
        pane === 'display' ? display : pane === 'backup' ? h('div', { 'data-xc-settings-pane': 'backup' }, h(BackupSection, { t, onImported })) : pane === 'storage' ? h('div', { 'data-xc-settings-pane': 'storage' }, h(StorageSection, { t })) : about),
      changelogOpen ? h(ChangelogDialog, { data: changelog, onClose: () => setChangelogOpen(false) }) : null))
    }

// ── 06g-backup-ui.js ─────────────────────────────────────────────────────────
    // ── Backup: one file for every canvas and layout template ────────────────
    //
    // Export is a real download of the workspace bundle the host produces;
    // import is a real POST that creates new canvases/templates (never replaces
    // an existing one). Raw data-source tables are not part of the bundle: a
    // canvas keeps its card data inline, and tables are re-imported from files.
    function downloadWorkspaceBackup (bundle) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `xcharts-backup-${stamp}.json`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function BackupSection ({ t = key => key, onImported }) {
      const inputRef = useRef(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [confirm, setConfirm] = useState(null)
      const exportBackup = async () => {
        if (busy) return
        setBusy(true); setError(''); setNotice('')
        try {
          const bundle = await getWorkspaceBackup()
          downloadWorkspaceBackup(bundle)
          setNotice(`${t('settings.backupExported')} · ${bundle.canvas_count ?? 0} ${t('settings.backupCanvases')} · ${bundle.template_count ?? 0} ${t('settings.backupTemplates')}`)
        } catch (exportError) { setError(`${t('settings.backupExportFailed')}：${exportError.message}`) } finally { setBusy(false) }
      }
      const runImport = async file => {
        setBusy(true); setError(''); setNotice('')
        try {
          if (file.size > 8 * 1024 * 1024) throw new Error(t('settings.backupTooLarge'))
          const bundle = JSON.parse(await file.text())
          const result = await importWorkspaceBackup(bundle)
          const imported = result.imported.length + result.imported_templates.length
          setNotice(`${t('settings.backupImported')} · ${result.imported.length} ${t('settings.backupCanvases')} · ${result.imported_templates.length} ${t('settings.backupTemplates')}${result.failed.length ? ` · ${result.failed.length} ${t('settings.backupSkipped')}` : ''}`)
          if (imported && typeof onImported === 'function') await onImported()
        } catch (importError) { setError(`${t('settings.backupImportFailed')}：${importError.message}`) } finally { setBusy(false) }
      }
      const pickImport = () => inputRef.current?.click?.()
      const onFile = event => {
        const input = event.currentTarget
        const file = input.files?.[0]
        input.value = ''
        if (!file) return
        setConfirm({ file, name: file.name })
      }
      return h('div', { 'data-xc-backup': true, style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h(SettingsRow, {
          label: t('settings.backupExport'),
          hint: t('settings.backupExportHint'),
          control: h('button', { type: 'button', style: S.btn, 'data-xc-backup-export': true, disabled: busy, onClick: () => { exportBackup() } }, t('settings.backupExport')),
        }),
        h(SettingsRow, {
          label: t('settings.backupImport'),
          hint: t('settings.backupImportHint'),
          control: h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('button', { type: 'button', style: S.btn, 'data-xc-backup-import': true, disabled: busy, onClick: pickImport }, t('settings.backupImport')),
            h('input', {
              type: 'file', accept: '.json,application/json', ref: inputRef, 'data-xc-backup-input': true,
              style: { display: 'none' }, onChange: onFile,
            })),
        }),
        h(SettingsRow, { label: t('settings.backupScope'), hint: t('settings.backupNote') }),
        busy ? h(StatusLine, { children: [t('settings.backupWorking')] }) : null,
        error ? h(StatusLine, { tone: 'alert' }, error) : null,
        notice ? h(StatusLine, { 'data-xc-backup-notice': true }, notice) : null,
        confirm
          ? h(ConfirmDialog, {
            title: t('settings.backupImport'), tone: 'normal', confirmLabel: t('settings.backupImport'), cancelLabel: t('settings.cancel'),
            onConfirm: () => { const file = confirm.file; setConfirm(null); runImport(file) },
            onCancel: () => setConfirm(null),
          }, h('div', { style: { lineHeight: 1.6 } },
            `${t('settings.backupImportConfirm')}`,
            h('div', { style: { ...S.mutedSmall, marginTop: '4px', overflowWrap: 'anywhere' } }, confirm.name)))
          : null)
    }

// ── 07-canvas-workspace.js ─────────────────────────────────────────────────────────
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

// ── 08-datasource-query.js ─────────────────────────────────────────────────────────
    // ── Local datasource query model ────────────────────────────────────────
    //
    // The bounded declarative query the HTTP route and the agent tool both accept,
    // plus the presentation helpers and the builder pane the datasource page
    // renders. Kept in its own section so the page stays about layout and the
    // query model stays testable on its own (tests/data-source.test.js evaluates
    // this file directly).

    // Build the same bounded query object accepted by datasource_query and HTTP.
    function buildDatasourceQuery (columns, config) {
      const limit = Number(config.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('结果上限应为 1～5000。')
      const query = { limit }
      if (config.metrics.length) {
        // Date columns group by a chosen granularity; everything else stays a name.
        query.group_by = config.groups.map(name => {
          const type = columns.find(column => column.name === name)?.type
          if (type !== 'date') return name
          return { column: name, granularity: config.groupGranularity?.[name] || 'day' }
        })
        query.metrics = config.metrics.map(m => ({ op: m.op, ...(m.column ? { column: m.column } : {}), as: m.as || `${m.op}_${m.column || 'rows'}` }))
      } else {
        if (config.groups.length) throw new Error('分组查询需至少添加一个聚合指标。')
        if (!config.select.length) throw new Error('请选择至少一个字段。')
        query.select = config.select
      }
      query.filters = config.filters.map(f => {
        if (['is_null', 'not_null'].includes(f.op)) return { column: f.column, op: f.op }
        const column = columns.find(c => c.name === f.column)
        if (!column) throw new Error('请选择有效筛选字段。')
        let value = f.value
        if (column.type === 'number') {
          if (!String(value).trim() || !Number.isFinite(Number(value))) throw new Error(`${f.column} 的筛选值必须为数值。`)
          value = Number(value)
        } else if (column.type === 'boolean') {
          if (!['true', 'false'].includes(value)) throw new Error(`${f.column} 的筛选值请填写 true 或 false。`)
          value = value === 'true'
        } else if (column.type === 'date') {
          if (!String(value).trim()) throw new Error(`${f.column} 的筛选值必须是日期，例如 2024-01-02。`)
          value = String(value).trim()
        }
        return { column: f.column, op: f.op, value }
      })
      query.order_by = config.order.filter(o => o.column).map(o => ({ column: o.column, direction: o.direction }))
      return query
    }

    function datasourceTextUnits (value) {
      return Array.from(String(value ?? '')).reduce((n, ch) => n + (ch.codePointAt(0) > 255 ? 2 : 1), 0)
    }

    function datasourceColumnWidths (columns, rows) {
      const units = datasourceTextUnits
      return columns.map((column, i) => {
        const numeric = column.type === 'number'
        const length = Math.max(units(typeof column === 'string' ? column : column.name), ...rows.slice(0, 100).map(row => Math.min(32, units(row[i]))))
        return Math.max(numeric ? 80 : 96, Math.min(numeric ? 152 : 224, length * 7 + 24))
      })
    }

    // Output column name of one grouping: a date bucketed to month/quarter/year
    // is reported as `列(月)` so a summary and a sort field can name it.
    function datasourceGroupName (group, granularity) {
      if (group && typeof group === 'object') {
        const value = group.granularity
        return value && value !== 'day' ? `${group.column}(${DATE_GRAIN_LABELS[value] || value})` : group.column
      }
      return granularity && granularity !== 'day' ? `${group}(${DATE_GRAIN_LABELS[granularity] || granularity})` : group
    }
    const DATE_GRAIN_LABELS = { day: '日', month: '月', quarter: '季', year: '年' }
    const DATE_GRAIN_OPTIONS = [{ value: 'day', label: '按日' }, { value: 'month', label: '按月' }, { value: 'quarter', label: '按季' }, { value: 'year', label: '按年' }]

    function datasourceQuerySummary (config) {
      const groupNames = config.groups.map(group => datasourceGroupName(group, typeof group === 'string' ? config.groupGranularity?.[group] : undefined))
      const parts = [config.metrics.length ? `${groupNames.length ? '按 ' + groupNames.join('、') + ' 分组' : '全表汇总'} · ${config.metrics.map(m => `${m.op}(${m.column || '全部行'})`).join('、')}` : `选择 ${config.select.length} 个字段`]
      const operators = { eq: '等于', ne: '不等于', gt: '大于', gte: '不小于', lt: '小于', lte: '不大于', contains: '包含', is_null: '为空', not_null: '非空' }
      if (config.filters.length) parts.push(config.filters.slice(0, 3).map(f => `${f.column}${operators[f.op] || f.op}${['is_null', 'not_null'].includes(f.op) ? '' : String(f.value).slice(0, 24)}`).join('，') + (config.filters.length > 3 ? `等共 ${config.filters.length} 项` : '（全部满足）'))
      if (config.order.some(o => o.column)) parts.push(config.order.filter(o => o.column).map(o => `${o.column}${o.direction === 'desc' ? '降序' : '升序'}`).join('、'))
      parts.push(`最多 ${config.limit} 行`)
      return parts.join(' · ')
    }


    /** Read a stored query snapshot back as one human sentence. */
    function summarizeStoredQuery (query) {
      if (!query || typeof query !== 'object') return '口径未记录'
      return datasourceQuerySummary({
        select: Array.isArray(query.select) ? query.select : [],
        groups: Array.isArray(query.group_by) ? query.group_by : [],
        metrics: Array.isArray(query.metrics) ? query.metrics : [],
        filters: Array.isArray(query.filters) ? query.filters : [],
        order: Array.isArray(query.order_by) ? query.order_by : [],
        limit: query.limit ?? 1000,
      })
    }

    /**
     * The bounded query builder.
     *
     * It owns its transient UI state (field search, help disclosure) and reports a
     * complete config object on every change, so the page never has to know how a
     * query is assembled — that keeps the drag/resize/layout code in the page
     * section free of query semantics.
     */
    function DataSourceQueryPane ({ config, columns, busy, capabilities, onChange, onKeyDown, footer, diagnostics }) {
      const [fieldSearch, setFieldSearch] = useState('')
      const [queryHelpOpen, setQueryHelpOpen] = useState(false)
      const changelog = useChangelog(3)
      // All fields selected is the default and the common case, so the 24 chips
      // say nothing the label does not — they only unfold when asked for.
      const [fieldsOpen, setFieldsOpen] = useState(false)
      const patchQuery = patch => onChange({ ...config, ...patch })
      const queryColumns = columns
      const outputColumns = config.metrics.length
        ? [...config.groups.map(group => datasourceGroupName(group, config.groupGranularity?.[group])), ...config.metrics.map(m => m.as || `${m.op}_${m.column || 'rows'}`)] : config.select
      const selectControl = (label, value, choices, onSelect, extraStyle) => h(Select, {
        value,
        options: choices.map(choice => (choice && typeof choice === 'object' ? choice : { value: choice, label: String(choice) })),
        onChange: next => onSelect(next),
        ariaLabel: label,
        title: label,
        disabled: busy,
        dataAttrs: { 'data-xc-query-selector': label },
        triggerStyle: { minWidth: 0, maxWidth: '100%', height: 24, fontSize: '12px', ...extraStyle },
      })
      const editRow = (kind, index, patch) => patchQuery({ [kind]: config[kind].map((row, i) => i === index ? { ...row, ...patch } : row) })
      const removeRow = (kind, index) => h(LinkButton, { label: '移除', title: `删除${kind}第${index + 1}项`, disabled: busy, onClick: () => patchQuery({ [kind]: config[kind].filter((_, i) => i !== index) }) })
      const rowStyle = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }
      const section = UI.column
      const fieldRow = { display: 'flex', alignItems: 'center', gap: 6, minHeight: 22, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }
      const checkbox = { width: 13, height: 13, margin: 0, flex: '0 0 auto' }

      const fieldsDisabled = busy || !!config.metrics.length
      const fieldNeedle = fieldSearch.trim().toLocaleLowerCase()
      // "All fields" is the default query, so it is stated once in the label and
      // the chips stay folded: 24 identical chips said nothing the label did not.
      const allFieldsSelected = queryColumns.length > 0 && config.select.length === queryColumns.length
      const showFieldBody = !allFieldsSelected || fieldsOpen
      const matches = fieldNeedle
        ? queryColumns.filter(c => c.name.toLocaleLowerCase().includes(fieldNeedle))
        : []
      return h('section', { className: 'xc-ds-query', 'aria-label': '结构化查询配置', 'data-xc-query-builder': true, onKeyDown, style: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { 'data-xc-field-list': true, style: { ...section, flex: '0 0 auto' } },
          h(SectionLabel, { label: allFieldsSelected ? `原始字段 · 全部 ${queryColumns.length} 列` : `原始字段 · 已选 ${config.select.length}/${queryColumns.length}`, actions: [
            allFieldsSelected
              ? h(LinkButton, { key: 'adjust', label: fieldsOpen ? '收起字段' : '调整字段', disabled: fieldsDisabled, 'data-xc-field-adjust': true, onClick: () => setFieldsOpen(open => !open) })
              : h(LinkButton, { key: 'all', label: '全选', disabled: fieldsDisabled, onClick: () => patchQuery({ select: queryColumns.map(c => c.name) }) }),
            config.select.length
              ? h(LinkButton, { key: 'none', label: '清空', disabled: fieldsDisabled, onClick: () => patchQuery({ select: [] }) })
              : null,
          ] }),
          // All fields selected: the label already says so, and 调整字段 is right
          // there — so the section is one line instead of 24 chips.
          showFieldBody
            ? h(Fragment, null,
              h('input', { type: 'search', 'aria-label': '搜索原始字段', value: fieldSearch, placeholder: '搜索字段以添加', disabled: fieldsDisabled, onChange: e => setFieldSearch(e.target.value), style: { ...S.btn, width: '100%', fontWeight: 'normal', height: 24 } }),
              fieldSearch.trim()
                ? h('div', { 'data-xc-field-search': true, style: { maxHeight: 'clamp(120px, 26vh, 240px)', overflow: 'auto', display: 'flex', flexDirection: 'column' } },
                  ...matches.map(c => h('button', {
                    key: c.name,
                    type: 'button',
                    'data-xc-field-add': c.name,
                    'aria-pressed': config.select.includes(c.name),
                    disabled: fieldsDisabled,
                    title: c.name,
                    style: { ...fieldRow, width: '100%', border: 0, background: 'transparent', font: 'inherit', textAlign: 'left' },
                    onClick: () => patchQuery({ select: config.select.includes(c.name) ? config.select.filter(n => n !== c.name) : [...config.select, c.name] }),
                  }, h('span', { 'aria-hidden': true, style: { width: 14, flex: '0 0 auto', color: 'var(--dsw-alias-brand-primary)' } }, config.select.includes(c.name) ? '✓' : '＋'), h(EllipsisText, { text: c.name }))),
                  matches.length === 0 ? h('div', { style: { ...S.mutedSmall, padding: '8px 0' } }, '没有匹配的字段') : null)
                : h('div', { 'data-xc-field-chips': true, style: { display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 'clamp(120px, 26vh, 240px)', overflow: 'auto' } },
                  config.select.length
                    ? config.select.map(name => h('button', {
                      key: name,
                      type: 'button',
                      'data-xc-field-chip': name,
                      'aria-label': `移除字段 ${name}`,
                      title: `移除字段 ${name}`,
                      disabled: fieldsDisabled,
                      style: { ...S.btn, height: 22, padding: '0 6px', minWidth: 0, maxWidth: '100%', fontSize: '12px', fontWeight: 'normal', gap: 4 },
                      onClick: () => patchQuery({ select: config.select.filter(n => n !== name) }),
                    }, h('span', { style: { ...UI.ellipsis, maxWidth: 140 } }, name), h('span', { 'aria-hidden': true, style: { color: 'var(--dsw-alias-label-secondary)' } }, '×')))
                    : h('div', { style: { ...S.mutedSmall, padding: '4px 0' } }, '尚未选择字段：在上方搜索添加，或点“全选”。')))
            : null),
        h('div', { style: section },
          h(SectionLabel, { label: '筛选', actions: [
            h(LinkButton, { key: 'add', label: '添加条件', disabled: busy || config.filters.length >= 20, onClick: () => patchQuery({ filters: [...config.filters, { column: queryColumns[0]?.name, op: 'eq', value: '' }] }) }),
          ] })),
        ...config.filters.map((f, i) => h('div', { key: i, style: { ...rowStyle, gap: 4 } },
          selectControl(`筛选字段 ${i + 1}`, f.column, queryColumns.map(c => c.name), column => editRow('filters', i, { column, value: '' }), { flex: '1 1 120px' }),
          selectControl(`筛选条件 ${i + 1}`, f.op, [{ value: 'eq', label: '等于' }, { value: 'ne', label: '不等于' }, { value: 'gt', label: '大于' }, { value: 'gte', label: '≥' }, { value: 'lt', label: '小于' }, { value: 'lte', label: '≤' }, { value: 'contains', label: '包含' }, { value: 'is_null', label: '为空' }, { value: 'not_null', label: '非空' }], op => editRow('filters', i, { op }), { flex: '0 0 auto', width: 84 }),
          !['is_null', 'not_null'].includes(f.op) ? h('input', { 'aria-label': `筛选值 ${i + 1}`, value: f.value, disabled: busy, placeholder: '值', style: { ...S.btn, minWidth: 0, flex: '1 1 90px', height: 24, fontSize: '12px' }, onChange: e => editRow('filters', i, { value: e.target.value }) }) : null, removeRow('filters', i))),
        h(Disclosure, { label: `汇总${config.metrics.length ? ' · ' + config.metrics.length + ' 个指标' : ''}`, data: { 'data-xc-query-aggregate': true } },
          h('fieldset', { disabled: busy }, h('legend', null, '分组（最多 5 列）'), ...queryColumns.map(c => h('label', { key: c.name, style: { display: 'inline-flex', gap: 4, marginRight: 10, alignItems: 'center' } }, h('input', { type: 'checkbox', checked: config.groups.includes(c.name), disabled: !config.groups.includes(c.name) && config.groups.length >= 5, onChange: e => patchQuery({ groups: e.target.checked ? [...config.groups, c.name] : config.groups.filter(n => n !== c.name) }) }), c.name,
            // A date column asks for its bucket; the answer rides on the same config.
            c.type === 'date' && config.groups.includes(c.name)
              ? h(Select, {
                ariaLabel: `${c.name} 分组粒度`, dataAttrs: { 'data-xc-date-granularity': c.name }, disabled: busy,
                value: config.groupGranularity?.[c.name] || 'day', options: DATE_GRAIN_OPTIONS,
                triggerStyle: { height: 22, fontSize: '12px' }, width: 76,
                onChange: value => patchQuery({ groupGranularity: { ...(config.groupGranularity || {}), [c.name]: value } }),
              })
              : null))),
          h(SectionLabel, { label: '聚合指标', actions: [
            h(LinkButton, { key: 'add', label: '添加指标', disabled: busy || config.metrics.length >= 10, onClick: () => patchQuery({ metrics: [...config.metrics, { op: 'count', column: '', as: '' }] }) }),
          ] }),
          ...config.metrics.map((m, i) => h('div', { key: i, style: { ...rowStyle, gap: 4 } },
            selectControl(`聚合方法 ${i + 1}`, m.op, ['count', 'sum', 'avg', 'min', 'max'], op => editRow('metrics', i, { op, column: op === 'count' ? '' : queryColumns.find(c => c.type === 'number')?.name || '' }), { flex: '0 0 auto', width: 76 }),
            selectControl(`指标字段 ${i + 1}`, m.column, [...(m.op === 'count' ? [{ value: '', label: '全部行' }] : []), ...queryColumns.filter(c => m.op === 'count' || c.type === 'number').map(c => c.name)], column => editRow('metrics', i, { column }), { flex: '1 1 110px' }),
            h('input', { 'aria-label': `指标别名 ${i + 1}`, value: m.as, placeholder: '别名', disabled: busy, style: { ...S.btn, minWidth: 0, flex: '1 1 80px', height: 24, fontSize: '12px' }, onChange: e => editRow('metrics', i, { as: e.target.value }) }), removeRow('metrics', i)))),
        h(Disclosure, { label: '更多设置', data: { 'data-xc-query-more': true } },
          h(SectionLabel, { label: '排序', actions: [
            h(LinkButton, { key: 'add', label: '添加排序', disabled: busy || config.order.length >= 5, onClick: () => patchQuery({ order: [...config.order, { column: '', direction: 'asc' }] }) }),
          ] }),
          ...config.order.map((o, i) => h('div', { key: i, style: { ...rowStyle, gap: 4 } }, selectControl(`排序字段 ${i + 1}`, o.column, [{ value: '', label: '不排序' }, ...outputColumns], column => editRow('order', i, { column }), { flex: '1 1 120px' }), selectControl(`排序方向 ${i + 1}`, o.direction, [{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }], direction => editRow('order', i, { direction }), { flex: '0 0 auto', width: 76 }), removeRow('order', i))),
          h('label', { style: rowStyle }, '结果上限（1～5000）', h('input', { type: 'number', min: 1, max: 5000, 'aria-label': '结果行数上限', value: config.limit, disabled: busy, style: { ...S.btn, width: 100 }, onChange: e => patchQuery({ limit: e.target.value }) }))),
        h(Disclosure, { label: '说明与诊断', data: { 'data-xc-query-docs': true } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 } },
            h(LinkButton, { label: queryHelpOpen ? '收起查询说明' : '查询说明', 'aria-expanded': queryHelpOpen, 'data-xc-query-help-toggle': true, style: { alignSelf: 'flex-start' }, onClick: () => setQueryHelpOpen(open => !open) }),
            queryHelpOpen ? h('div', { role: 'note', 'data-xc-query-help': true, style: { lineHeight: 1.6 } }, '默认查询全部字段；可配置筛选、分组和聚合，最多保存 5,000 行。原始值保持不变，包括“?”。图表需要完整且不超过500行、分类唯一及数值列；表格可保留截断结果。') : null,
            // The query snapshot and source hash are diagnostics, so they live
            // with the rest of the diagnostics instead of floating above the table.
            diagnostics || null,
            h('div', { 'data-xc-interface-diagnostics': true, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
              h('span', null, capabilities ? `插件接口 v${capabilities.plugin_version} · 数据源接口已连接` : '接口尚未连接'),
              h(ChangelogControl, { data: changelog })))),
        footer || null)
    }

// ── 09a-data-table.js ─────────────────────────────────────────────────────────
    // ── 可复用表格面板：工具条、全屏、列显隐/列宽/冻结、右键菜单、分页 ──────────
    //
    // 表格是数据源页里最重的一块，现在抽成独立组件：DataSourcePage 只传数据
    // 与分页回调，任何需要“看一份表格”的地方（结果、预览、未来的其他面板）
    // 都用同一个组件，工具条与快捷键保持一致。
    //
    // 约定：
    // - data：{ columns, rows, total_rows?, materialized_rows?, truncated? }
    // - onPage(page)：翻页回调（页面负责读取对应页并回填 data）
    // - fetchRows(offset, limit)：复制/导出“全部”时逐页读取；缺省用当前页
    // - onFilterValue(columnName, value)：提供时才出现“按此值筛选”
    // - storageKey：列宽/显隐/冻结的记忆键（localStorage）
    function DataTablePane ({
      data,
      tableKey = 'result',
      page = 1,
      pageSize = 100,
      totalRows,
      busy = false,
      title,
      leading = null,
      fetchRows,
      onFilterValue,
      onResetFilters,
      onNotify,
      emptyTitle,
      emptyHint,
      storageKey,
    }) {
      const [searchOpen, setSearchOpen] = useState(false)
      const [tableSearch, setTableSearch] = useState('')
      const [copiedTip, setCopiedTip] = useState('')
      const [fullscreen, setFullscreen] = useState(false)
      const [hidden, setHidden] = useState({})
      const [widths, setWidths] = useState({})
      const [frozenFirst, setFrozenFirst] = useState(false)
      const [colsOpen, setColsOpen] = useState(false)
      const [cellMenu, setCellMenu] = useState(null)
      const [cellDetail, setCellDetail] = useState(null)
      const [resizingCol, setResizingCol] = useState(null)
      const [sort, setSort] = useState(null)
      const [profileOpen, setProfileOpen] = useState(false)

      // 记住每张表的列宽/显隐/冻结：只影响显示，不影响数据。
      useEffect(() => {
        if (!storageKey) return
        try {
          const saved = JSON.parse(window.localStorage.getItem(`xcharts.table.${storageKey}`) || '{}')
          if (saved.hidden && typeof saved.hidden === 'object') setHidden(saved.hidden)
          if (saved.widths && typeof saved.widths === 'object') setWidths(saved.widths)
          if (saved.frozen) setFrozenFirst(true)
        } catch { /* 忽略损坏的记忆 */ }
      }, [storageKey])
      const remember = next => {
        if (!storageKey) return
        try {
          window.localStorage.setItem(`xcharts.table.${storageKey}`, JSON.stringify({ hidden: next.hidden ?? hidden, widths: next.widths ?? widths, frozen: next.frozen ?? frozenFirst }))
        } catch { /* 隐私模式：仅保留内存态 */ }
      }

      useEffect(() => {
        if (!fullscreen) return undefined
        const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); setFullscreen(false) } }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [fullscreen])
      useEffect(() => {
        const onKey = event => {
          if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'f' && data?.columns?.length) {
            event.preventDefault(); setSearchOpen(true)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [data])

      const columns = data?.columns || []
      const rows = data?.rows || []
      const total = Number.isFinite(totalRows) ? totalRows : data?.total_rows ?? data?.row_count ?? rows.length
      const pageCount = Math.max(1, Math.ceil(total / pageSize))
      const baseWidths = datasourceColumnWidths(columns, rows)
      const columnName = i => typeof columns[i] === 'string' ? columns[i] : columns[i].name
      const visible = columns.map((column, i) => ({ column, i })).filter(({ i }) => !hidden[tableKey + ':' + i])
      const colWidth = i => widths[tableKey + ':' + i] ?? baseWidths[i]
      const frozenCol = visible[0]?.i

      // 排序只作用于当前页；三态：升序 → 降序 → 恢复原序。
      const sortRows = list => {
        if (!sort) return list
        const type = columns[sort.col]?.type
        const factor = sort.dir === 'asc' ? 1 : -1
        return list.slice().sort((a, b) => {
          const left = a[sort.col]; const right = b[sort.col]
          if (left == null && right == null) return 0
          if (left == null) return 1
          if (right == null) return -1
          if (type === 'number') return (Number(left) - Number(right)) * factor
          return String(left).localeCompare(String(right), 'zh-Hans-CN') * factor
        })
      }
      const visibleRows = sortRows(rows)
      const cycleSort = i => setSort(current => !current || current.col !== i ? { col: i, dir: 'asc' } : current.dir === 'asc' ? { col: i, dir: 'desc' } : null)
      const term = tableSearch.trim().toLowerCase()
      const hits = new Set()
      if (term) visibleRows.forEach((row, ri) => row.forEach((cell, ci) => { if (String(cell ?? '').toLowerCase().includes(term)) hits.add(ri + ':' + ci) }))
      // 字段画像：只统计当前页，用来快速判断空值/唯一值/数值范围。
      const profile = columns.map((column, i) => {
        const name = typeof column === 'string' ? column : column.name
        const values = rows.map(row => row[i]).filter(value => value !== null && value !== undefined && value !== '')
        const unique = new Set(values.map(value => String(value))).size
        const nums = column.type === 'number' ? values.map(Number).filter(Number.isFinite) : []
        return {
          name, type: column.type || 'string', total: rows.length,
          nulls: rows.length - values.length, unique,
          min: nums.length ? Math.min(...nums) : null,
          max: nums.length ? Math.max(...nums) : null,
          avg: nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : null,
        }
      })

      const readAllRows = async () => {
        // 服务端分页上限是 100 行/页：按 100 逐页读到结果末尾。
        if (typeof fetchRows === 'function' && total > 0) {
          const PAGE = 100
          const chunks = []
          for (let offset = 0; offset < total; offset += PAGE) {
            const chunk = await fetchRows(offset, PAGE)
            if (!chunk?.length) break
            chunks.push(...chunk)
            if (chunk.length < PAGE) break
          }
          if (chunks.length) return chunks
        }
        return rows
      }
      const tsvOfRows = list => {
        const cols = visible.map(({ i }) => i)
        return [cols.map(i => columnName(i)).join('\t'), ...list.map(row => cols.map(i => String(row[i] ?? '')).join('\t'))].join('\n')
      }
      const csvOfRows = list => {
        const escape = value => { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text }
        const cols = visible.map(({ i }) => i)
        return [cols.map(i => escape(columnName(i))).join(','), ...list.map(row => cols.map(i => escape(row[i])).join(','))].join('\n')
      }
      const copyAll = async () => {
        setCopiedTip('正在读取全部…')
        let list = []
        try {
          list = await readAllRows()
          await navigator.clipboard.writeText(tsvOfRows(list))
          setCopiedTip('已复制 ' + list.length + ' 行')
        } catch (error) {
          const text = '复制失败：' + (error?.message || '未知原因')
          setCopiedTip(text); onNotify?.(text, 'alert')
        } finally { if (typeof setTimeout === 'function') setTimeout(() => setCopiedTip(''), 3000) }
      }
      const exportAll = async () => {
        setCopiedTip('正在导出…')
        let list = []
        try {
          list = await readAllRows()
          const url = URL.createObjectURL(new Blob(['\ufeff' + csvOfRows(list)], { type: 'text/csv;charset=utf-8' }))
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = (title || '数据') + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv'
          anchor.style.display = 'none'
          // 某些 WebView 只对已挂载的锚点触发下载；revoke 也必须等下载开始后再做。
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          if (typeof setTimeout === 'function') setTimeout(() => URL.revokeObjectURL(url), 2000)
          setCopiedTip('已导出 ' + list.length + ' 行')
        } catch (error) {
          // 下载被环境拦截时，把 CSV 放进剪贴板，至少能拿到数据。
          let copied = false
          try { await navigator.clipboard.writeText(csvOfRows(list)); copied = list.length > 0 } catch { /* ignore */ }
          const text = '导出失败：' + (error?.message || '未知原因') + (copied ? '（CSV 已复制到剪贴板）' : '')
          setCopiedTip('导出失败'); onNotify?.(text, 'alert')
        } finally { if (typeof setTimeout === 'function') setTimeout(() => setCopiedTip(''), 3000) }
      }

      if (!columns.length) return h('div', { style: { ...S.muted, padding: 12 } }, '暂无数据')
      if (!rows.length) {
        return h('div', {
          'data-xc-table-empty': tableKey,
          style: { flex: '1 1 0%', minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, textAlign: 'center' },
        },
        h('strong', null, emptyTitle || (tableKey === 'result' ? '无匹配行' : '没有可预览的行')),
        h('div', { style: S.mutedSmall }, emptyHint || (tableKey === 'result' ? '当前筛选条件下没有数据，放宽或清除筛选后重新执行查询。' : '检查导入文件的表头行设置，或重新导入文件。')),
        tableKey === 'result' && typeof onResetFilters === 'function'
          ? h(LinkButton, { label: '清除筛选并重新配置', onClick: onResetFilters })
          : null)
      }

      const startResize = (i, event) => {
        event.preventDefault(); event.stopPropagation()
        setResizingCol(i)
        const startX = event.clientX
        const startWidth = colWidth(i)
        const onMove = move => setWidths(current => ({ ...current, [tableKey + ':' + i]: Math.max(56, Math.round(startWidth + (move.clientX - startX))) }))
        const onUp = () => {
          document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp)
          setResizingCol(null)
          remember({})
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }

      const lastVisible = visible[visible.length - 1]?.i
      const widthOf = i => fullscreen && i === lastVisible ? undefined : colWidth(i)
      const headers = visible.map(({ column, i }) => h('th', {
        key: i, title: columnName(i),
        onClick: () => cycleSort(i), 'data-xc-sort-col': i,
        style: {
          width: widthOf(i), cursor: 'pointer', userSelect: 'none', textAlign: column.type === 'number' ? 'right' : 'left', padding: '6px 10px', paddingRight: '14px',
          position: 'sticky', top: 0, left: frozenFirst && i === frozenCol ? 40 : undefined, zIndex: frozenFirst && i === frozenCol ? 3 : 2,
          background: 'var(--dsw-alias-bg-base, Canvas)', borderBottom: '1px solid var(--dsw-alias-border-l1)',
          color: 'var(--dsw-alias-label-secondary, inherit)', fontWeight: 500,
        },
      }, h('span', { style: { display: 'block', ...UI.ellipsis } }, columnName(i) + (sort && sort.col === i ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')), h('span', {
        'data-xc-col-resize': i, title: '拖动调整列宽', onMouseDown: event => startResize(i, event),
        style: { position: 'absolute', right: '-3px', top: 0, bottom: 0, width: '7px', cursor: 'col-resize', zIndex: 5, display: 'flex', justifyContent: 'center' },
      }, h('span', { style: { width: resizingCol === i ? '2px' : '1px', alignSelf: 'stretch', margin: '4px 0', borderRadius: '1px', background: resizingCol === i ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.5))' } }))))

      const bodyRows = visibleRows.map((row, i) => h('tr', { key: i },
        h('td', { style: { width: 40, position: 'sticky', left: 0, zIndex: 3, background: 'var(--dsw-alias-bg-base, Canvas)', textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 45%, transparent)', color: 'var(--dsw-alias-label-secondary, inherit)', fontVariantNumeric: 'tabular-nums' } }, String((page - 1) * pageSize + i + 1)),
        ...visible.map(({ column, i: j }) => {
          const raw = row[j]
          const isNull = raw === null || raw === undefined
          const text = isNull ? '—' : String(raw)
          const isFrozen = frozenFirst && j === frozenCol
          const long = !isNull && datasourceTextUnits(text) * 7 > colWidth(j) - 24
          return h('td', {
            key: j, title: isNull ? 'NULL' : text,
            onContextMenu: event => { event.preventDefault(); setCellMenu({ row: i, col: j, x: event.clientX, y: event.clientY }) },
            style: {
              width: widthOf(j), padding: '4px 10px', textAlign: column.type === 'number' ? 'right' : 'left',
              fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 45%, transparent)',
              color: isNull ? 'var(--dsw-alias-label-tertiary, inherit)' : 'var(--dsw-alias-label-primary, inherit)', lineHeight: 1.45, ...UI.ellipsis,
              ...(isFrozen ? { position: 'sticky', left: 40, zIndex: 2, background: 'var(--dsw-alias-bg-base, Canvas)' } : null),
              ...(term && hits.has(i + ':' + j) ? { background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e8a33d) 22%, transparent)' } : null),
            },
          },
          long ? h('button', { type: 'button', 'aria-label': `查看完整值：${columnName(j)}，第 ${(page - 1) * pageSize + i + 1} 行`, 'data-xc-cell-expand': true, onClick: () => setCellDetail({ title: columnName(j), value: text }), style: { display: 'block', width: '100%', padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'inherit', cursor: 'pointer', ...UI.ellipsis } }, text) : text)
        })))

      const pane = h('div', { key: tableKey, 'data-xc-data-table': tableKey, style: { position: 'relative', flex: '1 1 0%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h('div', { 'data-xc-table-tools': tableKey, style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 6px', minHeight: '28px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))' } },
          leading ? h('strong', { style: { ...S.mutedSmall, fontSize: '12px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' } }, leading) : null,
          searchOpen
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 1 auto', minWidth: 0 } },
              h('input', {
                type: 'search', autoFocus: true, value: tableSearch, 'aria-label': '表内搜索', placeholder: '搜索当前页', 'data-xc-table-search-input': tableKey,
                style: { ...S.btn, height: '24px', minWidth: '180px' },
                onChange: event => setTableSearch(event.target.value),
                onKeyDown: event => { if (event.key === 'Escape') { setSearchOpen(false); setTableSearch('') } },
              }),
              term ? h('span', { style: { ...S.mutedSmall, whiteSpace: 'nowrap' } }, hits.size + ' 处') : null)
            : null,
          h('span', { style: { flex: '1 1 auto' } }),
          copiedTip ? h('span', { style: { ...S.mutedSmall, whiteSpace: 'nowrap' } }, copiedTip) : null,
          h(IconButton, { title: fullscreen ? '退出全屏' : '全屏', onClick: () => setFullscreen(value => !value), buttonProps: { 'data-xc-table-fullscreen': tableKey, 'aria-pressed': fullscreen ? 'true' : 'false' } }, h(ToolIcon, { name: fullscreen ? 'collapse' : 'expand' })),
          h(IconButton, { title: '表内搜索', onClick: () => setSearchOpen(open => !open), buttonProps: { 'data-xc-table-search': tableKey, 'aria-expanded': searchOpen ? 'true' : 'false' } }, h(ToolIcon, { name: 'search' })),
          fullscreen ? null : h(IconButton, { title: '显示列 / 冻结首列', onClick: () => { setColsOpen(open => !open); setProfileOpen(false) }, buttonProps: { 'data-xc-table-columns': tableKey } }, h(ToolIcon, { name: 'panel' })),
          fullscreen ? null : h(IconButton, { title: '字段画像（当前页）', onClick: () => { setProfileOpen(open => !open); setColsOpen(false) }, buttonProps: { 'data-xc-table-profile': tableKey } }, h(ToolIcon, { name: 'compass' })),
          h(IconButton, { title: '复制全部结果', onClick: () => { copyAll() }, buttonProps: { 'data-xc-table-copy': tableKey } }, h(ToolIcon, { name: 'copy' })),
          h(IconButton, { title: '导出全部结果 CSV', onClick: () => { exportAll() }, buttonProps: { 'data-xc-table-export': tableKey } }, h(ToolIcon, { name: 'download' })),
          fullscreen ? null : h(IconButton, { title: '刷新当前页', onClick: () => onPage?.(page), buttonProps: { 'data-xc-table-refresh': tableKey, disabled: busy } }, h(ToolIcon, { name: 'refresh' }))),
        !fullscreen && profileOpen ? h(PanelPopover, { 'data-xc-table-profile-panel': tableKey, width: '440px' },
        h('div', { style: { ...S.mutedSmall, marginBottom: '6px' } }, '字段画像 · 当前页 ' + rows.length + ' 行'),
        h('table', { style: { width: '100%', fontSize: 12, borderCollapse: 'collapse' } },
          h('thead', null, h('tr', null,
            ['列', '类型', '空值', '唯一值', '最小', '最大', '平均'].map((label, index) => h('th', {
              key: label,
              style: { textAlign: index > 1 ? 'right' : 'left', padding: '4px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)', fontWeight: 500 },
            }, label)))),
          h('tbody', null, ...profile.map(row => h('tr', { key: row.name },
            h('td', { style: { padding: '4px 6px', maxWidth: '120px', ...UI.ellipsis } }, row.name),
            h('td', { style: { padding: '4px 6px', color: 'var(--dsw-alias-label-secondary)' } }, row.type),
            h('td', { style: { padding: '4px 6px', textAlign: 'right' } }, row.nulls + (row.total ? ' (' + Math.round(row.nulls / row.total * 100) + '%)' : '')),
            h('td', { style: { padding: '4px 6px', textAlign: 'right' } }, row.unique),
            h('td', { style: { padding: '4px 6px', textAlign: 'right' } }, row.min == null ? '—' : row.min),
            h('td', { style: { padding: '4px 6px', textAlign: 'right' } }, row.max == null ? '—' : row.max),
            h('td', { style: { padding: '4px 6px', textAlign: 'right' } }, row.avg == null ? '—' : row.avg.toFixed(2))))))) : null,
        !fullscreen && colsOpen ? h(PanelPopover, { 'data-xc-columns-popover': tableKey },
        h('div', { style: { ...S.mutedSmall, padding: '2px 4px 4px' } }, '显示列'),
        ...columns.map((column, i) => h('label', { key: i, style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '2px 4px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', 'data-xc-column-toggle': tableKey + ':' + i,
            checked: !hidden[tableKey + ':' + i],
            onChange: () => {
              const next = { ...hidden }
              const id = tableKey + ':' + i
              if (next[id]) delete next[id]; else next[id] = true
              setHidden(next); remember({ hidden: next })
            },
          }), typeof column === 'string' ? column : column.name)),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '4px', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))', marginTop: '4px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', 'data-xc-freeze-first': true, checked: frozenFirst,
            onChange: () => { setFrozenFirst(value => !value); remember({ frozen: !frozenFirst }) },
          }), '冻结首列'),
        h('button', { type: 'button', style: { ...S.btn, height: '24px', fontSize: '12px', marginTop: '4px' }, onClick: () => { setHidden({}); setWidths({}); setFrozenFirst(false); remember({ hidden: {}, widths: {}, frozen: false }) } }, '恢复默认')) : null,
        h('div', { className: 'xc-ds-table-scroll', role: 'region', 'aria-label': tableKey === 'result' ? '查询结果表格，可横向滚动' : '数据预览表格，可横向滚动', tabIndex: 0, 'data-xc-data-table-scroll': true, style: { flex: '1 1 0%', minHeight: 0, minWidth: 0, overflowX: 'scroll', overflowY: 'auto' } },
          h('table', { className: 'xc-ds-table', style: { width: '100%', minWidth: visible.reduce((sum, { i }) => sum + colWidth(i), 40), tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12 } },
            h('colgroup', null, h('col', { style: { width: 40 } }), ...visible.map(({ i }) => h('col', { key: i, style: { width: widthOf(i) } }))),
            h('thead', null, h('tr', null, h('th', { style: { width: 40, position: 'sticky', top: 0, left: 0, zIndex: 4, background: 'var(--dsw-alias-bg-base, Canvas)', borderBottom: '1px solid var(--dsw-alias-border-l1)', textAlign: 'right', padding: '6px 8px', color: 'var(--dsw-alias-label-secondary, inherit)', fontWeight: 500 } }, '#'), ...headers)),
            h('tbody', null, ...bodyRows))),
        h('div', { 'data-xc-table-pager': true, style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))', color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 12 } },
          leading
            ? h('span', { style: { flex: '1 1 auto' } })
            : h('span', { style: { marginRight: 'auto' } }, [
              pageCount > 1 ? `第 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} 条 / 共 ${total.toLocaleString()} 条` : `${total.toLocaleString()} 条`,
              tableKey === 'result' && data.truncated ? `已截断（保留 ${(data.materialized_rows ?? total).toLocaleString()} 行）` : null,
            ].filter(Boolean).join(' · ')),
          pageCount > 1
            ? h('input', {
              type: 'number', min: 1, max: pageCount, defaultValue: page, 'aria-label': '跳转页码', 'data-xc-table-goto': tableKey,
              style: { ...S.btn, width: '54px', height: '22px', textAlign: 'center' },
              onKeyDown: event => {
                if (event.key !== 'Enter') return
                const next = Number(event.currentTarget.value)
                if (Number.isInteger(next) && next >= 1 && next <= pageCount) onPage?.(next)
              },
            })
            : null,
          pageCount > 1 ? h('button', { type: 'button', style: S.btn, disabled: busy || page <= 1, onClick: () => onPage?.(page - 1) }, '上一页') : null,
          pageCount > 1 ? h('button', { type: 'button', style: S.btn, disabled: busy || page >= pageCount, onClick: () => onPage?.(page + 1) }, '下一页') : null))

      const menuData = rows
      const cellRow = cellMenu ? menuData[cellMenu.row] || [] : []
      const cellValue = cellMenu ? cellRow[cellMenu.col] : undefined
      const cellName = cellMenu ? columnName(cellMenu.col) : ''
      const copyText = async text => {
        try { await navigator.clipboard.writeText(text); setCopiedTip('已复制') } catch { setCopiedTip('复制失败') }
        setTimeout(() => setCopiedTip(''), 1500)
        setCellMenu(null)
      }
      const menuItem = (label, onClick, dataAttr) => h('button', {
        key: label, type: 'button', ...dataAttr,
        style: { ...S.btn, justifyContent: 'flex-start', height: '28px', fontWeight: 'normal', fontSize: '12px' }, onClick,
      }, label)

      const overlay = fullscreen ? h('div', {
        'data-xc-table-fullscreen-overlay': tableKey,
        style: { position: 'fixed', inset: 0, zIndex: 1300, background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', display: 'flex', flexDirection: 'column', padding: '8px' },
      },
      h('div', { style: { flex: '1 1 0%', minHeight: 0, display: 'flex', minWidth: 0 } }, pane)) : null

      return h('div', { style: { flex: '1 1 0%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' } },
        fullscreen ? null : pane,
        cellMenu ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 1400 }, onClick: () => setCellMenu(null) },
          h('div', {
            onContextMenu: event => event.preventDefault(),
            onClick: event => event.stopPropagation(),
            style: {
              position: 'fixed', left: `${Math.min(cellMenu.x, (window.innerWidth || 1200) - 200)}px`, top: `${Math.min(cellMenu.y, (window.innerHeight || 800) - 180)}px`,
              minWidth: '180px', background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))', color: 'inherit',
              border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))', borderRadius: RADIUS.sm,
              boxShadow: 'var(--dsw-elevation-panel, 0 10px 30px rgba(0,0,0,.28))', padding: '4px', display: 'flex', flexDirection: 'column', gap: '2px',
            },
          },
          menuItem('复制值', () => { copyText(String(cellValue ?? '')) }, { 'data-xc-cell-menu-copy-value': true }),
          menuItem('复制整行', () => { copyText([columns.map((_, i) => columnName(i)).join('\t'), cellRow.map(value => String(value ?? '')).join('\t')].join('\n')) }, { 'data-xc-cell-menu-copy-row': true }),
          menuItem('查看完整值', () => { setCellDetail({ title: cellName || '单元格', value: String(cellValue ?? '') }); setCellMenu(null) }, { 'data-xc-cell-menu-view': true }),
          typeof onFilterValue === 'function'
            ? menuItem('按此值筛选', () => { onFilterValue(cellName, cellValue); setCellMenu(null) }, { 'data-xc-cell-menu-filter': true })
            : null)) : null,
        cellDetail ? h(Dialog, { title: '完整值 · ' + cellDetail.title, onClose: () => setCellDetail(null), closeLabel: '关闭' },
          h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '55vh', overflow: 'auto', font: 'inherit', lineHeight: 1.6 } }, cellDetail.value)) : null,
        overlay)
    }

// ── 09-data-sources.js ─────────────────────────────────────────────────────────
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

// ── 09b-tool-view.js ─────────────────────────────────────────────────────────
    // ── Conversation tool card: the chart where the user is looking ─────────
    //
    // The agent creates cards through `canvas_add_card` / `canvas_update_card`,
    // and until now the only place to see one was the canvas panel — the
    // conversation showed a generic tool row with the raw arguments. The host
    // dispatches every wire tool name through the keyed `tool.call.toolview`
    // slot, so this registers a real card view for our own two tool names.
    //
    // The chart comes from the CALL ARGUMENTS (`block.argsRaw`), not from the
    // draft API: the model passes the complete ECharts option, while the draft
    // projection deliberately trims series to 8 points for the panel's sample
    // preview (`lib/store.js` `publicDraft`). Rendering the arguments means full
    // fidelity with no extra request per card — and never a misleading sample.
    //
    // The view is read-only and expanded: it is a look at the result, not a
    // second place to edit it. Confirming still happens in the canvas panel.

    /** Wire tool names that render as a card in the conversation. */
    const TOOL_CARD_NAMES = ['canvas_add_card', 'canvas_update_card', 'canvas_add_result']

    /**
     * `canvas_add_result` carries no option: the card is built on the host from the
     * result snapshot and written straight into the canvas (no draft). So that call
     * fetches the saved card instead — full fidelity again, and it proves the write
     * really landed rather than showing a preview of one.
     */
    const TOOL_CARD_FETCHES = ['canvas_add_result']

    /** The card fields our tools take as arguments. */
    const TOOL_CARD_FIELDS = ['type', 'title', 'chart_type', 'echarts_option', 'table_data',
      'presentation_spec', 'text_content', 'code_content', 'color']

    /** An update call sends only the changed fields, so the type is inferred. */
    function inferCardType (args) {
      if (args.echarts_option) return 'chart'
      if (args.table_data) return 'table'
      if (args.presentation_spec) return 'kpi'
      if (args.code_content) return 'code'
      if (args.text_content) return 'text'
      return null
    }

    /** The dispatched arguments as a card spec; a partial or malformed prefix yields null. */
    function toolCardArgs (block) {
      const raw = typeof block?.argsRaw === 'string'
        ? block.argsRaw
        : (typeof block?.call?.argsRaw === 'string' ? block.call.argsRaw : '')
      if (!raw.trim()) return null
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return null
        const card = {}
        for (const field of TOOL_CARD_FIELDS) {
          if (parsed[field] !== undefined) card[field] = parsed[field]
        }
        const type = card.type || inferCardType(card)
        return type ? { ...card, type } : null
      } catch { return null }
    }

    /** The settled result, parsed as JSON when it is one (our tools answer with JSON). */
    function toolCardResult (block) {
      if (!block || block.kind !== 'tool-result') return null
      const text = (Array.isArray(block.content) ? block.content : [])
        .map(part => (part && typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim()
      if (!text) return {}
      try {
        const parsed = JSON.parse(text)
        return parsed && typeof parsed === 'object' ? parsed : { message: text }
      } catch { return { message: text } }
    }

    // One line of status, in the user's words. A pending card is not an error and
    // not a success: it is waiting for a decision in the canvas panel.
    const TOOL_CARD_TONES = {
      busy: 'var(--dsw-alias-label-tertiary, inherit)',
      pending: 'var(--dsw-alias-state-warn-label, #e8a33d)',
      error: 'var(--dsw-alias-state-warn-label, #c33)',
      done: 'var(--dsw-alias-label-tertiary, inherit)',
    }

    function toolCardStatus (phase, block, result, written = false) {
      if (phase === 'preparing') return { tone: 'busy', text: '正在准备卡片…' }
      if (phase !== 'result') return { tone: 'busy', text: '正在生成预览…' }
      if (block?.isError) return { tone: 'error', text: '创建失败' }
      if (written) return { tone: 'done', text: '已写入画布' }
      if (result?.status === 'pending_confirmation') return { tone: 'pending', text: '等待在分析画布确认' }
      return { tone: 'done', text: result?.message || '已处理' }
    }

    /** One settled card, when the call wrote it instead of carrying it in its arguments. */
    function useWrittenCard (toolName, phase, block, result) {
      const [card, setCard] = useState(null)
      const [missing, setMissing] = useState(false)
      const canvasId = result?.canvas_id
      const cardId = result?.card_id
      const settled = phase === 'result' && !block?.isError
      const [canvasName, setCanvasName] = useState('')
      const [newer, setNewer] = useState(false)
      const versionId = result?.version_id
      useEffect(() => {
        if (!TOOL_CARD_FETCHES.includes(toolName) || !settled || !canvasId || !cardId) return undefined
        let alive = true
        const request = versionId ? getCardVersion(canvasId, cardId, versionId) : getCanvas(canvasId)
        request.then(payload => {
          if (!alive) return
          const found = versionId ? payload.version?.card : (payload?.canvas?.cards || payload?.cards || []).find(item => item.id === cardId)
          if (found) setCard(found)
          else setMissing(true)
          setCanvasName(payload?.canvas?.name || payload?.name || '')
          setNewer(!!versionId && payload.current_version_id !== versionId)
        }).catch(() => { if (alive) setMissing(true) })
        return () => { alive = false }
      }, [toolName, settled, canvasId, cardId, versionId])
      return { card, missing, canvasName, newer }
    }

    /**
     * The card view itself.
     *
     * Purely presentational: everything it needs arrives in `phase`/`block`, plus
     * one read of the canvas for a call that wrote its card on the host. It never
     * throws on odd input — a tool card that disappears is worse than one that
     * falls back to a line of text.
     */
    function CardToolView ({ phase, block, toolName, t, sessionId, onOpenCanvas, onOpenDatasource, onOpenSession, onAsk }) {
      const holderRef = useRef(null)
      // No canvas context here, so the palette is the default one; the chrome
      // still follows the host tokens, read from our own container because the
      // shell defines --dsw-* on deep wrappers rather than on :root.
      const palette = 'classic'
      const [theme, setTheme] = useState(() => resolveTheme(palette, null))
      useLayoutEffect(() => { setTheme(resolveTheme(palette, holderRef.current)) }, [palette])

      const result = toolCardResult(block)
      const written = useWrittenCard(toolName, phase, block, result)
      // `canvas_add_result` arguments describe the call, not the card: they carry
      // only type/title/x/y, so the saved card read back from the canvas is the
      // only complete spec. Prefer it, and never paint an empty chart box while
      // the read is still in flight.
      const argsCard = toolCardArgs(block)
      const card = (TOOL_CARD_FETCHES.includes(toolName) ? written.card || null : null) || argsCard || written.card
      const complete = !!card && (card.echarts_option || card.table_data || card.presentation_spec || card.text_content || card.code_content)
      const status = toolCardStatus(phase, block, result, !!written.card)
      const type = card?.type || 'chart'
      const title = card?.title || result?.title || '未命名卡片'
      const tall = complete && (type === 'chart' || type === 'table')
      const pending = phase === 'result' && result?.status === 'pending_confirmation'
      const [actionError, setActionError] = useState('')
      const [traceOpen, setTraceOpen] = useState(false)
      let callArgs = {}
      try { callArgs = JSON.parse(block?.argsRaw || block?.call?.argsRaw || '{}') } catch { /* streaming prefix */ }
      const canvasId = result?.canvas_id || callArgs.canvas_id
      const cardId = result?.card_id || callArgs.card_id
      const sourceId = written.card?.binding?.source_id
      const act = action => () => { setActionError(''); Promise.resolve().then(action).catch(error => setActionError(error.message)) }
      const ask = () => onAsk({ canvas_id: canvasId, card_id: cardId, version_id: result?.version_id || written.card?.data_version_id, title }, sessionId)

      return h('div', {
        ref: holderRef,
        'data-xc-tool-card': true,
        'data-xc-tool-phase': phase,
        'data-xc-tool-status': status.tone,
        style: {
          display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0,
          padding: '8px 10px',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: RADIUS.md,
          background: SURFACE.card,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
        h(EllipsisText, { text: title, style: { fontSize: FS, fontWeight: 500, flex: '0 1 auto' } }),
        card ? h('span', { style: { ...S.mutedSmall, flex: '0 0 auto' } }, t(`card.${type}`)) : null,
        h('span', { style: { flex: '1 1 auto', minWidth: '4px' } }),
        h('span', {
          'data-xc-tool-status-text': status.tone,
          style: { ...S.mutedSmall, flex: '0 0 auto', color: TOOL_CARD_TONES[status.tone] },
        }, status.text)),
      // The chart first: it is the reason this card exists. 300px is the smallest
      // height at which a two-axis chart keeps readable labels.
      complete ? h('div', { style: tall ? { height: '300px', minWidth: 0 } : { minWidth: 0 } },
        h(CardBody, { card, t, theme })) : null,
      block?.isError
        ? h('div', { style: S.errorBox }, block.error?.reason || block.error?.code || '卡片创建失败。')
        : null,
      !complete && !block?.isError && phase === 'result'
        ? h('div', { 'data-xc-tool-body-missing': true, style: S.mutedSmall },
          written.missing
            ? (result?.message || '卡片已写入画布，但没能读回它的配置。')
            : (TOOL_CARD_FETCHES.includes(toolName) && !written.card ? '正在读取已写入的卡片…' : (result?.message || '这条调用没有可预览的卡片。')))
        : null,
      canvasId && onOpenCanvas ? h('div', { 'data-xc-tool-actions': true, style: { ...S.row, flexWrap: 'wrap', minWidth: 0 } },
        h(EllipsisText, { text: written.canvasName || '分析画布', style: { ...S.mutedSmall, flex: '1 1 100px' } }),
        written.newer ? h('span', { style: S.mutedSmall }, '有更新') : null,
        h('button', { type: 'button', style: S.btn, onClick: act(() => onOpenCanvas(canvasId, cardId, result?.version_id)) }, pending ? '打开预览' : '打开画布'),
        sourceId && onOpenDatasource ? h('button', { type: 'button', style: S.btn, onClick: act(() => onOpenDatasource(sourceId)) }, '数据源') : null,
        cardId ? h('button', { type: 'button', style: S.btn, onClick: () => setTraceOpen(true) }, '溯源') : null,
        cardId && onAsk && !pending ? h('button', { type: 'button', style: S.btn, onClick: act(ask) }, '追问') : null) : null,
      actionError ? h('div', { role: 'alert', style: S.errorBox }, actionError) : null,
      traceOpen ? h(TraceDialog, { canvasId, cardId, versionId: result?.version_id, t,
        onClose: () => setTraceOpen(false), onOpenCanvas, onOpenDatasource, onOpenSession,
        onAsk: onAsk ? input => onAsk(input, sessionId).then(() => setTraceOpen(false)) : undefined }) : null,
      written.card ? h('span', { 'data-xc-tool-written': 'true', style: { display: 'none' } }, '已保存') : null)
    }

// ── 09c-database-ui.js ─────────────────────────────────────────────────────────
    // ── 新增数据源：文件拖拽 / 数据库连接 ────────────────────────────────────
    //
    // The old "导入 CSV / XLSX" button only opened a file picker. This dialog
    // keeps file import one click away (drop or browse) and adds database
    // connections: metadata only, the password is written once and never read
    // back. The agent never creates or sees a connection secret.
    const DS_TEXT = {
      'ds.addSource': '新增数据源', 'ds.sourceFile': '文件', 'ds.sourceDatabase': '数据库',
      'ds.dropHere': '拖拽文件到此处，或点击选择', 'ds.fileTypes': '支持 CSV / TSV / XLSX / Parquet', 'ds.importing': '正在导入…',
      'ds.tables': '张表', 'ds.showSchema': '表结构', 'ds.hideSchema': '收起结构',
      'ds.dbType': '类型', 'ds.dbName': '名称', 'ds.dbHost': '主机', 'ds.dbPort': '端口', 'ds.dbDatabase': '数据库', 'ds.dbUser': '用户',
      'ds.dbPassword': '密码', 'ds.dbSsl': '使用 SSL', 'ds.dbTest': '测试连接', 'ds.dbTesting': '连接中…', 'ds.dbConnected': '连接成功',
      'ds.dbSave': '保存连接', 'ds.dbNote': '密码只保存在本机加密凭据里：不会出现在界面、备份、导出文件、日志或 AI 上下文中。', 'ds.dbNeedsSecret': '这份连接来自备份，需要重新填写密码。',
      'ds.dbSecretSave': '保存密码', 'ds.dbSql': 'SQL', 'ds.dbRun': '执行', 'ds.dbRunning': '执行中…', 'ds.dbReadOnly': '只读 · 最多 5,000 行 · 15 秒超时 · 按 Ctrl+Enter 执行',
    }
    const dsT = key => DS_TEXT[key] || key

    // 两个页签的内容区同高，切换时不跳动；输入框必须可见（有底色与边框）。
    const SOURCE_PANEL_HEIGHT = '248px'
    const DB_INPUT = {
      width: '100%', boxSizing: 'border-box', height: '30px', padding: '0 8px',
      background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit',
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
      borderRadius: RADIUS.sm, fontSize: '12px', fontWeight: 'normal', outline: 'none',
    }

    function readFileBase64 (file, done, fail) {
      const reader = new FileReader()
      reader.onload = () => done(String(reader.result).split(',')[1] || '')
      reader.onerror = () => fail?.(new Error('文件读取失败'))
      reader.readAsDataURL(file)
    }

    function AddSourceDialog ({ t, onClose, onSaved, onToast }) {
      const [tab, setTab] = useState('file')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [dragging, setDragging] = useState(false)
      const [failedFile, setFailedFile] = useState(null)
      const [optionsOpen, setOptionsOpen] = useState(false)
      const [options, setOptions] = useState({ encoding: 'auto', delimiter: 'auto', header_row: '' })
      const inputRef = useRef(null)
      const importFile = (file, overrides = null) => {
        if (!file) return
        setBusy(true); setError('')
        const opts = overrides || options
        const parsed = {}
        if (opts.encoding && opts.encoding !== 'auto') parsed.encoding = opts.encoding
        if (opts.delimiter && opts.delimiter !== 'auto') parsed.delimiter = opts.delimiter
        if (opts.header_row && Number(opts.header_row) > 0) parsed.header_row = Number(opts.header_row)
        readFileBase64(file, async base64 => {
          try {
            await importDatasource({
              name: file.name.replace(/\.[^.]+$/, ''), filename: file.name, content_base64: base64,
              ...(Object.keys(parsed).length ? { options: parsed } : {}),
              source: { type: 'browser_upload', filename: file.name },
            })
            setFailedFile(null)
            onSaved?.()
          } catch (importError) {
            setError(importError.message)
            setFailedFile(file)
            setOptionsOpen(true)
            onToast?.('导入失败：' + importError.message, 'alert')
          } finally { setBusy(false) }
        }, loadError => { setBusy(false); setError(loadError.message) })
      }
      const drop = event => {
        event.preventDefault(); setDragging(false)
        importFile(event.dataTransfer?.files?.[0])
      }
      const tabButton = (value, label) => h('button', {
        key: value, type: 'button', role: 'tab', 'aria-selected': tab === value ? 'true' : 'false', 'data-xc-source-tab': value,
        style: { ...S.btn, height: '30px', fontWeight: tab === value ? 500 : 'normal', ...(tab === value ? { background: 'color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)' } : null) },
        onClick: () => { setTab(value); setError('') },
      }, label)
      return h(Dialog, { title: t('ds.addSource'), onClose, closeLabel: '关闭', width: 'min(600px, 92vw)' },
        h('div', { role: 'tablist', 'aria-label': t('ds.addSource'), style: { display: 'flex', gap: '6px', paddingBottom: '10px' } },
          tabButton('file', t('ds.sourceFile')), tabButton('database', t('ds.sourceDatabase'))),
        tab === 'file'
          ? h('div', {
            'data-xc-dropzone': true,
            style: {
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px',
              height: SOURCE_PANEL_HEIGHT, padding: '16px', boxSizing: 'border-box', textAlign: 'center',
              border: `1px dashed ${dragging ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.45))'}`,
              borderRadius: RADIUS.md, cursor: busy ? 'default' : 'pointer',
              background: dragging ? 'color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)' : 'transparent',
            },
            onDragOver: event => { event.preventDefault(); setDragging(true) },
            onDragLeave: () => setDragging(false),
            onDrop: drop,
            onClick: () => { if (!busy) inputRef.current?.click?.() },
          },
          h('strong', null, busy ? t('ds.importing') : t('ds.dropHere')),
          h('span', { style: S.mutedSmall }, t('ds.fileTypes')),
          h('input', {
            type: 'file', ref: inputRef, accept: '.csv,.tsv,.xlsx,.parquet', 'data-xc-import-input': 'true',
            style: { display: 'none' },
            onChange: event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; importFile(file) },
          }))
          : h(DatabaseForm, { t, onSaved, onCancel: onClose }),
        // 导入失败时可调整解析设置后重试，不必重新选文件；错误本身走浮动消息。
        failedFile
          ? h('div', { 'data-xc-import-retry': true, style: { display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '6px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { style: S.mutedSmall }, `「${failedFile.name}」可调整导入设置后重试`),
              h('button', { type: 'button', style: S.btn, 'data-xc-import-options-toggle': true, onClick: () => setOptionsOpen(open => !open) }, optionsOpen ? '收起设置' : '导入设置'),
              h('button', { type: 'button', style: S.btnPrimary, 'data-xc-import-retry-run': true, disabled: busy, onClick: () => importFile(failedFile) }, '重新导入')),
            optionsOpen
              ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px 10px' } },
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } },
                  h('span', { style: S.mutedSmall }, '编码'),
                  h(Select, {
                    value: options.encoding, ariaLabel: '编码',
                    options: [{ value: 'auto', label: '自动' }, { value: 'utf-8', label: 'UTF-8' }, { value: 'gb18030', label: 'GB18030' }, { value: 'windows-1252', label: 'Windows-1252' }],
                    onChange: value => setOptions(current => ({ ...current, encoding: value })),
                  })),
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } },
                  h('span', { style: S.mutedSmall }, '分隔符'),
                  h(Select, {
                    value: options.delimiter, ariaLabel: '分隔符',
                    options: [{ value: 'auto', label: '自动' }, { value: ',', label: '逗号' }, { value: ';', label: '分号' }, { value: '\t', label: '制表符' }, { value: '|', label: '竖线' }],
                    onChange: value => setOptions(current => ({ ...current, delimiter: value })),
                  })),
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } },
                  h('span', { style: S.mutedSmall }, '表头行'),
                  h('input', {
                    type: 'number', min: 1, max: 100, value: options.header_row, placeholder: '自动', 'aria-label': '表头行',
                    'data-xc-import-header': true, style: DB_INPUT,
                    onChange: event => setOptions(current => ({ ...current, header_row: event.target.value })),
                  })))
              : null)
          : null)
    }

    function DatabaseForm ({ t, onSaved, onCancel }) {
      const [form, setForm] = useState({ format: 'mysql', host: '127.0.0.1', port: 3306, database: '', user: '', password: '', ssl: false, name: '' })
      const [checking, setChecking] = useState(false)
      const [checked, setChecked] = useState(null)
      const [error, setError] = useState('')
      const patch = (key, value) => setForm(current => ({ ...current, [key]: value, ...(key === 'format' ? { port: value === 'postgres' ? 5432 : 3306 } : {}) }))
      const payload = () => ({ ...form, name: form.name.trim() || `${form.database || 'database'}@${form.host}` })
      const test = async () => {
        setChecking(true); setError(''); setChecked(null)
        try { setChecked(await testDatabaseConnection(payload())) } catch (checkError) { setError(checkError.message) } finally { setChecking(false) }
      }
      const save = async () => {
        setChecking(true); setError('')
        try {
          const created = await createDatabaseSource(payload())
          onSaved?.(created.datasource)
        } catch (saveError) { setError(saveError.message) } finally { setChecking(false) }
      }
      const field = (label, key, props = {}) => h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', minWidth: 0 } },
        h('span', { style: S.mutedSmall }, label),
        h('input', {
          'aria-label': label, 'data-xc-db-field': key, value: form[key], disabled: checking,
          style: DB_INPUT, onChange: event => patch(key, event.target.value), ...props,
        }))
      const engineOptions = [{ value: 'mysql', label: 'MySQL' }, { value: 'postgres', label: 'PostgreSQL' }]
      return h('div', { 'data-xc-db-form': true, style: { display: 'flex', flexDirection: 'column', gap: '10px', height: SOURCE_PANEL_HEIGHT, boxSizing: 'border-box' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 12px', alignContent: 'start' } },
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', minWidth: 0 } },
            h('span', { style: S.mutedSmall }, t('ds.dbType')),
            h(Select, { value: form.format, options: engineOptions, ariaLabel: t('ds.dbType'), dataAttrs: { 'data-xc-db-field': 'format' }, onChange: value => patch('format', value) })),
          field(t('ds.dbName'), 'name', { placeholder: '展示名称（可空）' }),
          field(t('ds.dbHost'), 'host'),
          field(t('ds.dbPort'), 'port', { type: 'number', min: 1, max: 65535 }),
          field(t('ds.dbDatabase'), 'database'),
          field(t('ds.dbUser'), 'user', { autoComplete: 'off' }),
          field(t('ds.dbPassword'), 'password', { type: 'password', autoComplete: 'new-password' }),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', paddingTop: '18px' } },
            h('input', { type: 'checkbox', checked: form.ssl, 'data-xc-db-field': 'ssl', onChange: event => patch('ssl', event.target.checked) }), t('ds.dbSsl'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: 'auto' } },
          h('button', { type: 'button', style: S.btn, 'data-xc-db-test': true, disabled: checking, onClick: () => { test() } }, checking ? t('ds.dbTesting') : t('ds.dbTest')),
          checked ? h('span', { 'data-xc-db-test-result': 'ok', style: S.mutedSmall }, `${t('ds.dbConnected')} · ${checked.server_version || ''} · ${checked.latency_ms} 毫秒`) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { type: 'button', style: S.btn, disabled: checking, onClick: onCancel }, t('settings.cancel')),
          h('button', { type: 'button', style: S.btnPrimary, 'data-xc-db-save': true, disabled: checking, onClick: () => { save() } }, t('ds.dbSave'))),
        h('div', { style: { ...S.mutedSmall, lineHeight: 1.5 } }, t('ds.dbNote')),
        error ? h(StatusLine, { tone: 'alert' }, error) : null)
    }

    /** 常用 SQL：按数据源保存在本机，收藏当前语句、点选填回、可删除。 */
    const snippetsKey = id => `xcharts.sql.snippets.${id}`
    function loadSnippets (id) {
      try {
        const raw = window.localStorage.getItem(snippetsKey(id))
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list.filter(item => item && typeof item.sql === 'string').slice(0, 10) : []
      } catch { return [] }
    }
    function persistSnippets (id, list) {
      try { window.localStorage.setItem(snippetsKey(id), JSON.stringify(list)) } catch { /* 隐私模式等：保留内存态 */ }
    }
    // 最近执行（自动记录）与最近使用的表（置顶），都按数据源存在本机。
    const historyKey = id => 'xcharts.sql.history.' + id
    function loadHistory (id) {
      try { const raw = window.localStorage.getItem(historyKey(id)); const list = raw ? JSON.parse(raw) : []; return Array.isArray(list) ? list.filter(item => typeof item === 'string').slice(0, 20) : [] } catch { return [] }
    }
    function persistHistory (id, list) {
      try { window.localStorage.setItem(historyKey(id), JSON.stringify(list.slice(0, 20))) } catch { /* ignore */ }
    }
    const recentTablesKey = id => 'xcharts.tables.recent.' + id
    function loadRecentTables (id) {
      try { const raw = window.localStorage.getItem(recentTablesKey(id)); const list = raw ? JSON.parse(raw) : []; return Array.isArray(list) ? list.filter(item => typeof item === 'string').slice(0, 8) : [] } catch { return [] }
    }
    function persistRecentTables (id, list) {
      try { window.localStorage.setItem(recentTablesKey(id), JSON.stringify(list.slice(0, 8))) } catch { /* ignore */ }
    }

    /** Detail pane of a database source: connection badge, schema rail, SQL, saved SQL. */
    function DatabasePane ({ t, detail, busy, hasResult = false, onRun, onCancel, onTest, onSecretSaved }) {
      const [sql, setSql] = useState('')
      const [schemaOpen, setSchemaOpen] = useState(true)
      const [schemaQuery, setSchemaQuery] = useState('')
      const [snippetsOpen, setSnippetsOpen] = useState(false)
      const sqlRef = useRef(null)
      const [hoverTable, setHoverTable] = useState('')
      const [expandedTable, setExpandedTable] = useState('')
      const [tableMenu, setTableMenu] = useState(null)
      const [schemaDialog, setSchemaDialog] = useState(null)
      const [schemaCopied, setSchemaCopied] = useState(false)
      const [schemaTab, setSchemaTab] = useState('fields')
      const [schemaFieldQuery, setSchemaFieldQuery] = useState('')
      const [joinDialog, setJoinDialog] = useState(null)
      const [password, setPassword] = useState('')
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [snippets, setSnippets] = useState(() => loadSnippets(detail.id))
      const [history, setHistory] = useState(() => loadHistory(detail.id))
      const [recentTables, setRecentTables] = useState(() => loadRecentTables(detail.id))
      const tables = detail.catalog?.tables || []
      const rank = name => { const index = recentTables.indexOf(name); return index < 0 ? 999 : index }
      // 搜索同时匹配表名与字段名；字段命中时在表名下标注，点击仍是看结构。
      const schemaTerm = schemaQuery.trim().toLowerCase()
      const matchedField = table => {
        if (schemaTerm.length < 2) return ''
        const hit = (table.columns || []).find(column => String(column.name).toLowerCase().includes(schemaTerm))
        return hit ? hit.name : ''
      }
      const filteredTables = tables
        .filter(table => !schemaTerm || (table.schema + '.' + table.name).toLowerCase().includes(schemaTerm) || Boolean(matchedField(table)))
        .slice()
        .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
      const tableTitle = table => table.schema + '.' + table.name + '\n' +
        table.columns.slice(0, 8).map(column => column.name + '（' + column.type + '）').join('\n') +
        (table.columns.length > 8 ? '\n…共 ' + table.columns.length + ' 列' : '')
      const rememberRun = text => {
        text = String(text || sql).trim()
        if (!text) return
        const next = [text, ...history.filter(item => item !== text)].slice(0, 20)
        setHistory(next); persistHistory(detail.id, next)
      }
      const selectedSql = () => {
        const el = sqlRef.current
        if (!el) return ''
        const start = el.selectionStart ?? 0
        const end = el.selectionEnd ?? 0
        return sql.slice(start, end).trim()
      }
      const run = () => {
        const text = selectedSql() || sql
        rememberRun(text)
        onRun?.(text)
      }
      const formatSql = text => {
        let out = String(text || '').replace(/\s+/g, ' ').trim()
        out = out.replace(/\b(select|from|where|group by|order by|having|limit|left join|inner join|join|union|distinct|as|and|or|count|sum|avg|min|max)\b/gi, word => word.toUpperCase())
        out = out.replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|UNION|LEFT JOIN|INNER JOIN|JOIN)\b/g, '\n$1')
        return out
      }
      // 单击与双击互斥：单击延迟 220ms 展开字段，双击先取消它再执行查询，
      // 避免"先展开、行高变化、第二次点击落空"的失败体验。
      const tableClickTimer = useRef(null)
      const onTableClick = table => {
        if (typeof setTimeout !== 'function') {
          setExpandedTable(current => current === table.name ? '' : table.name)
          return
        }
        if (tableClickTimer.current) clearTimeout(tableClickTimer.current)
        tableClickTimer.current = setTimeout(() => {
          tableClickTimer.current = null
          setExpandedTable(current => current === table.name ? '' : table.name)
        }, 220)
      }
      const onTableDouble = table => {
        if (tableClickTimer.current) { clearTimeout(tableClickTimer.current); tableClickTimer.current = null }
        selectStar(table)
        onRun?.('SELECT * FROM ' + table.name + ' LIMIT 100')
      }
      // 表名交互：SQL 里出现过的表即“已选”，多表时可生成联表草稿。
      const sqlTableNames = tables
        .filter(table => new RegExp('\\b' + table.name + '\\b').test(sql))
        .map(table => table.name)
      const selectStar = table => setSql('SELECT * FROM ' + table.name + ' LIMIT 100')
      const columnsOf = name => (tables.find(table => table.name === name)?.columns || []).map(column => column.name)
      const commonFields = (a, b) => columnsOf(a).filter(name => columnsOf(b).includes(name))
      const openJoinDialog = () => {
        const [first, second] = sqlTableNames.slice(0, 2)
        if (!first || !second) return
        setJoinDialog({ main: first, other: second, type: 'JOIN', field: commonFields(first, second)[0] || '' })
      }
      const joinSqlPreview = dialog => {
        if (!dialog) return ''
        const field = dialog.field || '字段'
        return 'SELECT *\nFROM ' + dialog.main + ' a\n' + dialog.type + ' ' + dialog.other + ' b ON a.' + field + ' = b.' + field + '\nLIMIT 100'
      }
      const quoteIdent = name => detail.format === 'mysql' ? '`' + name + '`' : '"' + name + '"'
      const createTableSql = table => 'CREATE TABLE ' + quoteIdent(table.schema) + '.' + quoteIdent(table.name) + ' (\n' +
        table.columns.map(column => '  ' + quoteIdent(column.name) + ' ' + column.type).join(',\n') + '\n);'
      const copySchema = async table => {
        try {
          await navigator.clipboard.writeText(createTableSql(table))
          setSchemaCopied(true)
          if (typeof setTimeout === 'function') setTimeout(() => setSchemaCopied(false), 1500)
        } catch { /* 剪贴板不可用时保持原文可选 */ }
      }
      useEffect(() => {
        if (!detail.needs_secret) setSql(current => current || (tables[0] ? `SELECT * FROM ${tables[0].name} LIMIT 100` : 'SELECT 1'))
      }, [detail.id])
      useEffect(() => { setSnippets(loadSnippets(detail.id)); setHistory(loadHistory(detail.id)); setRecentTables(loadRecentTables(detail.id)) }, [detail.id])
      const saveSnippet = () => {
        const text = sql.trim()
        if (!text) return
        const next = [{ id: Date.now().toString(36), sql: text }, ...snippets.filter(item => item.sql !== text)].slice(0, 10)
        setSnippets(next); persistSnippets(detail.id, next)
      }
      const removeSnippet = id => {
        const next = snippets.filter(item => item.id !== id)
        setSnippets(next); persistSnippets(detail.id, next)
      }
      const connectionLine = `${String(detail.format || '').toUpperCase()} · ${detail.connection?.host}:${detail.connection?.port} · ${detail.connection?.database} · ${detail.connection?.user}`
      const saveSecret = async () => {
        setSaving(true); setError('')
        try { await updateDatabaseSecret(detail.id, password); setPassword(''); onSecretSaved?.() } catch (saveError) { setError(saveError.message) } finally { setSaving(false) }
      }
      const runButton = h('button', { type: 'button', style: S.btnPrimary, 'data-xc-db-run': true, disabled: busy || !sql.trim(), onClick: () => run() }, busy ? t('ds.dbRunning') : t('ds.dbRun'))
      return h('div', { 'data-xc-db-pane': detail.id, style: { flex: hasResult ? '0 0 auto' : '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 } },
          h('span', {
            'data-xc-db-badge': detail.needs_secret ? 'needs_secret' : 'ready',
            style: {
              display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 8px', borderRadius: '999px',
              background: 'color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)', ...S.mutedSmall, minWidth: 0,
            },
          },
          h('span', { 'aria-hidden': true, style: { width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto', background: detail.needs_secret ? 'var(--dsw-alias-state-warn-primary, #e8a33d)' : 'var(--dsw-alias-state-success-primary, #2f9e6e)' } }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, connectionLine)),
          h('span', { style: S.mutedSmall }, `${tables.length} ${t('ds.tables')}`),
          h('span', { style: { flex: '1 1 auto' } }),
          typeof onTest === 'function'
            ? h(IconButton, { title: '测试连接', onClick: () => onTest(), buttonProps: { 'data-xc-db-test-saved': true, disabled: busy } }, h(ToolIcon, { name: 'refresh' }))
            : null,
          h(IconButton, { title: schemaOpen ? '收起表结构' : '展开表结构', onClick: () => setSchemaOpen(open => !open), buttonProps: { 'data-xc-db-schema-toggle': true, 'aria-expanded': schemaOpen ? 'true' : 'false' } }, h(ToolIcon, { name: 'panel' }))),
        detail.needs_secret
          ? h('div', { 'data-xc-db-secret': true, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: S.mutedSmall }, t('ds.dbNeedsSecret')),
            h('div', { style: { display: 'flex', gap: '8px' } },
              h('input', { type: 'password', autoComplete: 'new-password', 'aria-label': t('ds.dbPassword'), 'data-xc-db-secret-input': true, value: password, style: DB_INPUT, onChange: event => setPassword(event.target.value) }),
              h('button', { type: 'button', style: S.btnPrimary, 'data-xc-db-secret-save': true, disabled: saving, onClick: () => { saveSecret() } }, t('ds.dbSecretSave'))),
            error ? h(StatusLine, { tone: 'alert' }, error) : null)
          : h('div', { style: { display: 'flex', gap: '8px', flex: '1 1 auto', minHeight: 0 } },
            schemaOpen && tables.length
              ? h('div', { 'data-xc-db-schema': true, style: { flex: '0 0 200px', minWidth: 0, height: '240px', display: 'flex', flexDirection: 'column', gap: '4px', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))', borderRadius: RADIUS.sm, padding: '6px' } },
                h('input', {
                  type: 'search', placeholder: '搜索表', value: schemaQuery, 'aria-label': '搜索表', 'data-xc-db-schema-search': true,
                  style: { ...DB_INPUT, height: '26px', flex: '0 0 auto' }, onChange: event => setSchemaQuery(event.target.value),
                }),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'auto', flex: '1 1 auto', minHeight: 0 } },
                  ...filteredTables.map(table => h('div', { key: table.schema + '.' + table.name, style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
                    h('button', {
                      type: 'button',
                      'data-xc-db-table': table.name, title: tableTitle(table),
                      onMouseEnter: () => setHoverTable(table.name), onMouseLeave: () => setHoverTable(''),
                      onClick: () => onTableClick(table),
                      onDoubleClick: () => onTableDouble(table),
                      onContextMenu: event => { event.preventDefault(); setTableMenu({ x: event.clientX, y: event.clientY, table }) },
                      style: {
                        ...S.btn, justifyContent: 'space-between', height: '24px', fontWeight: 'normal', fontSize: '12px', minWidth: 0,
                        color: 'var(--dsw-alias-label-primary)',
                        background: hoverTable === table.name ? 'color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)' : 'transparent',
                        border: 0,
                      },
                    }, h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: '1px' } }, h('span', { style: { ...UI.ellipsis, maxWidth: '140px' } }, table.name), matchedField(table) ? h('span', { style: { ...S.mutedSmall, fontSize: '11px', ...UI.ellipsis, maxWidth: '140px' } }, '匹配字段：' + matchedField(table)) : null),
                      h('span', { style: { ...S.mutedSmall, marginLeft: 'auto', flex: '0 0 auto' } }, String(table.columns.length))),
                    expandedTable === table.name
                      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px', padding: '2px 6px 6px 14px' } },
                        ...table.columns.slice(0, 40).map(column => h('span', { key: column.name, style: { ...S.mutedSmall, fontSize: '11px', lineHeight: 1.5 } }, column.name + ' · ' + column.type)))
                      : null))))
              : null,
            h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('textarea', {
                'aria-label': t('ds.dbSql'), 'data-xc-db-sql': true, ref: sqlRef, value: sql, spellCheck: false, disabled: busy,
                placeholder: 'SELECT * FROM 表名 LIMIT 100',
                style: { ...DB_INPUT, height: '96px', padding: '8px', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'pre', overflow: 'auto', resize: 'vertical' },
                onChange: event => setSql(event.target.value),
                onKeyDown: event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); run() } },
              }),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                runButton,
                h('button', { type: 'button', style: { ...S.btn, height: '24px', fontSize: '12px' }, 'data-xc-sql-format': true, disabled: busy || !sql.trim(), onClick: () => setSql(formatSql(sql)) }, '格式化'),
                busy && typeof onCancel === 'function' ? h('button', { type: 'button', style: S.btn, 'data-xc-db-cancel': true, onClick: () => onCancel() }, '取消') : null,
                h(IconButton, { title: '收藏当前 SQL', onClick: saveSnippet, buttonProps: { 'data-xc-sql-save': true, disabled: busy || !sql.trim() } }, h(ToolIcon, { name: 'check' })),
                h('button', {
                  type: 'button', 'data-xc-sql-snippets-toggle': true, 'aria-expanded': snippetsOpen ? 'true' : 'false',
                  style: { ...S.btn, height: '24px', fontSize: '12px' },
                  onClick: () => setSnippetsOpen(open => !open),
                }, `常用 SQL${snippets.length ? ` · ${snippets.length}` : ''} ▾`),
                h('span', { title: t('ds.dbReadOnly'), style: { ...S.mutedSmall, cursor: 'help' } }, '只读')),
              snippetsOpen
                ? h('div', { 'data-xc-sql-snippets': true, style: { display: 'flex', flexDirection: 'column', gap: '4px', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))', borderRadius: RADIUS.sm, padding: '6px', maxHeight: '180px', overflow: 'auto' } },
                  h('div', { style: { ...S.mutedSmall, padding: '0 2px' } }, '最近执行'),
                  history.length
                    ? history.slice(0, 6).map((text, index) => h('button', {
                      key: 'history-' + index, type: 'button', 'data-xc-sql-history': index, title: text,
                      style: { ...S.btn, justifyContent: 'flex-start', height: '24px', fontWeight: 'normal', fontSize: '12px', minWidth: 0 },
                      onClick: () => { setSql(text); setSnippetsOpen(false) },
                    }, h('span', { style: { ...UI.ellipsis, maxWidth: '100%' } }, text.replace(/\s+/g, ' ').slice(0, 90))))
                    : h('div', { style: S.mutedSmall }, '还没有执行记录'),
                  h('div', { style: { ...S.mutedSmall, padding: '6px 2px 0', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))', marginTop: '2px' } }, '收藏'),
                  snippets.length
                    ? snippets.map(item => h('div', { key: item.id, style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
                      h('button', {
                        type: 'button', 'data-xc-sql-snippet': item.id, title: item.sql,
                        style: { ...S.btn, flex: '1 1 auto', justifyContent: 'flex-start', height: '24px', fontWeight: 'normal', fontSize: '12px', minWidth: 0 },
                        onClick: () => { setSql(item.sql); setSnippetsOpen(false) },
                      }, h('span', { style: { ...UI.ellipsis, maxWidth: '100%' } }, item.sql.replace(/\s+/g, ' ').slice(0, 90))),
                      h('button', { type: 'button', 'data-xc-sql-snippet-remove': item.id, style: { ...S.btn, height: '24px', fontSize: '12px', flex: '0 0 auto' }, onClick: () => removeSnippet(item.id) }, '删除')))
                    : h('div', { style: S.mutedSmall }, '还没有收藏的 SQL：写好后点收藏图标。'))
                : null,
                  error ? h(StatusLine, { tone: 'alert' }, error,
                    h('button', {
                      type: 'button', style: { ...S.btn, height: '22px', fontSize: '12px' }, 'data-xc-error-copy': true,
                      onClick: () => { try { navigator.clipboard.writeText(String(error)) } catch { /* ignore */ } },
                    }, '复制')) : null,
              tableMenu ? h(ContextMenu, {
                x: tableMenu.x, y: tableMenu.y, onClose: () => setTableMenu(null),
                items: [
                  { id: 'view', text: '查看数据', iconName: 'open', data: { 'data-xc-table-menu-view': tableMenu.table.name }, onSelect: () => { setTableMenu(null); selectStar(tableMenu.table); onRun?.('SELECT * FROM ' + tableMenu.table.name + ' LIMIT 100') } },
                  { id: 'schema', text: '查看表结构', iconName: 'layout', data: { 'data-xc-table-menu-schema': tableMenu.table.name }, onSelect: () => { setTableMenu(null); setSchemaTab('fields'); setSchemaFieldQuery(''); setSchemaDialog({ table: tableMenu.table }) } },
                  { id: 'select', text: '生成 SELECT 查询', iconName: 'pencil', data: { 'data-xc-table-menu-select': tableMenu.table.name }, onSelect: () => { setTableMenu(null); selectStar(tableMenu.table) } },
                  sqlTableNames.length >= 2
                    ? { id: 'join', text: '生成 JOIN 查询…', iconName: 'link', data: { 'data-xc-table-menu-join': tableMenu.table.name }, onSelect: () => { setTableMenu(null); openJoinDialog() } }
                    : null,
                ].filter(Boolean),
              }) : null,
                  schemaDialog
                    ? h(Dialog, { title: '表结构 · ' + schemaDialog.table.schema + '.' + schemaDialog.table.name, onClose: () => setSchemaDialog(null), closeLabel: '关闭', width: 'min(560px, 92vw)' },
                      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                        h('div', { role: 'tablist', 'aria-label': '表结构视图', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                          h('button', {
                            type: 'button', role: 'tab', 'aria-selected': schemaTab === 'fields' ? 'true' : 'false', 'data-xc-schema-tab': 'fields',
                            style: { ...S.btn, height: '28px', fontSize: '12px', ...(schemaTab === 'fields' ? { background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)' } : null) },
                            onClick: () => setSchemaTab('fields'),
                          }, '字段 · ' + schemaDialog.table.columns.length),
                          h('button', {
                            type: 'button', role: 'tab', 'aria-selected': schemaTab === 'sql' ? 'true' : 'false', 'data-xc-schema-tab': 'sql',
                            style: { ...S.btn, height: '28px', fontSize: '12px', ...(schemaTab === 'sql' ? { background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)' } : null) },
                            onClick: () => setSchemaTab('sql'),
                          }, 'CREATE TABLE'),
                          h('span', { style: { flex: '1 1 auto' } }),
                          schemaTab === 'sql'
                            ? h('button', { type: 'button', style: S.btn, 'data-xc-schema-copy': true, onClick: () => { copySchema(schemaDialog.table) } }, schemaCopied ? '已复制' : '复制语法')
                            : null),
                        schemaTab === 'fields'
                          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                            h('input', {
                              type: 'search', value: schemaFieldQuery, placeholder: '搜索字段', 'aria-label': '搜索字段', 'data-xc-schema-field-search': true,
                              style: { ...DB_INPUT, height: '26px' }, onChange: event => setSchemaFieldQuery(event.target.value),
                            }),
                            h('div', { style: { maxHeight: '44vh', overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))', borderRadius: RADIUS.sm } },
                            h('table', { style: { width: '100%', fontSize: 12, borderCollapse: 'collapse' } },
                              h('thead', null, h('tr', null,
                                h('th', { style: { position: 'sticky', top: 0, background: 'var(--dsw-alias-bg-base, #fff)', textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, '字段'),
                                h('th', { style: { position: 'sticky', top: 0, background: 'var(--dsw-alias-bg-base, #fff)', textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, '类型'))),
                              h('tbody', null, ...schemaDialog.table.columns.filter(column => !schemaFieldQuery.trim() || column.name.toLowerCase().includes(schemaFieldQuery.trim().toLowerCase())).map(column => h('tr', { key: column.name },
                                h('td', { style: { padding: '3px 8px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 45%, transparent)' } }, column.name),
                                h('td', { style: { padding: '3px 8px', color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 45%, transparent)' } }, column.type)))))))
                          : h('pre', { 'data-xc-create-sql': true, style: { margin: 0, padding: '10px', maxHeight: '48vh', overflow: 'auto', borderRadius: RADIUS.sm, background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, createTableSql(schemaDialog.table)),
                        h('div', { style: S.mutedSmall }, '类型来自 information_schema，不含长度、主键与默认值；CREATE 语法仅作参考。')))
                    : null,
              joinDialog
                ? h(Dialog, { title: '生成联表查询', onClose: () => setJoinDialog(null), closeLabel: '关闭' },
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } },
                      h('span', { style: S.mutedSmall }, '主表'),
                      h(Select, {
                        value: joinDialog.main, ariaLabel: '主表',
                        options: sqlTableNames.map(name => ({ value: name, label: name })),
                        onChange: value => setJoinDialog(current => ({ ...current, main: value })),
                      })),
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } },
                      h('span', { style: S.mutedSmall }, '连接方式'),
                      h(Select, {
                        value: joinDialog.type, ariaLabel: '连接方式',
                        options: [{ value: 'JOIN', label: 'JOIN（内连接）' }, { value: 'LEFT JOIN', label: 'LEFT JOIN（左连接）' }],
                        onChange: value => setJoinDialog(current => ({ ...current, type: value })),
                      })),
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } },
                      h('span', { style: S.mutedSmall }, '连接字段'),
                      commonFields(joinDialog.main, joinDialog.other).length
                        ? h(Select, {
                          value: joinDialog.field, ariaLabel: '连接字段',
                          options: commonFields(joinDialog.main, joinDialog.other).map(name => ({ value: name, label: name })),
                          onChange: value => setJoinDialog(current => ({ ...current, field: value })),
                        })
                        : h('input', {
                          value: joinDialog.field, placeholder: '两表没有同名字段，请手动输入条件字段', style: DB_INPUT,
                          'data-xc-join-field': true, onChange: event => setJoinDialog(current => ({ ...current, field: event.target.value })),
                        })),
                    h('pre', { style: { margin: 0, padding: '8px', borderRadius: RADIUS.sm, background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, joinSqlPreview(joinDialog)),
                    h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
                      h('button', { type: 'button', style: S.btn, onClick: () => setJoinDialog(null) }, '取消'),
                      h('button', {
                        type: 'button', style: S.btnPrimary, 'data-xc-join-generate': true,
                        onClick: () => { setSql(joinSqlPreview(joinDialog)); setJoinDialog(null) },
                      }, '生成草稿'))))
                : null)))
    }

// ── 10-plugin-registration.js ─────────────────────────────────────────────────────────
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

// ── 99-exit.js ─────────────────────────────────────────────────────────
    return module.exports
  },
})
