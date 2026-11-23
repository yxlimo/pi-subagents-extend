// Offline test for the pi-subagents-extend extension — command and spec cases (82-100).
// Case block split from extension.test.ts; runs against the same fake pi API.
//
//   node test/extension-commands.test.ts

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, specOf, specPathOf, workdir, stateDir, ext } from "../harness.ts"

// 82. bash 配了却跑不起来时，开场就说，而不是让子代理撞几次墙再自己推断。
//     （实测过：helper 没装时子代理连跑四条命令，每条都拿到同一句「helper not found」，
//     它最后自己得出了这个结论 —— 但那是四次调用换来的。）
{
  const real = process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH
  process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = "/nonexistent/pi-subagents-extend-helper"

  const missing = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls"] } } }),
  })
  const said = missing.ui.join("\n")
  assert.match(said, /no sandbox helper found/, "a missing helper is announced when the session starts")
  // 文案是契约的一部分：缺 helper 时读者要知道去哪找（包内平台路径）或怎么覆盖（环境变量）。
  assert.match(said, /bin\/pi-subagents-extend-helper-/, "and it names the path the package ships")
  assert.match(said, /PI_SUBAGENTS_EXTEND_HELPER_PATH/, "and the override that points at a binary you built")
  const refused = await missing.call("bash", { command: "ls" })
  assert.equal(refused?.block, true, "bash is refused rather than attempted")
  missing.restore()

  // 没开 bash 的会话不该被这条告警打扰。
  const noBash = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."] } }),
  })
  assert.doesNotMatch(noBash.ui.join("\n"), /sandbox helper/, "a session with bash off says nothing")
  noBash.restore()

  if (real === undefined) delete process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH
  else process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = real

  // 只有一条候选：npm 包内按平台命名的二进制。环境变量是覆盖，不算候选；
  // 源码 checkout 的开发路径也是同一条 —— build:helper 就落在那里。
  const candidates = ext.helperCandidates("/x/packages/pi-plugin/src")
  assert.deepEqual(
    candidates,
    [`/x/packages/pi-plugin/bin/pi-subagents-extend-helper-${process.platform}-${process.arch}`],
    "the only candidate is the packaged binary for this platform",
  )
  // 平台参与命名：否则「arm64 上找不到」这类报告无从判断。
  assert.equal(
    ext.helperCandidates("/x/packages/pi-plugin/src", "linux", "arm64")[0],
    "/x/packages/pi-plugin/bin/pi-subagents-extend-helper-linux-arm64",
    "the platform argument names the packaged binary",
  )
  // 旧名与 cargo 产物都不再是候选：包装出来的那份才是唯一的运行时来源。
  assert.ok(
    !candidates.some((c) => c.endsWith("/pi-subagents-extend-helper") || c.includes("target/release")),
    "no generic-name or cargo-artifact candidate survives",
  )
  console.log("  ok   缺 helper 开场告警；候选只有打包的平台二进制，旧名与 cargo 产物已移除")
}

// 83. 拒绝文案必须点名「被拒的命令」。早先只印允许列表，实测被读成
//     「command not in the allowlist: ls」→「ls 不被接受」，而真正被拒的是别的命令。
{
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls"] } } }),
  })
  const refused = await h.call("bash", { command: "pwd" })
  assert.equal(refused?.block, true, "a command outside the list is refused")
  assert.match(refused.reason, /not in the allowlist: "pwd"/, "the message names the command that was refused")
  assert.match(refused.reason, /allowed: ls/, "and keeps listing what is allowed")
  h.restore()
  console.log("  ok   拒绝文案点名被拒的命令，并附允许列表")
}

