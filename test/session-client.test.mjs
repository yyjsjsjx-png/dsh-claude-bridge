import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('会话客户端壳注册原版 DSH 客户端和相同包身份', async () => {
  const base = new URL('../plugin/session-client/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
  const provenance = JSON.parse(await readFile(new URL('provenance.json', base), 'utf8'));
  const bytes = await readFile(new URL('client.js', base));
  assert.equal(manifest.name, '@deepseek-ai/dsh-api-session-controller');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.deepEqual(manifest.dsh.client.external, ['@deepseek-ai/dsh-api-gateway/client']);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.clientSha256);
  let entry;
  vm.runInNewContext(bytes.toString('utf8'), { window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  assert.equal(entry.id, manifest.name);
  assert.equal(typeof entry.factory, 'function');
});
