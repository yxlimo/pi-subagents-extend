// Budgets: the two refusal counters, warn-versus-stop, and what charges a budget.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Outcome } from "../types.ts"
import { handler, specOf, fakeClock, defaultProbe, workdir, repo } from "../harness.ts"

// 33. 撞权限只统计「父代理放宽授权或调整设置能解决」的拒绝。
//     用法错误（元字符、缺 path）与硬规则（永久不开放的工具、profile 禁令）不消耗预算，
//     否则一次参数写错就能把长任务提前判死（现场：4 次计数里 1 次是 `cd X && git status`）。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], writeScope: ["src/**"], maxDenies: 2, bash: { allow: ["pnpm run typecheck"]} },
    }),
  })
  const counted = (reason: string): boolean => /in a row|denial budget/.test(reason)

  // (a) 用法错误：shell 元字符，连撞 4 次也不该推进计数。
  for (let i = 0; i < 4; i += 1) {
    const r = await h.call("bash", { command: `pnpm run typecheck && echo ${i}` })
    assert.equal(r?.block, true, "a metacharacter command is refused")
    assert.equal(counted(r.reason), false, `metacharacters do not feed the counter (call ${i + 1})`)
  }

  // (b) 硬规则：范围放多宽都不会开放的工具。
  for (let i = 0; i < 3; i += 1) {
    const r = await h.call("powershell", { command: "dir" })
    assert.equal(r?.block, true, "powershell is refused")
    assert.match(r.reason, /never available/i, "the message says it is not a grant the parent can widen")
    assert.equal(counted(r.reason), false, "a never-available tool does not feed the counter")
  }

  // (c) 缺 path：用法错误，同样不计。
  const noPath = await h.call("grep", { pattern: "x" })
  assert.equal(noPath?.block, true, "pathless grep at an out-of-scope cwd is refused")
  assert.equal(counted(noPath.reason), false, "a usage error does not feed the counter")

  // (d) 真正的撞权限：上面一堆拒绝之后，计数仍从 0 开始。
  const first = await h.call("read", { path: "outside/a.ts" })
  assert.ok(first, "out-of-scope read is refused")
  assert.equal(counted(first.reason), false, "the budget is still untouched by the usage errors before it")
  const second = await h.call("read", { path: "outside/b.ts" })
  assert.ok(second, "the second refusal is refused")
  assert.match(second.reason, /in a row/, "the second counted refusal warns at maxDenies 2")
  const third = await h.call("read", { path: "outside/c.ts" })
  assert.ok(third, "the third refusal is refused")
  assert.equal(third.terminate, true, "the third stops the run")
  assert.match(third.reason, /denial budget/)
  h.restore()
  console.log("  ok   撞权限只计授权类：用法错误与硬规则不消耗预算")
}


