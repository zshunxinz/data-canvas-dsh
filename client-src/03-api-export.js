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
