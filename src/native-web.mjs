import { isIP } from 'node:net'

export const NATIVE_WEB_TOOLS = Object.freeze(['WebSearch', 'WebFetch'])
export const DSH_WEB_TOOLS = Object.freeze(['web_search', 'web_fetch'])
export const isNativeWebTool = name => NATIVE_WEB_TOOLS.includes(name)

// Let Claude Code retain its own domain and redirect checks. This rejects
// explicit local destinations without claiming to isolate VPS DNS or egress.
export function nativeWebApprovalReason(name, input) {
  if (name === 'WebSearch') {
    return typeof input?.query === 'string' && input.query.trim() ? 'Claude Code 将向其网页搜索服务提交搜索词。' : null
  }
  if (name !== 'WebFetch' || typeof input?.url !== 'string') return null
  let url
  try { url = new URL(input.url) } catch { return null }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(host.replace(/^\[|\]$/g, ''))
    || !host.includes('.') || /\.(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host)) return null
  return 'Claude Code 将从远端读取网页：' + host
}

export function nativeWebResultText(value) {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (typeof text !== 'string') return null
  return text.length > 128_000 ? text.slice(0, 128_000) + '\n[网页工具展示已截断]' : text
}
