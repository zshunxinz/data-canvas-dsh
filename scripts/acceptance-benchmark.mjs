import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, platform, arch } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CanvasStore } from '../lib/store.js'

// Host storage timings only. These measurements do not measure browser layout,
// chart painting, scroll latency, assistive technology or PNG export.
const report = { sampled_at: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(), scope: 'host-storage-only', iterations: 5, threshold_ms: 1000, samples: [] }
const root = mkdtempSync(join(tmpdir(), 'xc-acceptance-'))
try {
  for (const count of [50, 200, 500]) {
    const store = new CanvasStore(join(root, String(count)))
    const cards = Array.from({ length: count }, (_, i) => ({
      type: 'chart', title: `卡片 ${i + 1}`, dataset: 'synthetic.csv', query: '12个月模拟数据，验收性能样本',
      echarts_option: { xAxis: { data: Array.from({ length: 12 }, (_, j) => j + 1) }, yAxis: {}, series: [{ type: 'bar', data: Array.from({ length: 12 }, (_, j) => i + j) }] },
      layout: { x: (i % 2) * 48, y: Math.floor(i / 2) * 16, w: 48, h: 15 },
    }))
    let canvas = store.createCanvas({ name: `${count}卡存储基准`, cards })
    const timings = {}
    const measure = (name, fn) => {
      const values = []
      for (let i = 0; i < 5; i++) { const start = performance.now(); fn(i); values.push(Math.round((performance.now() - start) * 100) / 100) }
      timings[name] = { values_ms: values, max_ms: Math.max(...values), passes_host_threshold: Math.max(...values) <= 1000 }
    }
    measure('read', () => { canvas = new CanvasStore(store.root).getCanvas(canvas.id) })
    measure('move_and_save', i => { canvas = store.moveCard(canvas.id, canvas.cards[0].id, { ...canvas.cards[0].layout, y: i + 1 }, canvas.revision) })
    measure('undo', () => { canvas = store.undo(canvas.id, canvas.revision).canvas })
    measure('redo', () => { canvas = store.redo(canvas.id, canvas.revision).canvas })
    measure('portable_backup', () => store.exportCanvasBackup(canvas.id))
    report.samples.push({ cards: count, timings, process_rss_bytes: process.memoryUsage().rss })
  }
  console.log(JSON.stringify(report, null, 2))
} finally { rmSync(root, { recursive: true, force: true }) }
