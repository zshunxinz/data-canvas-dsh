    // ── Recent updates: the bundled changelog, one click away ───────────────
    //
    // A plugin installed from a folder has no "what's new" surface: the package
    // description is a single npm line, and the user is not going to open the
    // repository. So the changelog that ships with the package is served by the
    // host and shown in a dialog from both workspaces. One fetch per page load,
    // shared through a module cache; a host without the route simply shows the
    // version line without the button.
    const CHANGELOG = { data: null, promise: null }
    function loadChangelog (limit = 3) {
      if (CHANGELOG.data) return Promise.resolve(CHANGELOG.data)
      if (!CHANGELOG.promise) {
        CHANGELOG.promise = getChangelog(limit)
          .then(payload => { CHANGELOG.data = payload; return payload })
          .catch(error => { CHANGELOG.promise = null; throw error })
      }
      return CHANGELOG.promise
    }
    function useChangelog (limit = 3) {
      const [data, setData] = useState(CHANGELOG.data)
      useEffect(() => {
        if (CHANGELOG.data) return undefined
        let alive = true
        loadChangelog(limit).then(payload => { if (alive) setData(payload) }).catch(() => { /* version line only */ })
        return () => { alive = false }
      }, [limit])
      return data
    }
    function ChangelogDialog ({ data, onClose }) {
      const entries = data?.entries || []
      return h(Dialog, { title: '最近更新', onClose, closeLabel: '关闭', large: true },
        h('div', { 'data-xc-changelog-dialog': true, style: { display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 6 } },
          entries.map(entry => h('div', { key: entry.version, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
            h('div', { style: { fontSize: '12px', fontWeight: 500 } }, `v${entry.version}${entry.date ? ` · ${entry.date}` : ''}`),
            ...entry.lines.map((line, index) => h('div', { key: index, style: { ...S.mutedSmall, lineHeight: 1.6 } }, line)))),
          entries.length ? null : h('div', { style: S.mutedSmall }, '没有可显示的更新记录。'),
          data?.current_version ? h('div', { style: { ...S.mutedSmall, paddingTop: 4 } }, `当前版本 v${data.current_version}`) : null))
    }
    /** Version line + 「最近更新」 entry, shared by both workspaces. */
    function ChangelogControl ({ data, buttonProps = {} }) {
      const [open, setOpen] = useState(false)
      const version = data?.current_version
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
        version ? h('span', { style: S.mutedSmall, 'data-xc-version': version }, `v${version}`) : null,
        version ? h('button', { type: 'button', style: { ...S.btn, height: 24, fontSize: '12px' }, 'data-xc-changelog': true, ...buttonProps, onClick: () => setOpen(true) }, '最近更新') : null,
        open ? h(ChangelogDialog, { data, onClose: () => setOpen(false) }) : null)
    }
