import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function fixture ({ insert = () => true, ackFail = false } = {}) {
  const calls = [], navigations = [], inserted = []
  const context = vm.createContext({ console, Promise, Date, Set, JSON, Error, crypto: { randomUUID: () => 'request-unique' },
    getCapabilities: async () => ({ followup_api: 1 }),
    api: async (path, options) => {
      calls.push([path, JSON.parse(options.body)])
      if (path === '/followups') return { id: 'a'.repeat(32), prompt: '卡片 [xcharts:ref]', status: 'pending' }
      if (ackFail) throw new Error('network')
      return { status: 'attached' }
    },
  })
  vm.runInContext(`${readFileSync(new URL('../client-src/06c-followup-ui.js', import.meta.url), 'utf8')}\nglobalThis.factory = createFollowupBroker`, context)
  const broker = context.factory(id => navigations.push(id))
  const input = { draft: '保留草稿', draftRev: 7, phase: 'plain', occurrences: [] }
  const actions = { insertText: (text, span) => { inserted.push({ text, span }); return insert() } }
  return { broker, calls, navigations, inserted, input, actions }
}
const target = { canvas_id: 'canvas', card_id: 'card', version_id: 'v1-pinned', title: '客户数' }
const settle = () => new Promise(resolve => setImmediate(resolve))

test('follow-up appends at draft end and only reports ready after editor and server acknowledgement', async () => {
  const f = fixture()
  const promise = f.broker.ask(target, 'selected-session')
  await settle()
  assert.equal(f.broker.snapshot().status, 'waiting_editor')
  assert.deepEqual(f.navigations, ['selected-session'])
  f.broker.deliver('other-session', f.input, f.actions)
  assert.equal(f.inserted.length, 0)
  f.broker.deliver('selected-session', f.input, f.actions)
  f.broker.deliver('selected-session', f.input, f.actions)
  await promise
  assert.equal(f.inserted.length, 1)
  assert.equal(f.inserted[0].span.start, f.input.draft.length)
  assert.equal(f.inserted[0].span.end, f.input.draft.length)
  assert.equal(f.inserted[0].span.draftRev, 7)
  assert.match(f.inserted[0].text, /^\n\n关于卡片/)
  assert.equal(f.broker.snapshot().status, 'ready')
  assert.equal(f.calls[0][1].version_id, 'v1-pinned')
})

test('revision conflicts and chips preserve the draft, keep recoverable pending state and never write clipboard', async () => {
  const f = fixture({ insert: () => false })
  const promise = f.broker.ask(target, 'session').catch(error => error.message)
  await settle()
  f.broker.deliver('session', f.input, f.actions)
  assert.equal(f.broker.snapshot().status, 'failed')
  assert.equal(f.calls.length, 1, 'no acknowledgement for rejected editor operation')
  f.broker.retry()
  f.broker.deliver('session', { ...f.input, occurrences: [{ length: 10 }] }, f.actions)
  assert.equal(f.inserted.length, 1)
  assert.equal(f.broker.snapshot().status, 'failed')
  f.broker.cancel()
  assert.equal(await promise, '已取消追问')
})

test('lost acknowledgement retries receipt without appending a second reference', async () => {
  const f = fixture({ ackFail: true })
  const promise = f.broker.ask(target, 'session').catch(error => error.message)
  await settle()
  f.broker.deliver('session', f.input, f.actions)
  await settle()
  assert.equal(f.broker.snapshot().status, 'failed')
  f.broker.retry()
  await settle()
  assert.equal(f.inserted.length, 1)
  assert.equal(f.calls.length, 3)
  f.broker.cancel(); await promise
})

test('no known session requires selection and cancelled requests never enter later editors', async () => {
  const f = fixture()
  const promise = f.broker.ask(target).catch(error => error.message)
  assert.equal(f.broker.snapshot().status, 'selecting')
  assert.equal(f.calls.length, 0)
  f.broker.cancel()
  f.broker.deliver('session', f.input, f.actions)
  assert.equal(f.inserted.length, 0)
  assert.equal(await promise, '已取消追问')
})
