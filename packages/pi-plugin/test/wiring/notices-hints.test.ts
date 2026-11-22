// Notices: the rendered texts — the session-start warning, the deny-reason
// hint, the tool-result annotations, and the wording caps around them.
// The judgement itself (`unreachableEntries`) lives in notices.test.ts; this
// file never judges an entry, it only checks what the extension says about
// the ones the judgement has already flagged.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/notices-hints.test.ts

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, repo, workdir } from "../harness.ts"

// 127. 接线一：开场把「授权写了却永远命中不了」说一次，走 UI 而不是模型上下文。
//      没有这一条，子代理只能撞几次墙再自己推断，父代理也看不到自己配错了。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-ui-"))
  mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
  writeFileSync(join(tree, "packages", "pi-plugin", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run typecheck"] } } }),
  })
  const notices = h.ui.join("\n")
  assert.match(notices, /can never match/, "session_start warns about entries that can never match")
  assert.match(notices, /pnpm run typecheck/, "the warning names the entry")
  assert.ok(notices.includes("--dir"), `the warning carries the usable form, got: ${notices}`)
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   开场警告点出永远命中不了的条目，并给出带 --dir 的可用形态")
}

// 128. 接线二：与命令同首 token 的条目写进拒绝文案 —— 撞墙的原因和出路在同一段里。
//      那条条目自己不可达时，`why` 也要跟着写进去，否则读者会以为改个参数就行。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-deny-"))
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run lint"] } } }),
  })
  const refused = await h.call("bash", { command: "pnpm run typecheck" })
  assert.equal(refused?.block, true, "a command missing from the allowlist is refused")
  const reason = String(refused?.reason)
  assert.match(reason, /entries for `pnpm`/, "the refusal lists the entries with the same program")
  assert.match(reason, /pnpm run lint/, "and names the entry that is close")
  assert.match(reason, /no package\.json/, "the entry's own unreachability is stated too")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   拒绝文案点名同首 token 的条目，并带上它不可达的原因")
}

// 129. 反例：首 token 不同的条目与此无关，不写进文案。猜「你可能想跑那个」比不说更糟：
//      子代理会照着一条不相干的授权去改命令，然后再撞一次。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-other-"))
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run typecheck"] } } }),
  })
  const refused = await h.call("bash", { command: "rg foo x.ts" })
  assert.equal(refused?.block, true, "a command missing from the allowlist is refused")
  const reason = String(refused?.reason)
  assert.match(reason, /allowed:/, "the refusal still lists what is allowed")
  assert.doesNotMatch(reason, /entries for/, "no entries hint for a different program name")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   首 token 不同时不臆测：文案里不出现同首 token 条目提示")
}

// 142. 白名单里的命令在 cwd 下跑不起来时，子代理只看到 pnpm 自己的报错，看不出这是配置问题。
//      注解写进工具结果，把原因与改法一起给出；成功的命令不补（成功的输出里混注解会误导）。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-note-"))
	mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
	writeFileSync(join(tree, "packages", "pi-plugin", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run typecheck"] } } }),
	})
	assert.equal(await h.call("bash", { command: "pnpm run typecheck" }), undefined, "the entry is allowlisted, so the command runs")
	const failed = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const failure = String(failed?.content)
	assert.match(failure, /\[sandbox\] this command ran/, "the failure says the command ran")
	assert.match(failure, /cannot work from/, "and that the entry cannot work from this directory")
	assert.match(failure, /--dir/, "and it carries the usable form")
	assert.equal(await h.call("bash", { command: "pnpm run typecheck" }), undefined, "the same command runs again")
	const succeeded = await h.result("bash", "typecheck: no errors", false)
	assert.doesNotMatch(String(succeeded?.content), /this command ran/, "a successful command gets no such note")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   跑不起来的命令在工具结果里拿到注解与改法；成功的命令不补注解")
}

