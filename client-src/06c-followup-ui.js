    // A resident composer adapter; no historical Turn subscriptions or DOM writes.
    // One delivery machine for two kinds of reference: a frozen card follow-up
    // (server-side ref) and a datasource/result reference (a short marker).
    function referenceMarker (input) {
      if (input.kind === 'ds') return `[xcharts:ds:${input.datasource_id}${input.version ? `@${input.version}` : ''}]`
      if (input.kind === 'res') return `[xcharts:res:${input.result_id}]`
      return null
    }
    function referenceLine (input) {
      const marker = referenceMarker(input)
      if (input.kind === 'ds') return `@${input.name || '数据源'}（${input.rows ?? '?'} 行）${marker}`
      if (input.kind === 'res') return `@结果（${input.rows ?? '?'} 行）${marker}`
      return `关于卡片「${input.title || '分析卡片'}」[xcharts:${input.ref_id}]：`
    }
    function createFollowupBroker (openSession) {
      let active = null, lastSession = null, serial = 0
      const listeners = new Set()
      const notify = () => { for (const listener of listeners) listener() }
      const receipts = new Set()
      const requestId = () => globalThis.crypto?.randomUUID?.() || `ask-${Date.now()}-${++serial}`
      const broker = {
        snapshot: () => active,
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
        observeSession: id => { if (id) lastSession = id },
        knownSession: () => active?.session_id || lastSession,
        ask: (input, sessionId) => {
          const same = active && active.input && (
            ((input.kind ?? 'card') === 'card' && active.input.canvas_id === input.canvas_id && active.input.card_id === input.card_id && active.input.version_id === input.version_id) ||
            (input.kind === 'ds' && active.input.datasource_id === input.datasource_id) ||
            (input.kind === 'res' && active.input.result_id === input.result_id))
          if (active && !['ready', 'cancelled'].includes(active.status)) {
            if (same) return active.promise
            return Promise.reject(new Error('请先处理当前引用'))
          }
          let resolve, reject
          const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
          // An explicit session (card follow-up inside a conversation) goes straight
          // through; a page-level reference asks first, so the target is visible.
          active = { request_id: requestId(), input, session_id: sessionId || null, status: 'selecting', promise, resolve, reject, ref: null, error: '' }
          notify()
          if (active.session_id) broker.start(active.session_id)
          return promise
        },
        start: async sessionId => {
          const request = active
          if (!request || request.status === 'preparing') return
          request.session_id = sessionId
          request.status = 'preparing'; request.error = ''; notify()
          try {
            const capabilities = await getCapabilities()
            if ((request.input.kind ?? 'card') === 'card') {
              if (capabilities.followup_api !== 1) throw new Error('溯源服务尚未生效，请重启 DSH 后重试')
              const ref = request.ref || await api('/followups', { method: 'POST', body: JSON.stringify({ ...request.input, request_id: request.request_id, session_id: sessionId }) })
              if (active !== request || request.status === 'cancelled') return
              request.ref = ref
              if (ref.status !== 'pending') { request.status = 'ready'; request.resolve(ref); notify(); return }
            } else {
              if (capabilities.reference_api !== 1) throw new Error('引用服务尚未生效，请重启 DSH 后重试')
              const marker = referenceMarker(request.input)
              request.ref = { id: marker, prompt: referenceLine(request.input), marker }
            }
            request.status = 'waiting_editor'; notify()
            openSession(sessionId)
          } catch (error) {
            if (active !== request) return
            request.status = 'failed'; request.error = error.message; notify()
          }
        },
        deliver: (sessionId, input, inputActions) => {
          const request = active
          if (!request || request.session_id !== sessionId || !['waiting_editor', 'retry'].includes(request.status) || !request.ref || !inputActions?.insertText) return
          if (receipts.has(request.ref.id)) { broker.ack(request); return }
          if (input.phase !== 'plain' || input.claim) return
          const occurrences = Array.isArray(input.occurrences) ? input.occurrences : []
          if (occurrences.length) { request.status = 'failed'; request.error = '草稿含引用，请先处理草稿后重试'; notify(); return }
          // With no chips, the public draft projection and TokenSpan share offsets.
          const end = String(input.draft || '').length
          const prefix = end ? '\n\n' : ''
          const marker = request.ref.marker || `[xcharts:${request.ref.id}]`
          if (String(input.draft || '').includes(marker)) { receipts.add(request.ref.id); broker.ack(request); return }
          request.status = 'delivering'; notify()
          const text = request.ref.marker ? `${prefix}${request.ref.prompt}` : `${prefix}关于卡片「${request.input.title || '分析卡片'}」${marker}：`
          const inserted = inputActions.insertText(text, { start: end, end, draftRev: input.draftRev })
          if (!inserted) { request.status = 'failed'; request.error = '草稿已变化，请重试'; notify(); return }
          // Synchronous local receipt prevents duplicate insertion before HTTP ack.
          receipts.add(request.ref.id)
          broker.ack(request)
        },
        ack: async request => {
          request.status = 'acknowledging'; notify()
          try {
            if (request.ref.marker) {
              await api('/usages', { method: 'POST', body: JSON.stringify({ reference: request.ref.marker, session_id: request.session_id }) })
            } else {
              await api(`/followups/${request.ref.id}/ack`, { method: 'POST', body: JSON.stringify({ session_id: request.session_id, status: 'attached' }) })
            }
            if (active !== request) return
            request.status = 'ready'; request.resolve(request.ref); notify()
          } catch (error) {
            if (active !== request) return
            request.status = 'failed'; request.error = `引用已追加，确认失败：${error.message}`; notify()
          }
        },
        retry: () => {
          if (!active) return
          if (active.ref && receipts.has(active.ref.id)) { broker.ack(active); return }
          if (active.ref) { active.status = 'retry'; active.error = ''; notify(); openSession(active.session_id) }
          else broker.start(active.session_id)
        },
        cancel: () => {
          if (!active) return
          active.status = 'cancelled'
          active.reject(new Error('已取消追问'))
          notify()
        },
        dispose: () => { if (active && !['ready', 'cancelled'].includes(active.status)) broker.cancel(); listeners.clear() },
      }
      return broker
    }

    function FollowupDock ({ broker, sessionId, input, inputActions }) {
      const [, refresh] = useState(0)
      useEffect(() => broker.subscribe(() => refresh(value => value + 1)), [broker])
      useEffect(() => { broker.observeSession(sessionId) }, [broker, sessionId])
      const request = broker.snapshot()
      useEffect(() => { if (input) broker.deliver(sessionId, input, inputActions) }, [broker, sessionId, input, inputActions, request?.status])
      return null
    }

    function FollowupOverlay ({ broker, useSessions: sessionsSelector }) {
      const sessionList = typeof sessionsSelector === 'function' ? sessionsSelector(value => value) : { byId: {} }
      const [, refresh] = useState(0)
      const [chosen, setChosen] = useState('')
      useEffect(() => broker.subscribe(() => refresh(value => value + 1)), [broker])
      const request = broker.snapshot()
      if (!request || ['ready', 'cancelled'].includes(request.status)) return null
      const sessions = Object.values(sessionList?.byId || {})
      const choose = !request.session_id && request.status === 'selecting'
      const waiting = ['waiting_editor', 'preparing', 'acknowledging', 'delivering', 'retry'].includes(request.status)
      const toReference = (request.input.kind ?? 'card') !== 'card'
      const options = sessions.map(item => ({ value: item.id || item.sessionId, label: item.title || item.cwd || item.id || item.sessionId }))
      const target = choose ? (chosen || broker.knownSession() || options[0]?.value || '') : request.session_id
      return h(Dialog, { title: toReference ? '引用到对话' : '追问卡片', onClose: broker.cancel,
        footer: [
          h('button', { key: 'cancel', type: 'button', style: S.btn, 'data-xc-reference-cancel': true, onClick: broker.cancel }, '取消'),
          choose
            ? h('button', { key: 'open', type: 'button', style: S.btnPrimary, 'data-xc-reference-insert': true, disabled: !target, onClick: () => broker.start(target) }, toReference ? '插入引用' : '打开会话')
            : h('button', { key: 'retry', type: 'button', style: S.btnPrimary, disabled: !request.ref && waiting, onClick: broker.retry }, waiting ? '继续' : '重试'),
        ],
      },
        choose ? h('div', null, h(SectionLabel, { label: '目标会话' }),
          h(Select, { value: target, options, onChange: setChosen, ariaLabel: '目标会话' })) : null,
        waiting ? h(StatusLine, { children: [toReference ? '正在准备会话…' : '正在准备编辑器…'] }) : null,
        request.error ? h(StatusLine, { tone: 'alert', children: [request.error] }) : null,
        request.ref ? h('button', { type: 'button', style: S.btn, onClick: async () => {
          try { await navigator.clipboard.writeText(request.ref.prompt); setChosen('已复制') }
          catch { setChosen('复制失败') }
        } }, chosen === '已复制' || chosen === '复制失败' ? chosen : '复制引用') : null)
    }
