// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
// The path argument of a tool call: a missing path, the repository root, and
// the argument name each tool uses for its path.
//
//   node test/paths.test.ts

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, workdir } from "../harness.ts"

// 9. Search tools without an explicit path default to cwd and get judged on it.
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"] } }) })
  const grep = await h.call("grep", { pattern: "x" })
  assert.equal(grep?.block, true, "pathless grep (cwd) is out of scope here")
  assert.match(grep.reason, /outside (this task's |the )?(read )?scope/, "block reason teaches the scope")
  h.restore()
  console.log("  ok   缺省 path 视为 cwd 并按范围判定")
}

// 23. Missing path must not read as "the child walked to the wrong directory".
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0 } }),
  })
  const write = await h.call("write", { content: "x" })
  assert.equal(write?.block, true, "write without path is refused")
  assert.match(write.reason, /has no "path"/, "write names the path argument that is missing")
  assert.ok(!/outside the (read )?scope/.test(write.reason), "write does not blame the scope")

  const grep = await h.call("grep", { pattern: "foo" })
  assert.equal(grep?.block, true, "grep without path is refused")
  assert.match(grep.reason, /no path was given/, "grep says no path was given")
  assert.match(grep.reason, /working directory/, "grep says the cwd was used instead")

  // A missing path is a usage error, not a permission problem: it must not
  // count toward the deny budget, or a forgetful child gets stopped as
  // "the parent granted the wrong scope".
  for (let i = 0; i < 5; i += 1) await h.call("write", { content: "x" })
  const after = await h.call("read", { path: "src/real.ts" })
  assert.equal(after, undefined, "repeated missing-path refusals do not exhaust the deny budget")
  h.restore()
  console.log("  ok   缺 path 的拒绝文案说清原因，不误导成走错目录")
}
// 34. 拿仓库根当路径时，文案要说清「这是仓库根」，而不是让人以为 scope 有错。
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"] } }) })
  const rootish = await h.call("grep", { pattern: "x", path: "." })
  assert.equal(rootish?.block, true, "the repository root is outside a src-only scope")
  assert.match(rootish.reason, /repository root/, "the message names what was given")
  assert.match(rootish.reason, /widen the scope/, "and says the parent can widen it")
  h.restore()
  console.log("  ok   仓库根当路径时说清缘由，不装成 scope 写法有误")
}
// 88. 写工具拿不到目标路径：必须点名缺的是哪个入参并给出解法（hashline 的 requirePath，
//     或 bindings.tools.<name>.path），而且这是用法错、不计入撞权限预算。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-nopath-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], maxWriteDenies: 1, bash: false },
    }),
  })
  const missing = await h.call("replace", { remove_from: "x", text: "y" })
  assert.equal(missing?.block, true, "a write tool without its path is refused")
  assert.match(String(missing?.reason), /no target path/, "the message says the target is unknown")
  assert.match(String(missing?.reason), /requirePath/, "and names the switch that fixes it")
  // 预算是 1：如果按撞权限计数，第二次就该 warn、第三次硬停。这里不该有任何停机。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const again = await h.call("replace", { remove_from: "x", text: "y" })
    assert.notEqual(again?.terminate, true, "a usage error never consumes the grant-widening budget")
  }
  h.restore()
  console.log("  ok   写工具缺路径：点名入参与解法，且不计入撞权限预算")
}
// 89. undo_last_change 的 path 是必填入参，所以它永远可判：按写范围判，而不是被当成未知工具。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-undo-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  writeFileSync(join(tree, "src", "a.ts"), "a\n")
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: false } }),
  })
  const inside = await h.call("undo_last_change", { path: "src/a.ts" })
  assert.notEqual(inside?.block, true, "undo inside the scope is allowed")
  const outside = await h.call("undo_last_change", { path: "../elsewhere.ts" })
  assert.equal(outside?.block, true, "undo outside the scope is refused")
  assert.match(String(outside?.reason), /outside the scope|not writable/, "and it is judged by scope")
  h.restore()
  console.log("  ok   undo_last_change 按写工具判范围")
}
// 91. 路径入参名从工具自己的 schema 里取，不靠我们猜：注册表里写 file_path 的工具，
//     传 path 就是不传，必须被当成缺参数拒绝；读类工具（outline）按读范围判。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-schema-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  writeFileSync(join(tree, "src", "a.ts"), "a\n")
  const h = await handler({
    cwd: tree,
    piTools: [
      { name: "mytool", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
      { name: "outline", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ],
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: false, tools: { mytool: { access: "write" } } },
    }),
  })
  const viaSchema = await h.call("mytool", { file_path: "src/a.ts" })
  assert.notEqual(viaSchema?.block, true, "the schema's own argument name is accepted")
  const wrongArg = await h.call("mytool", { path: "src/a.ts" })
  assert.equal(wrongArg?.block, true, "passing a different argument name is a missing path")
  assert.match(String(wrongArg?.reason), /has no "file_path"/, "and the message names the schema's argument")
  const outlineOutside = await h.call("outline", { path: "../x.ts" })
  assert.equal(outlineOutside?.block, true, "outline is a read tool and obeys the read scope")
  assert.match(String(outlineOutside?.reason), /read scope/, "refused by the read scope")
  h.restore()
  console.log("  ok   路径入参名取自工具 schema；读类工具按读范围判")
}
rmSync(workdir, { recursive: true, force: true })
console.log("\npaths module tests passed")
