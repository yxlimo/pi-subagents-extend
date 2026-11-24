// Annotations: tool-result and context notes added to tool output.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, specOf, liveSandbox, workdir, repo, stateDir } from "../harness.ts"


// The suite must not write into the developer's real home. Spec files, `git-excludes` and the
// `xdg-cache` tree live in the extension's state directory, so point that at a throwaway one for
// the run. Not `tmpdir()`: the helper mounts a private tmpfs over `/tmp`, so a grant underneath
// it cannot take effect — the helper refuses such a spec (exit 77) and names the tmpfs as the
// cause.
// Redirecting `HOME` instead is too blunt: on CI `cargo` is rustup's shim and tries to create
// `$HOME/.rustup`, which the sandbox refuses because the package directory is not a write grant.
const realState = process.env.PI_SUBAGENTS_EXTEND_STATE
const testState = stateDir(".test-state-")
process.env.PI_SUBAGENTS_EXTEND_STATE = testState

// Cleanup runs on `exit` too, not only on the success path: a failed assertion would otherwise
// leave `.test-state-*` behind as an untracked directory, and pi-subagents' own patch capture
// (`git add -A`) would sweep it into a patch. Both steps are idempotent.
const restoreState = (): void => {
  if (realState === undefined) delete process.env.PI_SUBAGENTS_EXTEND_STATE
  else process.env.PI_SUBAGENTS_EXTEND_STATE = realState
  rmSync(testState, { recursive: true, force: true })
}
process.on("exit", restoreState)
// `exit` does not run on a signal: Ctrl-C during a run would leave the directory behind.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restoreState()
    process.exit(130)
  })
}

// The sandbox helper is a Rust binary. Tests execute the cargo build output and
// never the copy in `bin/`: that copy belongs to a loaded extension, so writing to
// it during a test run would swap the binary out from under a running session —
// `ETXTBSY` at best, a silent behaviour change between calls at worst. An explicit
// override wins, so a stub can be substituted; then the build output; a packaged
// `bin/` copy is the last resort for a checkout with no Rust toolchain.
function resolveHelperBin(): string {
  const candidates = [
    process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH?.trim(),
    join(repo, "..", "helper", "target", "release", "pi-subagents-extend-helper"),
    join(repo, "bin", "pi-subagents-extend-helper"),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    "no sandbox helper found; run `cargo build --release --manifest-path packages/helper/Cargo.toml`",
  )
}
const helperBin = resolveHelperBin()

// These cases inspect the command the extension rewrites and the spec it writes;
// none of them executes the helper, so the kernel's Landlock ABI only decides
// whether bash is offered at all. Where the ABI is below the required 7 the real
// helper refuses bash, and the suite would report a failure that says nothing about
// the extension. Point the environment at a stub instead: enforcement is covered by
// the helper's own cargo tests and by running this suite on a 6.15 or later kernel.
interface HelperDescription {
  landlock?: { kernel_abi?: number; supported?: boolean }
  network_namespace?: boolean
}

function helperAbi(bin: string): HelperDescription | undefined {
  const out = spawnSync(bin, ["--describe"], { encoding: "utf8" });
  try {
    return JSON.parse(out.stdout) as HelperDescription;
  } catch {
    return undefined;
  }
}

const described = helperAbi(helperBin);
// Cases that execute the helper for real need a kernel that can enforce the
// sandbox. With the stub there is nothing to enforce, so those parts are skipped
// instead of asserting on the stub's silence.
if (described?.landlock?.supported) {
  process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = helperBin
} else {
  const stubDir = mkdtempSync(join(tmpdir(), "pi-subagents-extend-stub-"))
  const stub = join(stubDir, "pi-subagents-extend-helper")
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' '{"landlock":{"kernel_abi":7,"required_abi":7,"supported":true,"reason":null},"network_namespace":true,"resolver_sockets":[]}'\n`,
  )
  chmodSync(stub, 0o755)
  process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = stub
  console.log(
    `  note  kernel Landlock ABI ${described?.landlock?.kernel_abi ?? "unknown"} is below the required 7;` +
      " the suite runs against a stub helper that reports ABI 7",
  )
}