// 35. 撞权限的缺省预算：5 次计数拒绝才 warn，第 6 次才硬停。
//     缺省值本身就是决策（硬停判早一次就丢整轮任务），所以用行为钉住它。
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"] } }) })
  const verdicts: Outcome[] = []
  for (const name of ["a", "b", "c", "d", "e", "f"]) {
    verdicts.push(await h.call("read", { path: `outside/${name}.ts` }))
  }
  const notes = verdicts.map((v) => v !== undefined && /in a row|denial budget/.test(v.reason))
  assert.deepEqual(
    notes,
    [false, false, false, false, true, true],
    "default budget of five: four silent refusals, a warning at the fifth, a stop at the sixth",
  )
  const fifth = verdicts[4]
  assert.ok(fifth, "the fifth refusal is refused")
  assert.equal(fifth.terminate, undefined, "the fifth only warns")
  assert.match(fifth.reason, /contact_supervisor/, "the warning names the escalation channel")
  const sixth = verdicts[5]
  assert.ok(sixth, "the sixth refusal is refused")
  assert.equal(sixth.terminate, true, "the sixth ends the run")
  assert.match(sixth.reason, /for the parent session/i, "the stop text is addressed to the parent, who can act on it")
  h.restore()
  console.log("  ok   撞权限缺省 5：第 5 次 warn（点名求援），第 6 次硬停")
}
// 44. Write refusals have their own budget: misuse must not become a grant error.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], writeScope: [".pi/reports"], maxDenies: 5, maxWriteDenies: 2 },
    }),
  })
  const first = await h.call("write", { path: "src/a.ts", content: "x" })
  assert.ok(first, "the first write refusal blocks")
  assert.equal(first.block, true, "the first write refusal blocks")
  assert.equal(first.terminate, undefined, "and does not stop the run")
  const second = await h.call("write", { path: "src/b.ts", content: "x" })
  assert.ok(second, "the second write refusal blocks")
  assert.match(second.reason, /one more refusal ends the run/, "the second write refusal warns")
  assert.match(second.reason, /write scope does not cover/, "the warning is about the write scope, not the grant")
  assert.match(second.reason, /report/, "and repeats the way out: deliver a report")
  assert.equal(second.terminate, undefined, "still no stop at the limit")

  // 读拒与写拒各算各的：一次范围外读不应把写预算推过阈值。
  const readDenial = await h.call("read", { path: "docs/x.md" })
  assert.ok(readDenial, "an out-of-scope read is refused")
  assert.equal(readDenial.block, true, "an out-of-scope read is refused")
  assert.doesNotMatch(readDenial.reason, /one more ends the run/, "the read refusal uses the other budget")
  assert.doesNotMatch(readDenial.reason, /write scope does not cover/, "and it is not described as a write problem")

  const third = await h.call("write", { path: "src/c.ts", content: "x" })
  assert.equal(third?.block, true, "the third write refusal blocks")
  assert.equal(third.terminate, true, "and hard-stops the run")
  h.restore()
  console.log("  ok   写拒单独计数：第 2 次警告、第 3 次硬停，不被读拒推高")
}
// 52. 撞权限判据是「连续」而不是「累计」：文档、skill 与拒绝文案都这么写。
//      中间有一次放行的调用就重新计数，否则早期的一次误判会在几十轮之后把任务判死。
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 2, maxWriteDenies: 2 } }) })
  mkdirSync(join(workdir, "src"), { recursive: true })
  writeFileSync(join(workdir, "src", "ok.ts"), "export {}\n")

  const first = await h.call("read", { path: "outside/a.ts" })
  assert.equal(first?.block, true, "the first refusal blocks")
  assert.equal(await h.call("read", { path: "src/ok.ts" }), undefined, "an allowed call in between")
  const second = await h.call("read", { path: "outside/b.ts" })
  assert.equal(second?.block, true, "the refusal after an allowed call blocks")
  assert.doesNotMatch(second.reason, /in a row/, "it is back to refusal 1, below the warning threshold")
  assert.equal(second.terminate, undefined, "an allowed call reset the counter: no warning, no stop")

  // 连续两次才到 warn，第三次才停 —— 和之前一样。
  const third = await h.call("read", { path: "outside/c.ts" })
  assert.match(third?.reason ?? "", /in a row/, "two in a row now warns")
  assert.equal(third?.terminate, undefined, "the warning still does not stop")
  const fourth = await h.call("read", { path: "outside/d.ts" })
  assert.equal(fourth?.terminate, true, "three in a row ends the run")
  h.restore()
  console.log("  ok   撞权限按「连续」计：中间放行一次就重新计数")
}