// 143. 注解要认「跑的是哪一条授权」，不是「首 token 一样就算」。白名单里同时有可达的
//      `pnpm --dir packages/a run build` 与不可达的 `pnpm run typecheck` 时，早先只比
//      `pnpm` 这个程序名，于是**可达**那条一失败就被安上 `pnpm run typecheck` 的诊断与改法：
//      那条命令根本没跑，照它改也没用。对照组：跑的就是不可达那条时，注解必须点名它。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-note-entry-"))
	mkdirSync(join(tree, "packages", "a"), { recursive: true })
	writeFileSync(join(tree, "packages", "a", "package.json"), JSON.stringify({ scripts: { build: "tsc -b" } }))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm --dir packages/a run build", "pnpm run typecheck"] } },
		}),
	})
	const reachable = "pnpm --dir packages/a run build"
	assert.equal(await h.call("bash", { command: reachable }), undefined, "the reachable entry is allowlisted")
	const unrelatedResult = await h.result("bash", "error TS1234: boom", true)
	const unrelated = String(unrelatedResult?.content)
	assert.doesNotMatch(unrelated, /this command ran/, "a failed reachable command is not annotated")
	assert.doesNotMatch(unrelated, /cannot work from/, "and no other entry's diagnosis is pinned on it")
	assert.doesNotMatch(unrelated, /pnpm run typecheck/, "the unrelated entry is not named at all")
	// 对照组：跑的是那条不可达的，注解点名的就必须是它。
	assert.equal(await h.call("bash", { command: "pnpm run typecheck" }), undefined, "the unreachable entry is allowlisted too")
	const ownResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const own = String(ownResult?.content)
	assert.match(own, /this command ran/, "the failing unreachable command is annotated")
	assert.match(own, /"pnpm run typecheck" cannot work/, "and the note names that very entry")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   注解按条目匹配实际跑的命令；同程序名的无关条目不会被安上来")
}

// 144. 候选包可能有几百个，文案必须有上限：把整棵树拼进一条告警，读者读不完，
//      也看不出重点是「这条授权指错了地方」。上限 8 条，超出补 `… and N more`。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-list-cap-"))
	const names = Array.from({ length: 10 }, (_, i) => `pkg-${String(i + 1).padStart(2, "0")}`)
	for (const name of names) {
		mkdirSync(join(tree, name), { recursive: true })
		writeFileSync(join(tree, name, "package.json"), "{}")
	}
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run build"] } } }),
	})
	const notices = h.ui.join("\n")
	assert.match(notices, /… and 2 more/, "the session warning stops at eight candidates and counts the rest")
	assert.ok(!notices.includes("pkg-09") && !notices.includes("pkg-10"), `the warning names no candidate past the cap, got: ${notices}`)
	assert.equal(await h.call("bash", { command: "pnpm run build" }), undefined, "the entry is allowlisted")
	const noteResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const note = String(noteResult?.content)
	assert.match(note, /… and 2 more/, "the tool-result note is capped the same way")
	assert.ok(!note.includes("pkg-09") && !note.includes("pkg-10"), `the note names no candidate past the cap, got: ${note}`)
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   候选列表封在 8 条，超出补「… and N more」；告警与工具结果一致")
}

// 148. 注解该问的是「allowlist 用**哪一条**放行了这条命令」，不是「白名单里哪一条匹配得上」。
//      白名单里有一条**比命令短**的宽条目（`pnpm`）时，可达命令失败仍会被安上那条宽条目的
//      诊断 —— 它自己确实不可达，但它不是放行这条命令的那一条。判据与放行必须同源。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-grant-entry-"))
	mkdirSync(join(tree, "packages", "a"), { recursive: true })
	writeFileSync(join(tree, "packages", "a", "package.json"), JSON.stringify({ scripts: { build: "tsc -b" } }))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm --dir packages/a run build", "pnpm"] } },
		}),
	})
	const exact = "pnpm --dir packages/a run build"
	assert.equal(await h.call("bash", { command: exact }), undefined, "the reachable entry allowlists it")
	const failedResult = await h.result("bash", "error TS1234: boom", true)
	const failed = String(failedResult?.content)
	assert.doesNotMatch(failed, /this command ran/, "the entry that granted it is reachable, so there is nothing to explain")
	assert.doesNotMatch(failed, /"pnpm" cannot work/, "the shorter, wider entry is not pinned on this command")
	// 对照组：跑的就是那条宽条目，注解必须点名它自己。
	assert.equal(await h.call("bash", { command: "pnpm" }), undefined, "the wide entry allowlists the bare command")
	const wideResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const wide = String(wideResult?.content)
	assert.match(wide, /"pnpm" cannot work/, "running the wide entry still gets its own diagnosis")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   注解问 allowlist 是哪条放行的；更短的宽条目不再顶替真正的授权")
}

