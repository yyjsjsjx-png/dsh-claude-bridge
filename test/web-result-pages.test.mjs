import test from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWebResultPages } from '../remote/web-result-pages.mjs'

test('only registered web output for the bound session can be read, with UTF-8 pages', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-web-pages-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configDir = join(root, 'config'), cwd = join(root, 'cwd'), sessionId = 'session-a'
  const folder = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'), sessionId, 'tool-results')
  await mkdir(folder, { recursive: true })
  await mkdir(cwd)
  const pages = createWebResultPages({ configDir, cwd, sessionId })
  const callId = 'toolu_fixture', file = join(folder, callId + '.txt')
  const text = 'x'.repeat(4094) + '汉字😀' + ' beyond preview'
  const marker = path => '<persisted-output>\nOutput too large (52KB). Full output saved to: ' + path + '\n\nPreview\n</persisted-output>'
  await writeFile(file, text)
  assert.equal(await pages.read({ callId }), null)
  assert.equal(await pages.register('../toolu_fixture'), false)
  assert.equal(await pages.register(callId, marker(file + '.other')), false)
  assert.equal(await pages.register(callId, marker(file)), true)
  const first = await pages.read({ callId })
  assert.equal(first.nextOffset, 4094)
  const second = await pages.read({ callId, offset: first.nextOffset })
  assert.equal(first.content + second.content, text)
  assert.equal(second.nextOffset, null)
  assert.equal(await pages.read({ callId, offset: 4095 }), null)
  assert.equal(await createWebResultPages({ configDir, cwd, sessionId: 'session-b' }).read({ callId }), null)
  await link(file, join(folder, 'toolu_link.txt'))
  assert.equal(await pages.register('toolu_link', marker(join(folder, 'toolu_link.txt'))), false)
  assert.equal(await pages.read({ callId }), null)
  await rm(join(folder, 'toolu_link.txt'))
  await writeFile(file, 'changed')
  assert.equal(await pages.read({ callId }), null)
})
