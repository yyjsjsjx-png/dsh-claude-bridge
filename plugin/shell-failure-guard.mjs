/** Preserve structured process-start failures before rc.5 Tools normalizes them. */
async function usableWorkdir(ctx, args, exec) {
  try {
    const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    const target = await ctx.fs.resolve(args.workdir ?? cwd, { cwd, signal: exec.signal });
    return (await ctx.fs.stat(target, exec.signal))?.type === 'directory';
  } catch { return false; }
}

export function installShellFailureGuard(ctx, shell, scope, HarnessError) {
  const wrapped = new WeakSet();
  const restorers = [];
  const wrap = () => {
    const tool = ctx.tools.get(shell, scope);
    // Never change a globally registered tool used by ordinary sessions.
    if (!tool || tool === ctx.tools.get(shell) || wrapped.has(tool)) return;
    const original = tool.execute;
    const execute = async function (args, exec) {
      try { return await original.call(this, args, exec); }
      catch (error) {
        // A late preparation rejection must not replace the user's cancellation.
        exec.signal?.throwIfAborted();
        if (['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(error?.code)
          && typeof error.syscall === 'string' && error.syscall.startsWith('spawn')
          // Node reports a missing cwd as spawn ENOENT too. An unverified
          // per-call directory must not poison the session's shell health.
          && (args.workdir === undefined || error.code === 'ENOENT' || error.code === 'ENOEXEC')
          && await usableWorkdir(ctx, args, exec)) {
          exec.signal?.throwIfAborted();
          throw new HarnessError(`基础 ${shell} 进程无法启动（${error.code}）；远程会话插件不可用，请修复后重载。`,
            'REMOTE_SHELL_EXECUTOR_FAILED', { cause: error });
        }
        exec.signal?.throwIfAborted();
        throw error;
      }
    };
    tool.execute = execute;
    wrapped.add(tool);
    restorers.push(() => { if (tool.execute === execute) tool.execute = original; });
  };
  wrap();
  // The native shell tool re-registers when the optional jobs service changes.
  const off = ctx.on('tools/change', wrap);
  return () => { off(); for (const restore of restorers) restore(); };
}
