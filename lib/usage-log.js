import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Append one usage fact (reference, action, session). Append-only, month files,
 * never carries data rows, and never fails the operation that produced it.
 */
export function appendUsage (root, record) {
  try {
    const dir = join(root, 'usages')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${record.at.slice(0, 7)}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
  } catch { /* an audit trail must not break the action */ }
  return record
}
