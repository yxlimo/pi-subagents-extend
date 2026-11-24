import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { specOf, workdir, bashApi, childRun } from "../harness.ts"
import "../support.ts"









// 234. A quoted value in a git global flag must not hide the network verb: whitespace
//      splitting used to make `x'` the "subcommand", so a real `fetch` was never seen.
{
  const writer = "git -c core.pager='rm x' reset --hard"
  assert.equal(bashApi.requiresNetwork(writer), null, "reset stays local behind a quoted global value")
  assert.equal(
    bashApi.requiresNetwork("git -c core.pager='rm x' fetch"),
    "git fetch",
    "the network verb is found behind the same quoted global value"
  )
  console.log("  ok   quoted git global values no longer hide the network verb")
}

// 235. No-argument git globals must be skipped so a network verb behind them is still found.
{
  assert.equal(bashApi.requiresNetwork("git -p fetch"), "git fetch", "a no-argument global does not hide a network verb")
  console.log("  ok   no-argument git globals do not hide a network verb")
}








// 243. A quoted global value spanning three or more words used to be split into whitespace
//      fragments; the first bare fragment became the "subcommand" and hid a network verb.
{
  assert.equal(
    bashApi.requiresNetwork("git -c k='a b c' fetch"),
    "git fetch",
    "the network verb is found behind a multi-word quoted global"
  )
  console.log("  ok   multi-word quoted globals no longer hide a network verb")
}


// 245. Switching the verdict tokenizer must not disturb allowlist matching: commandMatches keeps
//      splitting on whitespace, so a literal entry with a quoted argument still matches by prefix.
{
  const entry = "git -c core.pager='rm x' reset"
  assert.equal(
    bashApi.commandMatches(entry, "git -c core.pager='rm x' reset --hard"),
    true,
    "a literal entry with a quoted argument still matches by whitespace-token prefix"
  )
  assert.equal(
    bashApi.commandMatches(entry, "git -c core.pager='rm x' clean -fd"),
    false,
    "and still refuses a different verb"
  )
  console.log("  ok   allowlist matching is unchanged by the verdict tokenizer switch")
}

// 246. preExec runs once per child session from the role md; failures keep the session alive.
{
  const home = join(workdir, "role-home-246")
  const md = join(home, ".agents", "phase3-setup.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n  setup:\n    preExec: printf "ran\\n" >> marker.txt\n---\n# phase3-setup\n')
  const proj = join(workdir, "role-proj-246")
  mkdirSync(proj, { recursive: true })
  const marker = join(proj, "marker.txt")
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-setup"/>\nhello' })
  assert.equal(readFileSync(marker, "utf8"), "ran\n", "exactly one run")
  assert.equal(await run.call("read", { path: marker }), undefined, "the session proceeds after preExec")
  run.restore()

  const failMd = join(home, ".agents", "phase3-fail.md")
  writeFileSync(failMd, '---\nextend:\n  permissions:\n    scope: ["."]\n  setup:\n    preExec: printf "boom\\n" >&2; exit 7\n---\n# phase3-fail\n')
  const failing = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-fail"/>\nhello' })
  assert.ok(failing.ui.some((m) => m.includes("setup.preExec exited with code 7") && m.includes("boom")), failing.ui.join("\n"))
  assert.equal(await failing.call("read", { path: marker }), undefined, "a failing preExec does not block the child")
  failing.restore()

  const ignoredMd = join(home, ".agents", "phase3-ignored.md")
  writeFileSync(ignoredMd, '---\nextend:\n  permissions:\n    scope: ["."]\n---\n# phase3-ignored\n')
  const payloadMarker = join(proj, "payload-marker.txt")
  const ignored = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase3-ignored"/>\nhello',
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], setup: { preExec: `printf ran > ${payloadMarker}` } } }),
  })
  assert.ok(ignored.ui.some((m) => m.includes("setup in extensionBindings is ignored")), ignored.ui.join("\n"))
  assert.equal(existsSync(payloadMarker), false, "a payload setup is never executed")
  ignored.restore()
  console.log("  ok   preExec runs once from the md; failures warn; payload setup is ignored")
}

// 247. The nodeModules hint appears only on the refusal that goes through the link.
{
  const home = join(workdir, "role-home-247")
  const md = join(home, ".agents", "phase3-keep.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n    write: []\n  worktree:\n    nodeModules: keep\n---\n# phase3-keep\n')
  const proj = join(workdir, "role-proj-247")
  const target = join(proj, "deps", "shared")
  mkdirSync(target, { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  symlinkSync(target, join(proj, "node_modules"), "dir")
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-keep"/>\nhello' })
  const linked = await run.call("write", { path: join(proj, "node_modules", "pkg", "x.js"), content: "x" })
  assert.ok(linked && linked.block && linked.reason.includes("readable but not writable"), "the write is refused")
  assert.match(linked.reason, /worktree\.nodeModules: remove/, "the refusal names the fix")
  const plain = await run.call("write", { path: join(proj, "src", "x.js"), content: "x" })
  assert.ok(plain && plain.block, "an ordinary write is also refused")
  assert.ok(!plain.reason.includes("worktree.nodeModules"), "but gets no nodeModules hint")
  assert.equal(existsSync(join(proj, "node_modules")), true, "keep leaves the link alone")
  run.restore()
  console.log("  ok   the readable-but-not-writable hint is limited to the node_modules link")
}
// 248. The deliverable grant must survive a session_start emitted after the wiring (P1-3).
{
  const home = join(workdir, "role-home-248")
  const md = join(home, ".agents", "phase3-order.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n    write: []\n  output:\n    deliverable: report.md\n---\n# phase3-order\n')
  const proj = join(workdir, "role-proj-248")
  mkdirSync(proj, { recursive: true })
  const bindings = JSON.stringify({
    "pi-subagents-extend/1": {
      scope: ["."], writeScope: ["."],
      bash: { allow: ["git status"] },
    },
  })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase3-order"/>\nhello',
    bindings,
    order: "hostile",
  })
  const target = join(proj, "report.md")
  assert.equal(existsSync(target), true, "the deliverable file was created")
  const input = { command: "git status" }
  assert.equal(await run.call("bash", input), undefined, "the bash command passes")
  const spec = specOf(input.command)
  assert.ok(
    spec.write.some((dir) => dir === target || dir.endsWith("/report.md")),
    `the deliverable grant survives the later session_start, got: ${spec.write.join(", ")}`,
  )
  run.restore()
  console.log("  ok   the deliverable grant survives a session_start after the wiring")
}

