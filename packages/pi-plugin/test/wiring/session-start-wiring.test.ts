import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join, dirname } from "node:path"
import type { PromptOptions } from "../types.ts"
import { handler, specOf, workdir, repo, childRun } from "../harness.ts"
import "../support.ts"

const rc = (await import(join(repo, "src", "role-config.ts"))) as unknown as typeof import("../../src/role-config.ts")

// 249. The nodeModules hint reaches the neither-readable-nor-writable refusal (P1-1).
{
  const home = join(workdir, "role-home-249")
  const md = join(home, ".agents", "phase3-hint.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n    write: []\n  worktree:\n    nodeModules: keep\n---\n# phase3-hint\n')
  const proj = join(workdir, "role-proj-249")
  const main = join(workdir, "role-main-249")
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(main, { recursive: true })
  symlinkSync(main, join(proj, "node_modules"), "dir")
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-hint"/>\nhello' })
  const refused = await run.call("write", { path: join(proj, "node_modules", "pkg", "x.js"), content: "x" })
  assert.ok(refused && refused.block, "the write is refused")
  assert.match(refused.reason, /neither readable nor writable/, "the refusal is the no-scope branch")
  assert.match(refused.reason, /worktree\.nodeModules: remove/, "the refusal names the fix")
  const plain = await run.call("write", { path: join(proj, "src", "x.js"), content: "x" })
  assert.ok(plain && plain.block, "an ordinary write is still refused")
  assert.ok(!plain.reason.includes("worktree.nodeModules"), "and gets no false hint")
  run.restore()
  console.log("  ok   the nodeModules hint reaches the neither-readable-nor-writable refusal")
}

// 250. P1-2: a second before_agent_start arriving mid-preExec must await the in-flight wiring.
{
  const home = join(workdir, "role-home-250")
  const md = join(home, ".agents", "phase3-double.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n  setup:\n    preExec: sleep 0.3; printf \'ran\\n\' >> count.txt\n  output:\n    deliverable: report.md\n---\n# phase3-double\n')
  const proj = join(workdir, "role-proj-250")
  mkdirSync(proj, { recursive: true })
  const count = join(proj, "count.txt")
  const bindings = JSON.stringify({
    "pi-subagents-extend/1": {
      scope: ["."],
      writeScope: ["."],
      bash: { allow: ["git status"] },
    },
  })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase3-double"/>\nhello',
    bindings,
    beforeStartEmissions: 2,
    beforeStartDelayMs: 50,
  })
  assert.equal(readFileSync(count, "utf8"), "ran\n", "preExec ran exactly once across two emissions")
  assert.equal(existsSync(join(proj, "report.md")), true, "the deliverable was wired")
  const input = { command: "git status" }
  assert.equal(await run.call("bash", input), undefined, "the bash command still passes")
  const spec = specOf(input.command)
  assert.ok(
    spec.write.some((dir) => dir === join(proj, "report.md") || dir.endsWith("/report.md")),
    `the deliverable grant survives the second emission, got: ${spec.write.join(", ")}`,
  )
  run.restore()
  console.log("  ok   a mid-preExec before_agent_start awaits the in-flight wiring")
}

