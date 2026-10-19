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
