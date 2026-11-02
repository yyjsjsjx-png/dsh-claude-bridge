const MAX_TITLE_POINTS = 200
const INVALID_TITLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

/** Read only the SDK's resolved native title. This never generates one or
 * substitutes summary/first-prompt text when the native title is not ready. */
export async function readSessionTitleMetadata({ sdk, sessionId, cwd, signal, timeoutMs = 1000 }) {
  if (signal?.aborted || typeof sdk?.getSessionInfo !== 'function') return undefined
  let timer, onAbort
  try {
    const stopped = new Promise(resolve => {
      timer = setTimeout(resolve, timeoutMs)
      onAbort = () => resolve(undefined)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    const reading = Promise.resolve().then(() => signal?.aborted ? undefined : sdk.getSessionInfo(sessionId, { dir: cwd }))
      .catch(() => undefined)
    const info = await Promise.race([reading, stopped])
    if (signal?.aborted || info?.sessionId !== sessionId) return undefined
    const title = info.customTitle
    if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_POINTS * 2
      || Array.from(title).length > MAX_TITLE_POINTS || INVALID_TITLE.test(title)) return undefined
    return title
  } catch { return undefined }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