// 37. 交接单提示（前台）：子代理 worktree 单返回 handoff 路径时，就地补「看哪个键」。
//     pi-subagents 捕获补丁后会删掉工作树与分支，父代理只拿到一行路径；
//     不点明 children[].patch 等于让父代理去猜。
{
  const h = await handler()
  const path = "/tmp/pi-subagents/async-subagent-runs/run-1/handoff.json"
  const out = await h.result("subagent", [
    { type: "text", text: `Worktree handoff: ${path} (1 children, 1 changed patches, cleanup complete)` },
  ])
  assert.ok(out, "the tool result is returned")
  assert.ok(Array.isArray(out.content), "the result content is patched")
  assert.equal(out.content.length, 2, "one text part is appended")
  const hint = out.content[1].text
  assert.match(hint, /\[worktree handoff\]/, "the hint is marked so it can be recognised")
  assert.ok(hint.includes(path), "the hint names the manifest path")
  assert.match(hint, /children\[\]\.patch/, "the hint names the key to read")
  assert.match(hint, /diffStat/, "the hint names the volume signal")
  assert.match(hint, /SHA quoted by the child no longer resolves/, "the hint says the child's SHA is dead")
  assert.match(hint, /Nothing was applied/, "the hint says nothing reached this checkout")
  assert.match(hint, /tasks\[\]\.reason/, "the hint says where the preserve reason lives")

  // 幂等：同一条消息再跑一次（tool_result 与 message_end 可能都命中）不应重复追加。
  const again = await h.result("subagent", out.content)
  assert.equal(again, undefined, "an already-annotated result is left alone")

  // 交接单写失败时没有路径，但工作树与分支是被保留下来的 —— 父代理必须知道这一点，
  // 否则会以为「没收到交接单 = 子代理什么都没做」。
  const unavailable = await h.result("subagent", [
    { type: "text", text: "Worktree handoff unavailable: EACCES" },
  ])
  const unavailableHint = unavailable?.content?.at(-1)?.text ?? ""
  assert.match(unavailableHint, /\[worktree handoff\]/, "the unavailable case is annotated too")
  assert.match(unavailableHint, /not deleted/, "it says the worktree was kept")
  assert.match(unavailableHint, /git worktree list/, "it says how to find it")
  assert.equal(unavailableHint.includes("children[].patch"), false, "it does not promise a manifest key")

  // 同一条消息再跑一次也不重复追加。
  assert.ok(unavailable, "the unavailable result is returned")
  assert.equal(
    await h.result("subagent", unavailable.content),
    undefined,
    "an already-annotated unavailable result is left alone",
  )

  // 普通工具结果、普通子代理结果（没有 worktree）都不动。
  assert.equal(await h.result("bash", [{ type: "text", text: "ok" }]), undefined, "other tools are untouched")
  assert.equal(
    await h.result("subagent", [{ type: "text", text: "child finished, no worktree" }]),
    undefined,
    "a subagent result without a worktree gets no hint",
  )
  h.restore()
  console.log("  ok   交接单提示（前台）：补出该看的键与失效的分支/SHA，幂等且不误伤")
}

// 38. 交接单提示（后台）：async 完成通知是注入到会话里的消息，实测 message_end 不为它
//     触发，所以走 context —— 每次 LLM 调用前拿到完整消息表，就地补一句。
{
  const h = await handler()
  const path = "/tmp/pi-subagents/async-subagent-runs/run-2/handoff.json"
  const injected = { role: "user", content: [{ type: "text", text: `run finished.\n\nParallel handoff: ${path}` }] }
  const out = await h.context([{ role: "system", content: "sys" }, injected])
  assert.ok(out, "the message list is replaced")
  const injectedContent = out.messages[1]?.content
  assert.ok(Array.isArray(injectedContent), "the injected notification keeps its content parts")
  const injectedParts = Array.isArray(injectedContent) ? injectedContent : []
  const injectedText = injectedParts.at(-1)?.text ?? ""
  assert.match(injectedText, /\[worktree handoff\]/, "the injected notification gets the hint")
  assert.ok(injectedText.includes(path), "and carries the manifest path")
  assert.equal(out.messages[0]?.content, "sys", "other messages pass through untouched")

  // 字符串形态的 content 也要能补。
  const asString = await h.context([{ role: "custom", customType: "subagent-notify", content: `Parallel handoff: ${path}` }])
  assert.ok(asString, "a string body is annotated too")
  assert.equal(typeof asString.messages?.[0]?.content, "string", "a string body stays a string")
  assert.match(String(asString.messages[0]?.content), /children\[\]\.patch/)

  // 没有交接单行的消息、以及 assistant 角色都不动。
  assert.equal(
    await h.context([{ role: "user", content: [{ type: "text", text: "just a prompt" }] }]),
    undefined,
    "no handoff line, no patch",
  )
  assert.equal(
    await h.context([{ role: "assistant", content: [{ type: "text", text: `Parallel handoff: ${path}` }] }]),
    undefined,
    "assistant messages are not annotated",
  )

  // 幂等：已经带标记的消息不再追加。
  assert.equal(await h.context(out.messages as unknown[]), undefined, "an already-annotated message is left alone")
  h.restore()
  console.log("  ok   交接单提示（后台）：context 里补上注入的通知，其它消息不动")
}

