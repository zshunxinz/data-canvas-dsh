import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DataStore } from './data-store.js'

const EXAMPLE_FILE = fileURLToPath(new URL('../examples/retail-orders.csv', import.meta.url))
const MARKER = '.example-source-imported'
const EXAMPLE_NAME = '零售订单（示例）'

/**
 * 首次运行时把内置示例导入为普通数据源，用户打开插件就能直接查询。
 *
 * 幂等：标记文件存在、或已有一个 `bundled_example` 来源时不再导入；
 * 用户主动删除示例后也不会被重新塞回来。导入失败只记日志，不影响启动。
 */
export async function ensureExampleSource (root, logger) {
  try {
    mkdirSync(root, { recursive: true })
    const marker = join(root, MARKER)
    if (existsSync(marker)) return false
    if (!existsSync(EXAMPLE_FILE)) {
      logger?.warn?.(`[data-canvas-dsh] example dataset missing: ${EXAMPLE_FILE}`)
      writeFileSync(marker, new Date().toISOString(), 'utf8')
      return false
    }
    const store = new DataStore(root)
    const exists = store.list().some(item => item.source?.type === 'bundled_example')
    if (!exists) {
      const bytes = readFileSync(EXAMPLE_FILE)
      await store.import({
        name: EXAMPLE_NAME,
        filename: 'retail-orders.csv',
        content_base64: bytes.toString('base64'),
        source: { type: 'bundled_example', name: 'retail-orders' },
      })
      logger?.info?.(`[data-canvas-dsh] example datasource installed: ${EXAMPLE_NAME}`)
    }
    writeFileSync(marker, new Date().toISOString(), 'utf8')
    return !exists
  } catch (error) {
    logger?.warn?.(`[data-canvas-dsh] example datasource skipped: ${String(error?.message || error)}`)
    return false
  }
}
