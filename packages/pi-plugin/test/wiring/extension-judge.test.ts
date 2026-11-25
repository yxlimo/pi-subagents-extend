// Judge gate: the subagent dispatch preflight (tool-face mismatch refusal, unresolved
// agent name warning), the worktree dispatch default (payload null vs the role md),
// and the bash deny refusal wording.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension-judge.test.ts

import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EventHandler, FakeExtensionApi, Outcome, SessionContext } from "../types.ts"
import { ext, handler, writeAgentMd, workdir } from "../harness.ts"

/**
 * The dispatch preflight needs a host that exposes the ACTIVE tool face
 * (getActiveTools) — harness.ts's handler() only wires getAllTools, and on such a
 * stub the preflight fails open, which is the production behavior for old hosts but
 * makes the positive case unassertable. This helper mirrors handler() minus the
 * bindings plumbing (the preflight runs before the policy-active gate, so these
 * cases deliberately run with NO bindings — the fbdf1d81 shape).
 */
async function dispatchHandler({ cwd, activeTools }: { cwd: string; activeTools?: string[] }): Promise<{
	call: (toolName: string, input?: Record<string, unknown>) => Promise<Outcome>
	ui: string[]
	restore: () => void
}> {
	const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
	delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
	const handlers: Record<string, EventHandler> = {}
	const api: FakeExtensionApi & { getActiveTools?: () => string[] } = {
		on(event, fn) {
			handlers[event] = fn
		},
		registerCommand() {},
	}
	if (activeTools) api.getActiveTools = () => [...activeTools]
	ext.activate(api)
	const ui: string[] = []
	const ctx: SessionContext = { cwd, ui: { notify: (message) => ui.push(message) }, actions: { abort() {} } }
	if (handlers.session_start) await handlers.session_start({ type: "session_start" }, ctx)
	let seq = 0
	return {
		call: (toolName, input) =>
			handlers.tool_call({ type: "tool_call", toolCallId: `j${++seq}`, toolName, input }, ctx) as Promise<Outcome>,
		ui,
		restore: () => {
			if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
			else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
		},
	}
}

/** Write an agent md with a raw frontmatter block — the preflight reads a top-level `tools:`. */
function writeAgentMdRaw({ cwd, role, frontmatter }: { cwd: string; role: string; frontmatter: string }): string {
	const dir = join(cwd, ".pi", "agents")
	mkdirSync(dir, { recursive: true })
	const file = join(dir, `${role}.md`)
	writeFileSync(file, `---\n${frontmatter}---\n\nRole body.\n`)
	return file
}

// 1. A dispatch payload's `worktree: null` counts as absent: the role md's
//    extend.worktree.enabled: true still fills the default. shouldDefaultWorktree
//    already treats null as absent on the input (`??=` semantics); the strategy
//    lookup must not disagree with it, or a payload that only wanted to leave the
//    key unset silently suppresses the role default.
{
  const proj = join(workdir, "judge-worktree-null")
  writeAgentMd({
    cwd: proj,
    role: "wt-judge-null",
    extend: { permissions: { scope: ["."], allowTools: ["subagent"] }, worktree: { enabled: true } },
  })
  const h = await handler({
    cwd: proj,
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { worktree: null, permissions: { scope: ["."], allowTools: ["subagent"] } },
    }),
  })
  const input: Record<string, unknown> = { agent: "wt-judge-null", task: "x" }
  assert.equal(await h.call("subagent", input), undefined, "filling the default is not a refusal")
  assert.equal(input.worktree, true, "a payload worktree: null counts as absent; the role md default applies")
  h.restore()
  console.log("  ok   a payload worktree: null does not suppress the role md's worktree default")
}

// 2. The bash deny refusal says the command is blocked by a deny entry and quotes
//    the entry itself, so the reader sees which line of which policy blocked it.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git diff"], deny: ["git stash"] } },
    }),
  })
  const refused = await h.call("bash", { command: "git stash" })
  assert.ok(refused && refused.block, "a deny entry blocks the command")
  assert.match(refused.reason, /command blocked by a deny entry/, `the refusal names a deny entry, got: ${refused.reason}`)
  assert.match(refused.reason, /"git stash"/, `the refusal quotes the deny entry, got: ${refused.reason}`)
  // 逐段查 deny：复合命令的第二段同样命中 deny，而且这属于硬规则 —— 不推进撞权限计数。
  const compound = await h.call("bash", { command: "git diff && git stash" })
  assert.ok(compound && compound.block, "the second segment is checked against deny too")
  assert.match(compound.reason, /command blocked by a deny entry/, `a denied segment is refused as a deny, got: ${compound.reason}`)
  assert.match(compound.reason, /"git stash"/, "the refusal names the denied entry, not the whole line")
  h.restore()
  console.log("  ok   the deny refusal names a deny entry and quotes it")
}

