/**
 * Date values in one place: what a text date looks like, what an Excel serial
 * number means, and how a date collapses to a day/month/quarter/year bucket.
 *
 * Stored form is ISO text (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss`): it sorts
 * lexicographically, survives JSON unchanged and groups with a slice.
 */
const PATTERNS = [
  // 2024-1-2, 2024/1/2, 2024.1.2, optionally with a time part
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/,
  // 2024年1月2日, optionally with a time part
  /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  // ISO datetime with a zone: keep the wall-clock date, drop the offset
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/,
]

const pad = value => String(value).padStart(2, '0')

function build (year, month, day, hour, minute, second) {
  const y = Number(year), mo = Number(month), d = Number(day)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (hour === undefined) {
    const probe = new Date(Date.UTC(y, mo - 1, d))
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
    return `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}`
  }
  const h = Number(hour), mi = Number(minute), s = Number(second ?? 0)
  if (h > 23 || mi > 59 || s > 59) return null
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`
}

/** Normalize a text date to ISO, or null when it is not a date. */
export function formatDateValue (value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19)
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  for (const pattern of PATTERNS) {
    const match = pattern.exec(text)
    if (match) return build(match[1], match[2], match[3], match[4], match[5], match[6])
  }
  return null
}

/** Excel serial day number to ISO; 25569 is 1970-01-01 in the 1900 system. */
export function excelSerialToDate (serial, date1904 = false) {
  if (typeof serial !== 'number' || !Number.isFinite(serial) || serial <= 0 || serial > 2958465) return null
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const at = new Date(base + Math.round(serial * 86400000))
  if (Number.isNaN(at.getTime())) return null
  const iso = at.toISOString()
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19)
}

/** Does an Excel number format describe a date (ignoring quoted literals)? */
export function isDateFormat (numFmt) {
  if (typeof numFmt !== 'string' || !numFmt) return false
  const plain = numFmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '')
  if (!/[ymd]/i.test(plain)) return false
  return !/^[@#0.,%]+$/.test(plain)
}

const GRANULARITIES = ['day', 'month', 'quarter', 'year']
export const GRANULARITY_LABELS = { day: '日', month: '月', quarter: '季', year: '年' }

export function isGranularity (value) { return GRANULARITIES.includes(value) }

/** Collapse an ISO date to the bucket key used by a grouping. */
export function dateBucket (value, granularity) {
  if (value === null || value === undefined) return value
  const text = String(value)
  if (!isGranularity(granularity) || granularity === 'day') return text.slice(0, 10)
  if (granularity === 'month') return text.slice(0, 7)
  if (granularity === 'year') return text.slice(0, 4)
  const month = Number(text.slice(5, 7))
  return `${text.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`
}
