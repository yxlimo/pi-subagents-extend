// Role md states at before_agent_start: a md that exists and speaks policy but cannot
// be applied must fail closed — every tool call refused, with the refusal naming the md
// path and the problems. The two legitimate gaps stay fail open: a md with no `extend`
// block expresses no restriction, and a role with no md at all is a builtin agent.
//
//   node test/session-start-roles.test.ts

import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EventHandler, FakeExtensionApi, Outcome, SessionContext } from "../types.ts"
import { ext, childRun, workdir, writeAgentMd, childSystemPrompt } from "../harness.ts"

/**
 * A role-md child: `handler()` never fires before_agent_start, and the role wiring runs
 * there, so the two events are driven directly, mirroring handler()'s activation. No
 * bindings: the md is the only policy source, which is what makes a broken md fail-open
 * observable.
 */
async function roleChild({ cwd, prompt }: { cwd: string; prompt: string }): Promise<{
  call: (toolName: string, input?: Record<string, unknown>) => Promise<Outcome>
  ui: string[]
  restore: () => void
}> {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  const handlers: Record<string, EventHandler> = {}
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand() {},
  }
  ext.activate(api)
  const ui: string[] = []
  const ctx: SessionContext = { cwd, ui: { notify: (message) => ui.push(message) }, actions: { abort() {} } }
  if (handlers.session_start) await handlers.session_start({ type: "session_start" }, ctx)
  if (handlers.before_agent_start) {
    await handlers.before_agent_start({ type: "before_agent_start", systemPrompt: prompt }, ctx)
  }
  let seq = 0
  return {
    call: (toolName, input) =>
      handlers.tool_call({ type: "tool_call", toolCallId: `r${++seq}`, toolName, input }, ctx) as Promise<Outcome>,
    ui,
    restore: () => {
      if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
    },
  }
}

const outside = (proj: string): string => join(proj, "..", "outside-the-tree.ts")

// 1. A md with malformed YAML frontmatter says policy (it declares an extend block) but
//    yields nothing readable: fail closed, and the refusal must name the md so the parent
//    knows which file to fix.
{
  const proj = join(workdir, "roles-broken-yaml")
  mkdirSync(join(proj, ".pi", "agents"), { recursive: true })
  const md = join(proj, ".pi", "agents", "broken-yaml.md")
  writeFileSync(md, "---\nname: broken-yaml\nextend: [unclosed\n---\n\nRole body.\n")
  const h = await roleChild({ cwd: proj, prompt: childSystemPrompt("broken-yaml", "Role body.") })
  const blocked = await h.call("read", { path: outside(proj) })
  assert.equal(blocked?.block, true, "a malformed role md denies the read instead of running unconstrained")
  assert.match(String(blocked?.reason), /broken-yaml\.md/, "the refusal names the md path")
  assert.match(String(blocked?.reason), /invalid YAML in frontmatter/, "the refusal names the problem")
  h.restore()
  console.log("  ok   a role md with malformed frontmatter fails closed and the refusal names the md")
}

// 2. A md whose extend block has only an unknown key (a typo such as permissionsX for
//    permissions) silently drops the intended grant today; failing closed turns the typo
//    into a refusal that names it.
{
  const proj = join(workdir, "roles-unknown-key")
  writeAgentMd({ cwd: proj, role: "typo-role", extend: { permissionsX: { scope: ["src/**"] } } })
  const h = await roleChild({ cwd: proj, prompt: childSystemPrompt("typo-role", "Role body.") })
  const blocked = await h.call("read", { path: outside(proj) })
  assert.equal(blocked?.block, true, "an extend block with only unknown keys denies the read")
  assert.match(String(blocked?.reason), /typo-role\.md/, "the refusal names the md path")
  assert.match(String(blocked?.reason), /permissionsX: unknown block/, "the refusal names the unknown key")
  h.restore()
  console.log("  ok   a role md whose extend block has only unknown keys fails closed and names the key")
}

// 3. The control: a md with no extend block at all expresses no restriction, and stays
//    legitimate. This is what stops the fix from becoming "any role md denies everything".
{
  const proj = join(workdir, "roles-no-extend")
  mkdirSync(join(proj, ".pi", "agents"), { recursive: true })
  writeFileSync(
    join(proj, ".pi", "agents", "plain-role.md"),
    "---\nname: plain-role\nsystemPromptMode: append\n---\n\nRole body.\n",
  )
  const h = await roleChild({ cwd: proj, prompt: childSystemPrompt("plain-role", "Role body.") })
  const outcome = await h.call("read", { path: outside(proj) })
  assert.equal(outcome, undefined, "a role md without an extend block leaves the child unconstrained")
  h.restore()
  console.log("  ok   a role md with no extend block stays fail open")
}

