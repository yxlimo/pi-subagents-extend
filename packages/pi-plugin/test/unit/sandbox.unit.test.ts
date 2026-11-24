// Offline unit tests for the sandbox layer's own decisions: write-grant
// derivation (grants), the spec shape handed to the helper (spec), the scan
// order the toolchain detection depends on, and how a command is wrapped for
// the helper (the announce/quiet prefix of wrapInSandbox).
//
// No handler, no childRun, no fake pi API: these cases call
// sandboxWritableDirs / buildSpec directly, so a bug in
// the module itself is caught here instead of looking identical to a wiring bug
// through a full host environment.

import assert from "node:assert/strict"
import { sortByName } from "../../src/dependencies.ts"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { sandboxWritableDirs } from "../../src/sandbox/grants.ts"
import { QUIET_NETWORK_NOTICE_ENV, buildSpec, scratchDir, wrapInSandbox } from "../../src/sandbox/spec.ts"
import { stateDir } from "../state-dir.ts"

import { createWiring } from "../../src/wiring/context.ts"
// 单元测试不导入 harness（那会牵起 helper 解析与扩展加载），所以这里直接用 state-dir 的
// 约定而不是 harness 的再导出：沙箱里落在工作树根的 .test-state（角色授权覆盖它），本地则回退
// 到包目录下被 gitignore 的 .test-*。
const root = realpathSync.native(stateDir(".unit-sandbox-"))

// grants 会往 stateDir 写工具链缓存，spec 会写 git-excludes：钉进临时树里，
// 不碰真实 ~/.cache。
process.env.PI_SUBAGENTS_EXTEND_STATE = join(root, "state")

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

/** grants / spec 用例的公共 rule 实参：只带被测字段，其余按 `as never` 惯例省略。 */
const writeRule = (extra: Record<string, unknown> = {}): never =>
  ({ writable: true, scratchPaths: [], writablePaths: [], env: {}, gitExcludes: false, ...extra }) as never

// 整棵子树的写法（`dir`、`dir/**`）必须授权目录本身：Landlock 只能正向授权，
// 授权目录就是授权它下面所有东西 —— 命令要能在里面建文件。cwd 本身不能因此被
// 打开：读范围的宽窄不该自动变成写权限。
{
  const cwd = join(root, "subtree")
  const dir = join(cwd, "dir")
  mkdirSync(dir, { recursive: true })
  const byName = sandboxWritableDirs({ writeGlobs: ["dir"] } as never, cwd, writeRule())
  assert.ok(byName.includes(dir), "a whole-subtree grant authorises the directory itself")
  assert.ok(!byName.includes(cwd), "granting one subtree does not open the checkout root")
  const byGlob = sandboxWritableDirs({ writeGlobs: ["dir/**"] } as never, cwd, writeRule())
  assert.ok(byGlob.includes(dir), "dir/** grants the same directory as the bare dir spelling")
  console.log("  ok   subtree grants authorise the directory itself, not the checkout root")
}

// 文件级 glob 展开成实际存在的文件，且绝不截断在第一个通配符：截断会把整个
// src/auth/ 打开，明明写窄了的 glob 反而变成整目录可写。
{
  const cwd = join(root, "fileglob")
  const auth = join(cwd, "src/auth")
  mkdirSync(join(auth, "nested"), { recursive: true })
  const login = join(auth, "login.ts")
  const logout = join(auth, "logout.ts")
  writeFileSync(login, "")
  writeFileSync(logout, "")
  writeFileSync(join(auth, "notes.md"), "")
  writeFileSync(join(auth, "nested/deep.ts"), "")
  const granted = sandboxWritableDirs({ writeGlobs: ["src/auth/*.ts"] } as never, cwd, writeRule())
  assert.ok(granted.includes(login) && granted.includes(logout), "each existing match is granted as a file")
  assert.ok(!granted.includes(auth), "the parent directory is not opened by a file-level glob")
  assert.ok(!granted.includes(join(cwd, "src")), "no ancestor directory is opened either")
  assert.ok(!granted.includes(join(auth, "nested/deep.ts")), "a single * does not reach into subdirectories")
  console.log("  ok   file-level globs expand to the matched files, never to the parent directory")
}