// 53. 绑定写坏时不能变成「全拒但永不停止」：每个调用都被拒却永远不计满，子代理会磨到超时。
//      预算改成缺省值之后，拒几次就硬停，真实原因留在拒绝文案里。
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": {} }) })
  const first = await h.call("read", { path: "src/a.ts" })
  assert.equal(first?.block, true, "a broken binding refuses everything")
  assert.match(first.reason, /scope is missing/i, "and the reason names what is wrong with the binding")
  assert.equal(first.terminate, undefined, "the first refusal does not stop the run")

  let last: Outcome = first
  for (let i = 0; i < 5; i += 1) last = await h.call("read", { path: `src/${i}.ts` })
  assert.equal(last?.terminate, true, "a broken binding hard-stops instead of looping forever")
  h.restore()
  console.log("  ok   绑定写坏：拒绝文案点名原因，且会硬停而不是无限重试")
}
// 59. readOnly 的写拒属于写预算，不是授权预算。
//     readOnly 与 writeScope: [] 是同一种处境：写不了、放宽读范围也解决不了，出路是改成交报告，
//     而不是去求援。旧实现把它交给 bail（授权预算）：第 5 次才 warn、第 6 次才停，
//     文案还让子代理 contact_supervisor —— 与 writeScope: [] 的行为和文档里的「等价」不符。
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], readOnly: true } }) })
  const first = await h.call("write", { path: "src/a.ts", content: "x" })
  assert.equal(first?.block, true, "a readOnly write is refused")
  assert.match(first.reason, /no write grant/, "the refusal says there is no write grant")
  assert.equal(first.terminate, undefined, "the first refusal neither warns nor stops")

  // 计数归属直接看 /permission：写拒 1 次，读拒仍是 0 次。
  const permission = h.commands.permission
  assert.ok(permission, "/permission is registered")
  await permission.handler("", { cwd: workdir, ui: { notify: (m: string) => h.ui.push(m) } })
  const status = h.ui.at(-1) ?? ""
  assert.match(status, /read denials: 0\/5/i, "a readOnly write leaves the grant budget untouched")
  assert.match(status, /write denials: 1\/2/i, "and is charged to the write budget")

  const second = await h.call("write", { path: "src/b.ts", content: "x" })
  assert.equal(second?.block, true, "the second readOnly write is refused")
  assert.equal(second.terminate, undefined, "at two refusals it only warns: the write budget, not the grant budget of five")
  assert.match(second.reason, /Write refusal 2 in a row/, "the warning names the write budget")
  assert.match(second.reason, /report/i, "and gives the way out: deliver the finding as a report")
  assert.match(second.reason, /one more refusal ends the run/, "and says the next refusal stops the run")

  const third = await h.call("write", { path: "src/c.ts", content: "x" })
  assert.equal(third?.block, true, "the third readOnly write is refused")
  assert.equal(third.terminate, true, "the third ends the run")
  assert.match(third.reason, /write budget/, "the stop text names the criterion that fired")
  assert.match(third.reason, /report/, "and tells the parent a report was the intended deliverable")
  h.restore()

  // 判别式：授权预算压到 1。若 readOnly 写拒记在授权预算上，第一次就会 warn、第二次就硬停。
  const narrow = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], readOnly: true, maxDenies: 1 } }),
  })
  const one = await narrow.call("edit", { path: "src/a.ts", content: "x" })
  assert.equal(one?.block, true, "a readOnly edit is refused")
  assert.doesNotMatch(one.reason, /in a row/, "a grant budget of one is not reached by the first readOnly write")
  const two = await narrow.call("write", { path: "src/b.ts", content: "x" })
  assert.equal(two?.terminate, undefined, "nor spent by the second: the write budget owns these refusals")
  assert.match(two?.reason ?? "", /Write refusal 2 in a row/, "the second refusal warns on the write budget")
  narrow.restore()
  console.log("  ok   readOnly 的写拒走写预算：第 2 次 warn（指向报告）、第 3 次硬停")
}
// 72. Repeat probe counts a repeat only when the output did not change.
//     缺陷：判据原先只看「同一条命令出现 N 次」，不看输出。一个在量目录布局的子代理
//     三次 `ls` 同一个目录、每次输出都不同，却被判成原地打转并硬停 —— 那正是测量。
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), repeatBash: 3 },
    readOnly: true,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  let last: { stop: boolean } | undefined
  for (const out of ["a", "b", "c", "d"]) {
    last = p.noteBashStart("ls -la .pnpm")
    p.noteBashResult(out)
    assert.notEqual(last?.stop, true, "a repeat that returns new output is progress, not spinning")
  }
  assert.equal(last, undefined, "and it never even warns")
  p.dispose()
  console.log("  ok   同一命令但输出有变化时不算原地打转")
}

// 73. The same command with byte-identical output is still spinning.
//     这条与 72 成对：放宽的只有「输出变了」这一种，真卡住的孩子输出一字不差。
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), repeatBash: 3 },
    readOnly: true,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  for (let i = 0; i < 2; i += 1) {
    p.noteBashStart("git status")
    p.noteBashResult("On branch main\nnothing to commit")
  }
  const third = p.noteBashStart("git status")
  assert.equal(third?.stop, false, "identical output still reaches the warn")
  p.noteBashResult("On branch main\nnothing to commit")
  const fourth = p.noteBashStart("git status")
  assert.equal(fourth?.stop, true, "and one more still stops the run")
  p.dispose()
  console.log("  ok   输出一字不差的重复仍算原地打转（72 的另一半）")
}