// 37. 离线沙箱里的网络失败要就地说明「主代理没授权」，否则子代理会当成机器坏了，
//     换 registry / 加 timeout 反复重试，把轮次全浪费掉。
{
  const netprobe = join(workdir, "netprobe.sh")
  writeFileSync(
    netprobe,
    [
      "#!/bin/sh",
      "node -e 'const s=require(\"net\").connect({host:\"1.1.1.1\",port:80});",
      "s.on(\"error\",e=>{console.error(e.code+\": \"+e.message);process.exit(1)});",
      "setTimeout(()=>process.exit(2),3000)'",
      "",
    ].join("\n"),
  )

  const offlineHandler = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["sh netprobe.sh"], writable: true } } }),
  })
  const input = { command: "sh netprobe.sh" }
  assert.equal(await offlineHandler.call("bash", input), undefined, "the probe is allowlisted")
  assert.equal(specOf(input.command).offline, true, "bash is offline by default")

  if (liveSandbox) {
    const exec = spawnSync("/bin/sh", ["-c", input.command], { cwd: workdir, encoding: "utf8" })
    const output = `${exec.stdout}${exec.stderr}`
    // 建得出网络命名空间时报 ENETUNREACH；建不出来时由 Landlock 兜底，报连接 EACCES。
    assert.match(output, /ENETUNREACH|EACCES/u, "the command really fails on the network")

    const noted = await offlineHandler.result("bash", output, true)
    // 字符串 content 会被拼成字符串，parts 数组则多一个 text part；两种形状都取尾部。
    const note = typeof noted?.content === "string" ? noted.content : (noted?.content?.at(-1)?.text ?? "")
    assert.match(note, /\[sandbox\]/u, "the failure is annotated so it can be recognised")
    assert.match(note, /off per the parent/u, "it names the cause")
    assert.match(note, /not a broken machine/u, "it says this is not an environment fault")
    assert.match(note, /contact_supervisor/u, "it says which channel can widen the grant")
    assert.match(note, /"network": true/u, "it names what the parent would have to grant")

    // 同一份结果再走一次不重复追加。
    assert.ok(noted, "the network failure is annotated")
    assert.equal(await offlineHandler.result("bash", noted.content), undefined, "already annotated results are left alone")
  } else {
    console.log("  skip  live network probe: no real sandbox on this kernel")
  }

  // 本地连接被拒在沙箱里是正常测试结果，不能补这句提示（loopback 是通的）。
  assert.equal(
    await offlineHandler.result("bash", "Error: connect ECONNREFUSED 127.0.0.1:3000"),
    undefined,
    "ECONNREFUSED is a normal local result, not a permission problem",
  )
  assert.equal(await offlineHandler.result("bash", "FAIL src/a.test.ts > adds 1+1"), undefined, "unrelated failures are untouched")
  assert.equal(await offlineHandler.result("read", "ENETUNREACH"), undefined, "only bash results are annotated")
  offlineHandler.restore()

  // 开了网络的会话不补：那时网络失败确实是环境问题。
  const onlineHandler = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["sh netprobe.sh"], writable: true, network: true } },
    }),
  })
  assert.equal(
    await onlineHandler.result("bash", "Error: connect ENETUNREACH 1.1.1.1:80"),
    undefined,
    "an online sandbox is not annotated",
  )
  onlineHandler.restore()
  console.log("  ok   离线沙箱的网络失败被标注为「主代理未授权」，且不误报本地拒绝与在线会话")
}

