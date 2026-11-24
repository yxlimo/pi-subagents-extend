// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type {
  EventHandler,
  FakeExtensionApi,
  Outcome,
} from "../types.ts"
import { handler, specOf, fakeClock, defaultProbe, workdir, repo, ext } from "../harness.ts"
import { restoreState } from "../support.ts"

// 1. No bindings: the extension is inert, every call passes.
{
  const h = await handler({ bindings: undefined })
  assert.equal(await h.call("read", { path: "src/auth/login.ts" }), undefined, "unconfigured read passes")
  assert.equal(await h.call("bash", { command: "ls" }), undefined, "unconfigured bash passes")
  assert.equal(h.ui.length, 0, "unconfigured session_start stays silent")
  h.restore()
  console.log("  ok   无 bindings 时不生效，父会话不受影响")
}

// 2. Bindings scope: reads and in-scope writes pass, everything else is denied.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/auth/**", "src/**", "README.md"], maxDenies: 0 },
    }),
  })
  assert.equal(await h.call("read", { path: "src/auth/login.ts" }), undefined, "in-scope read passes")
  assert.equal(await h.call("edit", { path: "src/auth/login.ts" }), undefined, "in-scope edit passes")
  assert.equal(await h.call("grep", { path: "src/auth" }), undefined, "in-scope grep passes")
  assert.equal(await h.call("ls", { path: "src/auth" }), undefined, "dir glob also matches the dir itself")
  assert.equal(await h.call("read", { path: "README.md" }), undefined, "plain-file glob passes")
  assert.equal(await h.call("ls", { path: "src" }), undefined, "'src/**' matches 'src' itself")

  const outside = await h.call("read", { path: "docs/design.md" })
  assert.equal(outside?.block, true, "out-of-scope read is blocked")
  assert.match(outside.reason, /outside the read scope/, "block reason names the read scope")
  const editOutside = await h.call("write", { path: "docs/notes.md" })
  assert.equal(editOutside?.block, true, "out-of-scope write is blocked")

  const bash = await h.call("bash", { command: "cat /etc/passwd" })
  assert.equal(bash?.block, true, "bash is always blocked")
  const codemode = await h.call("codemode", { code: "1" })
  assert.equal(codemode?.block, true, "codemode is always blocked")

  const unknown = await h.call("web_search", { query: "x" })
  assert.equal(unknown?.block, true, "unknown tools fail closed")

  assert.equal(await h.call("structured_output", { result: {} }), undefined, "structured_output passes")
  assert.equal(await h.call("contact_supervisor", { message: "need a wider scope" }), undefined, "contact_supervisor is the report channel")
  h.restore()
  console.log("  ok   范围内放行、范围外拒绝，执行器与未知工具 fail closed")
}


// 6. Bindings for another namespace leave this extension inert.
{
  const h = await handler({ bindings: JSON.stringify({ "some-other-ext/1": { data: 1 } }) })
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "foreign bindings do not engage the scope")
  h.restore()
  console.log("  ok   别的扩展的绑定不触发本扩展")
}

// 7. maxReads caps successful reads.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], maxReads: 2 } }),
  })
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "read 1 passes")
  assert.equal(await h.call("read", { path: "src/b.ts" }), undefined, "read 2 passes")
  const third = await h.call("read", { path: "src/c.ts" })
  assert.equal(third?.block, true, "read 3 is denied by the budget")
  assert.match(third.reason, /read budget/, "block reason names the budget")
  assert.equal(await h.call("grep", { path: "src" }), undefined, "grep does not consume the read budget")
  h.restore()
  console.log("  ok   maxReads 限制 read 次数")
}

// 8. allowTools opens holes for named non-executor tools.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], allowTools: ["todo_write"] } }),
  })
  assert.equal(await h.call("todo_write", { items: [] }), undefined, "allowTools entry passes")
  const executor = await h.call("bash", { command: "ls" })
  assert.equal(executor?.block, true, "allowTools cannot re-enable executors")
  h.restore()
  console.log("  ok   allowTools 放行点名工具，但执行器类仍拒绝")
}


// 10. The bundled usage skill ships with the extension via resources_discover.
{
  const handlers: Record<string, EventHandler> = {}
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand() {},
  }
  ext.activate(api)
  const discover = handlers.resources_discover
  assert.ok(discover, "the extension registers resources_discover")
  const result = (await discover({ type: "resources_discover", cwd: workdir, reason: "startup" }, { cwd: workdir, ui: { notify() {} } })) as
    | { skillPaths?: string[] }
    | undefined
  const dirs = result?.skillPaths ?? []
  assert.equal(dirs.length, 3, "all usage skills are registered")
  const names = dirs.map((dir) => {
    const path = join(dir, "SKILL.md")
    assert.equal(existsSync(path), true, `${dir} holds a SKILL.md`)
    const frontmatter = readFileSync(path, "utf8").slice(0, 400)
    return frontmatter.match(/name: ([\w-]+)/)?.[1]
  })
  assert.deepEqual(
    names.sort(),
    ["pi-subagents-extend", "pi-subagents-extend-context", "pi-subagents-extend-probes"],
    "scope, probe and context skills",
  )
  console.log("  ok   三个用法 skill 随扩展经 resources_discover 注册")
}

