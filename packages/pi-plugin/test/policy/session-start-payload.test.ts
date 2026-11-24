// Session start: dispatch payload validation and /permission reporting (cases 267-280).
// Split from session-start.test.ts. Offline test for the pi-subagents-extend extension:
// runs the extension against a fake pi API so the scope contract can be checked without a
// live pi session. The policy is captured when the extension activates, so every case
// re-activates with its own environment.
//
//   node test/session-start-payload.test.ts

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { handler, workdir, writeAgentMd, childRun } from "../harness.ts"
import "../support.ts"

// 267. `output` at either level is ignored once and cannot grant a deliverable path.
{
  const home = join(workdir, "role-home-267")
  const md = join(home, ".agents", "phase4-output.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n# phase4-output\n')
  const proj = join(workdir, "role-proj-267")
  mkdirSync(join(proj, "src"), { recursive: true })
  const deliverable = "report.md"
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase4-output"/>\nhello',
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        output: { deliverable },
        permissions: { scope: ["src/**"], output: { deliverable } },
      },
    }),
  })
  const warns = run.ui.filter((m) => m.includes("output in extensionBindings is ignored"))
  assert.equal(warns.length, 1, `output warns once even at both levels, got: ${run.ui.join("\n")}`)
  assert.equal(await run.call("read", { path: join(proj, "src/a.ts") }), undefined, "the scope is unchanged")
  const report = await run.call("read", { path: join(proj, deliverable) })
  assert.equal(report?.block, true, "a payload output does not widen the read scope")
  run.restore()
  console.log("  ok   output in a dispatch payload warns once at either level and changes nothing")
}
// 268. A dispatch payload with worktree beside permissions is honoured and wins
//      over the role md's worktree default. This is the block-level key that
//      used to be dropped by extractCallConfig.
{
  const proj = join(workdir, "blocks-proj-268")
  writeAgentMd({
    cwd: proj,
    role: "coder",
    extend: { permissions: { scope: ["."], allowTools: ["subagent"] }, worktree: { enabled: false } },
  })
  const h = await handler({
    cwd: proj,
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { worktree: true, permissions: { scope: ["."], allowTools: ["subagent"] } },
    }),
  })
  const input: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true, "the payload's block-level worktree wins over the role md default")
  const warns = h.ui.filter((m) => m.includes("not tracked by git"))
  assert.equal(warns.length, 0, "a payload worktree is not treated as a role default")
  h.restore()
  console.log("  ok   a dispatch's worktree beside permissions wins over the role md default")
}


// 273. A malformed payload with no permissions does not honour its worktree.
{
  const empty = mkdtempSync(join(tmpdir(), "pi-subagents-extend-malformed-273-"))
  const h = await handler({
    cwd: empty,
    rawBindings: true,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { worktree: true } }),
  })
  const input: Record<string, unknown> = { agent: "ghost", task: "x" }
  const outcome = await h.call("subagent", input)
  assert.equal(outcome?.block, true, "the malformed payload is refused")
  const malformed = await h.call("read", { path: "x.ts" })
  assert.equal(malformed?.block, true, "a path call is refused too")
  assert.match(String(malformed?.reason), /permissions object/, "the missing permissions object is named")
  assert.equal(input.worktree, undefined, "its worktree is not filled")
  h.restore()
  rmSync(empty, { recursive: true, force: true })
  console.log("  ok   a payload without permissions does not get its worktree honoured")
}






// 279. /permission prints a plain allow line.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { allow: ["ls a"] },
      },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.ok(text.includes("bash allow: ls a"), "the allow column prints its entries")
  assert.equal(text.includes("no write access"), false, "no write refusal note is printed")
  h.restore()
  console.log("  ok   /permission prints a plain allow line when the allowlist has entries")
}


// 281. A role md that only repeats a default must not be named as a source layer.
//      Filling a field the payload left out is not the same as changing the outcome: an
//      bash: { network: false } parses to the same policy as no bash block
//      at all, so the refusal's source must stay the payload alone — the md is not where
//      the parent can fix anything. An md that does change the parsed policy must keep
//      being named, so the pair of directions in one case is the point.
{
  const proj = join(workdir, "role-proj-281")
  mkdirSync(proj, { recursive: true })
  const md = writeAgentMd({
    cwd: proj,
    role: "repeat-default",
    extend: { permissions: { bash: { network: false } } },
  })
  const run = await childRun({
    cwd: proj,
    home: workdir,
    systemPrompt: '<active_agent name="repeat-default"/>\nhello',
    rawBindings: true,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { permissions: { scope: ["src/**"] } } }),
  })
  const blocked = await run.call("bash", { command: "git status" })
  assert.equal(blocked?.block, true, "the command is refused either way")
  assert.ok(
    String(blocked?.reason).includes("bash is not allowed here"),
    `the refusal is the missing allowlist, got: ${blocked?.reason}`,
  )
  assert.ok(
    String(blocked?.reason).includes("(source: extensionBindings pi-subagents-extend/1)"),
    `the source must name the payload alone, got: ${blocked?.reason}`,
  )
  assert.ok(
    !String(blocked?.reason).includes(md),
    `a default-repeating md must not be named as a source layer, got: ${blocked?.reason}`,
  )
  run.restore()

  // The mirror direction: the md does change the parsed policy — the payload has no
  // scope at all (denyAll on its own) and the md's scope rescues it — so the source
  // must keep naming the md. A fix that dropped the md here would overcorrect.
  const rescuingMd = writeAgentMd({
    cwd: proj,
    role: "real-scope",
    extend: { permissions: { scope: ["src/**"] } },
  })
  const rescue = await childRun({
    cwd: proj,
    home: workdir,
    systemPrompt: '<active_agent name="real-scope"/>\nhello',
    rawBindings: true,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { permissions: { bash: { allow: ["ls"] } } } }),
  })
  const outside = await rescue.call("read", { path: join(proj, "..", "outside-281.ts") })
  assert.equal(outside?.block, true, "the read outside the md's scope is refused")
  assert.ok(
    String(outside?.reason).includes("outside the read scope"),
    `the refusal is the scope check, got: ${outside?.reason}`,
  )
  assert.ok(
    String(outside?.reason).includes(`(source: extensionBindings pi-subagents-extend/1 + role md ${rescuingMd})`),
    `a policy-changing md must stay named as a source layer, got: ${outside?.reason}`,
  )
  rescue.restore()
  console.log("  ok   a default-repeating md is not named as source; a policy-changing md is")
}
