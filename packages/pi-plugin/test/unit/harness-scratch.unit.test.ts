// Offline unit tests for the shared harness scratch-directory contract.
//
// The other suites only observe the scratch directory indirectly, so nothing
// pinned the choice between `<worktree-root>/.test-state` (what sandboxed
// children get from the session's preExec) and the legacy package-local
// `.test-state-*` fallback (what every plain local run depends on). A wrong
// fix here once shipped green: the fallback works locally, so a regression
// to `join(repo, "..", ".test-state")` was only exposed by a sandboxed child.
//
// These cases spawn a child `node` process that imports `test/harness.ts` and
// prints `process.env.PI_SUBAGENTS_EXTEND_STATE` instead of importing the
// harness in-process: importing it creates the directory and registers exit
// handlers, and those would leak into this test process.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url)) // <pkg>/test/unit
const packageRoot = join(here, "..", "..") // packages/pi-plugin
// Same derivation as harness.ts: worktree root is three levels above this
// test file (`<worktree>/packages/pi-plugin/test/unit/harness-scratch.unit.test.ts`).
const worktreeRoot = join(packageRoot, "..", "..")
const sharedState = join(worktreeRoot, ".test-state")
const harnessPath = join(packageRoot, "test", "harness.ts")

// Ownership first: a pre-existing `.test-state` belongs to the session setup
// (it is what sandboxed children are granted), so we must never delete it —
// only a directory we created ourselves. Write access is then probed by
// creating, the same honest test harness.ts uses — a Landlock denial is
// invisible to accessSync.
const preExisted = existsSync(sharedState)
const ownedByUs = !preExisted
// Runs the harness in a fresh node process and returns what it published.
function spawnHarness(): { stdout: string; stderr: string; status: number | null } {
  const run = spawnSync(
    process.execPath,
    [
      "-e",
      // The harness resolves every path from its own import.meta.url, so the
      // child needs no cwd and no environment setup beyond an empty state var.
      // The marker matters: below Landlock ABI 7 the harness prints its own note about the stub
      // helper on the way in, so the child's stdout is not one bare path. Parsing a marker line
      // keeps the case about the scratch path instead of about how much the harness says.
      "import(require('url').pathToFileURL(process.argv[1]).href).then(() => console.log('HARNESS_STATE=' + process.env.PI_SUBAGENTS_EXTEND_STATE))",
      harnessPath,
    ],
    { encoding: "utf8" },
  )
  return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status }
}

/** The scratch path the child reported, ignoring any other line it printed. */
function stateOf(stdout: string): string {
  const line = stdout.split("\n").find((entry) => entry.startsWith("HARNESS_STATE="))
  return line ? line.slice("HARNESS_STATE=".length).trim() : ""
}

let passed = 0
const skipped: string[] = []
const restore = (): void => {
  // Only a directory we created: a pre-existing `.test-state` belongs to the
  // session setup, and the harness child cleans its own run-* temp on exit.
  if (ownedByUs) rmSync(sharedState, { recursive: true, force: true })
}
process.on("exit", restore)
// 收到信号时 exit 钩子不跑：Ctrl-C 留下的临时目录会被补丁采集误收进去。
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restore()
    process.exit(130)
  })
}
// 修错了路径（比如往包外一级跑）会 ENOENT，但本地因为回退路径能跑而全绿。
{
  // Creating here doubles as the write probe: in a sandboxed child without the
  // session setup this is where a Landlock denial would surface.
  mkdirSync(sharedState, { recursive: true })
  const run = spawnHarness()
  const state = stateOf(run.stdout)
  assert.equal(
    run.status,
    0,
    `harness child exited with ${run.status}: ${run.stderr}`,
  )
  assert.ok(
    state.startsWith(sharedState + "/") || state.startsWith(sharedState + "\\"),
    `expected the state inside ${sharedState}, got ${state}`,
  )
  console.log("  ok   harness prefers <worktree-root>/.test-state when it exists")
  passed++
}
// 共享目录不存在时走旧回退：普通本地运行没有 preExec，全靠包内的
// `.test-state-*`。这个行为不能悄悄变。共享目录如果本来就存在（比如沙箱
// 会话的 setup 建的），删不掉也不该删，跳过这个用例并明说。
{
  if (ownedByUs) {
    rmSync(sharedState, { recursive: true, force: true })
    const run = spawnHarness()
    const state = stateOf(run.stdout)
    assert.equal(
      run.status,
      0,
      `harness child exited with ${run.status}: ${run.stderr}`,
    )
    assert.ok(
      state.startsWith(packageRoot + "/.test-state-") ||
        state.startsWith(packageRoot + "\\.test-state-"),
      `expected the legacy package-local .test-state-* fallback, got ${state}`,
    )
    console.log("  ok   harness falls back to the package-local .test-state-*")
    passed++
  } else {
    const why = "harness fallback case: pre-existing .test-state we do not own"
    console.log(`  skip ${why}`)
    skipped.push(why)
  }
}
console.log(
  `harness-scratch.unit: ${passed} cases passed` +
    (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
)