// 151. 候选被截断时得说一句「没列全」：否则文案让人去挑，而没显示出来的恰好是它挑不了的那几个。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-cap-note-"))
	for (let i = 1; i <= 10; i += 1) {
		const name = `pkg-${String(i).padStart(2, "0")}`
		mkdirSync(join(tree, name), { recursive: true })
		writeFileSync(join(tree, name, "package.json"), "{}")
	}
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run build"] } } }),
	})
	const notices = h.ui.join("\n")
	assert.match(notices, /only the first 8 are listed/, "the warning says the list is not complete")
	assert.equal(await h.call("bash", { command: "pnpm run build" }), undefined, "the entry is allowlisted")
	const noteResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const note = String(noteResult?.content)
	assert.match(note, /only the first 8 are listed/, "and so does the tool-result note")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   候选被截断时明说「只列了前 8 个」，不让人去挑看不见的")
}

// 152. 告警里的**条目**列表同样要封顶：十几条不可达条目一起展开，那条告警会长到没人读。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-entry-cap-"))
	mkdirSync(join(tree, "pkg-a"), { recursive: true })
	writeFileSync(join(tree, "pkg-a", "package.json"), "{}")
	const entries = Array.from({ length: 10 }, (_, i) => `pnpm run e${String(i + 1).padStart(2, "0")}`)
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: entries } } }),
	})
	const notices = h.ui.join("\n")
	assert.match(notices, /10 allowlist entries can never match/, "the count still says how many there really are")
	assert.match(notices, /… and 2 more/, "but the list itself stops at eight")
	assert.ok(!notices.includes("pnpm run e09") && !notices.includes("pnpm run e10"), `no entry past the cap is named, got: ${notices}`)
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   条目列表也封在 8 条，总数照实说")
}

// 153. 拒绝文案里的「同首 token 条目」提示走的是同一套候选渲染，所以也必须有截断说明
//      （上一轮只给告警与注解补了用例，这条渲染点漏了）。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deny-cap-"))
	for (let i = 1; i <= 10; i += 1) {
		const name = `pkg-${String(i).padStart(2, "0")}`
		mkdirSync(join(tree, name), { recursive: true })
		writeFileSync(join(tree, name, "package.json"), "{}")
	}
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], maxDenies: 0, bash: { read: ["pnpm run build"] } } }),
	})
	const denied = await h.call("bash", { command: "pnpm run other" })
	assert.equal(denied?.block, true, "a command outside the entry is refused")
	const text = String(denied?.reason ?? "")
	assert.match(text, /only the first 8 are listed/, `the refusal hint is capped with the same note, got: ${text}`)
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   拒绝提示里的候选也封顶并说明")
}

// 156. 拒绝提示不能静默丢掉 re: 正则条目：同首 token 的字面条照列，但还得点明另有正则
//      条目可能放行 —— 否则子代理只看到三个「mise」字面条，以为这个程序没被允许，
//      却不知道有一条它看不到的正则兜底，于是照着字面条改参数再撞一次。
{
	const notices = (await import(join(repo, "src", "notices.ts"))) as unknown as {
		headEntriesHint: (rule: unknown, command: string, cwd: string) => string
	}
	const match = (await import(join(repo, "src", "bash-match.ts"))) as unknown as {
		parseBashRule: (raw: unknown) => unknown
	}
	const rule = match.parseBashRule({ read: ["mise run typecheck", "re:^mise run test:(paths|policy)$"] })
	const hint = notices.headEntriesHint(rule, "mise run test:all", workdir)
	assert.match(hint, /mise run typecheck/, "the literal same-program entry is still listed")
	assert.match(hint, /plus 1 regex entry/, "the hint says a regex entry may also match")
	// 复数与「没有字面条时仍给提示」：只有正则条目时 listed 读 none，后缀照给。
	const regexOnly = match.parseBashRule({ read: ["re:^mise run test:(paths|policy)$", "re:^mise run lint$"] })
	const regexHint = notices.headEntriesHint(regexOnly, "mise run test:all", workdir)
	assert.match(regexHint, /plus 2 regex entries/, "the plural form counts every regex entry")
	assert.match(regexHint, /: none \(plus 2 regex entries/, "with no literal siblings the hint still reports the regex entries")
	console.log("  ok   拒绝提示点明 re: 正则条目：字面条照列，正则条目计数（含复数与无字面条时）")
}