// 84. 并行 bash 必须各用各的 spec 文件。早先文件名是 spec-<pid>.json（一进程一个），
//     pi 并行发工具调用时会互相覆盖：先起的 helper 可能读到后一条的 spec，拿到错的
//     写清单与 cwd。这里在同一进程里连发两次调用、都不等结果，然后比对两份文件。
//
//     说清能钉住什么：文件名与生命周期可以（下面这些断言）；**内容归属**不行 —— rule
//     来自 policy 而不是来自某一次调用，同一 handler 下两份 spec 的 cwd/offline/write
//     按构造必然相同，用 deepEqual 比较只会得到「它们一样」，实现退回单文件时那句也
//     照样通过（早先就是这么写的）。归属靠文件名区分加用例 85 的覆盖/清理行为来钉。
{
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls", "git status"], writable: true } },
    }),
  })
  const first = { command: "ls" }
  const second = { command: "git status" }
  const firstOutcome = await h.call("bash", first, "c1")
  assert.equal(firstOutcome?.block ?? false, false, "first call is allowed")
  const secondOutcome = await h.call("bash", second, "c2")
  assert.equal(secondOutcome?.block ?? false, false, "second call is allowed")
  const firstSpec = specPathOf(first.command)
  const secondSpec = specPathOf(second.command)
  assert.notEqual(firstSpec, secondSpec, "concurrent calls get distinct spec files")
  // 两份都还在（结果还没回来），而且都能整份解析 —— 半截 JSON 会在 specOf 里抛。
  assert.ok(existsSync(firstSpec), "the first spec survives the second call")
  const a = specOf(first.command)
  const b = specOf(second.command)
  assert.equal(a.cwd, workdir, "the first spec carries its own cwd")
  assert.equal(b.cwd, workdir, "the second spec carries its own cwd")
  assert.ok(a.write.length > 0 && b.write.length > 0, "both specs carry a resolved write list")
  // 结果回来后清掉，避免每个 bash 调用留一份垃圾。
  await h.result("bash", "ok", false, "c1")
  await h.result("bash", "ok", false, "c2")
  assert.equal(existsSync(firstSpec), false, "the first spec is removed once its result is in")
  assert.equal(existsSync(secondSpec), false, "the second spec is removed too")
  h.restore()
  console.log("  ok   并行调用各用各的 spec 文件，结果回来后清理")
}

// 85. spec 文件的生命周期：结果回来删自己的；重复 id 留下的孤儿与陈旧的交给会话结束清扫。
//     早先只在 tool_result 里删，其余路径全部遗留 —— 实测这台机器上堆了 2993 份，
//     因为「每次调用一份文件名」把「互相覆盖」换成了「互相累积」。
{
  // (a) 同一 toolCallId 又来一次：只覆盖条目，旧文件**不能**删 —— 我们判断不出先那次是否
  //     已经启动，删掉会让一个在途 helper 以 exit 77 死在「读不到 spec」上；孤儿交给清扫。
  //     两个方向都断言，否则实现改成「删」或「不删」都能过。
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls"] } } }),
  })
  const first = { command: "ls" }
  await h.call("bash", first, "dup")
  const firstSpec = specPathOf(first.command)
  assert.ok(existsSync(firstSpec), "the first spec is written")
  const second = { command: "ls" }
  await h.call("bash", second, "dup")
  const secondSpec = specPathOf(second.command)
  assert.notEqual(secondSpec, firstSpec, "the repeat gets its own file")
  assert.ok(existsSync(firstSpec), "the superseded spec is left to the sweep instead of deleted under a live helper")
  assert.ok(existsSync(secondSpec), "the live one stays until its result arrives")
  await h.result("bash", "ok", false, "dup")
  assert.equal(existsSync(secondSpec), false, "and is removed when the result arrives")
  h.restore()

  // (b) session_shutdown 按年龄清扫：陈旧的清掉，新的留着（别的进程可能正在用），
  //     同一目录里的 git-excludes 绝不能碰。清扫读的是状态目录，所以把它指到临时目录。
  const h2 = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls"] } } }),
  })
  const fakeState = mkdtempSync(join(tmpdir(), "pi-specsweep-"))
  const cache = fakeState
  mkdirSync(cache, { recursive: true })
  const staleSpec = join(cache, "spec-1-1-t1.json")
  const staleTemp = join(cache, "spec-1-3-t3.json.tmp")
  const freshSpec = join(cache, "spec-1-2-t2.json")
  const excludes = join(cache, "git-excludes")
  for (const path of [staleSpec, staleTemp, freshSpec]) writeFileSync(path, "{}")
  writeFileSync(excludes, "*.log\n")
  const old = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(staleSpec, old, old)
  utimesSync(staleTemp, old, old)
  // git-excludes 也改老：否则「年龄闸门」本身就保住了它，前缀过滤那条守卫就没人钉。
  utimesSync(excludes, old, old)
  const previousState = process.env.PI_SUBAGENTS_EXTEND_STATE
  process.env.PI_SUBAGENTS_EXTEND_STATE = fakeState
  try {
    await h2.shutdown()
  } finally {
    if (previousState === undefined) delete process.env.PI_SUBAGENTS_EXTEND_STATE
    else process.env.PI_SUBAGENTS_EXTEND_STATE = previousState
  }
  assert.equal(existsSync(staleSpec), false, "a stale spec is swept at shutdown")
  assert.equal(existsSync(staleTemp), false, "a stale half-written temp file is swept too")
  assert.equal(existsSync(freshSpec), true, "a fresh spec is left alone for its own process")
  assert.equal(existsSync(excludes), true, "git-excludes in the same directory is untouched")
  h2.restore()
  rmSync(fakeState, { recursive: true, force: true })
  console.log("  ok   spec 生命周期：结果回来删自己的、重复 id 的孤儿留给清扫、别的文件不碰")
}