// 3. The bash deny refusal keeps the source label: the reader still learns which
//    layer contributed the entry.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git diff"], deny: ["git stash"] } },
    }),
  })
  const refused = await h.call("bash", { command: "git stash" })
  assert.ok(refused && refused.block, "a deny entry blocks the command")
  assert.ok(
    refused.reason.includes("(source: extensionBindings pi-subagents-extend/1)"),
    `the refusal keeps the source label, got: ${refused.reason}`,
  )
  h.restore()
  console.log("  ok   the deny refusal keeps the (source: …) label")
}

// 4. The bash deny refusal is layer-neutral: it names no configuration file ("the
//    project profile" no longer exists as a layer) and no layer that supposedly
//    owns or cannot lift the entry — it states only what the code backs: a deny
//    entry is a restriction no layer can remove.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git diff"], deny: ["git stash"] } },
    }),
  })
  const refused = await h.call("bash", { command: "git stash" })
  assert.ok(refused && refused.block, "a deny entry blocks the command")
  assert.ok(
    !refused.reason.includes("project profile"),
    `the refusal must not name the deleted profile layer, got: ${refused.reason}`,
  )
  assert.ok(
    !refused.reason.includes("cannot lift"),
    `the refusal must not claim a layer owns the prohibition, got: ${refused.reason}`,
  )
  assert.match(
    refused.reason,
    /no layer can remove it/,
    `the refusal states the backed fact about a deny entry, got: ${refused.reason}`,
  )
  h.restore()
  console.log("  ok   the deny refusal is layer-neutral and states what the code backs")
}

// 5. Check 1, positive: the agent md declares tools the host's active tool face does not
//    offer, so the dispatch is refused BEFORE spawn, naming the missing tools, the md, and
//    the likely cause. No bindings in this case on purpose: the preflight must fire in a
//    parent session whose own policy layer is dormant — that is the fbdf1d81 shape (an
//    md hardcoding `edit` on a host where pi-hashline-edit-pro replaced it).
{
  const proj = join(workdir, "judge-preflight-toolface")
  writeAgentMdRaw({
    cwd: proj,
    role: "preflight-toolface",
    frontmatter: "name: preflight-toolface\ntools:\n  - read\n  - edit\n  - bash\n",
  })
  const h = await dispatchHandler({ cwd: proj, activeTools: ["read", "grep"] })
  const refused = await h.call("subagent", { agent: "preflight-toolface", task: "x" })
  assert.ok(refused && refused.block, "a tool-face mismatch refuses the dispatch before spawn")
  assert.match(refused.reason, /\bedit\b/, `the refusal names the missing tool, got: ${refused.reason}`)
  assert.match(refused.reason, /preflight-toolface\.md/, `the refusal names the agent md, got: ${refused.reason}`)
  assert.match(refused.reason, /tool set/, `the refusal names the likely cause, got: ${refused.reason}`)
  h.restore()
  console.log("  ok   a dispatch whose md declares absent tools is refused before spawn, naming them")
}

// 6. Check 1, negative control (a): an md without a `tools:` declaration never triggers
//    the comparison — `tools:` is optional and pi-subagents does not require it.
{
  const proj = join(workdir, "judge-preflight-no-tools")
  writeAgentMdRaw({ cwd: proj, role: "preflight-no-tools", frontmatter: "name: preflight-no-tools\n" })
  const h = await dispatchHandler({ cwd: proj, activeTools: ["read"] })
  const outcome = await h.call("subagent", { agent: "preflight-no-tools", task: "x" })
  assert.equal(outcome, undefined, "an md without tools: leaves the dispatch alone")
  h.restore()
  console.log("  ok   an md without a tools: declaration dispatches silently")
}

