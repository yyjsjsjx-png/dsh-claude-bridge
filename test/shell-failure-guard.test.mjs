import test from 'node:test';
import assert from 'node:assert/strict';
import { installShellFailureGuard } from '../plugin/shell-failure-guard.mjs';
import { shellInfrastructureFailure } from '../src/remote-capabilities.mjs';

test('远程 shell 保留启动故障码，普通工具不受影响，重注册及卸载可恢复', async () => {
  const raw = Object.assign(new Error('process-start-failed'), { code: 'ENOENT', syscall: 'spawn pwsh.exe' });
  const execute = async () => { throw raw; };
  const globalTool = { execute };
  let ownTool = { execute }, changed;
  class HarnessError extends Error { constructor(message, code) { super(message); this.code = code; } }
  const ctx = { tools: { get: (_name, scope) => scope ? ownTool : globalTool },
    workingDirectory: { ensure: async () => 'workspace' },
    fs: { resolve: async () => ({}), stat: async () => ({ type: 'directory' }) },
    on: (_event, fn) => { changed = fn; return () => { changed = undefined; }; } };
  const dispose = installShellFailureGuard(ctx, 'pwsh', {}, HarnessError);
  await assert.rejects(ownTool.execute({}, {}), { code: 'REMOTE_SHELL_EXECUTOR_FAILED' });
  await assert.rejects(globalTool.execute({}, {}), error => error === raw);
  assert.equal(shellInfrastructureFailure('pwsh', { error: { info: { code: 'REMOTE_SHELL_EXECUTOR_FAILED' } } }, 'pwsh').code,
    'REMOTE_SHELL_UNAVAILABLE');
  const previous = ownTool;
  ownTool = { execute }; changed();
  await assert.rejects(ownTool.execute({}, {}), { code: 'REMOTE_SHELL_EXECUTOR_FAILED' });
  dispose();
  assert.equal(previous.execute, execute);
  assert.equal(ownTool.execute, execute);
});

test('普通命令、工作目录、审批与取消错误原样传播', async () => {
  for (const error of [new Error('invalid command'), { code: 'ENOENT', syscall: 'stat' }, { code: 'TOOL_ABORTED' }]) {
    const tool = { execute: async () => { throw error; } };
    const ctx = { tools: { get: (_name, scope) => scope ? tool : undefined }, on: () => () => {} };
    const dispose = installShellFailureGuard(ctx, 'pwsh', {}, Error);
    await assert.rejects(tool.execute({}, {}), thrown => thrown === error);
    dispose();
  }
});

test('spawn ENOENT 也可能来自错误工作目录，无法核实时不锁死 shell', async () => {
  const error = Object.assign(new Error('spawn failure'), { code: 'ENOENT', syscall: 'spawn pwsh.exe' });
  const tool = { execute: async () => { throw error; } };
  const ctx = { tools: { get: (_name, scope) => scope ? tool : undefined }, on: () => () => {},
    workingDirectory: { ensure: async () => 'workspace' },
    fs: { resolve: async () => ({}), stat: async () => undefined },
  };
  const dispose = installShellFailureGuard(ctx, 'pwsh', {}, Error);
  await assert.rejects(tool.execute({ workdir: 'missing-directory' }, {}), thrown => thrown === error);
  dispose();
});

test('ACL 准备与沙箱不可用属于原生环境错误，不标记插件不可用', async () => {
  const aclError = Object.assign(new Error('任意不匹配文案'), {
    name: 'Win32Error', api: 'SetNamedSecurityInfoW', win32Code: 5,
  });
  for (const error of [
    aclError,
    Object.assign(new Error('无关内容'), { name: 'Win32Error', api: 'GetNamedSecurityInfoW', win32Code: 5 }),
    Object.assign(new Error('原生沙箱环境不可用'), { name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' }),
    new Error('SetNamedSecurityInfoW failed (Win32 5): grantWrite(workspace)'),
    Object.assign(new Error('用户命令失败'), { name: 'Win32Error', api: 'CreateFileW', win32Code: 5 }),
    Object.assign(new Error('不完整结构'), { name: 'Win32Error', api: 'SetNamedSecurityInfoW' }),
    Object.assign(new Error('审批拒绝'), { code: 'DENIED' }),
  ]) {
    const tool = { execute: async () => { throw error; } };
    const ctx = { tools: { get: (_name, scope) => scope ? tool : undefined }, on: () => () => {} };
    const dispose = installShellFailureGuard(ctx, 'pwsh', {}, Error);
    await assert.rejects(tool.execute({}, {}), result => result === error);
    assert.equal(shellInfrastructureFailure('pwsh', error, 'pwsh'), undefined);
    dispose();
  }
});

test('取消后迟到的 ACL 准备失败保留用户取消原因', async () => {
  const cancellation = new DOMException('用户停止', 'AbortError');
  const abort = new AbortController();
  const error = Object.assign(new Error('准备失败'), {
    name: 'Win32Error', api: 'SetNamedSecurityInfoW', win32Code: 5,
  });
  const tool = { execute: async () => { abort.abort(cancellation); throw error; } };
  const ctx = { tools: { get: (_name, scope) => scope ? tool : undefined }, on: () => () => {} };
  const dispose = installShellFailureGuard(ctx, 'pwsh', {}, Error);
  await assert.rejects(tool.execute({}, { signal: abort.signal }), result => result === cancellation);
  dispose();
});