// 74. After a stop, later calls are told the run is stopped, not re-told the old command.
//     缺陷：停机后每个调用收到的是同一条 #stopReason，而那句话描述的是触发停机的那次
//     动作。实测：一个子代理被判打转后改去 `ls -la docs`，回来的仍是点名 .pnpm 的旧文案，
//     于是它把新命令读成「也犯了那个错」。
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), repeatBash: 2, abortGraceMs: 1000 },
    readOnly: true,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  p.noteBashStart("ls -la .pnpm")
  p.noteBashResult("same")
  const warned = p.noteBashStart("ls -la .pnpm")
  assert.equal(warned?.stop, false, "the threshold warn comes first")
  p.noteBashResult("same")
  // 宽限到期由边界兑现（探针自己停机的那条路）。
  clock.advance(1000)
  const stopping = p.atToolBoundary()
  assert.equal(stopping?.stop, true, "once the grace expires the run stops")
  assert.match(String(stopping?.reason), /\.pnpm/, "the stopping call is told which command caused it")
  const later = p.atToolBoundary()
  assert.equal(later?.stop, true, "and later calls are still refused")
  assert.ok(!String(later?.reason).includes(".pnpm"), "the old command is not quoted again")
  assert.match(String(later?.reason), /stopped earlier/, "instead the call is told the run is stopped")
  p.dispose()
  console.log("  ok   停机后的调用收到状态说明，不复述触发停机的旧命令")
}

// 75. The CPU-stall watchdog is opt-in, reaches the spec only when on, and its kill is annotated.
//     背景：墙钟超时分不开「死锁」和「长编译」。判据在 helper 侧（它是 PID 1，看得见整棵
//     子树），扩展这一层只有三件事要负责：默认关、开启时把秒数写进 spec、被它杀掉时给模型
//     一句「重试没用」的说明 —— 否则模型会把它当成偶发失败，原样再跑一遍。
{
  const { parseBashRule } = await import(join(repo, "src", "bash/index.ts"))
  assert.equal(parseBashRule({ allow: ["pnpm test"] })?.cpuStallSeconds, false, "off unless asked for")
  assert.equal(parseBashRule({ allow: ["pnpm test"], cpuStallSeconds: false })?.cpuStallSeconds, false, "explicit false stays off")
  assert.equal(parseBashRule({ allow: ["pnpm test"], cpuStallSeconds: 0 })?.cpuStallSeconds, false, "0 means off, not kill at once")
  assert.equal(parseBashRule({ allow: ["pnpm test"], cpuStallSeconds: 90 })?.cpuStallSeconds, 90, "a positive value arms it")
  assert.equal(parseBashRule({ allow: ["pnpm test"], cpuStallSeconds: "60" })?.cpuStallSeconds, false, "a string is refused, not coerced (see 78)")

  const armed = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: [workdir], writeScope: [workdir], bash: { allow: ["node"], cpuStallSeconds: 90} },
    }),
  })
  const armedInput = { command: "node build.mjs" }
  await armed.call("bash", armedInput)
  assert.equal(specOf(armedInput.command).stallSeconds, 90, "the seconds reach the spec")
  armed.restore()

  const plain = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: [workdir], writeScope: [workdir], bash: { allow: ["node"] } } }),
  })
  const plainInput = { command: "node build.mjs" }
  await plain.call("bash", plainInput)
  assert.equal(
    "stallSeconds" in specOf(plainInput.command),
    false,
    "when off the key is absent: an older helper rejects unknown fields",
  )
  plain.restore()

  const { cpuStallNote } = await import(join(repo, "src", "sandbox-note.ts"))
  const killed = "pi-subagents-extend-helper: cpu stall: the command tree used no CPU for 90 s while still running; killing it"
  assert.match(String(cpuStallNote(killed)), /no CPU for 90 s/, "the note carries what the helper measured")
  assert.match(String(cpuStallNote(killed)), /Retrying stalls the same way/, "and says a retry will not help")
  assert.equal(cpuStallNote("FAIL src/app.test.ts > adds numbers"), undefined, "an ordinary test failure is left alone")
  assert.equal(cpuStallNote(`${killed}\n\n[sandbox] already annotated`), undefined, "the note is added once")
  console.log("  ok   CPU 卡死看门狗：默认关、开启才进 spec、被杀时的说明点明重试无用")
}

