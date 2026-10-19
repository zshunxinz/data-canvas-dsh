    // ── Storage: where the data lives, and how to reclaim it ────────────────
    //
    // The path always comes from the host response, never from this file: the same
    // plugin installed on another machine shows that machine's storage root
    // (`$DSH_HOME/storages/xcharts-canvas`, or the configured `storagePath`).
    const STORAGE_LABELS = {
      canvases: '画布', datasources: '数据源', results: '查询结果', history: '撤销历史',
      inputs: '版本快照', executions: '调用证据', followups: '追问引用', usages: '使用记录',
    }
    function formatStorageBytes (bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = bytes / 1024, index = 0
      while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
    }

    /** Storage pane of the settings dialog: location, per-directory size, safe cleanups. */
    function StorageSection ({ t = key => key } = {}) {
      const [usage, setUsage] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [confirm, setConfirm] = useState(null)
      const [copied, setCopied] = useState(false)
      const load = () => {
        getStorage().then(payload => setUsage(payload)).catch(loadError => setError('读取存储信息失败：' + loadError.message))
      }
      useEffect(() => { load() }, [])
      const run = async target => {
        setBusy(true); setError(''); setNotice('')
        try {
          const payload = await cleanStorage(target)
          setUsage(payload.storage)
          setNotice(`已清理${payload.label}，释放 ${formatStorageBytes(payload.freed_bytes)}`)
        } catch (cleanError) { setError('清理失败：' + cleanError.message) } finally { setBusy(false) }
      }
      return h('div', { 'data-xc-storage': true, style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
        h(SettingsRow, {
          label: t('settings.storagePath'),
          hint: usage ? (usage.source === 'custom' ? t('settings.customPath') : t('settings.defaultPath')) : t('settings.loading'),
          control: h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '58%' } },
            h('span', { 'data-xc-storage-path': usage?.storage_path || '', title: usage?.storage_path || '', style: { ...S.mutedSmall, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' } }, usage?.storage_path || ''),
            usage
              ? h('button', {
                type: 'button', 'data-xc-storage-copy': true, disabled: busy,
                style: { ...S.btn, height: 24, fontSize: '12px', flex: '0 0 auto' },
                onClick: async () => {
                  try { await navigator.clipboard.writeText(usage.storage_path); setCopied(true) } catch { setCopied(false) }
                },
              }, copied ? t('settings.copied') : t('settings.copy'))
              : null),
        }),
        h(SettingsRow, {
          label: '占用合计',
          hint: usage ? `${usage.total_files} 个文件` : '',
          control: h('span', { 'data-xc-storage-total': usage?.total_bytes ?? 0, style: S.mutedSmall }, usage ? formatStorageBytes(usage.total_bytes) : '—'),
        }),
        usage
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 } },
            ...usage.directories.filter(directory => directory.files).map(directory => h('div', { key: directory.name, 'data-xc-storage-dir': directory.name, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' } },
              h('span', { style: { ...S.mutedSmall, flex: '1 1 auto', minWidth: 0 } }, STORAGE_LABELS[directory.name] || directory.name),
              h('span', { style: { ...S.mutedSmall, flex: '0 0 auto' } }, formatStorageBytes(directory.bytes)))))
          : null,
        usage
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4 } },
            ...usage.cleanable.map(item => h('button', {
              key: item.target, type: 'button', 'data-xc-storage-clean': item.target, disabled: busy,
              style: { ...S.btn, height: 26, fontSize: '12px' },
              onClick: () => setConfirm(item),
            }, `清理${item.label}`)))
          : null,
        error ? h(StatusLine, { tone: 'alert' }, error) : null,
        notice ? h(StatusLine, { 'data-xc-storage-notice': true }, notice) : null,
        confirm
          ? h(ConfirmDialog, {
            title: `清理${confirm.label}`, tone: 'danger', confirmLabel: '清理', cancelLabel: '取消',
            onConfirm: () => { const target = confirm.target; setConfirm(null); run(target) },
            onCancel: () => setConfirm(null),
          }, h('div', { style: { lineHeight: 1.6 } }, `${confirm.hint}。此操作不可撤销。`))
          : null)
    }