// 产物目录：Cargo 的 target 是主产物，缺了就创建（cargo test 一定会写它，不创建
// 第一次跑就是 Permission denied）；dist 只是 node 的惯例目录，缺了不造（空目录
// 没有意义）。父代理显式点名的缺失目录也要创建 —— helper 会拒绝不存在的 spec
// 路径，悄悄丢掉这条授权等于把报错推到很远的地方。
  const cwd = join(root, "scratch")
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, "package.json"), "{}")
{
  writeFileSync(join(cwd, "Cargo.toml"), "[package]\nname = \"x\"\n")
  const granted = sandboxWritableDirs({ writeGlobs: [] } as never, cwd, writeRule({ scratchPaths: ["out-artifacts"] }))
  assert.ok(granted.includes(join(cwd, "target")) && existsSync(join(cwd, "target")), "the primary artifact dir is created and granted")
  assert.ok(!existsSync(join(cwd, "dist")) && !granted.includes(join(cwd, "dist")), "a merely conventional dir is not conjured up")
  assert.ok(granted.includes(join(cwd, "out-artifacts")) && existsSync(join(cwd, "out-artifacts")), "an explicitly named missing dir is created, not silently dropped")
  console.log("  ok   primary artifact dirs are created, conventional ones are not, explicit ones are never dropped")
}

// linked worktree 的 git 布局：本次 checkout 的 gitdir（index.lock / HEAD.lock 的
// 落点）整个授权；common dir（主仓 .git）只给 objects / refs / logs。hooks 与
// config 永远不给 —— 授权 hooks 等于让子代理种一个父代理之后会执行的 hook，
// 授权 config 则能改 core.hooksPath 达到同样的效果。
{
  const main = join(root, "wt-main")
  const linked = join(root, "wt-linked")
  mkdirSync(main, { recursive: true })
  writeFileSync(join(main, "seed.txt"), "seed\n")
  execFileSync("git", ["init", "-b", "main", main], { encoding: "utf8" })
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: main, encoding: "utf8" })
  }
  run(["add", "."])
  run(["-c", "user.email=unit@test", "-c", "user.name=unit", "commit", "--quiet", "-m", "seed"])
  run(["worktree", "add", "--quiet", linked])
  const common = join(main, ".git")
  const gitDir = join(common, "worktrees", "wt-linked")
  const granted = sandboxWritableDirs({ writeGlobs: [] } as never, linked, writeRule())
  assert.ok(granted.includes(gitDir), "the linked worktree's own gitdir is granted (index.lock lives there)")
  for (const name of ["objects", "refs", "logs"]) {
    assert.ok(granted.includes(join(common, name)), `the common dir is granted for ${name}`)
  }
  assert.ok(!granted.includes(common), "the common dir itself is not opened")
  assert.ok(!granted.includes(join(common, "hooks")), "hooks are never granted: a child could plant a hook the parent later runs")
  assert.ok(!granted.includes(join(common, "config")), "config is never granted: core.hooksPath must stay out of reach")
  console.log("  ok   a linked worktree grants its gitdir plus common objects/refs/logs, never hooks or config")
}

// writable: false 是角色自己定下的上限：写范围一个目录都不进 spec，任何一层都
// 不该放宽它。但 helper 需要的挂载不能少 —— /tmp 与设备文件必须仍在 write 里，
// 否则命令连 2>/dev/null 都过不去（EPERM）。
{
  const cwd = join(root, "readonly")
  const secret = join(cwd, "secret")
  mkdirSync(secret, { recursive: true })
  writeFileSync(join(secret, "leak.txt"), "")
  const rule = writeRule({
    writable: false,
    env: { TMPDIR: "/tmp", MISE_STATE_DIR: join(root, "mise") },
  })
  const spec: { tmp?: string; write: string[] } = buildSpec(cwd, rule, { writeGlobs: ["secret"] } as never)
  assert.ok(!spec.write.some((p) => p === secret || p.startsWith(`${secret}/`)), "a writable:false role leaks no scope dir into the spec")
  assert.ok(spec.write.includes("/tmp"), "/tmp stays granted so the command has a working tmp")
  assert.ok(spec.write.includes("/dev/null"), "device paths stay granted so redirections do not die with EPERM")
  assert.ok(!("tmp" in spec), "no private tmp mount is requested when TMPDIR is the conventional /tmp")
  console.log("  ok   a writable:false role carries no scope dirs but keeps the mounts the helper needs")
}

