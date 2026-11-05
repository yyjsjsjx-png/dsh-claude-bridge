import test from 'node:test';
import assert from 'node:assert/strict';
import { guardNativeSubagentSettings } from '../plugin/presets/subagent-settings.mjs';

test('仅过滤原生设置自己的远程created回调，保留普通回调this、options和disposer', () => {
  const callbacks = [], calls = [], disposer = () => true, options = { prepend: true };
  const entry = {}, events = { on(event, listener, supplied) { callbacks.push({ event, listener, supplied }); return disposer; } };
  const ctx = { events, fiber: { entry, parent: { fiber: {} } } };
  const first = guardNativeSubagentSettings(ctx, entry), on = ctx.on;
  const second = guardNativeSubagentSettings(ctx, entry);
  const other = () => {}, carrier = {};
  assert.equal(ctx.on('agent/created', function (payload) { calls.push([this, payload]); }, options), disposer);
  ctx.on('other/event', other);
  assert.equal(callbacks[0].supplied, options); assert.equal(callbacks[1].listener, other);
  const remote = { agent: { session: { header: { agentPreset: 'claude-sdk-remote' } } } };
  assert.equal(callbacks[0].listener.call(carrier, remote), undefined);
  const ordinary = { agent: { session: { header: { agentPreset: 'standard' } } } };
  callbacks[0].listener.call(carrier, ordinary);
  assert.deepEqual(calls, [[carrier, ordinary]]);
  first(); first(); assert.equal(ctx.on, on);
  second(); assert.equal(Object.hasOwn(ctx, 'on'), false);
});