// 4. The builtin-agent case: a role tag naming a role with no md anywhere must stay fail
//    open, or every ordinary subagent would be locked out. The parent still gets the warning.
{
  const proj = join(workdir, "roles-no-md")
  const h = await roleChild({ cwd: proj, prompt: childSystemPrompt("ghost-role", "Role body.") })
  const outcome = await h.call("read", { path: outside(proj) })
  assert.equal(outcome, undefined, "a role with no md anywhere stays unconstrained")
  assert.ok(
    h.ui.some((message) => message.includes('no role md was found for role "ghost-role"')),
    "the parent is warned that no md was found",
  )
  h.restore()
  console.log("  ok   a role tag with no md anywhere stays fail open and warns")
}

// 5. A dispatch payload's scope replaces the role md's scope — it does not union.
//    Whoever sends the payload can move or narrow the boundary, but the md's wider
//    scope must not leak back in through the baseline merge (applyRoleBaseline only
//    fills fields the payload omits; a present scope is present even when narrower).
{
  const proj = join(workdir, "roles-scope-payload")
  writeAgentMd({
    cwd: proj,
    role: "scope-replaced",
    extend: { permissions: { scope: ["docs/**"] } },
  })
  const run = (scope: string[]) =>
    childRun({
      cwd: proj,
      home: join(workdir, "role-home-scope"),
      systemPrompt: '<active_agent name="scope-replaced"/>\nhello',
      rawBindings: true,
      bindings: JSON.stringify({ "pi-subagents-extend/1": { permissions: { scope } } }),
    })
  const moved = await run(["src/**"])
  const granted = await moved.call("read", { path: join(proj, "src/a.ts") })
  assert.equal(granted, undefined, "the payload's scope applies: src is readable")
  const refused = await moved.call("read", { path: join(proj, "docs/x.md") })
  assert.equal(refused?.block, true, "the md's wider scope does not survive the payload's replacement")
  assert.match(String(refused?.reason), /outside the read scope/, "the refusal is a scope refusal")
  assert.match(String(refused?.reason), /Read scope: src\/\*\*/, "the refusal names the payload's scope")
  assert.doesNotMatch(String(refused?.reason), /docs\/\*\*/, "the md's scope is not unioned back in")
  moved.restore()
  const narrowed = await run([])
  const payloadSide = await narrowed.call("read", { path: join(proj, "src/a.ts") })
  const mdSide = await narrowed.call("read", { path: join(proj, "docs/x.md") })
  assert.equal(payloadSide?.block, true, "payload scope: [] narrows away even what the payload itself granted before")
  assert.equal(mdSide?.block, true, "payload scope: [] does not inherit the md's wider scope")
  assert.match(String(payloadSide?.reason), /outside the read scope/, "the refusal is a scope refusal, not a tool refusal")
  assert.match(String(payloadSide?.reason), /Read scope: \(empty\)/, "the read scope is the narrowed empty list")
  narrowed.restore()
  console.log("  ok   a dispatch payload's scope replaces the role md's scope, including down to empty")
}
// 6. Two payload bash merge semantics: an explicitly empty bash.allow clears the
//    allowlist (it is a present-but-empty value, not an absent one, so the md's
//    entries must not fall back in), and a non-object bash switches the whole bash
//    surface off — refused with the bash-disabled reason, not a scope reason.
{
  const proj = join(workdir, "roles-bash-merge")
  writeAgentMd({
    cwd: proj,
    role: "bash-merge",
    extend: { permissions: { scope: ["src/**"], bash: { allow: ["echo md-allowed"] } } },
  })
  const run = (permissions: Record<string, unknown>) =>
    childRun({
      cwd: proj,
      home: join(workdir, "role-home-bash"),
      systemPrompt: '<active_agent name="bash-merge"/>\nhello',
      rawBindings: true,
      bindings: JSON.stringify({ "pi-subagents-extend/1": { permissions } }),
    })
  const cleared = await run({ scope: ["src/**"], bash: { allow: [] } })
  const emptied = await cleared.call("bash", { command: "echo md-allowed" })
  assert.equal(emptied?.block, true, "an explicitly empty bash.allow clears: the md's entry does not fall back in")
  assert.match(String(emptied?.reason), /bash is not allowed here/, "the refusal is the bash-disabled reason")
  assert.doesNotMatch(String(emptied?.reason), /command not in the allowlist/, "the whole surface is off, not a list miss")
  cleared.restore()
  const off = await run({ scope: ["src/**"], bash: false })
  const shut = await off.call("bash", { command: "echo md-allowed" })
  assert.equal(shut?.block, true, "a non-object bash switches the whole bash surface off")
  assert.match(String(shut?.reason), /bash is not allowed here/, "the refusal names bash being disallowed, not the scope")
  assert.doesNotMatch(String(shut?.reason), /outside the read scope/, "not a scope refusal")
  const reading = await off.call("read", { path: join(proj, "src/a.ts") })
  assert.equal(reading, undefined, "bash: false leaves the rest of the policy intact")
  off.restore()
  console.log("  ok   an explicit empty bash.allow clears the allowlist and a non-object bash switches bash off")
}
