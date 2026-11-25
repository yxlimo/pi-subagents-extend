// Direct-unit coverage for role-config, deliverable and context-scope.
//
// Every case calls the exported function itself: no handler, no childRun, no
// fake pi API. Where the decision lives behind a named wiring function
// (deliverableGrant, the binding-key gate), the test drives the exported
// entry point that owns it instead of copying the decision into the test.
//
// Scratch files live in <worktree>/.test-state, the same directory harness.ts
// prefers in a sandboxed child, and are removed on exit / signal.

import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { injectMainOnly, stripMarkedSections, unbalancedWarning } from "../../src/context-scope.ts"
import { ensureDeliverableLink, mainRepoRoot } from "../../src/deliverable.ts"
import { extractCallConfig } from "../../src/policy/payload.ts"
import { agentMdDirs, BINDING_NAMESPACE, BINDING_VERSION, bindingKey, outputFromBlock, policyFromBlock, readExtendBlock, resolveAgentFile, setupFromBlock, worktreeFromBlock } from "../../src/role-config.ts"
import { wireDeliverable } from "../../src/wiring/agent-start.ts"

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, "..", "..")
const worktreeRoot = join(packageRoot, "..", "..")
const stateRoot = join(worktreeRoot, ".test-state")
mkdirSync(stateRoot, { recursive: true })
const root = realpathSync.native(mkdtempSync(join(stateRoot, "unit-role-")))

const restore = (): void => {
  rmSync(root, { recursive: true, force: true })
}
process.on("exit", restore)
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restore()
    process.exit(130)
  })
}

// The anchor tiers consult `git worktree list`; hiding git from PATH makes
// "no git evidence" a deterministic state instead of "whatever repo encloses
// the scratch directory". Nothing else in these cases spawns a process.
const emptyBin = join(root, "empty-bin")
mkdirSync(emptyBin)
const withoutGit = <T>(fn: () => T): T => {
  const previous = process.env.PATH
  process.env.PATH = emptyBin
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
}

let passed = 0
const ok = (label: string): void => {
  passed += 1
  console.log(`  ok   ${label}`)
}