// 86. 前置环境变量赋值不该让白名单失效：`HOME=/tmp/x node a.ts` 跑的就是 `node a.ts`。
//     实测撞到过——同一个被允许的 `node` 被拒成「command not in the allowlist」，而那行文案里
//     恰好列着 node，看起来像自相矛盾。三个方向都要钉住，否则「剥太多」也能全绿：
//       (a) 只剥最前面连续的赋值，命令中间的 `A=1` 不动；
//       (b) 带引号的值、`+=` 追加赋值同样算赋值（按空白切词会把它们切坏、误拒）；
//       (c) 能改变「跑哪个程序 / 加载哪段代码」的名字必须拒 —— 带上它，被允许的命令
//           就等于跑任意代码（`NODE_OPTIONS=--require=/tmp/x.js node` 实测会执行 /tmp/x.js）。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-assign-"))
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["."],
        bash: { read: ["git status", "node", "re:^ls -la$"] },
      },
    }),
  })
  const assigned = await h.call("bash", { command: "HOME=/tmp/pi-home node script.mjs" })
  assert.notEqual(assigned?.block, true, "an assignment prefix does not defeat a plain entry")
  const twoAssignments = await h.call("bash", { command: "A=1 B=2 git status" })
  assert.notEqual(twoAssignments?.block, true, "several assignments are stripped too")
  const stillRefused = await h.call("bash", { command: "HOME=/tmp/pi-home rm -rf src" })
  assert.equal(stillRefused?.block, true, "stripping the prefix does not allow a command that is not listed")
  // (a) 命令中间的赋值不是前缀：`git A=1 status` 的真实 argv 是 [git, A=1, status]，不是 git status。
  //     换成「剥掉所有赋值形状的 token」时这条会变成允许 —— 正是这里要挡的过度剥离。
  const midCommandAssignment = await h.call("bash", { command: "git A=1 status" })
  assert.equal(midCommandAssignment?.block, true, "only leading assignments are stripped")
  // (b) 带引号的空格值、`+=` 追加赋值：bash 都当赋值，按空白切词会切坏。
  const quotedValue = await h.call("bash", { command: 'HOME="/tmp/my home" node script.mjs' })
  assert.notEqual(quotedValue?.block, true, "a quoted value with spaces is still one assignment")
  const appendAssignment = await h.call("bash", { command: "A+=1 node script.mjs" })
  assert.notEqual(appendAssignment?.block, true, "an append assignment (+=) is an assignment")
  // (c) 注入入口：这些名字一旦放行，白名单就形同虚设，所以命中即拒并点名。
  const nodeOptions = await h.call("bash", { command: "NODE_OPTIONS=--require=/tmp/evil.js node -e ''" })
  assert.equal(nodeOptions?.block, true, "NODE_OPTIONS is refused: it preloads code into an allowed node")
  assert.match(String(nodeOptions?.reason), /NODE_OPTIONS/, "the note names the offending variable")
  const gitExternalDiff = await h.call("bash", { command: "GIT_EXTERNAL_DIFF=/tmp/evil git status" })
  assert.equal(gitExternalDiff?.block, true, "GIT_* is refused: git runs it as a subcommand")
  const pathSwap = await h.call("bash", { command: "PATH=/tmp/evil git status" })
  assert.equal(pathSwap?.block, true, "PATH is refused: it swaps which program runs")
  // 正向控制：同样的命令去掉注入名字后仍然放行，否则上面三条可以靠「一律拒绝」骗过去。
  const benignAgain = await h.call("bash", { command: "HOME=/tmp/x node script.mjs" })
  assert.notEqual(benignAgain?.block, true, "a benign name is still allowed after the denied ones are refused")
  // 正则条目仍是整串匹配：作者写的是真实命令行，赋值前缀该由作者自己决定要不要认。
  const regexStillSeesAssignment = await h.call("bash", { command: "HOME=/tmp/x ls -la" })
  assert.equal(regexStillSeesAssignment?.block, true, "re: entries keep matching the command as written")
  const regexPlain = await h.call("bash", { command: "ls -la" })
  assert.notEqual(regexPlain?.block, true, "the same re: entry still matches the bare command")
  h.restore()
  console.log("  ok   前置赋值：只剥前缀、引号与 += 也算、注入名字拒绝，正则条目仍按原文匹配")
}