// 251. P2-2: the transfer read refusal must not carry the write-only nodeModules hint.
{
  const home = join(workdir, "role-home-251")
  const md = join(home, ".agents", "phase3-xfer-hint.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**", "docs/**"]\n    write: ["docs/**"]\n  worktree:\n    nodeModules: keep\n---\n# phase3-xfer-hint\n')
  const proj = join(workdir, "role-proj-251")
  const real = join(workdir, "role-real-251")
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(join(proj, "docs"), { recursive: true })
  mkdirSync(join(real, "pkg"), { recursive: true })
  symlinkSync(real, join(proj, "node_modules"), "dir")

  const hl = mkdtempSync(join(tmpdir(), "pi-subagents-extend-xfer-hint-hl-"))
  const sessionFile = join(hl, "session.jsonl")
  const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)
  mkdirSync(join(hl, "sessions"), { recursive: true })
  const srcAbs = join(proj, "src", "a.ts")
  const docAbs = join(proj, "docs", "b.md")
  const modSrc = join(proj, "node_modules", "pkg", "src.js")
  const modDest = join(proj, "node_modules", "pkg", "dest.js")
  writeFileSync(
    join(hl, "sessions", `${key}.registry.jsonl`),
    [
      JSON.stringify({ kind: "session", sessionFile }),
      ...Object.entries({ [srcAbs]: "srcA", [docAbs]: "docB", [modSrc]: "modSrc", [modDest]: "modDest" }).map(([path, anchor]) =>
        JSON.stringify({ kind: "allocate", path, rows: [[anchor, "line"]] }),
      ),
      "",
    ].join("\n"),
  )
  const previous = { dir: process.env.PI_HASHLINE_DIR, session: process.env.PI_SESSION_FILE }
  process.env.PI_HASHLINE_DIR = hl
  process.env.PI_SESSION_FILE = sessionFile

  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-xfer-hint"/>\nhello' })
  try {
    const readRefusal = await run.call("copy", { source_from: "modSrc", source_to: "modSrc", anchor: "docB", direction: "after" })
    assert.ok(readRefusal && readRefusal.block, "the transfer read is refused")
    assert.match(String(readRefusal.reason), /read scope/, "it is the read-side refusal")
    assert.ok(!readRefusal.reason.includes("worktree.nodeModules"), "a read refusal carries no write-only hint")

    const moveRefusal = await run.call("move", { source_from: "modSrc", source_to: "modSrc", anchor: "docB", direction: "after" })
    assert.ok(moveRefusal && moveRefusal.block, "the move is refused on its source")
    assert.match(String(moveRefusal.reason), /worktree\.nodeModules: remove/, "the source write refusal keeps the hint")

    const destRefusal = await run.call("copy", { source_from: "srcA", source_to: "srcA", anchor: "modDest", direction: "after" })
    assert.ok(destRefusal && destRefusal.block, "the destination write is refused")
    assert.match(String(destRefusal.reason), /worktree\.nodeModules: remove/, "the destination write refusal keeps the hint")
  } finally {
    run.restore()
    if (previous.dir === undefined) delete process.env.PI_HASHLINE_DIR
    else process.env.PI_HASHLINE_DIR = previous.dir
    if (previous.session === undefined) delete process.env.PI_SESSION_FILE
    else process.env.PI_SESSION_FILE = previous.session
  }
  console.log("  ok   the transfer read refusal has no write-only nodeModules hint")
}

// 252. P2-1: a second child session with a different cwd must get its own wiring, not be skipped.
{
  const home = join(workdir, "role-home-252")
  const md = join(home, ".agents", "phase3-two-sessions.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n  setup:\n    preExec: sleep 0.05; printf \'ran\\n\' >> count.txt\n---\n# phase3-two-sessions\n')
  const projA = join(workdir, "role-proj-252a")
  const projB = join(workdir, "role-proj-252b")
  mkdirSync(projA, { recursive: true })
  mkdirSync(projB, { recursive: true })
  const bindings = JSON.stringify({
    "pi-subagents-extend/1": {
      scope: ["."],
      bash: { allow: ["git status"]},
    },
  })
  const countA = join(projA, "count.txt")
  const countB = join(projB, "count.txt")
  const run = await childRun({
    cwd: projA,
    home,
    systemPrompt: '<active_agent name="phase3-two-sessions"/>\nhello',
    bindings,
    beforeStartEmissions: 2,
    beforeStartCwds: [projA, projB],
  })
  assert.equal(existsSync(countA), true, "the first session wired its preExec")
  assert.equal(existsSync(countB), true, "the second session with a different cwd was not skipped")
  assert.equal(readFileSync(countA, "utf8"), "ran\n", "the first session's preExec ran once")
  assert.equal(readFileSync(countB, "utf8"), "ran\n", "the second session's preExec ran once")
  run.restore()
  console.log("  ok   a second child session with a different cwd is wired independently")
}

// 253. A tagless prompt still applies the md scope through its body (systemPromptMode: replace host).
{
  const home = join(workdir, "role-home-253")
  const md = join(home, ".agents", "body-match-253.md")
  mkdirSync(dirname(md), { recursive: true })
  const body = "BODY MATCH ROLE MARKER a distinctive child prompt body carried through systemPromptMode replace that identifies this role without any active_agent tag at all"
  writeFileSync(md, `---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n${body}\n`)
  const proj = join(workdir, "role-proj-253")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: `rewritten prompt\n${body}\ntail` })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope is applied from the body match")
  const outside = await run.call("write", { path: join(proj, "outside", "x.ts"), content: "x" })
  assert.ok(outside && outside.block, "a write outside the md scope is refused")
  assert.ok(
    outside.reason.includes(`(source: role md ${md})`),
    `the refusal must name the md as the source, got: ${outside.reason}`,
  )
  run.restore()
  console.log("  ok   a tagless prompt applies the md scope through its body")
}

