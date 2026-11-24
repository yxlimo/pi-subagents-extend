// Session start: role-md policy resolution, worktree defaults, role wiring and /permission output.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"

import { join, dirname } from "node:path"
import { handler, workdir, repo, writeAgentMd } from "../harness.ts"
import "../support.ts"


// 170. 角色 md 的 extend.worktree.enabled: true 给 subagent 派单补默认值；补值不是拒绝。
{
  const proj = join(workdir, "proj-worktree-default")
  writeAgentMd({
    cwd: proj,
    role: "coder",
    extend: {
      permissions: { scope: ["."], allowTools: ["subagent", "subagent_launch", "read"] },
      worktree: { enabled: true },
    },
  })
  // 172 复用这个角色：没有 worktree 配置的 md 不得长出 worktree 键。
  writeAgentMd({ cwd: proj, role: "plain", extend: { permissions: { scope: ["."], allowTools: ["subagent"] } } })
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", input), undefined, "filling the default is not a refusal")
  assert.equal(input.worktree, true)
  h.restore()
  console.log("  ok   a role md's worktree default fills a subagent dispatch")
}

// 171. 调用方显式 false 是「我要共享工作树」，不能被角色 md 默认值盖掉。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x", worktree: false }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, false, "an explicit false survives the role md default")
  h.restore()
  console.log("  ok   explicit worktree: false wins over the role default")
}

// 172. md 没有 worktree 字段时不能凭空长出这个键。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "plain", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.ok(!Object.hasOwn(input, "worktree"), "no worktree key appears without a strategy")
  h.restore()
  console.log("  ok   no worktree field leaves the input untouched")
}

// 173. 工作流里的 subagent_launch 也要补：tasks[] / chain 的子代理不能漏。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { workflowRunId: "run-1", key: "k", agent: "coder", task: "x" }
  assert.equal(await h.call("subagent_launch", input), undefined)
  assert.equal(input.worktree, true, "the nested launch gets the same default")
  h.restore()
  console.log("  ok   nested subagent_launch gets the role md's worktree default")
}

// 174. 非派单工具不补，即使入参里也带了个 agent 字段。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { path: "src/x.ts", agent: "coder" }
  assert.equal(await h.call("read", input), undefined)
  assert.ok(!Object.hasOwn(input, "worktree"), "only dispatch tools are touched")
  h.restore()
  console.log("  ok   non-dispatch tools are left alone")
}

// 175. 角色解析不到就 fail open，不拿别的角色的策略来补。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "ghost-role-175", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.ok(!Object.hasOwn(input, "worktree"), "an unknown agent has no strategy")
  h.restore()
  console.log("  ok   an unresolvable agent gets no default")
}

// 176. ??= 把 null 也算「没给」：显式 false 才有优先权。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x", worktree: null }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true, "null is absent under ??=")
  h.restore()
  console.log("  ok   a null worktree is filled like a missing one")
}

// 177. 没有角色 md 时，本次 bindings 自己写了 worktree 也照样生效。
{
  const empty = mkdtempSync(join(tmpdir(), "pi-subagents-extend-worktree-call-"))
  const h = await handler({
    cwd: empty,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], worktree: true, allowTools: ["subagent"] },
    }),
  })
  const input: Record<string, unknown> = { agent: "ghost", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true, "the call's own bindings carry the strategy")
  h.restore()
  rmSync(empty, { recursive: true, force: true })
  console.log("  ok   call-level worktree applies without a role md")
}


// 170-182. worktree 补值的护栏（review P1）与派单自带 worktree 覆盖（P2）。
const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
const worktreeProj = (name: string, role: string, extend: Record<string, unknown>, tracked: "tracked" | "untracked" | "none"): string => {
  const proj = join(workdir, name)
  writeAgentMd({ cwd: proj, role, extend })
  if (tracked !== "none") spawnSync("git", ["init", "-q"], { cwd: proj, stdio: "ignore" })
  if (tracked === "tracked") spawnSync("git", ["add", join(".pi", "agents", `${role}.md`)], { cwd: proj, stdio: "ignore" })
  return proj
}
const extendWorktree = { permissions: { scope: ["."], allowTools: ["subagent"] }, worktree: { enabled: true } }
const extendPlain = { permissions: { scope: ["."], allowTools: ["subagent"] } }