// 87. 锚点编辑族按写工具判：本条只用 `replace` 验证「进了 allowTools 也绕不开写范围」，
//     其余成员在 87（缺目标）、88（undo_last_change）、94（copy/move 两侧）、97（显式 path）分别钉。
//     宿主上 pi-hashline-edit-pro 会把内置 edit 从活动工具集里删掉，只认 edit 的名字表在
//     那里等于「整套编辑能力都是未知工具」。同时钉住顺序：allowTools 不能成为绕过路径判定的
//     后门——把 replace 写进 allowTools 之后仍必须受写范围约束。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-hashline-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  writeFileSync(join(tree, "src", "a.ts"), "a\n")

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], allowTools: ["replace"], bash: false },
    }),
  })
  const inside = await h.call("replace", { path: "src/a.ts", remove_from: "x", text: "y" })
  assert.notEqual(inside?.block, true, "replace inside the scope is allowed")
  const outside = await h.call("replace", { path: "outside/b.ts", remove_from: "x", text: "y" })
  assert.equal(outside?.block, true, "replace outside the scope is refused")
  assert.match(
    String(outside?.reason),
    /outside the scope|not writable/,
    "refused by the scope, not waved through by allowTools",
  )
  h.restore()
  console.log("  ok   hashline 编辑族按写工具判，allowTools 不能绕过写范围")
}







// 99. 写授权落在私有 tmpfs 之下时剔掉，而不是让 helper 拒掉整份 spec。
//     helper 在 /tmp（和 spec 的 tmp）上挂私有 tmpfs，挂载之后落在其下的授权路径从它的视图里
//     消失，于是整份 spec 被拒（exit 77）—— 一条命令都跑不了。授权那个目录本身仍有效（挂载点还在），
//     所以只剔严格在下的，并且把这件事告诉父代理一次（静默丢弃会让子代理反复撞「写不进去」）。
//     真实触发面不是 writeScope 的绝对授权（它走 absoluteWrite，不进 bash 的可写面），而是
//     bash.writablePaths，以及 HOME 落在 /tmp 下的 toolchainCacheDir()（容器与 CI 就是这样）。
{
  const grant = join(tmpdir(), `pi-hidden-grant-${process.pid}`)
  // cwd 必须不在 /tmp 下：helper 只在 cwd 不落在该目录时才挂私有 tmpfs（否则会盖住工作目录），
  // 而测试的 workdir 本身就在 tmpdir() 里。`.test-*` 已在 .gitignore 里，不会污染工作树。
  const outsideTmp = stateDir(".test-cwd-")
  mkdirSync(grant, { recursive: true })
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [grant] },
      },
    }),
    cwd: outsideTmp,
  })
  const input = { command: "git status" }
  assert.equal(await h.call("bash", input), undefined, "命令本身照旧放行：配置问题不该让 bash 全灭")
  const spec = specOf(input.command)
  assert.ok(!spec.write.includes(grant), "落在私有 tmpfs 之下的授权被剔掉")
  assert.ok(spec.write.includes(tmpdir()), "被私有化的目录本身仍可写，否则 /tmp 上的任何写入都用不了")
  assert.equal(
    h.ui.filter((m) => m.includes(grant)).length,
    1,
    "剔掉这件事告诉父代理一次：不说的话，子代理只看到写被拒",
  )
  // 同一条命令再来一次不该重复提示 —— 每条命令一份 spec，否则警告会淹没整个会话。
  await h.call("bash", { command: "git status" })
  assert.equal(
    h.ui.filter((m) => m.includes(grant)).length,
    1,
    "第二次调用不重复提示",
  )
  // 同一个进程里的**下一个会话**必须重新提示：提示状态是模块级的，若不在 session_start 重置，
  // 新会话会静默吞掉本该发出的告警（丢了，不是重复）。用同一条授权路径才钉得住这一点。
  const nextSession = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [grant] },
      },
    }),
    cwd: outsideTmp,
  })
  const nextInput = { command: "git status" }
  assert.equal(await nextSession.call("bash", nextInput), undefined, "下一个会话的命令照旧放行")
  assert.equal(
    nextSession.ui.filter((m) => m.includes(grant)).length,
    1,
    "下一个会话重新提示一次：模块级状态不重置就会永久吞掉这条告警",
  )
  nextSession.restore()
  h.restore()

  // 正控：树内的授权照旧写进 spec —— 否则「一律剔掉」也能过上面几条。
  const inside = join(outsideTmp, "inside-grant")
  mkdirSync(inside, { recursive: true })
  const tree = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [inside] },
      },
    }),
    cwd: outsideTmp,
  })
  const command = { command: "git status" }
  assert.equal(await tree.call("bash", command), undefined, "树内授权的命令放行")
  assert.ok(specOf(command.command).write.includes(inside), "树内的写授权仍然进 spec")
  assert.equal(tree.ui.filter((m) => m.includes("write grant(s) dropped")).length, 0, "树内授权不触发丢弃提示")
  tree.restore()
  rmSync(grant, { recursive: true, force: true })
  rmSync(outsideTmp, { recursive: true, force: true })
  console.log("  ok   落在私有 tmpfs 之下的写授权被剔掉，并提示父代理一次")
}