// 38. 写越界：结果要说明「这个路径不在主代理给的写授权里」，而不是让子代理
//     以为文件系统坏了、去换目录或加 sudo。判据是路径 vs spec.write，不是文案猜。
{
  // 注意：spec.write 天然包含 tmpdir() 与 cwd，所以「授权外」的路径不能用 /tmp 下的。
  const outsidePath = `/var/tmp/pi-extend-write-${process.pid}.txt`
  const insidePath = join(workdir, "inside.txt")
  const script = join(workdir, "write.sh")
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "node -e '",
      'const fs=require("fs");',
      'try { fs.writeFileSync(process.argv[1],"x"); console.log("wrote"); }',
      'catch (e) { console.error(e.code+": permission denied, open "+process.argv[1]); process.exit(1); }',
      "' \"$1\"",
      "",
    ].join("\n"),
  )

  const bindings = JSON.stringify({
    "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["sh write.sh"], writable: true } },
  })

  // 授权外：命令真的被内核拒掉。
  const h = await handler({ bindings })
  const outInput = { command: `sh write.sh ${outsidePath}` }
  assert.equal(await h.call("bash", outInput), undefined, "the writer script is allowlisted")
  const outSpec = specOf(outInput.command)
  assert.equal(outSpec.write.includes(outsidePath), false, "the outside path is not granted")
  if (liveSandbox) {
    const outExec = spawnSync("/bin/sh", ["-c", outInput.command], { cwd: workdir, encoding: "utf8" })
    assert.match(`${outExec.stdout}${outExec.stderr}`, /EACCES|Permission denied/u, "the write really is refused")
    assert.equal(existsSync(outsidePath), false, "nothing was written outside the grant")

    const outNote = await h.result("bash", `${outExec.stdout}${outExec.stderr}`, true)
    const note = typeof outNote?.content === "string" ? outNote.content : (outNote?.content?.at(-1)?.text ?? "")
    assert.match(note, /\[sandbox\]/u, "the refusal is annotated")
    assert.ok(note.includes(outsidePath), "the note names the path that was refused")
    assert.match(note, /writablePaths/u, "the note says what the parent would have to grant")
    assert.match(note, /contact_supervisor/u, "the note names the channel")
    assert.equal(await h.result("bash", note), undefined, "already annotated results are left alone")
  } else {
    console.log("  skip  live write refusal: no real sandbox on this kernel")
  }

  // 授权内：同样的脚本写得进去，且不该有任何提示。
  const inInput = { command: `sh write.sh ${insidePath}` }
  assert.equal(await h.call("bash", inInput), undefined, "the writer script is allowlisted")
  if (liveSandbox) {
    const inExec = spawnSync("/bin/sh", ["-c", inInput.command], { cwd: workdir, encoding: "utf8" })
    assert.equal(inExec.status, 0, `writing inside the grant works: ${inExec.stderr}`)
    assert.ok(existsSync(insidePath), "the file really landed")
    assert.equal(await h.result("bash", `${inExec.stdout}${inExec.stderr}`), undefined, "a granted write is not annotated")
  }

  // 宿主权限被拒不能归因到沙箱：我们自己也读不到那个文件时，保持沉默。
  await h.call("bash", { command: `sh write.sh ${outsidePath}` })
  assert.equal(
    await h.result("bash", "cat: /etc/shadow: Permission denied"),
    undefined,
    "a host-permission refusal is not blamed on the sandbox",
  )
  // 文案里有权限拒绝但路径就在授权内 → 也不是越界写。
  await h.call("bash", { command: `sh write.sh ${outsidePath}` })
  assert.equal(
    await h.result("bash", `EACCES: permission denied, open '${insidePath}'`),
    undefined,
    "a refusal on a granted path is not reported as out of scope",
  )
  h.restore()
  console.log("  ok   写越界被标注为授权问题；授权内与宿主权限被拒都不误报")
}
// 60. git 会去建它其实用不到的锁文件。linked worktree 的 common dir 只授权 objects/refs/logs，
//     于是每次提交都打一行 `error: Unable to create '<common>/packed-refs.lock': Permission denied`
//     —— 退出码 0，commit 照样落地（ref 写成松散 ref，packed-refs 留旧值，下次 gc 收拾）。
//     把这行注解成「授权不够，去要 writablePaths」比漏提示更有害：父代理会去放宽一份正确的授权。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], writeScope: ["src"], bash: { allow: ["git commit"], writable: true } },
    }),
  })
  // 授权外的路径不能用 /tmp 下的：spec.write 天然包含 tmpdir()，那里会被判成「授权内」，
  // 这样「不注解」就会因为错误的原因通过。
  const lock = `/var/tmp/pi-extend-${process.pid}/packed-refs.lock`
  const input = { command: "git commit -m x" }
  assert.equal(await h.call("bash", input), undefined, "git commit is allowlisted")
  const outcome = await h.result("bash", `error: Unable to create '${lock}': Permission denied`, true)
  assert.equal(outcome, undefined, "a git lock-file probe is not annotated as an out-of-scope write")
  h.restore()
  console.log("  ok   git 的锁文件探测（.lock）不被当成越界写上报")
}