// 254. False-positive control: an md body that is NOT in the prompt contributes nothing.
{
  const home = join(workdir, "role-home-254")
  const matchedMd = join(home, ".agents", "present-254.md")
  const decoyMd = join(home, ".agents", "absent-254.md")
  mkdirSync(dirname(matchedMd), { recursive: true })
  const presentBody = "PRESENT ROLE BODY that appears in the child prompt and must supply the scope while the absent decoy contributes nothing"
  const decoyBody = "ABSENT ROLE BODY that never appears in the prompt and must not grant the outside directory to this child under any circumstance"
  writeFileSync(matchedMd, `---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n${presentBody}\n`)
  writeFileSync(decoyMd, `---\nextend:\n  permissions:\n    scope: ["outside/**"]\n---\n${decoyBody}\n`)
  const proj = join(workdir, "role-proj-254")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: `rewritten prompt\n${presentBody}\ntail` })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the matched md's scope is applied")
  const outside = await run.call("read", { path: join(proj, "outside", "x.ts") })
  assert.ok(outside && outside.block, "the decoy's outside/** scope is not applied")
  assert.match(outside.reason, /outside the read scope/)
  assert.ok(!outside.reason.includes(decoyMd), "the decoy md is not named as a source")
  run.restore()
  console.log("  ok   a role md whose body is absent from the prompt contributes nothing")
}

// 255. No tag and no body match still warns, with the systemPromptMode: replace hint when an extend md exists.
{
  const home = join(workdir, "role-home-255")
  const md = join(home, ".agents", "unknown-255.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n---\n# a role body that is not in the prompt\n')
  const proj = join(workdir, "role-proj-255")
  mkdirSync(proj, { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: "UNMATCHED PROMPT 255 with no role tag and no role body markers" })
  const joined = run.ui.join("\n")
  assert.match(joined, /no active_agent role was found/, "the existing no-role warning stays")
  assert.match(joined, /systemPromptMode: replace/, "the likely cause is named")
  assert.match(joined, /append/, "the fix is named")
  run.restore()
  console.log("  ok   a tagless unmatched prompt warns about systemPromptMode: replace")
}

// 256. A foreground child has no PI_SUBAGENT_CHILD (measured: pi-subagents sets it only for
// host === "runner"; a foreground child runs in the parent with restoreProcessEnv). Its bindings
// payload is the child signal, so the role md extend must still be applied there.
{
  const home = join(workdir, "role-home-256")
  const md = join(home, ".agents", "fg-coder-256.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n  output:\n    deliverable: report.md\n---\n# fg-coder-256\n')
  const proj = join(workdir, "role-proj-256")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const options: PromptOptions = {}
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="fg-coder-256"/>\nhello',
    bindings: JSON.stringify({ "pi-subagents-extend/1": {} }),
    foreground: true,
    systemPromptOptions: options,
  })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope allows its subtree in a foreground child")
  const outside = await run.call("write", { path: join(proj, "outside", "x.ts"), content: "x" })
  assert.ok(outside && outside.block, "a write outside the md scope is refused in a foreground child")
  assert.ok(
    outside.reason.includes(`role md ${md}`),
    `the refusal must name the md as a source, got: ${outside.reason}`,
  )
  assert.ok(
    Object.keys(options.sections ?? {}).some((name) => name.includes("deliverable")),
    `the md's deliverable must be wired into the prompt sections, got: ${Object.keys(options.sections ?? {}).join(", ")}`,
  )
  run.restore()
  console.log("  ok   a foreground child applies the role md extend from its bindings payload")
}

// 257. The main session is not a child: no bindings payload and no role identity in the prompt
// must keep the role-md layer inert (no warning, no wiring).
{
  const home = join(workdir, "role-home-257")
  const md = join(home, ".agents", "main-excluded-257.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n  output:\n    deliverable: report.md\n---\n# MAIN EXCLUDED ROLE BODY 257 distinctive marker\n')
  const proj = join(workdir, "role-proj-257")
  mkdirSync(proj, { recursive: true })
  const options: PromptOptions = {}
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: "ORDINARY MAIN SESSION PROMPT 257 with no active_agent tag and no role body marker",
    foreground: true,
    bindings: undefined,
    systemPromptOptions: options,
  })
  const joined = run.ui.join("\n")
  assert.ok(
    !joined.includes("role md limits are NOT applied") && !joined.includes("no active_agent role was found"),
    `a main session must not emit role-md warnings, got: ${joined}`,
  )
  assert.deepEqual(Object.keys(options.sections ?? {}), [], "a main session must have no role deliverable wiring")
  run.restore()
  console.log("  ok   a main session is excluded from role wiring")
}

