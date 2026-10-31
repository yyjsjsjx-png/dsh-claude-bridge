import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolveDshModule } from '../../plugin/compat/resolve-dsh-module.mjs'

// Session.create alone does not perform the on-disk lifecycle checks.
export async function strictSession(session) {
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
  const { sessionFormatCatalog } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const { releasedV4SessionFormatCodec: codec } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href)
  const restore = sessionFormatCatalog.createRestore(codec.encodeHeader(session.header, 0),
    { recovery: 'strict', validation: 'current' })
  const events = session.snapshotEvents()
  for (const event of events) restore.decodeRow(codec.encodeEvent(event))
  const artifact = restore.finish()
  assert.equal(artifact.events.length, events.length)
  assert.equal(artifact.header.id, session.id)
  return artifact
}
