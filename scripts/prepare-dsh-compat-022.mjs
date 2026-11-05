/** Reproduce the two reviewed seams in the official 0.2.2-rc.1 AgentLoop. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readArchiveEntries, adaptAgentLoop } from './prepare-dsh-compat.mjs';

export const DESKTOP_022_PROFILE = Object.freeze({
  sourceSha256: 'a6fa8e0c7c90191caf5f4a3bb5c624a86e9845cf3c79d020b71420d0e20ae4c1',
  construction: 'const created = machine = new ReactLoopAgent(loopCtx, id, agentOptions, session, projections, lastTurn);',
  replacement: 'const created = machine = createClaudeLoopAgent(ReactLoopAgent, loopCtx, id, agentOptions, session, projections, lastTurn);',
  stepEnd: 'this.session.append("step/end", {\n\t\t\t\t\t\t\tturn,\n\t\t\t\t\t\t\tstep\n\t\t\t\t\t\t});',
  imports: "import '../check-host.mjs';\nimport { resolveDshModule } from '../resolve-dsh-module.mjs';\nimport { createClaudeLoopAgent } from '../../claude-agent.mjs';\n",
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareDesktop022(archive) {
  const base = 'dsh/node_modules/@deepseek-ai/dsh-agent-loop';
  const entries = await readArchiveEntries(archive, [`${base}/lib/index.js`, `${base}/package.json`, `${base}/LICENSE`]);
  const manifest = JSON.parse(entries.get(`${base}/package.json`));
  const source = entries.get(`${base}/lib/index.js`), license = entries.get(`${base}/LICENSE`);
  if (manifest.name !== '@deepseek-ai/dsh-agent-loop' || manifest.version !== '0.2.2-rc.1' || manifest.license !== 'MIT'
    || digest(license) !== 'ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be') {
    throw new Error('不是已核对的 0.2.2-rc.1 官方包。');
  }
  const legacy = JSON.parse(await readFile(new URL('../plugin/compat/provenance.json', import.meta.url)));
  const adapted = adaptAgentLoop(source, legacy.officialImports, DESKTOP_022_PROFILE);
  const target = new URL('../plugin/compat/desktop-022/', import.meta.url);
  await mkdir(target, { recursive: true });
  for (const [name, bytes] of [['agent-loop.original.mjs', source], ['agent-loop.mjs', adapted], ['LICENSE', license]]) {
    await writeFile(new URL(name, target), bytes);
  }
  const provenance = { ...legacy, version: manifest.version,
    commit: '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db',
    sourceSha256: digest(source), adaptedSha256: digest(adapted),
    changes: ['导入桥接构造器并传递原生 projections/lastTurn', '仅远程 Agent 按动态 step 闭合',
      '官方依赖绑定安装版 ESM 单例', '加载前检查 Host 能力'],
  };
  delete provenance.runtimeSha256;
  await writeFile(new URL('provenance.json', target), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('用法：node scripts/prepare-dsh-compat-022.mjs <app.asar>');
  await prepareDesktop022(resolve(process.argv[2]));
  console.log('已生成 0.2.2-rc.1 兼容副本。');
}