// 258. /permission must name the binding namespace and version, taken from bindingKey().
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["ls"] } } }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const lines = notified.join("\n").split("\n")
  const sourceAt = lines.findIndex((line) => line.startsWith("Source: "))
  assert.ok(sourceAt >= 0, "the command prints the source line")
  assert.equal(lines[sourceAt + 1], `Bindings: ${rc.bindingKey()}`, "the binding key from bindingKey() follows the source line")
  h.restore()
  console.log("  ok   /permission prints the binding namespace and version")
}


// 260. /permission prints the allow column with its entries.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["ls a"] } } }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.match(text, /^bash allow: ls a/m, "the allow column shows the allow entry")

  h.restore()
  console.log("  ok   /permission prints the allow column with its entries")
}


// 263. A dispatch carrying a foreign /2 binding key warns once with both keys.
{
  const matching = await handler()
  await matching.call("subagent", { extensionBindings: { "pi-subagents-extend/1": {} } })
  assert.equal(matching.ui.filter((m) => m.includes("declares binding")).length, 0, "the current version warns nothing")
  matching.restore()

  const h = await handler()
  const wrong = { "pi-subagents-extend/2": {} }
  await h.call("subagent", { extensionBindings: wrong })
  const warns = h.ui.filter((m) => m.includes("declares binding"))
  assert.equal(warns.length, 1, "exactly one warning for the wrong version")
  assert.match(warns[0], /pi-subagents-extend\/2/, "the received key is named")
  assert.match(warns[0], /pi-subagents-extend\/1/, "the correct key is named")
  await h.call("subagent", { extensionBindings: wrong })
  assert.equal(h.ui.filter((m) => m.includes("declares binding")).length, 1, "a second dispatch stays silent")
  h.restore()
  console.log("  ok   a wrong dispatch version warns once with both keys")
}


// 266. `setup` at either level is ignored once and never executed.
{
  const home = join(workdir, "role-home-266")
  const md = join(home, ".agents", "phase4-setup.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n# phase4-setup\n')
  const proj = join(workdir, "role-proj-266")
  mkdirSync(join(proj, "src"), { recursive: true })
  const marker = join(proj, "payload-marker.txt")
  const command = `printf ran > ${marker}`
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase4-setup"/>\nhello',
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        setup: { preExec: command },
        permissions: { scope: ["src/**"], setup: { preExec: command } },
      },
    }),
  })
  const warns = run.ui.filter((m) => m.includes("setup in extensionBindings is ignored"))
  assert.equal(warns.length, 1, `setup warns once even at both levels, got: ${run.ui.join("\n")}`)
  assert.equal(existsSync(marker), false, "payload setup is never executed")
  assert.equal(await run.call("read", { path: join(proj, "src/a.ts") }), undefined, "the scope is unchanged")
  const outside = await run.call("read", { path: join(proj, "outside.ts") })
  assert.equal(outside?.block, true, "the ignored key does not widen the scope")
  run.restore()
  console.log("  ok   setup in a dispatch payload warns once at either level and changes nothing")
}

// 267. The startup summary must report what the config holds, not which columns happen to be set.
//      It counted the legacy read/write columns only, so a role using the current single-column
//      `allow` spelling — every role md in this repo — reported "bash 0 read / 0 write" at startup
//      while its allowlist was full. A summary that contradicts the config is worse than none: the
//      parent reads it as "bash is effectively off" and never looks again.
{
  // The summary is posted at session_start, which is where a bindings-carrying session gets its
  // policy. A child whose policy arrives with the role md resolves it in before_agent_start instead,
  // so it never reaches this line — the reachable shape is a parent or a bindings-driven child.
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { allow: ["git status", "rg"] } },
    }),
  })
  const summary = h.ui.find((m) => m.includes("scope active"))
  assert.ok(summary, `a startup summary is posted, got: ${h.ui.join("\n")}`)
  assert.match(summary, /bash 2 allowed/, "the summary counts the allow entries")
  assert.doesNotMatch(summary, /0 read \/ 0 write/, "and never claims the allowlist is empty")
  h.restore()
  console.log("  ok   the startup summary counts the allow column instead of reporting legacy zeros")
}