// 178. 未跟踪的角色 md：补值时告警一次，第二次派单不再重复。
//      未跟踪的 md 在 worktree 副本里不存在，子代理认不出角色，等于没有任何角色策略。
if (!gitAvailable) {
  console.log("  skip  untracked role md warning（环境里没有 git）")
} else {
  const proj = worktreeProj("proj-wt-untracked", "coder", extendWorktree, "untracked")
  const h = await handler({ cwd: proj })
  const first: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", first), undefined)
  assert.equal(first.worktree, true, "the default is still filled")
  const warns = h.ui.filter((m) => m.includes("not tracked by git"))
  assert.equal(warns.length, 1, "one warning for the untracked role md")
  assert.match(warns[0], /worktree: true/, "the warning explains that worktree: true uses a copy")
  assert.match(warns[0], /\.pi\/agents\/coder\.md/, "the warning names the role md")
  assert.match(warns[0], /no role policy/, "the warning says the child runs with no role policy")
  assert.match(warns[0], /Commit the role md/, "the warning says to commit it")
  const second: Record<string, unknown> = { agent: "coder", task: "y" }
  assert.equal(await h.call("subagent", second), undefined)
  assert.equal(h.ui.filter((m) => m.includes("not tracked by git")).length, 1, "still one warning")
  h.restore()
  console.log("  ok   an untracked role md warns once, with why and how")
}

// 179. 已跟踪的角色 md 不告警。
if (!gitAvailable) {
  console.log("  skip  tracked role md stays silent（环境里没有 git）")
} else {
  const proj = worktreeProj("proj-wt-tracked", "coder", extendWorktree, "tracked")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true)
  assert.equal(h.ui.filter((m) => m.includes("not tracked by git")).length, 0, "a tracked role md is silent")
  h.restore()
  console.log("  ok   a tracked role md stays silent")
}

// 180. 判定不了（不在 git 仓库里）时不告警：宁可少说，不许误报。
{
  const proj = worktreeProj("proj-wt-norepo", "coder", extendWorktree, "none")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true)
  assert.equal(h.ui.filter((m) => m.includes("not tracked by git")).length, 0, "an undecidable check stays silent")
  h.restore()
  console.log("  ok   an undecidable git-tracking check warns nothing")
}

// 181. 派单自带 worktree: false 覆盖 md 的 true：不补值。
{
  const proj = worktreeProj("proj-wt-false", "coder", extendWorktree, "none")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = {
    agent: "coder",
    task: "x",
    extensionBindings: { "pi-subagents-extend/1": { worktree: false } },
  }
  assert.equal(await h.call("subagent", input), undefined)
  assert.ok(!Object.hasOwn(input, "worktree"), "the dispatch's false suppresses the role md default")
  h.restore()
  console.log("  ok   a dispatch's worktree: false overrides the role md default")
}

// 182. 派单自带 worktree: true 而 md 没有该字段：补值；来源是派单，不告警。
if (!gitAvailable) {
  console.log("  skip  dispatch worktree participates（环境里没有 git）")
} else {
  const proj = worktreeProj("proj-wt-own-true", "plain", extendPlain, "untracked")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = {
    agent: "plain",
    task: "x",
    extensionBindings: { "pi-subagents-extend/1": { worktree: true } },
  }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true, "the dispatch's own worktree participates in the decision")
  assert.equal(h.ui.filter((m) => m.includes("not tracked by git")).length, 0, "a dispatch-sourced strategy warns about no file")
  h.restore()
  console.log("  ok   a dispatch's own worktree: true fills in, with no role-md warning")
}


// 182a. md 里 worktree.enabled: false 是明确的「不用」：派单没写 worktree 时既不补值也不拒绝。
{
  const proj = join(workdir, "proj-worktree-default")
  writeAgentMd({
    cwd: proj,
    role: "wt-md-false",
    extend: {
      permissions: { scope: ["."], allowTools: ["subagent"] },
      worktree: { enabled: false },
    },
  })
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "wt-md-false", task: "x" }
  assert.equal(await h.call("subagent", input), undefined, "an explicit no-worktree role is not a refusal")
  assert.ok(!Object.hasOwn(input, "worktree"), "enabled: false must not fill a default")
  h.restore()
  console.log("  ok   a role md's worktree.enabled: false leaves the input untouched")
}

// 183-200. Role config source and versioned namespace (phase 1).
const rc = (await import(join(repo, "src", "role-config.ts"))) as unknown as typeof import("../../src/role-config.ts")

// 183. The active_agent tag gives the role wherever it stands alone on a line.
{
  assert.equal(rc.parseRoleName('<active_agent name="coder"/>\nyou are a helpful assistant'), "coder")
  assert.equal(rc.parseRoleName('rewritten prompt\n\n<active_agent name="coder"/>\n\nsystem prompt'), "coder", "the bridge puts the tag after the rewritten prompt")
  console.log("  ok   parseRoleName reads the role from any line that is only the tag")
}

// 184. No tag, a tag quoted inside another line, or an empty name is no role.
{
  assert.equal(rc.parseRoleName("a prompt with no tag"), null)
  assert.equal(rc.parseRoleName('first line\ncontext: <active_agent name="coder"/>'), null, "a tag inside another line is not the role")
  assert.equal(rc.parseRoleName('<active_agent name=""/>'), null, "an empty name is no role")
  console.log("  ok   parseRoleName returns null when the tag is absent, quoted or empty")
}

