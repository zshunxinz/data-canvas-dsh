import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = join(root, 'client-src')
const outputFile = join(root, 'client.js')
const sections = [
  '00-entry.js',
  '01-bootstrap.js',
  '02-theme-locale.js',
  '03-api-export.js',
  '04-styles-icons.js',
  '04b-ui-kit.js',
  '05-card-rendering.js',
  '06-card-interactions.js',
  '06b-trace-ui.js',
  '06c-followup-ui.js',
  '06d-changelog-ui.js',
  '06e-storage-ui.js',
  '06f-settings-ui.js',
  '06g-backup-ui.js',
  '07-canvas-workspace.js',
  '08-datasource-query.js',
  '09a-data-table.js',
  '09-data-sources.js',
  '09b-tool-view.js',
  '09c-database-ui.js',
  '10-plugin-registration.js',
  '99-exit.js',
]

const source = (await Promise.all(sections.map(async section => {
  const text = await readFile(join(sourceDirectory, section), 'utf8')
  return `// ── ${section} ─────────────────────────────────────────────────────────\n${text.trimEnd()}`
}))).join('\n\n')

await writeFile(outputFile, `${source}\n`, 'utf8')
console.log(`Built client.js from ${sections.length} source sections.`)
