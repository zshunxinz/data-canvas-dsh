import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { CanvasError } from './store.js'

/**
 * Credentials live here and nowhere else: AES-256-GCM, one random IV per
 * record, and a key that never enters the data source JSON, the backup, a
 * result snapshot, a log line or a model context.
 */
const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32

function keyFile (root) { return join(root, 'secrets.key') }
export function secretsDir (root) { return join(root, 'secrets') }
function recordPath (root, ref) { return join(secretsDir(root), `${ref}.json`) }

function envKey () {
  const raw = process.env.XCHARTS_SECRET_KEY
  if (!raw) return null
  const buffer = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  return buffer.length === KEY_BYTES ? buffer : null
}

function ensureKey (root) {
  const fromEnv = envKey()
  if (fromEnv) return fromEnv
  const path = keyFile(root)
  if (existsSync(path)) {
    const key = readFileSync(path)
    if (key.length !== KEY_BYTES) throw new CanvasError('SECRET_KEY_INVALID', 'secrets.key 长度无效，请删除后重新保存凭据')
    return key
  }
  mkdirSync(root, { recursive: true })
  const key = randomBytes(KEY_BYTES)
  writeFileSync(path, key, { mode: 0o600 })
  // Best effort: POSIX permissions; on Windows the file inherits the profile ACL.
  try { chmodSync(path, 0o600) } catch { /* windows */ }
  return key
}

/** Store a password (or any connection secret) and return its opaque reference. */
export function putSecret (root, value) {
  if (typeof value !== 'string' || !value) throw new CanvasError('INVALID_SECRET', '密码不能为空')
  if (value.length > 512) throw new CanvasError('INVALID_SECRET', '密码过长')
  const key = ensureKey(root)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify({ value }), 'utf8'), cipher.final()])
  const record = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    created_at: new Date().toISOString(),
  }
  const ref = randomBytes(16).toString('hex')
  mkdirSync(secretsDir(root), { recursive: true })
  writeFileSync(recordPath(root, ref), JSON.stringify(record), { mode: 0o600 })
  return ref
}

export function readSecret (root, ref) {
  if (typeof ref !== 'string' || !/^[a-f0-9]{32}$/.test(ref)) throw new CanvasError('SECRET_NOT_FOUND', '凭据不存在')
  let record
  try { record = JSON.parse(readFileSync(recordPath(root, ref), 'utf8')) } catch { throw new CanvasError('SECRET_NOT_FOUND', '凭据不存在或已被删除') }
  try {
    const key = ensureKey(root)
    const decipher = createDecipheriv(ALGO, key, Buffer.from(record.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()])
    const parsed = JSON.parse(plain.toString('utf8'))
    return typeof parsed.value === 'string' ? parsed.value : ''
  } catch (error) {
    if (error instanceof CanvasError) throw error
    throw new CanvasError('SECRET_UNREADABLE', '凭据无法解密（密钥已更换）；请重新填写密码')
  }
}

export function deleteSecret (root, ref) {
  if (typeof ref !== 'string' || !/^[a-f0-9]{32}$/.test(ref)) return false
  try { unlinkSync(recordPath(root, ref)); return true } catch { return false }
}

/** Never echo a secret back, no matter which layer produced the text. */
export function redactText (text, secret) {
  let out = String(text ?? '')
  if (secret) out = out.split(secret).join('***')
  return out
}

/** Hosts are shown partially: enough to recognise, not enough to leak. */
export function maskHost (host) {
  const value = String(host ?? '')
  if (!value) return ''
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.')
    return `${parts[0]}.${parts[1]}.*.*`
  }
  const labels = value.split('.')
  if (labels.length <= 2) return value
  return `${labels[0]}.${labels[1]}.***`
}
