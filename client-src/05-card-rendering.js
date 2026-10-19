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
