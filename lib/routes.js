/**
 * HTTP routes for the browser half.
 *
 * The canvas view needs to read and write canvases independently of the model
 * (a user dragging a card must not require a chat turn), so the plugin serves
 * its own same-origin JSON API rather than going through a typed Remote
 * binding. Same reasons as the reference plugin on this machine: the routes
 * work on every kernel line that provides a web server, and the browser half
 * stays free of kernel-specific transport imports.
 *
 * Mounted at `/api/xcharts-canvas`:
 *   GET    /capabilities                 loaded host plugin capabilities
 *   GET    /canvases                     list
 *   POST   /canvases                     create
 *   POST   /canvases/example             create a sales example (simulated data)
 *   GET    /canvases/:id                 read one
 *   DELETE /canvases/:id                 delete
 *   PATCH  /canvases/:id/layout          commit card layouts (revision-checked)
 *   POST   /canvases/:id/arrange         tidy arrangement
 *
 * All bodies are JSON. Errors are `{ error, code }` with a matching status.
 *
 * @module lib/routes
 */

import { readFileSync } from 'node:fs'
import { CanvasStore, CanvasError, RevisionConflict } from './store.js'
import { tidyArrange, COLS, EXTENT_COLS_CEIL, clampLayout, nearestFreeSlot } from './grid.js'
import { DataStore } from './data-store.js'
import { rejectionFor } from './trust.js'
import { TraceService } from './trace-service.js'
import { ReferenceService, parseReference } from './reference-service.js'
import { storageUsage, cleanStorage } from './storage-maintenance.js'
import { exportWorkspace, importWorkspace } from './workspace-backup.js'
import { testConnection, introspect, normalizeConnection, DATABASE_FORMATS } from './db/adapter.js'
import { readSecret } from './secrets.js'

const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const CAPABILITIES = { api_version: 1, plugin_version: PLUGIN_VERSION, trace_api: 1, followup_api: 1, reference_api: 1, changelog_api: 1, storage_api: 1, workspace_backup_api: 1, database_api: 1, sql_query_api: 1, create_example: true, local_assets: 1, datasource_api: true, datasource_resources: ['datasources', 'results'], datasource_types: ['csv', 'tsv', 'xlsx', 'parquet', ...DATABASE_FORMATS] }

