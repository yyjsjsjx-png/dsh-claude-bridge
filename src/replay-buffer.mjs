export const RECOVERY_PROTOCOL = 'resume-v1'
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sequence = value => Number.isSafeInteger(value) && value >= 0
const requestId = value => typeof value === 'string' && /^[0-9a-f-]{36}:[1-9][0-9]*$/i.test(value)
function invalid(code) { return Object.assign(new Error('连接恢复记录无效，执行状态需核实'), { code }) }

/** One live peer's bounded retransmission window. Never reissue an RPC call. */
export function createReplayBuffer({ maxLineBytes, maxBytes = maxLineBytes * 4, maxFrames = 4096, onLine }) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < maxLineBytes
    || !Number.isSafeInteger(maxFrames) || maxFrames < 1 || typeof onLine !== 'function') throw new TypeError('恢复缓冲配置无效')
  let outgoing = 0, transmitted = 0, acknowledged = 0, received = 0, bytes = 0
  const pending = new Map()

  function parse(line) {
    if (typeof line !== 'string' || !line.endsWith('\n') || line.indexOf('\n') !== line.length - 1
      || Buffer.byteLength(line) > maxLineBytes + 1) throw invalid('RECOVERY_FRAME_INVALID')
    let message
    try { message = JSON.parse(line) } catch { throw invalid('RECOVERY_FRAME_INVALID') }
    if (!record(message) || message.jsonrpc !== '2.0') throw invalid('RECOVERY_FRAME_INVALID')
    return message
  }
  function acknowledge(value) {
    if (!sequence(value) || value > transmitted || value < acknowledged) throw invalid('RECOVERY_ACK_INVALID')
    acknowledged = value
    for (const [id, frame] of pending) {
      if (id > value) break
      bytes -= frame.bytes; pending.delete(id)
    }
  }
  function enqueue(line) {
    const message = parse(line)
    if (Object.hasOwn(message, '_bridge')) throw invalid('RECOVERY_FRAME_INVALID')
    const size = Buffer.byteLength(line) + 128
    if (bytes + size > maxBytes || pending.size >= maxFrames || outgoing >= Number.MAX_SAFE_INTEGER) throw invalid('RECOVERY_BUFFER_FULL')
    const id = ++outgoing
    const frame = { id, message, bytes: size }
    // Reserve header space now; never silently discard an oversized frame.
    if (Buffer.byteLength(JSON.stringify({ ...message, _bridge: { sequence: id, ack: received } })) > maxLineBytes) {
      throw invalid('RECOVERY_FRAME_TOO_LARGE')
    }
    pending.set(id, frame); bytes += size
    return id
  }
  function* frames(after = acknowledged) {
    for (const [id, frame] of pending) if (id > after) {
      yield { id, line: JSON.stringify({ ...frame.message, _bridge: { sequence: id, ack: received } }) + '\n' }
    }
  }
  async function accept(line) {
    const message = parse(line)
    const header = message._bridge
    if (!record(header) || !sequence(header.sequence) || header.sequence < 1 || !sequence(header.ack)
      || Object.keys(header).some(key => !['sequence', 'ack'].includes(key))) throw invalid('RECOVERY_FRAME_INVALID')
    // A delayed duplicate may carry an older ACK, which never moves us back.
    if (header.ack > acknowledged) acknowledge(header.ack)
    if (header.sequence <= received) return false
    if (header.sequence !== received + 1) throw invalid('RECOVERY_SEQUENCE_GAP')
    delete message._bridge
    await onLine(JSON.stringify(message) + '\n', message)
    received = header.sequence
    return true
  }
  return {
    enqueue, frames, accept, acknowledge,
    markTransmitted(value) {
      if (!sequence(value) || value > outgoing) throw invalid('RECOVERY_ACK_INVALID')
      transmitted = Math.max(transmitted, value)
    },
    pendingCancels() {
      const ids = [...pending.values()].filter(frame => frame.message.method === '$/cancelRequest')
        .map(frame => frame.message.params?.id)
      if (ids.length > 128 || ids.some(id => !requestId(id))) throw invalid('RECOVERY_CANCEL_INVALID')
      return ids
    },
    get received() { return received },
    get acknowledged() { return acknowledged },
    get size() { return pending.size },
    get bytes() { return bytes },
  }
}

export function validatePriorityCancels(value) {
  if (!Array.isArray(value) || value.length > 128 || value.some(id => !requestId(id))) throw invalid('RECOVERY_CANCEL_INVALID')
  return [...new Set(value)]
}
