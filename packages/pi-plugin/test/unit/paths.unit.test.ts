// Offline unit tests for the pure path primitives in src/paths.ts.
//
// No fake pi API, no handler, no bindings: these cases call the functions
// directly, so a boundary slip is caught here instead of through a host.

import assert from "node:assert/strict"
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stateDir } from "../state-dir.ts"
import { dropHiddenGrants, expandPath, privatisedDirs, resolveComparable, underRoot } from "../../src/paths/index.ts"

const root = realpathSync.native(stateDir(".unit-paths-"))

const restore = (): void => {
  rmSync(root, { recursive: true, force: true })
}
process.on("exit", restore)
// 收到信号时 exit 钩子不跑：Ctrl-C 留下的临时目录会被补丁采集误收进去。
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restore()
    process.exit(130)
  })
}

// 根路径本身算在自己之下：相等分支不能丢。
{
  assert.equal(underRoot("/etc", "/etc"), true, "a root is inside itself")
  console.log("  ok   underRoot treats the root itself as inside")
}

// 子路径要判为在内：分隔符拼接不能把直接子节点漏掉。
{
  assert.equal(underRoot("/etc", "/etc/hosts"), true, "a direct child is inside")
  console.log("  ok   underRoot accepts a child path")
}

// 同前缀的兄弟不算在内：只按字符串前缀比会把 /etc-other 当成 /etc 的子树。
{
  assert.equal(underRoot("/etc", "/etc-other"), false, "a sibling with the same prefix is outside")
  assert.equal(underRoot("/x/y", "/x/y2"), false, "a sibling one character past the root is outside")
  console.log("  ok   underRoot rejects prefix-only siblings")
}

// 根自带末尾分隔符时与不带时一致：不能因为已有 / 就退化成纯前缀比较。
{
  assert.equal(underRoot("/etc/", "/etc/hosts"), true, "a trailing separator keeps the child inside")
  assert.equal(underRoot("/etc/", "/etc-other"), false, "a trailing separator still rejects the sibling")
  console.log("  ok   underRoot behaves the same with a trailing separator on the root")
}

// 树内软链必须解析成真实目标，否则词法判断会把树外目标当成树内。
{
  const tree = join(root, "tree")
  const outside = join(root, "outside")
  mkdirSync(tree, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const link = join(tree, "link")
  symlinkSync(outside, link)
  const resolved = resolveComparable(link)
  assert.equal(resolved, realpathSync.native(outside), "a symlink resolves to its real target")
  assert.notEqual(resolved, link, "the link itself is not the comparable path")
  console.log("  ok   resolveComparable follows an in-tree symlink to its outside target")
}

// 目标不存在时，尾巴要接到最深已存在祖先的真实路径上，不能把整条路径原样返回。
{
  const base = realpathSync.native(root)
  const missing = join(base, "missing", "deep", "new.txt")
  assert.equal(
    resolveComparable(missing),
    `${base}/missing/deep/new.txt`,
    "the remainder is appended to the deepest existing ancestor",
  )
  console.log("  ok   resolveComparable appends a missing remainder to the deepest existing ancestor")
}

// ~/ 按 homedir 展开，不能按传入的 cwd。
{
  assert.equal(expandPath("/some/cwd", "~/x"), join(homedir(), "x"), "~ expands against the home directory")
  console.log("  ok   expandPath expands ~ against the home directory")
}

// 绝对路径原样返回：不能拼上 cwd，也不能归一化。
{
  assert.equal(expandPath("/some/cwd", "/etc/hosts"), "/etc/hosts", "an absolute path is returned verbatim")
  console.log("  ok   expandPath returns an absolute path as-is")
}

// 私有化目录列表按目录边界排除 cwd：/tmp-other 不是 /tmp 的子树。
{
  assert.ok(privatisedDirs("/tmp-other", "/scratch").includes("/tmp"), "a prefix-only sibling cwd does not hide /tmp")
  assert.ok(!privatisedDirs("/tmp/child", "/scratch").includes("/tmp"), "a real child cwd does hide /tmp")
  console.log("  ok   privatisedDirs aligns the cwd exclusion on a directory boundary")
}

// 被私有 tmpfs 盖掉的授权要回传一次，且回传原条目；挂载点自身与同前缀兄弟保留。
{
  const scratch = join(root, "scratch")
  const cwd = join(root, "work")
  mkdirSync(scratch, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const hidden = join(scratch, "grant.txt")
  const sibling = join(root, "scratch-other", "grant.txt")
  const { kept, dropped } = dropHiddenGrants([hidden, scratch, sibling], cwd, scratch)
  assert.deepEqual(dropped, [hidden], "the hidden grant is reported exactly once, naming the original entry")
  assert.deepEqual(kept, [scratch, sibling], "the mount point and a prefix-only sibling are kept")
  console.log("  ok   dropHiddenGrants reports a removed grant once and names the entry")
}

console.log("  paths.unit: 10 cases passed")