// 100. 经软链指向私有化目录的授权同样要剔掉。
//      helper 把两边都解析软链后比较（resolve_comparable），插件若按原字符串比就会保留这条授权，
//      而 helper 会因它拒掉整份 spec —— 又回到「一条命令都跑不了」。反方向同样有害：插件比 helper
//      更激进时，一条本来能用的授权会被白白剔掉。
{
  const outsideTmp = stateDir(".test-cwd-")
  // 指向 tmpdir()（私有化目录）的软链：插件按原字符串看不在 /tmp 下，按真实路径看在。
  const toTmp = join(outsideTmp, "link-to-tmp")
  symlinkSync(tmpdir(), toTmp)
  const grantViaLink = join(toTmp, "pi-hidden-target")
  mkdirSync(grantViaLink, { recursive: true })

  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [grantViaLink] },
      },
    }),
    cwd: outsideTmp,
  })
  const input = { command: "git status" }
  assert.equal(await h.call("bash", input), undefined, "命令照旧放行")
  assert.ok(
    !specOf(input.command).write.includes(grantViaLink),
    "经软链指向私有化目录的授权被剔掉：helper 解析软链后会拒绝整份 spec",
  )
  assert.equal(
    h.ui.filter((m) => m.includes(grantViaLink)).length,
    1,
    "并且点名提示了这条软链授权",
  )
  // 缺失的尾巴必须原样保留、祖先软链必须解析：helper 的 resolve_comparable 就是这个语义，而
  // buildSpec 能产出的授权都真实存在，所以这一段是直接钉函数本身，补上「缺失尾巴」这条覆盖缺口。
  assert.equal(
    ext.resolveComparable(join(toTmp, "not-created-yet")),
    join(tmpdir(), "not-created-yet"),
    "缺失尾巴保留、祖先软链解析：与 helper 一致，否则『命令即将创建的目录』会被判成另一条路径",
  )
  // `..` 原样保留，不归一化：Rust 那边是 push 进去的，归一化会让两边对同一条授权给出不同结论。
  assert.equal(
    ext.resolveComparable(`${tmpdir()}/pi-nx/../x`),
    `${tmpdir()}/pi-nx/../x`,
    "缺失段里的 `..` 原样保留，与 helper 逐字节一致",
  )
  h.restore()

  // 正控：软链指向树内目录时，授权照旧保留 —— 否则「看见软链就剔」也能过上面几条。
  const insideTarget = join(outsideTmp, "real-inside")
  mkdirSync(join(insideTarget, "build"), { recursive: true })
  const toInside = join(outsideTmp, "link-to-inside")
  symlinkSync(insideTarget, toInside)
  const grantInside = join(toInside, "build")
  const tree = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [grantInside] },
      },
    }),
    cwd: outsideTmp,
  })
  const inside = { command: "git status" }
  assert.equal(await tree.call("bash", inside), undefined, "树内软链授权的命令放行")
  assert.ok(
    specOf(inside.command).write.includes(grantInside),
    "软链指向树内目录时授权保留：不能比 helper 更激进",
  )
  tree.restore()
  rmSync(outsideTmp, { recursive: true, force: true })
  console.log("  ok   经软链指向私有化目录的写授权被剔掉，指向树内的照旧保留")
}


