/**
 * Request trust fence for the plugin's HTTP surface.
 *
 * Why this is needed: the plugin registers a prefix (`/api/xcharts-canvas`) that
 * is *longer* than the kernel's own `/api` prefix, and the web server dispatches
 * by longest prefix. These routes therefore run before the connection service's
 * own admission check, so without this module they would answer any loopback
 * caller — including a web page the user happens to have open, which can issue
 * cross-site requests to a local port.
 *
 * Measured on the running plugin before this module existed:
 *   GET /api/xcharts-canvas/canvases          → 200 (no cookie)
 *   GET /api/our-free-model/meta              → 401 (fence present)
 *
 * Two layers, tried in order:
 *   1. the composition's own `connection` service, when one is mounted — the
 *      exact decision the kernel applies to its own `/api` routes, so this
 *      plugin is never weaker than the app;
 *   2. a structural replica for compositions without that service: loopback
 *      host only, no cross-site fetches, and any `Origin`/`Referer` must match
 *      the `Host` authority.
 *
 * A failure inside a mounted host service fails closed (503), never open.
 *
 * @module lib/trust
 */

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** Split Host/Origin/Referer into {scheme, hostname, port}, defaulting the port. */
function authorityOf (value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/** Fixed reason strings only — never echo caller-supplied values back. */
function structuralReason (req) {
  const host = authorityOf(req.headers?.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback'

  const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 'cross-site'

  for (const header of ['origin', 'referer']) {
    const raw = req.headers?.[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return `${header}-invalid`
    // The web server speaks plain http on a loopback bind, so an Origin that
    // claims another scheme or authority is not this page.
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) {
      return `${header}-mismatch`
    }
  }
  return undefined
}

/**
 * Decide one request.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection the harness `connection` service, if mounted
 * @returns {number|undefined} an HTTP status to reject with, or undefined to allow
 */
export function rejectionFor (req, connection) {
  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined
      return status === undefined ? undefined : status
    }
    // Hosts before dsh 0.1.7 publish the same decision under the older name.
    const legacy = connection?.requestRejection
    if (typeof legacy === 'function') {
      const status = legacy.call(connection, req)
      return status === undefined ? undefined : status
    }
  } catch {
    // Never bypass browser authentication when a mounted host service fails.
    return 503
  }
  return structuralReason(req) === undefined ? undefined : 403
}

/** The replica fence alone, exported so it can be tested without a service. */
export function structuralRejection (req) {
  return structuralReason(req) === undefined ? undefined : 403
}