// 61. 上一条只放过 `.lock` 这一种：同样形状、同样被拒、路径不以 .lock 结尾时仍然要注解，
//     否则等于把判据放宽成「git 报错就不注解」。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], writeScope: ["src"], bash: { allow: ["git commit"], writable: true } },
    }),
  })
  const target = `/var/tmp/pi-extend-${process.pid}/hooks/pre-commit`
  const input = { command: "git commit -m x" }
  assert.equal(await h.call("bash", input), undefined, "git commit is allowlisted")
  const outcome = await h.result("bash", `error: Unable to create '${target}': Permission denied`, true)
  // content 保持传进来的形状：传字符串回来就是字符串，传 parts 数组就是数组末尾多一个 part。
  const content: unknown = outcome?.content
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part as { text?: string }).text ?? "").join("\n")
        : ""
  assert.match(text, /outside the writes the parent granted/, "a non-lock refusal is still annotated")
  assert.match(text, /hooks\/pre-commit/, "and the note names the path that was refused")
  h.restore()
  console.log("  ok   .lock 之外的拒绝照旧注解，判据没有被放宽成「git 报错就不注解」")
}

// 62. 注解以「这条命令真的失败了」为前提，不是以输出文本里出现 EACCES 为前提。
//     实测到的误判：一个子代理跑 `git diff`，diff 正文里含 EACCES 字样，于是它自己那份
//     正确的改动被追加了「这在授权之外，去要 writablePaths」——成功命令收到失败建议。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], writeScope: ["src"], bash: { allow: ["git diff", "cat"], writable: true } },
    }),
  })
  const outside = `/var/tmp/pi-extend-${process.pid}/outside.txt`
  const input = { command: "git diff" }
  assert.equal(await h.call("bash", input), undefined, "git diff is allowlisted")

  // 一份 diff：正文里出现 EACCES 与一条树外绝对路径，但它只是被打印出来的内容。
  const diff = `diff --git a/src/a.ts b/src/a.ts\n+  throw new Error("EACCES: permission denied, open '${outside}'");\n`
  assert.equal(
    await h.result("bash", diff),
    undefined,
    "a successful command whose text merely mentions EACCES is not annotated",
  )

  // 同一条命令真的失败时，注解照旧出现。spec 表按 toolCallId 记、且在第一个结果回来后就删，
  // 所以这里要重新 call 一次，否则第二次 result 拿不到这次命令的可写清单。
  // 必须用新的 input 对象：tool_call 会就地把它改写成沙箱包装命令，复用同一个对象时
  // 第二次的 command 已经是包装后的字符串，自然不在白名单里（真实调用每次都是新对象）。
  assert.equal(await h.call("bash", { command: "git diff" }), undefined, "the same command runs again")
  const failed = await h.result("bash", `touch: cannot touch '${outside}': Permission denied`, true)
  const content: unknown = failed?.content
  const text = typeof content === "string" ? content : ((content as { text: string }[] | undefined)?.at(-1)?.text ?? "")
  assert.match(text, /outside the writes the parent granted/, "a real refusal is still annotated")
  h.restore()
  console.log("  ok   注解只在命令真的失败时出现：输出正文里的 EACCES 不触发")
}