// scratchDir 同时是 spec.tmp（helper 挂私有 tmpfs 的位置）和 write 里的授权：
// 两处必须是同一个目录，命令写进 TMPDIR 的文件才落在沙箱里，而不是落在宿主的
// os.tmpdir() 上。坏掉的 TMPDIR（不存在）退回 /tmp：不能因为一个坏 TMPDIR 让
// bash 全灭。
{
  const cwd = join(root, "pinned")
  const pinned = join(cwd, "pinned-tmp")
  const grantedDir = join(cwd, "granted")
  mkdirSync(pinned, { recursive: true })
  mkdirSync(grantedDir, { recursive: true })
  const rule = writeRule({ env: { TMPDIR: pinned, MISE_STATE_DIR: join(root, "mise") } })
  const spec: { tmp?: string; write: string[] } = buildSpec(cwd, rule, { writeGlobs: ["granted"] } as never)
  assert.equal(scratchDir(cwd, rule), pinned, "scratchDir honours a pinned existing TMPDIR")
  assert.equal(spec.tmp, pinned, "the spec mounts the pinned dir, not os.tmpdir()")
  assert.ok(spec.write.includes(pinned), "the mounted tmp is also the granted path: writes land inside the sandbox")
  assert.ok(spec.write.includes(grantedDir), "a scope grant outside the private tmp survives the mount")
  const broken = writeRule({ env: { TMPDIR: join(cwd, "no-such-dir") } })
  assert.equal(scratchDir(cwd, broken), "/tmp", "a missing pinned TMPDIR falls back to /tmp instead of killing every command")
  console.log("  ok   the spec's tmp mount and its write grant are the same pinned directory")
}


// helper 的「网络已隔离」提示打到 stderr，每条离线命令都落进模型上下文一次。
// 改法：wrapInSandbox 给 helper 调用加一个环境变量前缀，helper 读到就不再播报
// 成功行（降级警告不受影响，每次照说）。前缀只准落在 helper 本身：`--` 之后的
// 用户命令段必须逐字节不变 —— 命令匹配规则看到的仍然是原来那条命令。
const afterHelper = (wrapped: string): string => wrapped.slice(wrapped.indexOf("'--' ") + 5)
{
  const command = "pnpm run typecheck"
  const announce = wrapInSandbox(command, "/tmp/spec-a.json", "/opt/helper")
  assert.ok(announce.startsWith("'/opt/helper'"), "the first wrapped command carries no quiet prefix")
  assert.ok(!announce.includes(QUIET_NETWORK_NOTICE_ENV), "and says nothing about the quiet variable")
  assert.equal(afterHelper(announce), `'bash' '-lc' '${command}'`, "the user command segment after -- is byte-identical to the input")
  console.log("  ok   the first wrapped command announces and keeps the user command byte-identical")
}
{
  const command = "pnpm run typecheck"
  const announce = wrapInSandbox(command, "/tmp/spec-a.json", "/opt/helper")
  const quiet = wrapInSandbox(command, "/tmp/spec-a.json", "/opt/helper", false)
  assert.ok(quiet.startsWith(`${QUIET_NETWORK_NOTICE_ENV}=1 '/opt/helper'`), "an already-announced call prefixes the helper invocation with the quiet variable")
  assert.equal(afterHelper(quiet), afterHelper(announce), "the quiet prefix does not touch the user command segment")
  console.log("  ok   a later wrapped command is quiet and its user command segment is unchanged")
}

// 调用方侧的状态（谁传 announce=false）：judgeToolCall 的完整调用链需要 helper
// 二进制（describeHelper 真的会跑 `--describe`），单元腿不带它，所以这里只钉得住
// 不需要二进制的那一半：记牌住在 WiringState 上，新会话从「未播报」起步 —— 每份
// createWiring() 一个值，不存在跨会话泄漏的模块级开关。第二次调用带不带前缀由
// handler 层（stub helper）覆盖。
{
  const wiring = createWiring()
  assert.equal(wiring.sandboxNetworkNoticeAnnounced, false, "a fresh session's wiring starts unannounced, so its first offline command still speaks")
  console.log("  ok   a fresh session's wiring starts unannounced")
}

// 工具链探测按 readdir 的顺序取前 DETECT_MAX_ROOTS 个目录，而这个顺序由文件系统决定 ——
// 这台机器上 tmpfs 给的是排序结果，ext4 的 dir_index、XFS、NFS 给的是哈希序，同一个仓库在
// 两台机器上因此可能扫到不同的目录。磁盘上的顺序在本机造不出来，所以这里钉的是比较器本身。
{
  const shuffled = ["mike", "alpha", "zeta", "delta", "Bravo"].map((name) => ({ name }))
  assert.deepEqual(
    sortByName(shuffled).map((entry) => entry.name),
    ["Bravo", "alpha", "delta", "mike", "zeta"],
    "the scan sorts by code unit, so the same tree yields the same directories on any filesystem",
  )

  // 排序不能是 localeCompare：在 sv-SE 之类的 locale 下 "zeta" 会排到 "Bravo" 前面，
  // 那样顺序又变成了环境依赖。
  const pairs = ["zeta", "Bravo", "ä", "A"].map((name) => ({ name }))
  assert.deepEqual(
    sortByName(pairs).map((entry) => entry.name),
    ["A", "Bravo", "zeta", "ä"],
    "sorting is not locale-sensitive",
  )
  console.log("  ok   the toolchain scan sorts by code unit, not by readdir order or locale")
}

console.log("  sandbox.unit: 13 cases passed")
