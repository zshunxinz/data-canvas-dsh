    // ── Settings dialog: the Harness layout, scoped to this plugin ───────────
    //
    // A left rail names the sections and the right pane holds rows of
    // label/hint + control, one divider per row. It is deliberately the same
    // shape as the host's settings dialog, so switching between them does not
    // ask the user to learn a second layout.

    /** One settings row: label and hint on the left, control on the right. */
    function SettingsRow ({ label, hint, control, children }) {
      return h('div', {
        'data-xc-settings-row': true,
        style: {
          display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0',
          borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))', minWidth: 0,
        },
      },
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', { style: { fontSize: FS } }, label),
        hint ? h('div', { style: { ...S.mutedSmall, marginTop: '2px' } }, hint) : null),
      control || children || null)
    }

    /** A switch that reads as a switch: role, state, disabled, keyboard. */
    function SettingSwitch ({ checked, disabled = false, onChange, dataAttrs = {} }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false', checked, disabled,
        ...dataAttrs,
        style: {
          flex: '0 0 auto', width: '38px', height: '22px', borderRadius: '11px', border: 'none', padding: '2px',
          cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
          background: checked ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.45))',
          display: 'flex', alignItems: 'center', justifyContent: checked ? 'flex-end' : 'flex-start',
          transition: 'background .15s ease',
        },
        onClick: () => { if (!disabled) onChange(!checked) },
      }, h('span', { style: { width: '18px', height: '18px', borderRadius: '50%', background: 'var(--dsw-alias-bg-base, #fff)', boxShadow: '0 1px 2px rgba(0,0,0,.25)' } }))
    }

    function CanvasSettingsDialog ({ t, settings, error, saving, onChange, onResetZoom, changelog, onImported, onClose }) {
      const [pane, setPane] = useState('display')
      const [changelogOpen, setChangelogOpen] = useState(false)
      const sections = [
        { id: 'display', label: t('settings.display') },
        { id: 'backup', label: t('settings.backup') },
        { id: 'storage', label: t('settings.storage') },
        { id: 'about', label: t('settings.about') },
      ]
      const display = h('div', { 'data-xc-settings-pane': 'display' },
        error ? h('div', { style: { ...S.errorBox, marginBottom: '8px' } }, error) : null,
        h(SettingsRow, { label: t('canvas.snap'), hint: t('settings.snapHint'), control: h(SettingSwitch, { checked: settings.snap, disabled: saving, onChange: value => onChange('snap', value), dataAttrs: { 'data-xc-setting': 'snap' } }) }),
        h(SettingsRow, { label: t('canvas.wide'), hint: t('settings.wideHint'), control: h(SettingSwitch, { checked: settings.wide, disabled: saving, onChange: value => onChange('wide', value), dataAttrs: { 'data-xc-setting': 'wide' } }) }),
        h(SettingsRow, { label: t('canvas.badges'), hint: t('settings.badgesHint'), control: h(SettingSwitch, { checked: settings.badges, disabled: saving, onChange: value => onChange('badges', value), dataAttrs: { 'data-xc-setting': 'badges' } }) }),
        h(SettingsRow, { label: t('canvas.resetZoom'), hint: t('settings.resetZoomHint'), control: h('button', { type: 'button', style: S.btn, 'data-xc-reset-zoom': true, onClick: onResetZoom }, t('canvas.resetZoom')) }))
      const about = h('div', { 'data-xc-settings-pane': 'about' },
        h(SettingsRow, {
          label: t('settings.version'),
          control: changelog?.current_version
            ? h('span', { 'data-xc-version': changelog.current_version, style: S.mutedSmall }, `v${changelog.current_version}`)
            : h('span', { style: S.mutedSmall }, '—'),
        }),
        h(SettingsRow, {
          label: t('settings.changelog'), hint: t('settings.changelogHint'),
          control: changelog
            ? h('button', { type: 'button', style: S.btn, 'data-xc-changelog': true, onClick: () => setChangelogOpen(true) }, t('settings.changelog'))
            : h('span', { style: S.mutedSmall }, '—'),
        }),
        h(SettingsRow, { label: t('settings.changelogFile'), control: h('span', { style: S.mutedSmall }, 'CHANGELOG.md') }),
        h(SettingsRow, { label: t('settings.export'), hint: t('settings.exportHint') }))
      return h(Dialog, {
        title: t('canvas.settings'), onClose, closeLabel: t('canvas.close'),
        width: 'min(920px, 94vw)', height: 'min(620px, 88vh)',
      },
      h('div', { 'data-xc-settings-body': true, style: {
        display: 'flex', height: '100%', minHeight: 0, margin: '-16px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))', borderRadius: RADIUS.md, overflow: 'hidden',
      } },
      h('nav', { 'aria-label': t('canvas.settings'), style: {
        flex: '0 0 168px', display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 8px',
        borderRight: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
      } },
      ...sections.map(section => h('button', {
        key: section.id, type: 'button', 'data-xc-settings-nav': section.id,
        'aria-current': pane === section.id ? 'page' : undefined,
        style: {
          ...S.btn, justifyContent: 'flex-start', height: '34px', border: 'none',
          background: pane === section.id ? 'color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)' : 'transparent',
          fontWeight: pane === section.id ? 500 : 'normal',
        },
        onClick: () => setPane(section.id),
      }, section.label))),
      h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto', padding: '12px 18px' }, 'data-xc-settings-content': pane },
        pane === 'display' ? display : pane === 'backup' ? h('div', { 'data-xc-settings-pane': 'backup' }, h(BackupSection, { t, onImported })) : pane === 'storage' ? h('div', { 'data-xc-settings-pane': 'storage' }, h(StorageSection, { t })) : about),
      changelogOpen ? h(ChangelogDialog, { data: changelog, onClose: () => setChangelogOpen(false) }) : null))
    }
