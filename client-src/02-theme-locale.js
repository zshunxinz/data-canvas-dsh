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