function writeRoleMd(dir: string, role: string, extendYaml: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${role}.md`)
  writeFileSync(file, `---\nextend:\n${extendYaml}---\n\nRole body: this file exists only to carry frontmatter in the unit suite.\n`)
  return file
}

console.log("pi-subagents-extend role/deliverable/context unit")

// 1. The key is one literal version, not a namespace prefix.
{
  assert.equal(BINDING_NAMESPACE, "pi-subagents-extend")
  assert.equal(BINDING_VERSION, 1)
  assert.equal(bindingKey(), "pi-subagents-extend/1")
  ok("bindingKey is pi-subagents-extend/1 from a single BINDING_VERSION")
}

// 2. /1 is accepted; /2 is refused, never silently read as /1.
{
  const accepted = extractCallConfig(
    JSON.stringify({ [bindingKey()]: { permissions: { scope: ["src/**"] } } }),
  )
  assert.equal(accepted.error, undefined, "the current version is accepted")
  assert.deepEqual(accepted.config?.scope, ["src/**"])

  const rejected = extractCallConfig(
    JSON.stringify({ "pi-subagents-extend/2": { permissions: { scope: ["src/**"] } } }),
  )
  assert.match(String(rejected.error), /pi-subagents-extend\/1/, "the refusal names the supported version")
  assert.match(String(rejected.error), /pi-subagents-extend\/2/, "the refusal names the version actually supplied")
  assert.equal(rejected.config, undefined, "a /2 payload yields no policy at all")
  ok("a /2 key is refused rather than parsed as /1")
}

// 3. Two versions of the namespace are ambiguous, not a preferred one.
{
  const both = extractCallConfig(JSON.stringify({
    "pi-subagents-extend/1": { permissions: { scope: ["."] } },
    "pi-subagents-extend/2": { permissions: { scope: ["."] } },
  }))
  assert.match(String(both.error), /ambiguous/)
  assert.equal(both.config, undefined)
  ok("two versions in one payload are refused as ambiguous")
}

// 4. Every documented extend block is parsed from the same role md.
{
  const file = writeRoleMd(join(root, "all-blocks"), "full", [
    "  permissions:",
    '    scope: ["src/**"]',
    '    write: ["dist/**"]',
    "  worktree:",
    "    enabled: true",
    "    nodeModules: remove",
    "  setup:",
    "    preExec: echo hi",
    "  output:",
    "    deliverable: report.md",
    "",
  ].join("\n"))
  const read = readExtendBlock(file)
  assert.deepEqual(read.problems, [])
  assert.ok(read.block, "the extend block was found")
  const policy = policyFromBlock(read.block)
  assert.deepEqual(policy.problems, [])
  assert.deepEqual(policy.policy?.scope, ["src/**"])
  assert.deepEqual(policy.policy?.writeScope, ["dist/**"])
  assert.deepEqual(worktreeFromBlock(read.block).worktree, { enabled: true, nodeModules: "remove" })
  assert.deepEqual(setupFromBlock(read.block).setup, { preExec: "echo hi" })
  assert.deepEqual(outputFromBlock(read.block).output, { deliverable: "report.md" })
  ok("permissions, worktree, setup and output all parse from one extend block")
}

// 4b. `extend.worktree` 只认对象形式，与文档一致：布尔、字符串、数字都不是配置，
//     报出来而不是猜。钉住这条是为了别再有人把「支持简写」当善意加回来 —— 它的代价是
//     两套写法都要维护、文档和代码各说一套。
{
  const shorthand = writeRoleMd(join(root, "wt-boolean"), "wt-boolean", "  worktree: true\n")
  const parsedShort = worktreeFromBlock(readExtendBlock(shorthand).block ?? {})
  assert.equal(parsedShort.worktree, undefined, "布尔不是配置，不给策略")
  assert.ok(
    parsedShort.problems.some((problem) => /worktree must be an object/.test(problem)),
    `布尔要报错：${JSON.stringify(parsedShort.problems)}`,
  )

  const badEnabled = writeRoleMd(join(root, "wt-enabled-bad"), "wt-enabled-bad", "  worktree:\n    enabled: \"yes\"\n")
  const parsedBadEnabled = worktreeFromBlock(readExtendBlock(badEnabled).block ?? {})
  assert.equal(parsedBadEnabled.worktree?.enabled, undefined, "enabled 不是布尔时不给值")
  assert.ok(
    parsedBadEnabled.problems.some((problem) => /worktree\.enabled must be a boolean/.test(problem)),
    `enabled 的类型错误要报出来：${JSON.stringify(parsedBadEnabled.problems)}`,
  )

  const unknown = writeRoleMd(join(root, "wt-unknown-key"), "wt-unknown-key", "  worktree:\n    enabled: true\n    node_module: remove\n")
  const parsedUnknown = worktreeFromBlock(readExtendBlock(unknown).block ?? {})
  assert.deepEqual(parsedUnknown.worktree, { nodeModules: "keep", enabled: true }, "未知键不生效")
  assert.ok(
    parsedUnknown.problems.some((problem) => /worktree\.node_module: unknown key/.test(problem)),
    `未知键要点名报出：${JSON.stringify(parsedUnknown.problems)}`,
  )
  ok("`extend.worktree` 只认对象；布尔、类型错误、未知键都报出来而不是被猜成某种含义")
}

// 5. A misspelled top-level block is reported, not quietly dropped.
{
  const file = writeRoleMd(join(root, "unknown-block"), "typo", [
    "  permisisons:",
    '    scope: ["src/**"]',
    "",
  ].join("\n"))
  const read = readExtendBlock(file)
  assert.ok(read.block, "the extend block was found")
  const parsed = policyFromBlock(read.block)
  assert.ok(parsed.problems.includes("permisisons: unknown block"), parsed.problems.join("\n"))
  assert.deepEqual(parsed.policy, {}, "the typo produces no policy")
  ok("an unknown extend block name is reported instead of ignored")
}

// 6. Role md and dispatch payload both require the permissions layer.
{
  const wrapped = writeRoleMd(join(root, "wrapped"), "wrapped", [
    "  permissions:",
    '    scope: ["src/**"]',
    "",
  ].join("\n"))
  const flat = writeRoleMd(join(root, "flat"), "flat", [
    '  scope: ["src/**"]',
    "",
  ].join("\n"))

  const wrappedBlock = readExtendBlock(wrapped).block
  const flatBlock = readExtendBlock(flat).block
  assert.ok(wrappedBlock)
  assert.ok(flatBlock)
  const parsedWrapped = policyFromBlock(wrappedBlock)
  assert.deepEqual(parsedWrapped.problems, [])
  assert.deepEqual(parsedWrapped.policy?.scope, ["src/**"], "extend.permissions fills the role policy")

  const parsedFlat = policyFromBlock(flatBlock)
  assert.ok(parsedFlat.problems.some((p) => p.includes("scope: unknown block")), parsedFlat.problems.join("\n"))
  assert.equal(parsedFlat.policy?.scope, undefined, "a flat extend block grants no scope")

  const flatPayload = extractCallConfig(JSON.stringify({ [bindingKey()]: { scope: ["src/**"] } }))
  assert.match(String(flatPayload.error), /missing "permissions" object/, "a flat dispatch payload is refused too")
  ok("role md parses only through permissions; the flat spelling is refused")
}

// 7. A linked worktree's .git file reaches the main checkout via commondir.
{
  const caseRoot = join(root, "anchor-linked")
  const main = join(caseRoot, "main")
  const worktree = join(caseRoot, "worktree")
  const gitDir = join(main, ".git", "worktrees", "topic")
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, "commondir"), "../..\n")
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/topic\n")
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`)

  assert.deepEqual(mainRepoRoot(worktree), { root: realpathSync.native(main), via: "common-dir" })
  ok("a linked worktree's gitfile resolves the main checkout through commondir")
}

