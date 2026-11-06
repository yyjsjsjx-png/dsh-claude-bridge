export const REMOTE_PROMPT_POLICY = 'remote-v1'

// Frozen first-party signatures, verified in desktop rc.5 b830ec9 and
// 0.2.2-rc.1 66491b0: system-prompt/src/index.ts and
// harness-dev-context/src/index.ts. Those text constants are not public exports.
// Unknown wording/metadata stays visible; names alone never establish ownership.
const HARNESS_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
const SOURCE_GUIDANCE = 'The checkout location and current working directory are separate values and may differ; '
  + 'never infer the working directory from the checkout path. Use pwd to determine the current working directory. '
  + 'Use this checkout only to inspect or extend DSH itself.'
const SOURCE_PROMPT = `The runtime context names the DeepSeek Harness implementation checkout. ${SOURCE_GUIDANCE}`
const WEB_GUIDANCE = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
  + 'The browser provides no implicit DOM, route, or screenshot context. '
  + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
  + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
  + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  + 'Starting another server does not update this GUI. '
  + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
  + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
const WEB_PROMPT = `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. ${WEB_GUIDANCE}`
const LEGACY_SOURCE_PREFIX = 'The DeepSeek Harness implementation checkout is at '
const LEGACY_SOURCE_SUFFIX = '. The checkout location and current working directory are separate values and may differ; '
  + 'never infer the working directory from this path. Use pwd to determine the current working directory. '
  + 'Use this checkout only to inspect or extend DSH itself.'
const LEGACY_WEB_PREFIX = 'You are interacting with the user through the DeepSeek Harness Web GUI at '

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

function nativeEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  // Native resolved rows contain only these fields. Custom origin/required or
  // other annotations are not discarded merely because their text is familiar.
  const fields = new Set(['name', 'text', 'interpolate'])
  const descriptors = Object.getOwnPropertyDescriptors(entry)
  if (Reflect.ownKeys(descriptors).some(key => !fields.has(key))) return false
  return typeof descriptors.name?.value === 'string' && typeof descriptors.text?.value === 'string'
    && (!descriptors.interpolate || Object.hasOwn(descriptors.interpolate, 'value'))
}

function canonicalStringBetween(text, prefix, suffix, kind) {
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return false
  const encoded = text.slice(prefix.length, text.length - suffix.length)
  let value
  try { value = JSON.parse(encoded) } catch { return false }
  if (typeof value !== 'string' || !value || JSON.stringify(value) !== encoded
    || value.includes('\r') || value.includes('\n') || value.includes('\0')) return false
  return kind === 'url' ? value.startsWith('http://') || value.startsWith('https://')
    : value.startsWith('/') || value.startsWith('\\\\')
      || value.length > 2 && value[1] === ':' && (value[2] === '/' || value[2] === '\\')
}

function firstPartySection(entry) {
  if (!nativeEntry(entry)) return false
  if (entry.name === 'harness:identity') return entry.interpolate === undefined && entry.text === HARNESS_IDENTITY
  if (entry.interpolate !== false) return false
  if (entry.name === 'harness:source') return entry.text === SOURCE_PROMPT
    || canonicalStringBetween(entry.text, LEGACY_SOURCE_PREFIX, LEGACY_SOURCE_SUFFIX, 'path')
  if (entry.name === 'app:web-surface') return entry.text === WEB_PROMPT
    || canonicalStringBetween(entry.text, LEGACY_WEB_PREFIX, `. ${WEB_GUIDANCE}`, 'url')
  return false
}

function firstPartyContext(entry) {
  if (!nativeEntry(entry) || entry.interpolate !== false) return false
  if (entry.name === 'harness:source') return canonicalStringBetween(entry.text,
    'Current DeepSeek Harness implementation checkout: ', '.', 'path')
  if (entry.name === 'app:web-surface') return canonicalStringBetween(entry.text,
    'Current DeepSeek Harness Web GUI URL: ', '.', 'url')
  return false
}

/** Remove only verified first-party scaffolding from a new-policy remote assembly. */
export function applyRemotePromptPolicy(assembly, policy) {
  if (policy === undefined || policy === 'legacy') return assembly
  if (policy !== REMOTE_PROMPT_POLICY) fail('REMOTE_PROMPT_POLICY_UNSUPPORTED', '不支持的远程提示策略。')
  if (!assembly || typeof assembly !== 'object') return assembly
  const descriptors = Object.getOwnPropertyDescriptors(assembly)
  let changed = false
  for (const [field, omit] of [['sections', firstPartySection], ['contexts', firstPartyContext]]) {
    const entries = assembly[field]
    if (!Array.isArray(entries)) continue
    const kept = entries.filter(entry => !omit(entry))
    if (kept.length === entries.length) continue
    // Preserve symbols, non-enumerable metadata, prototype and retained object
    // identities without mutating the native assembly or rewriting any text.
    descriptors[field] = { ...descriptors[field], value: kept }
    delete descriptors[field].get
    delete descriptors[field].set
    changed = true
  }
  if (!changed) return assembly
  const result = Object.create(Object.getPrototypeOf(assembly), descriptors)
  if (!Object.isExtensible(assembly)) Object.preventExtensions(result)
  return result
}