// 7. Check 1, negative control (b): an md whose declared tools are all on the host's
//    active face stays silent — the check compares, it does not demand a declaration
//    it can match.
{
  const proj = join(workdir, "judge-preflight-tools-present")
  writeAgentMdRaw({
    cwd: proj,
    role: "preflight-present",
    frontmatter: "name: preflight-present\ntools:\n  - read\n  - grep\n",
  })
  const h = await dispatchHandler({ cwd: proj, activeTools: ["read", "grep", "edit"] })
  const outcome = await h.call("subagent", { agent: "preflight-present", task: "x" })
  assert.equal(outcome, undefined, "a fully covered tools: list leaves the dispatch alone")
  h.restore()
  console.log("  ok   a dispatch whose md tools are all present dispatches silently")
}

// 8. Check 2, positive: a name for which NO md resolves warns once — naming the effective
//    cwd, the consulted directories, and the builtin-alias fallback — but the dispatch
//    itself is NOT refused: builtin agents legitimately have no md.
{
  const proj = join(workdir, "judge-preflight-unresolved")
  const h = await dispatchHandler({ cwd: proj, activeTools: ["read"] })
  const outcome = await h.call("subagent", { agent: "preflight-nowhere", task: "x" })
  assert.equal(outcome, undefined, "an unresolved agent name warns instead of refusing")
  assert.equal(h.ui.length, 1, `exactly one warning is issued, got: ${JSON.stringify(h.ui)}`)
  const warning = h.ui[0] ?? ""
  assert.ok(warning.includes(proj), `the warning names the effective cwd, got: ${warning}`)
  assert.match(warning, /preflight-nowhere\.md/, `the warning names the unresolved role, got: ${warning}`)
  assert.match(warning, /consulted:/, `the warning lists the consulted directories, got: ${warning}`)
  assert.match(warning, /builtin alias/, `the warning names the builtin-alias fallback, got: ${warning}`)
  const again = await h.call("subagent", { agent: "preflight-nowhere", task: "y" })
  assert.equal(again, undefined, "the repeat dispatch still runs")
  assert.equal(h.ui.length, 1, `the warning is issued once per name, got: ${JSON.stringify(h.ui)}`)
  h.restore()
  console.log("  ok   an unresolved agent name warns once, naming cwd and the builtin fallback")
}

// 9. Check 2, negative control: a name whose md DOES resolve from the dispatch cwd stays
//    silent — the warning is for names that fell through to somewhere invisible.
{
  const proj = join(workdir, "judge-preflight-resolves")
  writeAgentMdRaw({ cwd: proj, role: "preflight-resolves", frontmatter: "name: preflight-resolves\n" })
  const h = await dispatchHandler({ cwd: proj, activeTools: ["read"] })
  const outcome = await h.call("subagent", { agent: "preflight-resolves", task: "x" })
  assert.equal(outcome, undefined, "a resolvable agent name dispatches")
  assert.equal(h.ui.length, 0, `no warning for a resolvable name, got: ${JSON.stringify(h.ui)}`)
  h.restore()
  console.log("  ok   a dispatch whose agent md resolves stays silent")
}

// 10. Gate order, RUNTIME_TOOLS: a live scoped session with an empty allowTools still gets
//     `todo` — it is a session-runtime tool that touches no file, so refusing it costs a
//     child its plan between turns while granting it leaks nothing. The gate sits after the
//     stopped gate and before allowTools. The assertion is on the verdict itself: undefined
//     means nothing was blocked, not merely that no exception was thrown.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"] } }),
  })
  const outcome = await h.call("todo", { todos: [] })
  assert.equal(outcome, undefined, `a live session lets todo through unblocked, got: ${JSON.stringify(outcome)}`)
  h.restore()
  console.log("  ok   a live scoped session with no allowTools still gets todo")
}

// 11. Negative control for case 10, same bindings: an unknown non-runtime tool is still
//     refused. Without this, a regression that allowed everything would satisfy case 10.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"] } }),
  })
  const refused = await h.call("webfetch", { url: "https://example.com" })
  assert.ok(refused && refused.block, "an unknown non-runtime tool is still refused")
  assert.match(refused.reason, /not on the allow list/, `the refusal is the allowTools bail, got: ${refused.reason}`)
  h.restore()
  console.log("  ok   the same bindings still refuse an unknown non-runtime tool")
}