// 7b. A linked worktree finds the role md of the project it belongs to, not of the disk it sits on.
// Regression: worktrees live under ~/.pi/worktrees, so the upward walk from the child's cwd never
// reaches the workspace — a dispatched child got no policy at all and `git commit` simply succeeded.
{
  const caseRoot = join(root, "md-linked")
  const main = join(caseRoot, "main")
  const worktree = join(caseRoot, "worktrees", "pi-worktree-abc-0")
  const gitDir = join(main, ".git", "worktrees", "topic")
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, "commondir"), "../..\n")
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/topic\n")
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`)
  mkdirSync(join(main, ".pi", "agents"), { recursive: true })
  writeFileSync(join(main, ".pi", "agents", "probe-role.md"), "---\nextend: {}\n---\nprobe\n")
  const home = join(caseRoot, "home")
  mkdirSync(home, { recursive: true })

  assert.ok(
    agentMdDirs(worktree, home).includes(join(realpathSync.native(main), ".pi", "agents")),
    "the main checkout's .pi/agents is searched from inside a linked worktree",
  )
  assert.equal(
    resolveAgentFile("probe-role", worktree, home),
    join(realpathSync.native(main), ".pi", "agents", "probe-role.md"),
  )
  ok("a linked worktree resolves the role md of the project it belongs to")
}

// 8. A standalone gitfile is the next tier, ahead of cwd.
{
  const caseRoot = join(root, "anchor-gitfile")
  const checkout = join(caseRoot, "checkout")
  const gitDir = join(checkout, "separate-gitdir")
  mkdirSync(checkout, { recursive: true })
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(checkout, ".git"), `gitdir: ${gitDir}\n`)

  const anchor = withoutGit(() => mainRepoRoot(checkout))
  assert.deepEqual(anchor, { root: realpathSync.native(checkout), via: "gitfile" })
  ok("a standalone gitdir outranks the cwd fallback")
}

// 9. With no git evidence at all, the cwd fallback still resolves.
{
  const free = join(root, "anchor-free")
  mkdirSync(free)

  const anchor = withoutGit(() => mainRepoRoot(free))
  assert.deepEqual(anchor, { root: realpathSync.native(free), via: "cwd" })
  ok("a git-free directory resolves through the final cwd tier")
}

// 10. The child-side link points at the real file on the main side.
{
  const caseRoot = join(root, "link")
  const child = join(caseRoot, "child")
  const main = join(caseRoot, "main")
  mkdirSync(child, { recursive: true })
  mkdirSync(main, { recursive: true })

  const first = ensureDeliverableLink(child, main, "notes/out.md")
  assert.equal(first.action, "created", "the link is created on the child side")
  assert.equal(first.linkPath, join(child, "notes", "out.md"))
  assert.equal(first.targetPath, join(main, "notes", "out.md"))
  assert.equal(readlinkSync(first.linkPath), first.targetPath, "it points into the main checkout")
  assert.ok(lstatSync(first.linkPath).isSymbolicLink())

  const second = ensureDeliverableLink(child, main, "notes/out.md")
  assert.equal(second.action, "reused", "a second call does not rewrite it")
  ok("ensureDeliverableLink links the child path to the main-side file")
}

// 11. A directory at the deliverable path never becomes a write grant.
{
  const caseRoot = join(root, "wire-directory")
  const target = join(caseRoot, "dist")
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, "keep.txt"), "keep\n")
  const policy = { absoluteWrite: [] as string[] }
  const options: { sections?: Record<string, string> } = {}
  const warnings: string[] = []

  const result = withoutGit(() =>
    wireDeliverable(caseRoot, { output: { deliverable: "dist" } }, policy, options, (m) => warnings.push(m)),
  )
  assert.deepEqual(policy.absoluteWrite, [], "a directory opens no write grant")
  assert.deepEqual(options.sections, undefined, "no deliverable section is announced")
  assert.ok(
    warnings.some((m) => m.includes(target) && m.includes("not a regular file")),
    warnings.join("\n"),
  )
  assert.equal(result.target, target)
  ok("a directory deliverable is refused before any subtree can be granted")
}

// 12. A symlinked parent is refused before it can create an outside file.
{
  const caseRoot = join(root, "wire-parent")
  const outside = join(root, "wire-parent-outside")
  mkdirSync(caseRoot, { recursive: true })
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, join(caseRoot, ".pi"), "dir")
  const deliverable = ".pi/reports/review.md"
  const policy = { absoluteWrite: [] as string[] }
  const options: { sections?: Record<string, string> } = {}
  const warnings: string[] = []

  withoutGit(() =>
    wireDeliverable(caseRoot, { output: { deliverable } }, policy, options, (m) => warnings.push(m)),
  )
  assert.deepEqual(policy.absoluteWrite, [], "no outside file is granted")
  assert.deepEqual(options.sections, undefined, "no deliverable section is announced")
  assert.equal(existsSync(join(outside, "reports", "review.md")), false, "the outside file was never created")
  assert.ok(
    warnings.some((m) => m.includes(deliverable) && m.includes(outside)),
    warnings.join("\n"),
  )
  ok("a parent symlink escaping the main root is refused before creating the file")
}

// 13. The fenced region is stripped for the child, kept for the parent.
{
  const project = join(root, "context-project")
  mkdirSync(join(project, ".pi"), { recursive: true })
  const mainOnlyText = "Parent-only escalation path: contact supervisor."
  writeFileSync(join(project, ".pi", "main-only.md"), `${mainOnlyText}\n`)
  const fenced = "public\n<!-- main-agent-only:start -->\nSECRET PARENT RULE\n<!-- main-agent-only:end -->\ntail\n"
  const childFiles = [{ path: join(project, "AGENTS.md"), content: fenced }]
  const parentFiles = [{ path: join(project, "AGENTS.md"), content: fenced }]

  const stripped = stripMarkedSections(childFiles)
  assert.equal(stripped.files, 1, "one file changed for the child")
  assert.ok(stripped.removedChars > 0, "the marked block was actually removed")
  assert.deepEqual(stripped.unbalanced, [])
  assert.equal(childFiles[0].content, "public\ntail\n")
  assert.equal(parentFiles[0].content, fenced, "the parent copy still sees the whole file")
  assert.ok(parentFiles[0].content.includes("SECRET PARENT RULE"))

  const parentOptions: { sections?: Record<string, string> } = {}
  const injected = injectMainOnly(parentOptions, project)
  assert.equal(injected, mainOnlyText.length, "the parent-only file was injected")
  assert.ok(Object.values(parentOptions.sections ?? {}).includes(mainOnlyText))

  const childOptions: { sections?: Record<string, string> } = {}
  assert.equal(injectMainOnly(childOptions, join(root, "no-main-only")), 0, "the child has no such file")
  assert.equal(childOptions.sections, undefined)
  ok("the fenced block is stripped for the child while the parent keeps it and gets main-only.md")
}

// 14. A broken fence keeps every instruction and reports the imbalance.
{
  const files = [
    { path: "start.md", content: "keep me\n<!-- main-agent-only:start -->\nSECRET\n" },
    { path: "end.md", content: "text\n<!-- main-agent-only:end -->\nmore\n" },
    { path: "fine.md", content: "plain\n" },
  ]
  const before = files.map((file) => file.content)
  const result = stripMarkedSections(files)

  assert.equal(result.files, 0, "nothing was stripped")
  assert.equal(result.removedChars, 0)
  assert.deepEqual(result.unbalanced, ["start.md", "end.md"])
  assert.deepEqual(files.map((file) => file.content), before, "the whole text survives a malformed fence")
  assert.match(String(unbalancedWarning(result)), /unclosed[\s\S]*kept/)
  ok("an unclosed marker keeps the entire text and reports both unbalanced files")
}

console.log(`  role.unit: ${passed} cases passed`)
