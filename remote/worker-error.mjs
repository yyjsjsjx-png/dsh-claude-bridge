/** A worker failure with a stable protocol code and an explicit unknown-outcome flag. */
export class WorkerError extends Error {
  constructor(code, message, { toolMayHaveExecuted = false } = {}) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.toolMayHaveExecuted = toolMayHaveExecuted
  }
}

/** Return a plain (non-array) object or throw INVALID_REQUEST. */
export function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerError('INVALID_REQUEST', `${name} 必须是对象`)
  }
  return value
}

/** Return a non-blank string within `maximum` UTF-8 bytes or throw INVALID_REQUEST. */
export function requireString(value, name, maximum = 4096) {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new WorkerError('INVALID_REQUEST', `${name} 无效`)
  }
  return value
}

/** Throw CANCELLED when the signal has already been aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new WorkerError('CANCELLED', '请求已取消')
}
