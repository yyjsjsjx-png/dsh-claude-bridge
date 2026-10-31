import { deflateRaw, inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'

// Independent, stateless frames: no compression context is shared with auth.
export const COMPRESSION = 'deflate-raw-v1'
export const COMPRESSION_THRESHOLD = 2048
const MAGIC = Buffer.from('DSH1', 'ascii')
const HEADER_BYTES = 8
const compress = promisify(deflateRaw)
const decompress = promisify(inflateRaw)

/** Preserve already-compressed image/base64 blocks as plain text frames. */
function containsImage(bytes) {
  return bytes.includes(Buffer.from('"type":"image"')) || bytes.includes(Buffer.from('"type":"base64"'))
}

/** Return a text frame unless an independently compressed binary frame saves bytes. */
export async function encodeFrame(line, { enabled = false, maxLineBytes } = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError('消息大小限制无效')
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(line, 'utf8')
  if (bytes.length < 1 || bytes.length > maxLineBytes + 1) throw new Error('消息超过大小限制')
  if (!enabled || bytes.length < COMPRESSION_THRESHOLD || containsImage(bytes)) return bytes.toString('utf8')
  const packed = await compress(bytes, { level: 3 })
  // Save at least 64 bytes and 5%; avoid using CPU/bandwidth to enlarge a frame.
  if (packed.length + HEADER_BYTES + 64 >= bytes.length || (packed.length + HEADER_BYTES) * 100 >= bytes.length * 95) {
    return bytes.toString('utf8')
  }
  const header = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(header)
  header.writeUInt32BE(bytes.length, 4)
  return Buffer.concat([header, packed])
}

/** Inflate one negotiated binary frame without allowing an oversized allocation. */
export async function decodeFrame(frame, { enabled = false, maxLineBytes } = {}) {
  const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame)
  const originalBytes = compressedFrameSize(bytes, { enabled, maxLineBytes })
  const result = await decompress(bytes.subarray(HEADER_BYTES), { maxOutputLength: originalBytes, info: true })
  if (result.buffer.length !== originalBytes || result.engine.bytesWritten !== bytes.length - HEADER_BYTES) {
    throw new Error('压缩帧长度不匹配')
  }
  return result.buffer
}

/** Validate the header before queueing so compressed bombs count by expanded size. */
export function compressedFrameSize(frame, { enabled = false, maxLineBytes } = {}) {
  if (!enabled) throw new Error('未协商压缩')
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError('消息大小限制无效')
  const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame)
  if (bytes.length <= HEADER_BYTES || bytes.length > maxLineBytes + 1 || !bytes.subarray(0, 4).equals(MAGIC)) {
    throw new Error('压缩帧无效')
  }
  const originalBytes = bytes.readUInt32BE(4)
  if (originalBytes < 1 || originalBytes > maxLineBytes + 1) throw new Error('解压后消息超过大小限制')
  return originalBytes
}