/** Plain lines of the newest changelog sections, served to the in-plugin 「最近更新」 dialog. */
function changelogSections (limit) {
  let text = ''
  try { text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8') } catch { return [] }
  const plain = line => String(line)
    .replace(/^\s*-\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
  const entries = []
  for (const block of text.split(/^## /m).slice(1)) {
    const [heading, ...body] = block.split('\n')
    const match = /^v?(\d+\.\d+\.\d+)\s*(?:[—-]\s*(\d{4}-\d{2}-\d{2}))?/.exec(heading.trim())
    if (!match) continue
    const lines = body.map(plain).filter(line => line && !line.startsWith('#'))
    if (!lines.length) continue
    entries.push({ version: match[1], date: match[2] || null, lines: lines.slice(0, 10) })
    if (entries.length >= limit) break
  }
  return entries
}

/** Map a domain error to an HTTP status. `null` means "not a domain error". */
function statusFor (error) {
  if (['VERSION_NOT_FOUND', 'CARD_NOT_FOUND', 'FOLLOWUP_NOT_FOUND'].includes(error?.code)) return 404
  if (['FOLLOWUP_CONFLICT', 'FOLLOWUP_SESSION_MISMATCH'].includes(error?.code)) return 409
  if (error instanceof RevisionConflict || error?.code === 'DRAFT_SUPERSEDED') return 409
  if (error instanceof CanvasError) {
    switch (error.code) {
      case 'CANVAS_NOT_FOUND':
      case 'CARD_NOT_FOUND':
      case 'DRAFT_NOT_FOUND':
      case 'DATA_NOT_FOUND':
      case 'DATASOURCE_NOT_FOUND':
      case 'RESULT_NOT_FOUND':
      case 'TEMPLATE_NOT_FOUND':
        return 404
      case 'BODY_TOO_LARGE':
        return 413
      case 'CORRUPT_JSON':
      case 'CORRUPT_CANVAS':
      case 'CORRUPT_INDEX':
      case 'CORRUPT_TEMPLATE':
        return 500
      default:
        return 400
    }
  }
  return null
}

function sendJson (res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-xcharts-canvas-version': PLUGIN_VERSION,
  })
  res.end(body)
}

function sendError (res, error) {
  const status = statusFor(error) ?? 500
  const payload = {
    error: error?.message || String(error),
    code: error?.code || 'INTERNAL',
  }
  if (error instanceof RevisionConflict) {
    payload.current_revision = error.current
    payload.expected_revision = error.expected
  }
  sendJson(res, status, payload)
}

/** Read and parse a JSON request body, with a hard size cap. */
function readBody (req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', chunk => {
      if (tooLarge) return
      size += chunk.length
      if (size > limitBytes) {
        tooLarge = true
        reject(new CanvasError('BODY_TOO_LARGE', `request body exceeds ${limitBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new CanvasError('INVALID_JSON', `request body is not valid JSON: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Strip the mount prefix and split the remaining path.
 *
 * Tolerant of both dispatch shapes on purpose: some compositions hand the
 * handler the full URL (prefix dispatch), others the remainder. Stripping the
 * prefix when it is present and leaving the path alone otherwise keeps the
 * route logic the same either way.
 */
function segmentsOf (url, prefix) {
  const path = String(url || '').split('?')[0]
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path
  return rest.split('/').filter(Boolean).map(decodeURIComponent)
}

/**
 * Build the request handler.
 *
 * @param {() => CanvasStore} store factory (root may change on config reload)
 * @param {string} prefix mount prefix, e.g. `/api/xcharts-canvas`
 * @param {() => object|undefined} [connection] resolves the harness
 *   `connection` service per request — it may be published after this plugin
 *   loads, so it is read lazily rather than captured once
 */
export function createApiHandler (store, prefix, connection, services = () => ({})) {
  return async function handler (req, res) {
    try {
      // Trust fence first: this prefix outranks the kernel's own `/api`, so
      // without this check the routes would answer any loopback caller.
      const rejection = rejectionFor(req, typeof connection === 'function' ? connection() : connection)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'x-xcharts-canvas-version': PLUGIN_VERSION })
        res.end(rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden')
        return
      }

      const method = (req.method || 'GET').toUpperCase()
      // segments are [resource, id?, action?, cardId?, cardAction?]
      const [resource, id, action, cardId, cardAction] = segmentsOf(req.url, prefix)

      if (resource === 'capabilities' && !id && method === 'GET') return sendJson(res, 200, CAPABILITIES)
      if (resource === 'backup' && !id && method === 'GET') return sendJson(res, 200, exportWorkspace(store(), PLUGIN_VERSION))
      if (resource === 'backup' && id === 'import' && method === 'POST') return sendJson(res, 201, importWorkspace(store(), await readBody(req)))
      if (resource === 'storage' && !id && method === 'GET') return sendJson(res, 200, storageUsage(store().root))
      if (resource === 'storage' && id === 'cleanup' && method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { ...cleanStorage(store().root, body.target), storage: storageUsage(store().root) })
      }
      if (resource === 'changelog' && !id && method === 'GET') {
        const asked = Number(new URL(req.url, 'http://localhost').searchParams.get('limit'))
        const limit = Number.isFinite(asked) ? Math.min(5, Math.max(1, Math.trunc(asked))) : 3
        return sendJson(res, 200, { current_version: PLUGIN_VERSION, entries: changelogSections(limit) })
      }

      if (!["canvases", "datasources", "results", "drafts", "followups", "usages"].includes(resource)) {
         return sendJson(res, 404, { error: `unknown route: ${req.url}`, code: 'NOT_FOUND' })
       }

       const db = store()
       const data = new DataStore(db.root)
        const trace = new TraceService(db.root, typeof services === 'function' ? services() : services)
        const references = new ReferenceService(db.root, typeof services === 'function' ? services() : services)
        const versionId = new URL(req.url, 'http://localhost').searchParams.get('version_id')
        if (resource === 'usages' && !id && method === 'POST') {
          const body = await readBody(req)
          const ref = parseReference(body.reference)
          return sendJson(res, 201, references.record(ref, 'ask', { session_id: body.session_id, outcome: 'ok' }))
        }
        if (resource === 'datasources' && id && action === 'usage' && method === 'GET') return sendJson(res, 200, await references.usageForSource(id))
        if (resource === 'followups') {
          if (!id && method === 'POST') {
            const body = await readBody(req)
            return sendJson(res, 200, await trace.createFollowup(body.canvas_id, body.card_id, body))
          }
          if (id && action === 'version' && method === 'GET') return sendJson(res, 200, await trace.context(id, { full: true }))
          if (id && !action && method === 'GET') return sendJson(res, 200, await trace.context(id))
          if (id && action === 'ack' && method === 'POST') return sendJson(res, 200, await trace.ackFollowup(id, await readBody(req)))
          return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'method not allowed' })
        }
        if (resource === 'canvases' && action === 'cards' && cardId) {
          if (cardAction === 'trace' && method === 'GET') return sendJson(res, 200, await trace.read(id, cardId, versionId))
          if (cardAction === 'trace' && method === 'POST' && segmentsOf(req.url, prefix)[5] === 'check') {
            const body = await readBody(req)
            return sendJson(res, 200, await trace.check(id, cardId, body.version_id ?? null))
          }
          if (cardAction === 'recompute' && method === 'POST') {
            const body = await readBody(req)
            return sendJson(res, 200, await trace.recompute(id, cardId, body.version_id ?? null))
          }
          if (cardAction === 'version' && method === 'GET') return sendJson(res, 200, { ...db.getCardVersion(id, cardId, versionId), canvas: { id, name: db.getCanvas(id).name } })
          if (cardAction === 'restore' && method === 'POST') {
            const body = await readBody(req)
            if (!Number.isInteger(body.expected_revision)) throw new CanvasError('REVISION_REQUIRED', '恢复版本前请重新读取画布')
            return sendJson(res, 200, db.restoreCardVersion(id, cardId, body.version_id, body.expected_revision))
          }
        }

       // Pending card drafts are visible to the browser UI, never as model tools.
       // The tool response does not expose draft IDs; only user controls in the
       // canvas workspace call the confirm/cancel routes.
       if (resource === 'drafts') {
         if (!id && !action && method === 'GET') return sendJson(res, 200, { drafts: db.listCardDrafts() })
         if (id && action === 'confirm' && method === 'POST') return sendJson(res, 200, db.confirmCardDraft(id))
         if (id && action === 'cancel' && method === 'POST') return sendJson(res, 200, db.cancelCardDraft(id))
         return sendJson(res, 405, { error: `method not allowed: ${method}`, code: 'METHOD_NOT_ALLOWED' })
       }

       if (resource === 'datasources') {
          if (id && action === 'version' && method === 'GET') {
            const params = new URL(req.url, 'http://localhost').searchParams
            const source = data.sourceVersion(id, params.get('hash'))
            const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 100)
            if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new CanvasError('INVALID_PAGE', '分页无效')
            return sendJson(res, 200, { datasource: { ...data.summary(source), rows: source.rows.slice(offset, offset + limit), offset, has_more: offset + limit < source.rows.length, read_only: true } })
          }
         if (!id && method === 'GET') return sendJson(res, 200, { datasources: data.list() })
         if (id === 'inspect' && method === 'POST') {
           const body = await readBody(req)
           return sendJson(res, 200, { preview: await data.inspect(body) })
         }
         if (id === 'test-connection' && method === 'POST') {
           const body = await readBody(req)
           return sendJson(res, 200, await testConnection(body.format, body, body.password))
         }
         if (id === 'database' && !action && method === 'POST') {
           const body = await readBody(req)
           const connection = normalizeConnection(body)
           const secret = typeof body.password === 'string' ? body.password : ''
           const checked = await testConnection(connection.format, connection, secret)
           const catalog = await introspect(connection.format, connection, secret)
           return sendJson(res, 201, { datasource: data.writeDatabaseSource({ name: body.name, connection, secret, catalog, server_version: checked.server_version }) })
         }
         if (!id && method === 'POST') {
           const body = await readBody(req, 8 * 1024 * 1024)
           return sendJson(res, 201, { datasource: await data.import(body) })
         }
         if (id && action === 'query' && method === 'POST') {
           const body = await readBody(req)
           // File sources send { query }; database sources send { sql, limit, timeout_ms }.
           const spec = body.query && typeof body.query === 'object'
             ? { ...body.query, ...(body.conversation ? { conversation: body.conversation } : {}) }
             : { ...body }
           return sendJson(res, 200, { result: await data.query(id, spec) })
         }
         if (id && action === 'secret' && method === 'PATCH') {
           const body = await readBody(req)
           return sendJson(res, 200, { datasource: data.updateDatabaseSecret(id, body.password) })
         }
         if (id && action === 'test' && method === 'POST') {
           const record = data.get(id)
           if (record.kind !== 'database') throw new CanvasError('INVALID_SOURCE', '该数据源不是数据库连接')
           const secret = readSecret(data.root, record.secret_ref)
           return sendJson(res, 200, await testConnection(record.format, { ...record.connection, format: record.format }, secret))
         }
         if (id && action === 'schema' && method === 'GET') {
           const refresh = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1'
           return sendJson(res, 200, { datasource: await data.databaseSchema(id, { refresh }) })
         }
         if (id && !action && method === 'GET') {
            const query = new URL(req.url, 'http://localhost').searchParams
            return sendJson(res, 200, { datasource: data.describe(id, Number(query.get('offset') ?? 0), Number(query.get('limit') ?? 20)) })
          }
         if (id && action === 'rename' && method === 'PATCH') {
           const body = await readBody(req)
           return sendJson(res, 200, { datasource: data.rename(id, body.name) })
         }
         if (id && action === 'note' && method === 'PATCH') {
           const body = await readBody(req)
           return sendJson(res, 200, { datasource: data.updateNote(id, body.note) })
         }
         if (id && action === 'results' && method === 'GET') {
           const query = new URL(req.url, 'http://localhost').searchParams
           return sendJson(res, 200, { results: data.listResults(id, Number(query.get('limit') ?? 20)) })
         }
         if (id && !action && method === 'DELETE') return sendJson(res, 200, data.remove(id))
         return sendJson(res, 405, { error: `method not allowed: ${method}`, code: 'METHOD_NOT_ALLOWED' })
       }
       if (resource === 'results' && id && action === 'rename' && method === 'PATCH') {
          const body = await readBody(req)
          return sendJson(res, 200, { result: data.renameResult(id, body.title) })
        }
        if (resource === 'results' && id && action === 'canvas' && method === 'POST') {
          const body = await readBody(req)
          return sendJson(res, 201, { card: data.addToCanvas(db, { ...body, result_id: id }) })
        }
        if (resource === 'results' && id && method === 'GET') {
         const query = new URL(req.url, 'http://localhost').searchParams
         return sendJson(res, 200, { result: data.readResult(id, Number(query.get('offset') ?? 0), Number(query.get('limit') ?? 20)) })
       }



      if (resource === 'canvases' && action === 'backup' && method === 'GET') return sendJson(res, 200, db.exportCanvasBackup(id))

      // /canvases
      if (!id) {
        if (method === 'GET') {
          return sendJson(res, 200, { canvases: db.listCanvases() })
        }
        if (method === 'POST') {
          const body = await readBody(req)
          const canvas = db.createCanvas({ name: body.name, description: body.description })
          return sendJson(res, 201, {
            canvas_id: canvas.id,
            name: canvas.name,
            revision: canvas.revision,
            created_at: canvas.created_at,
          })
        }
        return sendJson(res, 405, { error: `method not allowed: ${method}`, code: 'METHOD_NOT_ALLOWED' })
      }

      // Local layout templates live alongside canvas JSON; no external template service is used.
      if (id === 'templates' && !action) {
        if (method === 'GET') return sendJson(res, 200, { templates: db.listTemplates() })
        if (method === 'POST') {
          const body = await readBody(req)
          const template = db.createTemplate(body.canvas_id, body.name)
          return sendJson(res, 201, { template: { id: template.id, name: template.name, card_count: template.cards.length } })
        }
      }
      if (id === 'templates' && action) {
        if (action === 'rename' && method === 'PATCH') {
          const body = await readBody(req)
          return sendJson(res, 200, db.renameTemplate(cardId, body.name))
        }
        if (action === 'preview' && method === 'GET') return sendJson(res, 200, db.getTemplate(cardId))
        if (action === 'clone' && method === 'POST') {
          const body = await readBody(req)
          const canvas = db.createCanvasFromTemplate(cardId, body.name)
          return sendJson(res, 201, { canvas_id: canvas.id, name: canvas.name, revision: canvas.revision, card_count: canvas.cards.length })
        }
        if (action === 'delete' && method === 'DELETE') return sendJson(res, 200, db.deleteTemplate(cardId))
      }

      // Import a portable backup as a separate canvas; existing canvases are untouched.
      if (id === 'import' && !action && method === 'POST') {
        const backup = await readBody(req)
        const canvas = db.importCanvasBackup(backup)
        return sendJson(res, 201, {
          canvas_id: canvas.id,
          name: canvas.name,
          revision: canvas.revision,
          card_count: canvas.cards.length,
        })
      }

      // Explicit creation also works after the user deletes the seeded canvas.
      if (id === 'example' && !action && method === 'POST') {
        const canvas = db.createExampleCanvas()
        return sendJson(res, 201, { canvas_id: canvas.id, name: canvas.name, revision: canvas.revision })
      }

      // /canvases/:id
      if (!action) {
        if (method === 'GET') return sendJson(res, 200, db.getCanvas(id))
        if (method === 'DELETE') return sendJson(res, 200, db.deleteCanvas(id))
        if (method === 'PATCH') {
          const body = await readBody(req)
          // Presentation writes share the canvas revision/history contract.
          if (body.theme !== undefined) {
            const canvas = db.setTheme(id, body.theme, body.expected_revision ?? null)
            return sendJson(res, 200, { canvas_id: canvas.id, theme: canvas.theme, revision: canvas.revision })
          }
          const canvas = db.renameCanvas(id, body.name, body.expected_revision ?? null)
          return sendJson(res, 200, { canvas_id: canvas.id, name: canvas.name, revision: canvas.revision })
        }
        return sendJson(res, 405, { error: `method not allowed: ${method}`, code: 'METHOD_NOT_ALLOWED' })
      }

      // /canvases/:id/layout — the drag/resize commit path
      if (action === 'settings' && method === 'PATCH') {
        const body = await readBody(req)
        const canvas = db.setSettings(id, body.settings, body.expected_revision ?? null)
        return sendJson(res, 200, { canvas_id: id, revision: canvas.revision, settings: canvas.settings })
      }
      if (action === 'batch' && method === 'POST') {
        const body = await readBody(req)
        const canvas = db.batchCards(id, body, body.expected_revision ?? null)
        return sendJson(res, 200, { canvas_id: id, revision: canvas.revision })
      }
      if (action === 'layout' && method === 'PATCH') {
        const body = await readBody(req)
        const layout = body.layout
        if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
          throw new CanvasError('INVALID_LAYOUT', 'body.layout must be an object of { cardId: {x,y,w,h} }')
        }
        // Collision avoidance happens here rather than in the browser half:
        // `lib/grid.js` is the single source of truth for placement, and the
        // client bundle cannot import it (it may only require modules the shell
        // provides). `avoidOverlap: false` keeps the raw position for callers
        // that know better, e.g. a future multi-card drag.
        const avoidOverlap = body.avoid_overlap !== false
        let moved = 0

        const canvas = db.withCanvas(id, body.expected_revision ?? null, current => {
          const colBound = current.settings?.wide ? EXTENT_COLS_CEIL : COLS
          const byId = new Map(current.cards.map(card => [card.id, card]))
          for (const [cardId, rect] of Object.entries(layout)) {
            const card = byId.get(cardId)
            if (!card) throw new CanvasError('CARD_NOT_FOUND', `card not found: ${cardId}`)

            if (!rect || typeof rect !== 'object' || Array.isArray(rect)
              || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(rect[key] === undefined ? card.layout[key] : rect[key]))) {
              throw new CanvasError('INVALID_LAYOUT', 'layout coordinates must be finite numbers')
            }
            const requested = clampLayout({ ...card.layout, ...rect }, colBound)
            let settled = requested
            if (avoidOverlap) {
              // Other cards as they stand right now, so several cards moving in
              // one request do not fight over the same space.
              const others = current.cards.filter(c => c.id !== cardId)
              settled = nearestFreeSlot(others, requested, cardId, colBound)
            }
            if (settled.x !== card.layout.x || settled.y !== card.layout.y
              || settled.w !== card.layout.w || settled.h !== card.layout.h) moved++
            card.layout = settled
          }
          return current
        })

        return sendJson(res, 200, {
          canvas_id: canvas.id,
          revision: canvas.revision,
          moved,
          layouts: Object.fromEntries(canvas.cards.map(card => [card.id, card.layout])),
        })
      }

      // /canvases/:id/undo — restore the state before the last action
      if (action === 'undo' && method === 'POST') {
        const body = await readBody(req)
        const result = db.undo(id, body.expected_revision ?? null)
        return sendJson(res, 200, {
          canvas_id: id,
          revision: result.canvas.revision,
          restored: result.restored,
          removed_cards: result.removedCards,
          can_redo: true,
        })
      }

      // /canvases/:id/redo — re-apply the most recently undone change
      if (action === 'redo' && method === 'POST') {
        const body = await readBody(req)
        const result = db.redo(id, body.expected_revision ?? null)
        return sendJson(res, 200, {
          canvas_id: id,
          revision: result.canvas.revision,
          restored: result.restored,
          removed_cards: result.removedCards,
        })
      }

      // /canvases/:id/arrange
      if (action === 'arrange' && method === 'POST') {        const body = await readBody(req)
        const canvas = db.withCanvas(id, body.expected_revision ?? null, current => {
          const arranged = tidyArrange(current.cards, COLS)
          const byId = new Map(arranged.map(entry => [entry.id, entry.layout]))
          for (const card of current.cards) {
            const next = byId.get(card.id)
            if (next) card.layout = next
          }
          return current
        })
        return sendJson(res, 200, { canvas_id: canvas.id, revision: canvas.revision })
      }

      // /canvases/:id/cards — add a card (the UI and scripts use the HTTP API;
      // the agent uses the canvas_add_card tool, both end in db.addCard).
      if (action === 'cards' && !cardId && method === 'POST') {
        const body = await readBody(req)
        const canvas = db.addCard(id, body, body.expected_revision ?? null)
        const card = canvas.cards[canvas.cards.length - 1]
        return sendJson(res, 201, { canvas_id: canvas.id, revision: canvas.revision, card })
      }

      // /canvases/:id/cards/:cardId — per-card operations behind the context menu
      if (action === 'cards' && cardId) {
        // Rename / change content.
        if (!cardAction && method === 'PATCH') {
          const body = await readBody(req)
          const changes = {}
          for (const field of ['title', 'chart_type', 'echarts_option', 'table_data',
            'presentation_spec', 'text_content', 'show_header', 'source']) {
            if (body[field] !== undefined) changes[field] = body[field]
          }
          if (Object.keys(changes).length === 0) {
            throw new CanvasError('INVALID_CARD', 'no updatable field supplied')
          }
          const canvas = db.updateCard(id, cardId, changes, body.expected_revision ?? null)
          const card = canvas.cards.find(c => c.id === cardId)
          return sendJson(res, 200, { canvas_id: canvas.id, revision: canvas.revision, card })
        }

        if (!cardAction && method === 'DELETE') {
          // `searchParams.get` returns null when absent; Number(null) is 0,
          // which is finite and would be treated as a real revision — that
          // turned a no-parameter delete into a spurious 409. Parse explicitly.
          const raw = new URL(req.url, 'http://localhost').searchParams.get('expected_revision')
          const expected = raw === null || raw === '' ? null : Number(raw)
          if (expected !== null && !Number.isFinite(expected)) {
            throw new CanvasError('INVALID_REVISION', `expected_revision must be a number, got ${raw}`)
          }
          const canvas = db.removeCard(id, cardId, expected)
          return sendJson(res, 200, {
            canvas_id: canvas.id,
            revision: canvas.revision,
            removed: cardId,
            card_count: canvas.cards.length,
          })
        }

        // Duplicate: a copy beside the original, carrying the same data and
        // provenance so a variant keeps its audit trail.
        if (cardAction === 'duplicate' && method === 'POST') {
          const body = await readBody(req)
          const original = db.getCanvas(id).cards.find(card => card.id === cardId)
          if (!original) throw new CanvasError('CARD_NOT_FOUND', `card not found: ${cardId}`)
          const result = db.copyCardToCanvas(id, cardId, id, {
            removeFromSource: false,
            title: body.title || `${original.title} 副本`,
            expectedRevision: body.expected_revision ?? null,
          })
          return sendJson(res, 201, {
            canvas_id: id,
            revision: result.revision,
            card: result.card,
          })
        }

        // Move a card to another canvas: copy there, remove here. One request so
        // the card cannot be lost between two round trips.
        if (cardAction === 'move-to' && method === 'POST') {
          const body = await readBody(req)
          const targetId = String(body.target_canvas_id || '')
          if (!targetId) throw new CanvasError('INVALID_TARGET', 'target_canvas_id is required')
          if (targetId === id) throw new CanvasError('INVALID_TARGET', 'the card is already on this canvas')

          const result = db.copyCardToCanvas(id, cardId, targetId, {
            removeFromSource: true,
            title: body.title,
          })
          return sendJson(res, 200, {
            from: result.from,
            to: result.to,
            card_id: result.card.id,
          })
        }

        // Copy a card to another canvas, keeping the original in place.
        if (cardAction === 'copy-to' && method === 'POST') {
          const body = await readBody(req)
          const targetId = String(body.target_canvas_id || '')
          if (!targetId) throw new CanvasError('INVALID_TARGET', 'target_canvas_id is required')

          const result = db.copyCardToCanvas(id, cardId, targetId, {
            removeFromSource: false,
            title: body.title,
          })
          return sendJson(res, 201, {
            from: result.from,
            to: result.to,
            card_id: result.card.id,
          })
        }

        return sendJson(res, 405, { error: `method not allowed: ${method}`, code: 'METHOD_NOT_ALLOWED' })
      }

      // /canvases/:id/merge — pull every card of another canvas into this one
      if (action === 'merge' && method === 'POST') {
        const body = await readBody(req)
        const sourceId = String(body.source_canvas_id || '')
        if (!sourceId) throw new CanvasError('INVALID_SOURCE', 'source_canvas_id is required')
        const result = db.mergeCanvasInto(sourceId, id, { keepSource: body.keep_source !== false })
        return sendJson(res, 200, {
          canvas_id: id,
          revision: result.canvas.revision,
          moved: result.moved,
          kept_source: body.keep_source !== false,
        })
      }

      return sendJson(res, 404, { error: `unknown route: ${req.url}`, code: 'NOT_FOUND' })
    } catch (error) {
      sendError(res, error)
    }
  }
}