// 11. A scoped session does not advertise the delegation skill.
{
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-subagents-extend/1": { permissions: { scope: ["src/**"] } } })
  const handlers: Record<string, EventHandler> = {}
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand() {},
  }
  ext.activate(api)
  const scopedDiscover = handlers.resources_discover
  assert.ok(scopedDiscover, "the extension registers resources_discover")
  const scoped = (await scopedDiscover({ type: "resources_discover", cwd: workdir, reason: "startup" }, { cwd: workdir, ui: { notify() {} } })) as
    | { skillPaths?: string[] }
    | undefined
  assert.equal(scoped?.skillPaths, undefined, "a scoped session gets no skill path")
  if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
  console.log("  ok   已上锁的会话不注册委派 skill")
}

// 12. bash allowlist: a listed command is handed to the sandbox helper, everything else is denied.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { allow: ["git status", "cat src/a.ts"]},
      },
    }),
  })
  const input = { command: "git status" }
  assert.equal(await h.call("bash", input), undefined, "listed command passes")
  assert.match(
    input.command,
    /^'\/[^']*pi-subagents-extend-helper' '--spec' '\/[^']*spec-[0-9]+-[0-9]+-[^']*\.json' '--' 'bash' '-lc'/,
    "command is rewritten to run under the sandbox helper",
  )
  assert.match(input.command, /'bash' '-lc' 'git status'$/, "original command preserved as the payload")
  const spec = specOf(input.command)
  assert.deepEqual(spec.read, ["/"], "everything stays readable")
  // The scratch dir plus the baseline devices are writable; nothing from the
  // task scope is, which is the point.
  assert.deepEqual(
    spec.write.filter((path) => !path.startsWith("/dev")),
    ["/tmp"],
    "only the scratch dir is writable by default",
  )
  assert.ok(spec.write.includes("/dev/null"), "the baseline devices stay writable, or 2>/dev/null fails")
  assert.equal(spec.offline, true, "the command is offline by default")
  assert.equal(spec.cwd, workdir, "the command keeps its working directory")

  const other = { command: "pnpm publish" }
  const denied = await h.call("bash", other)
  assert.equal(denied?.block, true, "unlisted command is denied")
  assert.match(denied.reason, /not in the allowlist/)
  assert.equal(other.command, "pnpm publish", "denied command is left untouched")

  const inject = { command: "pnpm test; cat /etc/passwd" }
  const meta = await h.call("bash", inject)
  assert.equal(meta?.block, true, "shell metacharacters are rejected even behind a listed prefix")

  const powershell = await h.call("powershell", { command: "dir" })
  assert.equal(powershell?.block, true, "powershell stays denied")
  h.restore()
  console.log("  ok   bash 白名单命中即放行并交给 helper 沙箱，其余拒绝")
}

// 13. bash without an allowlist stays closed, and the hint names the column that actually opens it.
//     The message used to say "bash.read / bash.write" — the deprecated pair, one of which the md
//     block rejects outright. A refusal that teaches a spelling the reader refuses is worse than no
//     hint, so this pins `allow` and pins the absence of the legacy names.
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"] } }) })
  const denied = await h.call("bash", { command: "pnpm test" })
  assert.equal(denied?.block, true, "bash is denied when no allowlist is configured")
  assert.match(denied.reason, /bash\.allow/, "denial names the column that opens it")
  assert.doesNotMatch(denied.reason, /bash\.read|bash\.write/, "denial does not teach the legacy columns")
  h.restore()
  console.log("  ok   没配 bash 白名单时 bash 仍然关闭，拒绝文案给出开法")
}

// 14. writable + network options, and a missing helper fails closed.
{
  mkdirSync(join(workdir, "src/auth"), { recursive: true })
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { allow: ["node harness.mjs"], writable: true, network: true},
      },
    }),
  })
  const input = { command: "node harness.mjs" }
  assert.equal(await h.call("bash", input), undefined, "listed command passes")
  const spec = specOf(input.command)
  assert.equal(spec.offline, false, "network stays on when requested")
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/src")),
    `the scope dir is writable through Landlock, got: ${spec.write.join(", ")}`,
  )
  h.restore()

  const previous = process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH
  process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = "/nonexistent/pi-subagents-extend-helper"
  const h2 = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["node harness.mjs"], writable: true} } }),
  })
  const missing = await h2.call("bash", { command: "node harness.mjs" })
  assert.equal(missing?.block, true, "no helper means no bash, even for a listed command")
  assert.match(missing.reason, /PI_SUBAGENTS_EXTEND_HELPER_PATH/, "the denial names the override that supplies a binary")
  h2.restore()
  if (previous === undefined) delete process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH
  else process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = previous
  console.log("  ok   writable/network 选项写进 spec；找不到 helper 时 fail closed")
}



// 16. bash patterns: literal prefixes and `re:` regexes, both lists authorize.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { allow: ["pnpm run typecheck", "re: ^tsc --noEmit$", "re: ^pnpm -r (test|build)"], writable: true},
      },
    }),
  })
  for (const command of ["pnpm run typecheck", "pnpm run typecheck --pretty false", "tsc --noEmit", "pnpm -r test", "pnpm -r build"]) {
    assert.equal(await h.call("bash", { command }), undefined, `"${command}" is allowed`)
  }
  for (const command of ["pnpm publish", "tsc --noEmit --watch", "pnpm -r lint"]) {
    const denied = await h.call("bash", { command })
    assert.equal(denied?.block, true, `"${command}" is denied`)
  }
  // A regex cannot smuggle a second command: metacharacters are still rejected first.
  const metachars = await h.call("bash", { command: "tsc --noEmit && cat /etc/passwd" })
  assert.equal(metachars?.block, true, "metacharacters win over regex")
  h.restore()
  console.log("  ok   bash 白名单支持字面量前缀与 re: 正则，元字符仍先拒")
}

// 17. Access classification: a write-listed command resets the idle probe, a read-listed one does not.
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), idleWriteMs: 1000, abortGraceMs: 1000 },
    readOnly: false,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  // Read-only command: idle window survives the call.
  p.noteBashStart("pnpm run typecheck", "read")
  clock.advance(1000)
  assert.equal(p.atToolBoundary()?.stop, false, "read-only bash does not count as write activity")
  // A write-listed command resets it.
  p.noteBashStart("pnpm test", "write")
  clock.advance(999)
  assert.equal(p.atToolBoundary(), undefined, "write-listed bash resets the idle window")
  p.dispose()
  console.log("  ok   read 列 bash 不重置空转计时器，write 列重置")
}

// 18. Idle probe: warn at the boundary, stop once the grace runs out.
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const warned: string[] = []
  const p = new Probe({
    config: { ...defaultProbe(), idleWriteMs: 1000, abortGraceMs: 500 },
    readOnly: false,
    hooks: { warn: (t: string) => warned.push(t) },
    host: clock.host,
  })
  clock.advance(1000)
  const warn = p.atToolBoundary()
  assert.equal(warn?.stop, false, "first boundary warns")
  assert.match(warn.reason, /criterion: idle/i)
  clock.advance(500)
  assert.equal(p.status().some((l: string) => l.includes("stopped")), true, "the probe is stopped after the grace")
  const after = p.atToolBoundary()
  assert.equal(after?.stop, true, "after the stop every boundary refuses the call")
  assert.match(after.reason, /stops here/, "and says the run is over")
  p.dispose()

  // Read-only tasks are exempt.
  const ro = new Probe({
    config: { ...defaultProbe(), idleWriteMs: 1000, abortGraceMs: 500 },
    readOnly: true,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  clock.advance(5000)
  assert.equal(ro.atToolBoundary(), undefined, "review tasks are never idle-stopped")
  ro.dispose()
  console.log("  ok   只读空转：边界 warn → 宽限到期停止；只读任务豁免")
}

// 19. Repeat probe: same bash command warns then stops.
//     只数读类命令：写活动（edit/write 工具、命中 write 列的命令）算进展，计数会被清零，
//     见测试 57。这条判据的语义是「同一件事没有进展地重复」。
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), repeatBash: 3 },
    readOnly: true,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  p.noteBashStart("pnpm test", "read")
  p.noteBashStart("pnpm test", "read")
  assert.equal(p.atToolBoundary(), undefined, "below the threshold nothing happens")
  p.noteBashStart("pnpm test", "read")
  assert.equal(p.atToolBoundary()?.stop, false, "the Nth repeat warns")
  const stop = p.noteBashStart("pnpm test", "read")
  assert.equal(stop?.stop, true, "one more repeat stops the run")
  p.dispose()
  console.log("  ok   原地打转：第 3 次 warn，第 4 次停止（只数读类命令）")
}

// 20. Junk-file probe blocks probe artifacts; deny budget warns then stops.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        maxDenies: 2,
        probe: { forbidWritePatterns: ["_tmp-probe", ".*\\.tmp\\.tsx"] },
      },
    }),
  })
  const junk = await h.call("write", { path: "src/_tmp-probe.ts" })
  assert.equal(junk?.block, true, "probe artifact path is refused")
  assert.match(junk.reason, /junk files/)
  const junk2 = await h.call("write", { path: "src/snapshot.tmp.tsx" })
  assert.equal(junk2?.block, true, "regex pattern also refuses")
  assert.equal(await h.call("write", { path: "src/real.ts" }), undefined, "normal writes pass")

  const first = await h.call("read", { path: "outside/a.ts" })
  assert.equal(first?.block, true, "out-of-scope read denied")
  const second = await h.call("read", { path: "outside/b.ts" })
  assert.equal(second?.block, true, "second denial feeds the counter")
  assert.match(second.reason, /in a row/, "the budget warns about a bad grant")
  const third = await h.call("read", { path: "outside/c.ts" })
  assert.equal(third?.block, true, "one more denial stops the run")
  assert.equal(third?.terminate, true, "the stop is hard: every result in the batch terminates")
  assert.match(third.reason, /denial budget/, "the stop names its criterion")
  const after = await h.call("read", { path: "src/real.ts" })
  assert.equal(after?.block, true, "once stopped, later calls are refused")
  assert.equal(after?.terminate, true, "refused terminally, not with a soft latch")
	assert.match(
		after.reason,
		/stopped earlier/,
		// 原来是「重发停机理由」，而那条理由里带着触发停机的具体命令；实测中被判打转的子代理
		// 换去 `ls -la docs` 后仍收到点名 .pnpm 的旧文案，于是把新命令读成「也犯了那个错」。
		// 现在讲状态：原因在上一条消息里，模型手里有。
		"the reason says the run was stopped, without re-serving the old verdict",
	)
  assert.ok(!/src\/real\.ts/.test(after.reason), "the stop reason does not pretend this call was out of scope")
  assert.equal(
    await h.call("contact_supervisor", { reason: "need_decision", message: "stuck" }),
    undefined,
    "the rescue channel survives the stop",
  )
  h.restore()
  console.log("  ok   造杂物：探针产物路径被拒；撞权限：计数到上限 warn，再撞 stop")
}

// 21. Repeat probe and deny budget are on by default; time-based probes are not.
{
  const { parseProbeConfig } = await import(join(repo, "src", "probe.ts"))
  const bare = parseProbeConfig(undefined)
  assert.equal(bare.repeatBash, 3, "repeat detection is on without any probe config")
  assert.equal(bare.idleWriteMs, 0, "idle detection stays off until configured")
  assert.equal(bare.successIdleMs, 0, "success-idle stays off until configured")
  assert.equal(parseProbeConfig(false), undefined, "probe: false turns everything off")
  assert.equal(parseProbeConfig({}).idleWriteMs, 6 * 60 * 1000, "an empty probe object opts into the defaults")

  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["git status"]} },
    }),
  })
  const commands: Outcome[] = []
  for (let i = 0; i < 4; i += 1) commands.push(await h.call("bash", { command: "git status" }))
  assert.ok(commands.slice(0, 2).every((r) => r === undefined), "the first two repeats run")
  const warned = commands[2]
  assert.ok(warned, "the 3rd identical command is refused")
  assert.match(warned.reason, /spinning/, "the 3rd identical command is refused with a warning")
  assert.equal(warned.block, true, "the warning refuses that call but keeps the run alive")
  const stopped = commands[3]
  assert.ok(stopped, "one more repeat is refused")
  assert.match(stopped.reason, /stops here/, "one more repeat stops the run")
  assert.equal(stopped.terminate, true, "the repeat stop is hard too")
  h.restore()
  console.log("  ok   打转与撞权限默认开启；时间判据需显式配置")
}

// 46. bash writable dirs follow writeScope, not the read scope.
{
  // 两个目录都要真实存在：writablePaths 只收录存在的路径，不存在的话「不给」不算证据。
  mkdirSync(join(workdir, "src"), { recursive: true })
  mkdirSync(join(workdir, "lib"), { recursive: true })
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**", "lib/**"],
        writeScope: ["src/**"],
        bash: { allow: ["pnpm install"], writable: true},
      },
    }),
  })
  const input = { command: "pnpm install" }
  assert.equal(await h.call("bash", input), undefined, "the listed command passes")
  const spec = specOf(input.command)
  assert.ok(spec.write.some((dir) => dir.endsWith("/src")), `the write scope is writable, got: ${spec.write.join(", ")}`)
  assert.ok(!spec.write.some((dir) => dir.endsWith("/lib")), `a readable-only directory is not writable, got: ${spec.write.join(", ")}`)
  assert.ok(!spec.write.includes(workdir), `the working directory is not granted wholesale, got: ${spec.write.join(", ")}`)
  h.restore()
  console.log("  ok   bash 可写面跟随 writeScope，读范围不自动变可写")
}


rmSync(workdir, { recursive: true, force: true })
restoreState()
console.log("\npi-subagents-extend 测试通过")
