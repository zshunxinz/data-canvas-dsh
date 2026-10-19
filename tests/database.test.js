import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CanvasStore } from '../lib/store.js'
import { DataStore } from '../lib/data-store.js'
import { putSecret, readSecret, deleteSecret, maskHost } from '../lib/secrets.js'
import { prepareReadOnlyQuery, assertReadOnlySql } from '../lib/db/guard.js'
import { exportWorkspace, importWorkspace } from '../lib/workspace-backup.js'
import { storageUsage } from '../lib/storage-maintenance.js'

test('credentials are encrypted at rest and never readable from the source JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcsecret-'))
  try {
    const store = new DataStore(dir)
    const source = store.writeDatabaseSource({
      name: '生产库',
      connection: { format: 'postgres', host: '10.0.0.12', port: 5432, database: 'sales', user: 'reader' },
      secret: 'super-secret',
      catalog: { table_count: 1, tables: [{ schema: 'public', name: 'orders', columns: [{ name: 'id', type: 'int' }] }] },
      server_version: 'PostgreSQL 16.2',
    })
    assert.ok(existsSync(join(dir, 'secrets.key')), 'a local key is created on first use')
    const record = store.get(source.id)
    assert.equal(record.secret_ref.length, 32)
    const files = readdirSync(join(dir, 'secrets')).join(',')
    assert.ok(!files.includes('super-secret'), 'the secret is not used as a file name')
    assert.ok(!JSON.stringify(record).includes('super-secret'), 'the source JSON holds no plaintext password')
    assert.equal(readSecret(dir, record.secret_ref), 'super-secret')
    const masked = store.list().find(item => item.id === source.id)
    assert.equal(masked.kind, 'database')
    assert.equal(masked.needs_secret, false)
    assert.equal(masked.secret_ref, undefined, 'the compact list drops the credential reference')
    // A delete cascades: the credential file is removed with the source.
    store.remove(source.id)
    assert.equal(existsSync(join(dir, 'secrets', `${record.secret_ref}.json`)), false)
    assert.equal(deleteSecret(dir, 'f'.repeat(32)), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the SQL guard only admits bounded read-only statements', () => {
  assert.match(prepareReadOnlyQuery('select 1', 10), /LIMIT 11/)
  assert.match(prepareReadOnlyQuery('WITH x AS (SELECT 1) SELECT * FROM x', 10), /LIMIT 11/)
  assert.equal(prepareReadOnlyQuery('SHOW TABLES', 10), 'SHOW TABLES', 'catalogue statements are not wrapped in a subquery')
  assert.throws(() => assertReadOnlySql('SELECT 1; DROP TABLE t'), /单条 SQL/)
  assert.throws(() => assertReadOnlySql('DELETE FROM t'), /只读查询/)
  assert.throws(() => assertReadOnlySql('SELECT * INTO OUTFILE "/tmp/x" FROM t'), /写操作/)
  assert.throws(() => assertReadOnlySql('COPY t FROM PROGRAM \'x\''), /只读查询/)
  assert.equal(maskHost('10.0.0.12'), '10.0.*.*')
  assert.equal(maskHost('db.prod.internal'), 'db.prod.***')
})

test('a workspace backup carries connection metadata but never a password', async () => {
  const source = mkdtempSync(join(tmpdir(), 'xcbksrc-'))
  const target = mkdtempSync(join(tmpdir(), 'xcbkdst-'))
  try {
    const store = new CanvasStore(source)
    const data = new DataStore(source)
    const canvas = store.createCanvas({ name: '备份画布', cards: [{ type: 'text', title: '说明', text_content: 'x', layout: { x: 0, y: 0, w: 24, h: 8 } }] })
    data.writeDatabaseSource({
      name: '分析库',
      connection: { format: 'mysql', host: '127.0.0.1', port: 3306, database: 'analytics', user: 'reader' },
      secret: 'never-in-backup',
      catalog: { table_count: 0, tables: [] },
    })
    const bundle = exportWorkspace(store)
    assert.equal(bundle.connection_count, 1)
    assert.equal(bundle.connections[0].connection.database, 'analytics')
    assert.equal(JSON.stringify(bundle).includes('never-in-backup'), false, 'no credential in the bundle')
    assert.equal(JSON.stringify(bundle).includes('secret_ref'), false)

    // Import onto a fresh machine: the connection exists but waits for a password.
    const fresh = new CanvasStore(target)
    const result = importWorkspace(fresh, bundle)
    assert.equal(result.imported.length, 1)
    assert.equal(result.pending_connections.length, 1)
    const imported = new DataStore(target).list().find(item => item.kind === 'database')
    assert.equal(imported.needs_secret, true)
    assert.equal(imported.connection.host, '127.0.0.1')
    assert.equal(exportWorkspace(store).canvases.length, 1)
    assert.ok(canvas.id)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('the storage report counts credentials but offers no cleanup for them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcstore2-'))
  try {
    putSecret(dir, 'x')
    const usage = storageUsage(dir)
    const secrets = usage.directories.find(item => item.name === 'secrets')
    assert.ok(secrets && secrets.files === 1, 'the credential directory is counted')
    assert.equal(secrets.cleanable, false, 'credentials are never a cleanup target')
    assert.equal(usage.cleanable.some(item => item.target === 'secrets'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a database source can be renamed like a file source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcrename-'))
  try {
    const store = new DataStore(dir)
    const created = store.writeDatabaseSource({
      name: '旧名称',
      connection: { format: 'mysql', host: '127.0.0.1', port: 3306, database: 'zsx', user: 'reader' },
      secret: 'x',
      catalog: { table_count: 0, tables: [] },
    })
    const renamed = store.rename(created.id, '生产分析库')
    assert.equal(renamed.name, '生产分析库')
    assert.equal(store.get(created.id).name, '生产分析库')
    assert.equal(store.get(created.id).kind, 'database')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a datasource note is stored with the source and capped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcnote-'))
  try {
    const store = new DataStore(dir)
    const created = store.writeDatabaseSource({
      name: '备注库',
      connection: { format: 'mysql', host: '127.0.0.1', port: 3306, database: 'zsx', user: 'reader' },
      secret: 'x',
      catalog: { table_count: 0, tables: [] },
    })
    const updated = store.updateNote(created.id, '销售库，只读账号')
    assert.equal(updated.note, '销售库，只读账号')
    assert.equal(store.get(created.id).note, '销售库，只读账号')
    assert.equal(store.updateNote(created.id, 'x'.repeat(300)).note.length, 200)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
