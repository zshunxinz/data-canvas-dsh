import { CanvasError } from './store.js'
import { DataStore } from './data-store.js'

export const WORKSPACE_FORMAT = 'dsh-xcharts-workspace-backup'
export const WORKSPACE_FORMAT_VERSION = 1
const MAX_CANVASES = 100
const MAX_TEMPLATES = 200
const MAX_BYTES = 8 * 1024 * 1024

/**
 * One file that holds every canvas and layout template.
 *
 * Each canvas travels in the existing single-canvas backup format, so an old
 * per-canvas file still imports on its own, and this bundle is only a wrapper.
 * Data sources are not included: a canvas keeps its card data inline, and raw
 * tables are re-imported from their files.
 */
export function exportWorkspace (store, pluginVersion = null) {
  const canvases = store.listCanvases().map(summary => store.exportCanvasBackup(summary.id))
  const templates = store.listTemplates().map(summary => store.getTemplate(summary.id))
  // Database connections travel as metadata only: the credential stays out of any file.
  const connections = new DataStore(store.root).list().filter(item => item.kind === 'database').map(item => ({
    name: item.name, format: item.format, connection: item.connection, server_version: item.server_version,
    catalog: item.catalog ?? null, catalog_cached_at: item.catalog_cached_at ?? null,
  }))
  const bundle = {
    format: WORKSPACE_FORMAT,
    format_version: WORKSPACE_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    plugin_version: pluginVersion,
    canvas_count: canvases.length,
    template_count: templates.length,
    connection_count: connections.length,
    canvases,
    templates,
    connections,
  }
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_BYTES) {
    throw new CanvasError('BODY_TOO_LARGE', '备份超过 8 MiB，请按画布分别导出')
  }
  return bundle
}

/** Import a workspace bundle: every entry becomes a new canvas/template. */
export function importWorkspace (store, bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new CanvasError('INVALID_BACKUP', '不是可识别的备份文件')
  if (bundle.format !== WORKSPACE_FORMAT || bundle.format_version !== WORKSPACE_FORMAT_VERSION) {
    throw new CanvasError('INVALID_BACKUP', '备份格式或版本不受支持；单画布备份请在画布菜单里导入')
  }
  const canvases = Array.isArray(bundle.canvases) ? bundle.canvases : []
  const templates = Array.isArray(bundle.templates) ? bundle.templates : []
  if (!canvases.length && !templates.length) throw new CanvasError('INVALID_BACKUP', '备份里没有画布或模板')
  if (canvases.length > MAX_CANVASES) throw new CanvasError('INVALID_BACKUP', `一次最多导入 ${MAX_CANVASES} 张画布`)
  if (templates.length > MAX_TEMPLATES) throw new CanvasError('INVALID_BACKUP', `一次最多导入 ${MAX_TEMPLATES} 个模板`)
  const connections = Array.isArray(bundle.connections) ? bundle.connections : []
  const imported = [], failed = [], pending = []
  for (const backup of canvases) {
    try {
      const canvas = store.importCanvasBackup(backup)
      imported.push({ id: canvas.id, name: canvas.name, card_count: canvas.cards.length })
    } catch (error) { failed.push({ kind: 'canvas', name: backup?.canvas?.name ?? null, error: error.message }) }
  }
  const importedTemplates = []
  for (const template of templates) {
    try { importedTemplates.push(store.importTemplate(template)) }
    catch (error) { failed.push({ kind: 'template', name: template?.name ?? null, error: error.message }) }
  }
  if (connections.length) {
    const data = new DataStore(store.root)
    for (const item of connections) {
      try { pending.push(data.writePendingDatabaseSource(item)) }
      catch (error) { failed.push({ kind: 'connection', name: item?.name ?? null, error: error.message }) }
    }
  }
  return { imported, imported_templates: importedTemplates, pending_connections: pending, failed }
}
