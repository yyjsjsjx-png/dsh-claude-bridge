import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
  const configuredRoot = join(root, 'configured')
  await symlink(configDir, configuredRoot, 'junction')
  const pages = createWebResultPages({ configDir: configuredRoot, cwd, sessionId })
  const callId = 'toolu_fixture', file = join(folder, callId + '.txt')
  const text = 'x'.repeat(4094) + '汉字😀' + ' beyond preview'
  const marker = path => '<persisted-output>\nOutput too large (52KB). Full output saved to: ' + path + '\n\nPreview\n</persisted-output>'
  await writeFile(file, text)
  assert.equal(await pages.read({ callId }), null)
  assert.equal(await pages.read({ callId, query: '汉字' }), null)
  assert.equal(await pages.register('../toolu_fixture'), false)
  assert.equal(await pages.register(callId, marker(file + '.other')), false)
  assert.equal(await pages.register(callId, marker(file)), true)
  const first = await pages.read({ callId })
  assert.equal(first.nextOffset, 4094)
  const second = await pages.read({ callId, offset: first.nextOffset })
  assert.equal(first.content + second.content, text)
  assert.equal(second.nextOffset, null)
  const search = await pages.read({ callId, query: 'x汉字😀' })
  assert.equal(search.matches.length, 1)
  assert.equal(search.matches[0].offset, 4093)
  assert.match(search.matches[0].snippet, /x汉字😀 beyond preview/)
  assert.equal((await pages.read({ callId, offset: search.matches[0].offset })).content, 'x汉字😀 beyond preview')
  assert.deepEqual((await pages.read({ callId, query: 'Beyond' })).matches, [])
  assert.equal(await pages.read({ callId, query: '汉'.repeat(43) }), null)
  const repeated = await pages.read({ callId, query: 'x' })
  assert.equal(repeated.matches.length, 8)
  assert.equal(repeated.nextOffset, 8)
  assert.equal((await pages.read({ callId, query: 'x', offset: repeated.nextOffset })).matches[0].offset, 8)
  const withoutMarker = 'toolu_hash'
  await writeFile(join(folder, withoutMarker + '.txt'), text)
  assert.equal(await pages.register(withoutMarker, {}, 'wrong-hash'), false)
  assert.equal(await pages.register(withoutMarker, {}, createHash('sha256').update(text).digest('hex')), true)
  assert.equal((await pages.read({ callId: withoutMarker, offset: first.nextOffset })).content, second.content)
  assert.equal(await pages.read({ callId, offset: 4095 }), null)
  assert.equal(await createWebResultPages({ configDir, cwd, sessionId: 'session-b' }).read({ callId, query: '汉字' }), null)
  await link(file, join(folder, 'toolu_link.txt'))
  assert.equal(await pages.register('toolu_link', marker(join(folder, 'toolu_link.txt'))), false)
  assert.equal(await pages.read({ callId }), null)
  await rm(join(folder, 'toolu_link.txt'))
  const otherSession = join(folder, '..', '..', 'session-b')
  await symlink(join(folder, '..'), otherSession, 'junction')
  const throughLink = createWebResultPages({ configDir: configuredRoot, cwd, sessionId: 'session-b' })
  assert.equal(await throughLink.register(callId, {}, createHash('sha256').update(text).digest('hex')), false)
  await writeFile(file, 'changed')
  assert.equal(await pages.read({ callId }), null)
  assert.equal(await pages.read({ callId, query: 'changed' }), null)
})