// 76. A stop fired by a timer must still tell the model why.
//     回归：把停机后的回复换成状态说明之后，计时器那条路（只读空转、早可收工）就什么都不说了 ——
//     `#hooks.warn` 只是 UI 提示，从没进过模型上下文。于是模型收到「原因见上面的消息」，而上面
//     没有那条消息。现在第一次边界补发原因，之后才是状态说明。
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), idleWriteMs: 1000, abortGraceMs: 500 },
    readOnly: false,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  clock.advance(1000)
  assert.equal(p.atToolBoundary()?.stop, false, "the idle criterion warns first")
  clock.advance(500)
  const first = p.atToolBoundary()
  assert.equal(first?.stop, true, "the grace expiring stops the run")
  assert.match(String(first?.reason), /criterion: idle/i, "and the reason names the criterion")
  const second = p.atToolBoundary()
  assert.equal(second?.stop, true, "later calls are still refused")
  assert.match(String(second?.reason), /stopped earlier/, "but from then on they get the status line")
  assert.ok(!/criterion: idle/i.test(String(second?.reason)), "without repeating the cause a third time")
  p.dispose()

  // 早可收工那条计时器同理：它也不经过任何工具调用。
  const clock2 = fakeClock()
  const done = new Probe({
    config: {
      ...defaultProbe(),
      successIdleMs: 1000,
      successPatterns: ["all tests passed"],
    },
    readOnly: false,
    hooks: { warn: () => {} },
    host: clock2.host,
  })
  done.noteBashStart("pnpm test")
  done.noteBashResult("all tests passed", "x")
  clock2.advance(1000)
  const doneFirst = done.atToolBoundary()
  assert.equal(doneFirst?.stop, true, "the success-marker timer stops the run")
  assert.match(String(doneFirst?.reason), /work is done/, "and the first boundary names the criterion")
  const doneSecond = done.atToolBoundary()
  assert.match(String(doneSecond?.reason), /stopped earlier/, "while the next one gets the status line")
  done.dispose()
  console.log("  ok   计时器停机也要把原因交给模型一次（之后才换成状态说明）")
}

// 77. Two bash calls in one message pair their outputs by call id.
//     缺陷：单槽 `#pending` 在并行的工具调用下会把先到的结果记到后一条命令名下，再丢掉另一条 ——
//     输出比对于是张冠李戴，而这条判据的代价就是误杀。pi 默认并行执行同一条消息里的调用。
//     这里必须用**两条不同命令**：同一命令时两个槽指向同一个计数键，单槽也能得出同样结果，
//     那样这条用例就什么也没钉住（第一版正是如此）。
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), repeatBash: 3 },
    readOnly: true,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  // a 与 b 并行进入，结果按相反顺序回来。
  p.noteBashStart("ls -la a", "call-1")
  p.noteBashStart("ls -la b", "call-2")
  p.noteBashResult("b1", "call-2")
  p.noteBashResult("a1", "call-1")
  // 再来一轮：a 带回新输出（进展，计数清零），b 与上次相同（继续累加）。
  p.noteBashStart("ls -la a", "call-3")
  p.noteBashStart("ls -la b", "call-4")
  p.noteBashResult("a2", "call-3")
  p.noteBashResult("b2", "call-4")
  // 第三次 a：输出与 a2 相同，计数应为 2，还不到 3，不该停。
  // 单槽时 a1 的结果被记到 b 名下、a 的基线被丢掉，于是这次被当成第 3 次 → 误杀。
  const a3 = p.noteBashStart("ls -la a", "call-5")
  // 固定实现下 a 的计数已被新输出清零，第 3 次什么也不返回；单槽下 a 的计数是累加到 3 的，
  // 于是这里会给出「同一命令重复 3 次」的警告（`stop: false`，下一次就硬停）。
  assert.equal(a3, undefined, "a's own changed output reset its count; a single slot warns here")
  p.dispose()
  console.log("  ok   并行 bash 调用按 toolCallId 配对输出（单槽会记到另一条命令名下并误杀）")
}

// 78. `cpuStallSeconds` rejects values that would silently mean something else.
//     `0.5` 先 floor 会得 0，而 `0 !== false` 就把 `stallSeconds: 0` 写进 spec —— 旧版 helper
//     的 deny_unknown_fields 会整份拒绝。「关掉时不写键」的兼容性就在这里被破坏。`true` 经
//     Number() 会变成 1，即「静默 1 秒就杀整棵树」，而不是「开」。
{
  const { parseBashRule } = await import(join(repo, "src", "bash/index.ts"))
  assert.equal(parseBashRule({ allow: ["x"], cpuStallSeconds: 0.5 })?.cpuStallSeconds, false, "a fraction below 1 is off, not 0")
  assert.equal(parseBashRule({ allow: ["x"], cpuStallSeconds: true })?.cpuStallSeconds, false, "true is not a threshold")
  assert.equal(parseBashRule({ allow: ["x"], cpuStallSeconds: "60" })?.cpuStallSeconds, false, "a string is not a number either")
  assert.equal(parseBashRule({ allow: ["x"], cpuStallSeconds: 1.9 })?.cpuStallSeconds, 1, "a fraction above 1 floors")
  console.log("  ok   看门狗阈值只接受正数字：0.5 与 true 都是关，不会变成 0 或 1")
}
