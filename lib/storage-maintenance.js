import { readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { CanvasError } from './store.js'
import { homedir } from 'node:os'

/** Directories a cleanup may touch, with the sentence a user needs to judge it. */
export const CLEANABLE = {
  history: { label: '撤销历史', hint: '删除所有画布的撤销记录，画布内容不变' },
  executions: { label: '调用证据', hint: '删除工具调用证据，溯源里会显示为未留存' },
  usages: { label: '使用记录', hint: '删除数据源/结果的引用使用记录，使用情况面板会清空' },
  inputs: { label: '版本快照', hint: '删除历史内容快照，带版本号的引用会回退到当前内容' },
}

const SHOWN = ['canvases', 'datasources', 'results', 'history', 'inputs', 'executions', 'followups', 'usages', 'secrets']

function dirStats (root, name) {
  const path = join(root, name)
  try {
    const entries = readdirSync(path)
    let bytes = 0, files = 0
    for (const entry of entries) {
      try { const info = statSync(join(path, entry)); if (info.isFile()) { bytes += info.size; files++ } } catch { /* raced */ }
    }
    return { name, files, bytes }
  } catch { return { name, files: 0, bytes: 0 } }
}

function fileCount (root) {
  try { return readdirSync(root).reduce((sum, entry) => { try { return sum + (statSync(join(root, entry)).isFile() ? 1 : 0) } catch { return sum } }, 0) } catch { return 0 }
}

/**
 * Where the plugin stores its data, and how much of it sits in each directory.
 *
 * The root always comes from the host (config `storagePath`, else
 * `$DSH_HOME/storages/xcharts-canvas`), so the answer is the same on any machine
 * and never a path baked into the code.
 */
export function storageUsage (root) {
  const absolute = resolve(root)
  const directories = SHOWN.map(name => ({ ...dirStats(absolute, name), cleanable: Boolean(CLEANABLE[name]) }))
  const totalBytes = directories.reduce((sum, entry) => sum + entry.bytes, 0)
  const defaultRoot = join(homedir(), '.dsh', 'storages', 'xcharts-canvas')
  return {
    storage_path: absolute,
    source: absolute === resolve(defaultRoot) ? 'default' : 'custom',
    platform: process.platform,
    home: homedir(),
    dsh_home: process.env.DSH_HOME || null,
    total_bytes: totalBytes,
    total_files: directories.reduce((sum, entry) => sum + entry.files, 0) + fileCount(absolute),
    directories: directories.map(({ name, files, bytes, cleanable }) => ({ name, files, bytes, cleanable })),
    cleanable: Object.entries(CLEANABLE).map(([target, meta]) => ({ target, ...meta })),
  }
}

/** Delete one cleanable directory's files; never touches canvases, sources or results. */
export function cleanStorage (root, target) {
  const meta = CLEANABLE[target]
  if (!meta) throw new CanvasError('INVALID_CLEANUP_TARGET', `不能清理「${String(target)}」；可清理：${Object.keys(CLEANABLE).join('、')}`)
  const absolute = resolve(root)
  const path = resolve(absolute, target)
  if (!path.startsWith(`${absolute}${sep}`)) throw new CanvasError('INVALID_CLEANUP_TARGET', '清理目标不在存储目录内')
  if (!existsSync(path)) return { target, label: meta.label, deleted_files: 0, freed_bytes: 0 }
  const before = dirStats(absolute, target)
  rmSync(path, { recursive: true, force: true })
  return { target, label: meta.label, deleted_files: before.files, freed_bytes: before.bytes }
}