// 12. Gate order, RUNTIME_TOOLS vs the stop gate: once the session is stopped, todo is
//     refused and the refusal is the stop notice. This is what separates RUNTIME_TOOLS
//     from SAFE_TOOLS — had todo been written into SAFE_TOOLS, the SAFE_TOOLS check would
//     run BEFORE the stopped gate and this call would come back undefined. maxDenies: 1
//     reaches the hard stop in two refusals (first warns, second stops).
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], maxDenies: 1 } }),
  })
  const first = await h.call("webfetch", { url: "https://example.com" })
  assert.ok(first && first.block, "the first refusal warns")
  assert.ok(!first.terminate, "the first refusal does not stop the run")
  const second = await h.call("webfetch", { url: "https://example.com" })
  assert.ok(second && second.terminate, "the second refusal is the hard stop")
  const todo = await h.call("todo", { todos: [] })
  assert.ok(todo && todo.block, `a stopped session refuses todo, got: ${JSON.stringify(todo)}`)
  assert.equal(todo.terminate, true, "the refusal is terminal, like every post-stop call")
  assert.match(todo.reason, /this run stops here/, `the refusal is the stop notice, got: ${todo.reason}`)
  h.restore()
  console.log("  ok   after the stop, todo is refused with the stop notice — not a SAFE_TOOLS pass-through")
}

// 13. Counter behaviour: an ALLOWED todo call must not reset the denial budget, or a child
//     can interleave todo between two refusals and never reach the hard stop — the same
//     exploit that already forced contact_supervisor out of the reset. todo is granted via
//     allowTools here on purpose: that path bypasses both the SAFE_TOOLS check and the
//     RUNTIME_TOOLS gate, so the case is red against any build that grants todo yet forgets
//     the reset exclusion in index.ts (a reset clears #warned too, so the second refusal
//     would warn again instead of stopping).
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], allowTools: ["todo"], maxDenies: 1 },
    }),
  })
  const first = await h.call("webfetch", { url: "https://example.com" })
  assert.ok(first && first.block, "the first refusal warns")
  assert.ok(!first.terminate, "the first refusal does not stop the run")
  const todo = await h.call("todo", { todos: [] })
  assert.equal(todo, undefined, "todo itself is allowed")
  const second = await h.call("webfetch", { url: "https://example.com" })
  assert.ok(
    second && second.terminate,
    `the second refusal reaches the hard stop despite the interleaved todo, got: ${JSON.stringify(second)}`,
  )
  assert.match(second.reason, /denial budget/, "the stop names its criterion")
  h.restore()
  console.log("  ok   an allowed todo does not reset the denial budget; the hard stop still lands")
}

// 12. A worktree block that fails to parse is REPORTED. The failure mode it replaces is the
//     nastiest kind: the dispatch simply does not get a worktree, which looks exactly like
//     "the md never asked for one" — the caller sees the child edit files in the checkout
//     and has no reason to suspect the three lines they just wrote. The warning names the
//     md, the offending text and the shape to write instead, and repeats no more than once
//     per md (a session dispatches the same role many times).
{
  const proj = join(workdir, "judge-worktree-bad")
  writeAgentMd({
    cwd: proj,
    role: "wt-bad",
    extend: { permissions: { scope: ["."] }, worktree: 7 },
  })
  const h = await dispatchHandler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "wt-bad", task: "x" }
  assert.equal(await h.call("subagent", input), undefined, "a bad worktree setting does not refuse the dispatch")
  assert.equal(input.worktree, undefined, "no worktree is filled from a setting that failed to parse")
  assert.equal(h.ui.length, 1, `exactly one warning is issued, got: ${JSON.stringify(h.ui)}`)
  const warning = h.ui[0] ?? ""
  assert.match(warning, /wt-bad\.md/, `the warning names the role md, got: ${warning}`)
  assert.match(warning, /worktree must be an object/, `the warning quotes the parse problem, got: ${warning}`)
  assert.match(warning, /will not get a worktree/, `the warning says what the caller loses, got: ${warning}`)
  const again = await h.call("subagent", { agent: "wt-bad", task: "y" })
  assert.equal(again, undefined, "the repeat dispatch still runs")
  assert.equal(h.ui.length, 1, `the warning is issued once per md, got: ${JSON.stringify(h.ui)}`)
  h.restore()
  console.log("  ok   a malformed worktree block warns once, naming the md and the cost")
}
