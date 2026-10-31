import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Releases include index.mjs; rebuilding uses an existing compiler only.
const compiler = process.argv[2] ?? process.env.DSH_BRIDGE_TYPESCRIPT
if (!compiler) throw new Error('请提供现有 typescript/lib/typescript.js 路径；运行发行版无需编译。')
const imported = await import(pathToFileURL(resolve(compiler)).href)
const ts = imported.default ?? imported
const source = new URL('../plugin/index.mts', import.meta.url)
const result = ts.transpileModule(await readFile(source, 'utf8'), { fileName: 'index.mts', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    experimentalDecorators: false, newLine: ts.NewLineKind.LineFeed } })
if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error('插件源码编译失败，未覆盖运行文件。')
await writeFile(new URL('../plugin/index.mjs', import.meta.url), result.outputText)
console.log('已生成插件运行文件。')
