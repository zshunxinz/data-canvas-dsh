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
