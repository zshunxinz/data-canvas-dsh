    // ── Backup: one file for every canvas and layout template ────────────────
    //
    // Export is a real download of the workspace bundle the host produces;
    // import is a real POST that creates new canvases/templates (never replaces
    // an existing one). Raw data-source tables are not part of the bundle: a
    // canvas keeps its card data inline, and tables are re-imported from files.
    function downloadWorkspaceBackup (bundle) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `xcharts-backup-${stamp}.json`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function BackupSection ({ t = key => key, onImported }) {
      const inputRef = useRef(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [confirm, setConfirm] = useState(null)
      const exportBackup = async () => {
        if (busy) return
        setBusy(true); setError(''); setNotice('')
        try {
          const bundle = await getWorkspaceBackup()
          downloadWorkspaceBackup(bundle)
          setNotice(`${t('settings.backupExported')} · ${bundle.canvas_count ?? 0} ${t('settings.backupCanvases')} · ${bundle.template_count ?? 0} ${t('settings.backupTemplates')}`)
        } catch (exportError) { setError(`${t('settings.backupExportFailed')}：${exportError.message}`) } finally { setBusy(false) }
      }
      const runImport = async file => {
        setBusy(true); setError(''); setNotice('')
        try {
          if (file.size > 8 * 1024 * 1024) throw new Error(t('settings.backupTooLarge'))
          const bundle = JSON.parse(await file.text())
          const result = await importWorkspaceBackup(bundle)
          const imported = result.imported.length + result.imported_templates.length
          setNotice(`${t('settings.backupImported')} · ${result.imported.length} ${t('settings.backupCanvases')} · ${result.imported_templates.length} ${t('settings.backupTemplates')}${result.failed.length ? ` · ${result.failed.length} ${t('settings.backupSkipped')}` : ''}`)
          if (imported && typeof onImported === 'function') await onImported()
        } catch (importError) { setError(`${t('settings.backupImportFailed')}：${importError.message}`) } finally { setBusy(false) }
      }
      const pickImport = () => inputRef.current?.click?.()
      const onFile = event => {
        const input = event.currentTarget
        const file = input.files?.[0]
        input.value = ''
        if (!file) return
        setConfirm({ file, name: file.name })
      }
      return h('div', { 'data-xc-backup': true, style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h(SettingsRow, {
          label: t('settings.backupExport'),
          hint: t('settings.backupExportHint'),
          control: h('button', { type: 'button', style: S.btn, 'data-xc-backup-export': true, disabled: busy, onClick: () => { exportBackup() } }, t('settings.backupExport')),
        }),
        h(SettingsRow, {
          label: t('settings.backupImport'),
          hint: t('settings.backupImportHint'),
          control: h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('button', { type: 'button', style: S.btn, 'data-xc-backup-import': true, disabled: busy, onClick: pickImport }, t('settings.backupImport')),
            h('input', {
              type: 'file', accept: '.json,application/json', ref: inputRef, 'data-xc-backup-input': true,
              style: { display: 'none' }, onChange: onFile,
            })),
        }),
        h(SettingsRow, { label: t('settings.backupScope'), hint: t('settings.backupNote') }),
        busy ? h(StatusLine, { children: [t('settings.backupWorking')] }) : null,
        error ? h(StatusLine, { tone: 'alert' }, error) : null,
        notice ? h(StatusLine, { 'data-xc-backup-notice': true }, notice) : null,
        confirm
          ? h(ConfirmDialog, {
            title: t('settings.backupImport'), tone: 'normal', confirmLabel: t('settings.backupImport'), cancelLabel: t('settings.cancel'),
            onConfirm: () => { const file = confirm.file; setConfirm(null); runImport(file) },
            onCancel: () => setConfirm(null),
          }, h('div', { style: { lineHeight: 1.6 } },
            `${t('settings.backupImportConfirm')}`,
            h('div', { style: { ...S.mutedSmall, marginTop: '4px', overflowWrap: 'anywhere' } }, confirm.name)))
          : null)
    }