// 185. Whitespace around the tag is tolerated.
{
  assert.equal(rc.parseRoleName('  <active_agent   name="coder"  />  \nnext'), "coder")
  console.log("  ok   parseRoleName tolerates surrounding whitespace")
}

// 186. XML-escaped role names are decoded.
{
  assert.equal(rc.parseRoleName('<active_agent name="a&amp;b&quot;c"/>'), 'a&b"c')
  assert.equal(rc.parseRoleName('<active_agent name="coder&#45;x"/>'), "coder-x")
  console.log("  ok   parseRoleName decodes escaped role names")
}

// 187. Agent md resolution walks project levels before user levels.
{
  const proj = join(workdir, "resolve-proj")
  const home = join(workdir, "resolve-home")
  const files = [
    join(proj, ".pi", "agents", "worker.md"),
    join(proj, ".agents", "worker.md"),
    join(home, ".pi", "agent", "agents", "worker.md"),
    join(home, ".agents", "worker.md"),
  ]
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, file)
  }
  for (let i = 0; i < files.length; i += 1) {
    assert.equal(rc.resolveAgentFile("worker", proj, home), files[i])
    rmSync(files[i])
  }
  assert.equal(rc.resolveAgentFile("worker", proj, home), null, "no file means no role")
  console.log("  ok   agent md resolution follows the project-then-user order")
}

// 188. readExtendBlock returns the extend object from valid frontmatter.
{
  const file = join(workdir, "md-valid.md")
  writeFileSync(file, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n# body\n')
  const out = rc.readExtendBlock(file)
  assert.deepEqual(out.problems, [])
  assert.deepEqual(out.block, { permissions: { scope: ["src/**"] } })
  console.log("  ok   readExtendBlock returns the extend object")
}

// 189. No frontmatter is not a problem.
{
  const file = join(workdir, "md-no-front.md")
  writeFileSync(file, "# just a heading\n")
  const out = rc.readExtendBlock(file)
  assert.equal(out.block, undefined)
  assert.deepEqual(out.problems, [])
  console.log("  ok   no frontmatter yields no block and no problem")
}

// 190. Frontmatter without extend is not a problem.
{
  const file = join(workdir, "md-no-extend.md")
  writeFileSync(file, "---\ntitle: hello\n---\nbody\n")
  const out = rc.readExtendBlock(file)
  assert.equal(out.block, undefined)
  assert.deepEqual(out.problems, [])
  console.log("  ok   frontmatter without extend yields no problem")
}

// 191. Invalid YAML reports a problem instead of throwing.
{
  const file = join(workdir, "md-bad-yaml.md")
  writeFileSync(file, "---\nextend: [unterminated\n---\n")
  const out = rc.readExtendBlock(file)
  assert.equal(out.block, undefined)
  assert.equal(out.problems.length, 1)
  assert.match(out.problems[0], /invalid YAML/)
  console.log("  ok   invalid YAML yields one problem, not a throw")
}

// 192. permissions map onto the existing policy fields.
{
  const out = rc.policyFromBlock({
    permissions: {
      scope: ["src/**"],
      write: ["src/gen/**"],
      readOnly: true,
      allowTools: ["subagent"],
      budgets: { deny: 7, writeDeny: 3 },
    },
  })
  assert.deepEqual(out.problems, [])
  assert.deepEqual(out.policy, {
    scope: ["src/**"],
    writeScope: ["src/gen/**"],
    readOnly: true,
    allowTools: ["subagent"],
    maxDenies: 7,
    maxWriteDenies: 3,
  })
  console.log("  ok   permissions map onto scope, write, budgets and the rest")
}


// 194. Wired top-level blocks are no longer reported; unknown ones still are.
{
  const out = rc.policyFromBlock({ worktree: {}, setup: {}, output: {} })
  assert.deepEqual(out.problems, [])
  console.log("  ok   wired blocks are silent")
}

// 195. Unknown keys are reported by name.
{
  const inPermissions = rc.policyFromBlock({ permissions: { scope: ["."], mystery: 1 } })
  assert.ok(inPermissions.problems.some((p) => p.includes("mystery")))
  const topLevel = rc.policyFromBlock({ spooky: {} })
  assert.ok(topLevel.problems.some((p) => p.includes("spooky")))
  console.log("  ok   unknown keys are reported by name")
}

// 196. A mistyped scope is reported and omitted, other fields survive.
{
  const out = rc.policyFromBlock({ permissions: { scope: "src/**", readOnly: true } })
  assert.ok(out.problems.some((p) => p.includes("permissions.scope")))
  assert.equal(out.policy?.scope, undefined)
  assert.equal(out.policy?.readOnly, true)
  console.log("  ok   a string scope is reported and omitted")
}
