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
