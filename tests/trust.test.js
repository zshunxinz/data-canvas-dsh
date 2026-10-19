import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { rejectionFor, structuralRejection } from '../lib/trust.js'
import { createApiHandler } from '../lib/routes.js'
import { CanvasStore } from '../lib/store.js'

/**
 * The trust fence exists because this plugin's prefix (`/api/xcharts-canvas`)
 * outranks the kernel's own `/api` prefix, so these routes run before the
 * connection service's admission check. Measured before the fence existed:
 *   GET /api/xcharts-canvas/canvases   → 200 (no cookie)
 *   GET /api/our-free-model/meta       → 401 (fence present)
 */

function req (headers = {}, method = 'GET', url = '/api/xcharts-canvas/canvases') {
  const r = Readable.from([])
  r.method = method
  r.url = url
  r.headers = { host: '127.0.0.1:3080', ...headers }
  return r
}

test('a plain loopback request from the app page is allowed', () => {
  assert.equal(structuralRejection(req()), undefined)
  assert.equal(structuralRejection(req({ origin: 'http://127.0.0.1:3080' })), undefined)
  assert.equal(structuralRejection(req({ referer: 'http://127.0.0.1:3080/settings' })), undefined)
  assert.equal(structuralRejection(req({ origin: 'http://localhost:3080' })), 403,
    'a different hostname string is not the same authority as the Host header')
})

test('a non-loopback host is refused', () => {
  for (const host of ['evil.com:3080', '192.168.1.5:3080', '10.0.0.1']) {
    assert.equal(structuralRejection(req({ host })), 403, `should refuse ${host}`)
  }
})

test('cross-site fetches are refused', () => {
  assert.equal(structuralRejection(req({ 'sec-fetch-site': 'cross-site' })), 403)
  assert.equal(structuralRejection(req({ 'sec-fetch-site': 'same-origin' })), undefined)
})

test('a mismatched Origin or Referer is refused', () => {
  assert.equal(structuralRejection(req({ origin: 'http://attacker.example' })), 403)
  assert.equal(structuralRejection(req({ origin: 'https://127.0.0.1:3080' })), 403, 'scheme must match the plain-http bind')
  assert.equal(structuralRejection(req({ origin: 'http://127.0.0.1:9999' })), 403, 'port must match')
  assert.equal(structuralRejection(req({ referer: 'http://attacker.example/x' })), 403)
})

test('a malformed Origin is refused rather than ignored', () => {
  assert.equal(structuralRejection(req({ origin: 'not a url' })), 403)
})

test('a missing Host header is refused', () => {
  const r = req()
  delete r.headers.host
  assert.equal(structuralRejection(r), 403)
})

test('the mounted connection service takes precedence when present', () => {
  let asked = 0
  const connection = {
    admit (r) {
      asked++
      // allow one, reject the other — the fence must follow the host's answer
      return r.headers['x-test'] === 'deny' ? { rejection: 401 } : undefined
    },
  }
  assert.equal(rejectionFor(req({ 'x-test': 'allow' }), connection), undefined)
  assert.equal(rejectionFor(req({ 'x-test': 'deny' }), connection), 401)
  assert.equal(asked, 2)
})

test('older hosts exposing requestRejection are honoured', () => {
  const connection = { requestRejection: () => 403 }
  assert.equal(rejectionFor(req(), connection), 403)
})

test('a failing connection service fails closed, never open', () => {
  const connection = { admit () { throw new Error('boom') } }
  assert.equal(rejectionFor(req(), connection), 503)
})

test('the API handler refuses a cross-site caller before touching storage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xctrust-'))
  try {
    const store = new CanvasStore(dir)
    store.createCanvas({ name: 'secret' })
    const handler = createApiHandler(() => new CanvasStore(dir), '/api/xcharts-canvas', () => undefined)

    async function call (headers, method = 'GET', body) {
      const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
      r.method = method
      r.url = '/api/xcharts-canvas/canvases'
      r.headers = { host: '127.0.0.1:3080', ...headers }
      const res = {
        statusCode: null, headers: null, chunks: [],
        writeHead (s, h) { this.statusCode = s; this.headers = h },
        end (c) { if (c) this.chunks.push(Buffer.from(c)) },
      }
      await handler(r, res)
      return res
    }

    const allowed = await call({ origin: 'http://127.0.0.1:3080' })
    assert.equal(allowed.statusCode, 200, 'same-origin call should work')

    const blocked = await call({ origin: 'http://attacker.example' })
    assert.equal(blocked.statusCode, 403, 'cross-origin call must be refused')

    const blockedWrite = await call({ 'sec-fetch-site': 'cross-site' }, 'POST', { name: 'pwned' })
    assert.equal(blockedWrite.statusCode, 403)
    assert.equal(store.listCanvases().length, 1, 'the refused write must not have created a canvas')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the handler still works when no connection service is mounted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xctrust2-'))
  try {
    const handler = createApiHandler(() => new CanvasStore(dir), '/api/xcharts-canvas', () => undefined)
    const r = Readable.from([])
    r.method = 'GET'
    r.url = '/api/xcharts-canvas/canvases'
    r.headers = { host: 'localhost:3080' }
    const res = {
      statusCode: null, headers: null, chunks: [],
      writeHead (s, h) { this.statusCode = s; this.headers = h },
      end (c) { if (c) this.chunks.push(Buffer.from(c)) },
    }
    await handler(r, res)
    assert.equal(res.statusCode, 200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
