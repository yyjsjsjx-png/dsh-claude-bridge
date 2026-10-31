import { spawnSync } from 'node:child_process'

// Maintainer command: run after publishing a stable GitHub Release.
// Only the moving latest tag is updated; versioned tags stay immutable.
const repository = process.env.GH_REPO ?? 'yyjsjsjx-png/dsh-claude-bridge'
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('仓库名称无效。')
const gh = process.env.GH_PATH ?? 'gh'
function api(path, ...args) {
  const result = spawnSync(gh, ['api', `repos/${repository}/${path}`, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'GitHub 标签操作失败。')
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined
}

const release = api('releases/latest', '-H', 'Cache-Control: no-cache')
if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
  throw new Error('latest 只能指向已发布的正式版本。')
}
let object = api(`git/ref/tags/${release.tag_name}`).object
for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = api(`git/tags/${object.sha}`).object
if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('正式版本未指向有效提交。')
const matching = api('git/matching-refs/tags/latest')
if (!Array.isArray(matching)) throw new Error('无法读取 latest 标签。')
const current = matching.find(ref => ref.ref === 'refs/tags/latest')
if (current?.object.sha !== object.sha || current.object.type !== 'commit') {
  if (current) api('git/refs/tags/latest', '--method', 'PATCH', '-f', `sha=${object.sha}`, '-F', 'force=true', '--silent')
  else api('git/refs', '--method', 'POST', '-f', 'ref=refs/tags/latest', '-f', `sha=${object.sha}`, '--silent')
}
const verified = api('git/ref/tags/latest').object
if (verified.type !== 'commit' || verified.sha !== object.sha) throw new Error('latest 标签核对失败。')
console.log(JSON.stringify({ latest: release.tag_name, commit: object.sha }))
