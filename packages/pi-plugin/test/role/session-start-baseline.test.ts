import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { handler, specOf, workdir, writeAgentMd, childSystemPrompt, childRun, bashApi, rc } from "../harness.ts"
import "../support.ts"
// 199. The role md fills scope when no bindings file exists.
{
  const home = join(workdir, "role-home-199")
  const md = join(home, ".agents", "phase1-coder.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n# phase1-coder\n')
  const proj = join(workdir, "role-proj-199")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase1-coder"/>\nhello' })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope allows its subtree")
  const outside = await run.call("read", { path: join(proj, "outside", "x.ts") })
  assert.ok(outside && outside.block, "paths outside the md scope are refused")
  assert.match(outside.reason, /outside the read scope/)
  run.restore()
  console.log("  ok   the role md fills scope when no bindings exist")
}

// 200. A bindings value wins over the md baseline for the same key.
{
  const home = join(workdir, "role-home-200")
  const md = join(home, ".agents", "phase1-coder.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n')
  const proj = join(workdir, "role-proj-200")
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(join(proj, "allowed"), { recursive: true })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase1-coder"/>\nhello',
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"] } }),
  })
  assert.equal(await run.call("read", { path: join(proj, "src", "x.ts") }), undefined, "the bindings scope works")
  const mdPath = await run.call("read", { path: join(proj, "allowed", "x.ts") })
  assert.ok(mdPath && mdPath.block, "the md scope does not add to the bindings scope")
  assert.ok(
    mdPath.reason.includes("(source: extensionBindings pi-subagents-extend/1)"),
    `the refusal must name the bindings layer, got: ${mdPath.reason}`,
  )
  assert.ok(
    !mdPath.reason.includes(md) && !mdPath.reason.includes("role md"),
    `the md contributed no policy key, so it must not appear as a source, got: ${mdPath.reason}`,
  )
  run.restore()
  console.log("  ok   bindings wins over the md baseline for the same key")
}

// 201. The role md names itself as the source when it is the only configuration.
{
  const home = join(workdir, "role-home-201")
  const md = join(home, ".agents", "source-label-coder-201.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n# source-label-coder-201\n')
  const proj = join(workdir, "role-proj-201")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="source-label-coder-201"/>\nhello',
  })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope still allows its subtree")
  const outside = await run.call("read", { path: join(proj, "outside", "x.ts") })
  assert.ok(outside && outside.block, "paths outside the md scope are refused")
  assert.ok(
    outside.reason.includes(`(source: role md ${md})`),
    `the reason must name the md file as the only source layer, got: ${outside.reason}`,
  )
  assert.ok(
    !outside.reason.includes("extensionBindings"),
    `the md-only reason must not claim an extensionBindings layer, got: ${outside.reason}`,
  )
  run.restore()
  console.log("  ok   the role md names itself as the source when it is the only configuration")
}


// 202. A payload key and an md deny union name both layers, in contribution order.
//      A refusal's source is the parent agent's only clue about which file to edit, so it names
//      every layer that actually contributed — extensionBindings first, then the role md — and
//      only those layers. Here the md contributes through the deny union alone: the payload
//      declares scope and bash, so the md's only way in is its deny entry joining the union. The
//      denied command is read-class (`git status`) so the assertion pins *which* gate stopped it:
//      the deny check runs before the write gate and before the allowlist check, so a read-class
//      command can only be stopped by the deny. A write-class fixture is blocked too, but by a
//      message that says nothing about deny — it would pin less than this case claims.
{
  const proj = join(workdir, "role-proj-202")
  const md = writeAgentMd({
    cwd: proj,
    role: "source-label-coder-202",
    extend: { permissions: { scope: ["src/**"], bash: { deny: ["git status"] } } },
  })
  const run = await childRun({
    cwd: proj,
    home: workdir,
    systemPrompt: childSystemPrompt("source-label-coder-202", "Contribution-order role for the deny union."),
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git diff", "git status"] } },
    }),
  })
  assert.equal(await run.call("bash", { command: "git diff" }), undefined, "the payload's own allowlist still runs its commands")
  const denied = await run.call("bash", { command: "git status" })
  assert.ok(denied && denied.block, "the md's deny entry blocks a command the payload's own allowlist names")
  // The refusal must be the deny's: `git status` is read-class, so the write gate cannot be the
  // cause, and a write-gate message here would mean this case lost the claim it makes. (The deny
  // runs before the write gate, so a write-class fixture would also be denied — by a message that
  // never mentions deny.)
  assert.ok(
    denied.reason.includes("command blocked by a deny entry"),
    `the refusal must be a deny refusal, not a write-gate refusal, got: ${denied.reason}`,
  )
  assert.ok(!denied.reason.includes("bash.writable"), `a deny refusal must not mention bash.writable, got: ${denied.reason}`)
  assert.ok(
    denied.reason.includes(`(source: extensionBindings pi-subagents-extend/1 + role md ${md})`),
    `the reason must name the bindings layer then the md layer, got: ${denied.reason}`,
  )
  run.restore()

  // Negative control: the union is inert — the payload's deny already carries the entry — so the
  // source must not gain the md layer. Without this, a "names both layers" assertion would pass
  // even when the union added nothing.
  const inertMd = writeAgentMd({
    cwd: proj,
    role: "union-inert-coder-202",
    extend: { permissions: { scope: ["src/**"], bash: { deny: ["git stash"] } } },
  })
  const inert = await childRun({
    cwd: proj,
    home: workdir,
    systemPrompt: childSystemPrompt("union-inert-coder-202", "Inert-union control for the deny union."),
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git status"], deny: ["git stash"] } },
    }),
  })
  const sharedDeny = await inert.call("bash", { command: "git stash" })
  assert.ok(sharedDeny && sharedDeny.block, "the deny entry both layers carry still blocks the command")
  assert.ok(
    sharedDeny.reason.includes("(source: extensionBindings pi-subagents-extend/1)") && !sharedDeny.reason.includes(inertMd),
    `an unchanged deny must not name the md as a source, got: ${sharedDeny.reason}`,
  )
  inert.restore()

  // Second control: the md declares bash but no deny, so the union has nothing to add either.
  const noDenyMd = writeAgentMd({
    cwd: proj,
    role: "no-deny-coder-202",
    extend: { permissions: { scope: ["src/**"], bash: { allow: ["cat f"] } } },
  })
  const plain = await childRun({
    cwd: proj,
    home: workdir,
    systemPrompt: childSystemPrompt("no-deny-coder-202", "Deny-less control for the deny union."),
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git status"] } } }),
  })
  const missed = await plain.call("bash", { command: "git commit" })
  assert.ok(missed && missed.block, "a command outside the payload allowlist is refused")
  assert.ok(
    missed.reason.includes("(source: extensionBindings pi-subagents-extend/1)") && !missed.reason.includes(noDenyMd),
    `an md bash block without deny must not name the md as a source, got: ${missed.reason}`,
  )
  plain.restore()
  console.log("  ok   the bindings key and an md deny union name both layers, in contribution order")
}
// 203. A role tag below the first line still applies the md scope.
{
  const home = join(workdir, "role-home-203")
  const md = join(home, ".agents", "later-line-coder-203.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n# later-line-coder-203\n')
  const proj = join(workdir, "role-proj-203")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: 'rewritten prompt\n\n<active_agent name="later-line-coder-203"/>\n\nsystem prompt',
  })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope is active")
  const outside = await run.call("read", { path: join(proj, "outside", "x.ts") })
  assert.ok(outside && outside.block, "a path outside the md scope is refused")
  assert.match(outside.reason, /outside the read scope/)
  run.restore()
  console.log("  ok   a role tag on a later line applies the md scope")
}

// 204. The md is found by walking up from the dispatch cwd.
{
  const home = join(workdir, "role-home-204")
  const md = join(workdir, "role-root-204", ".pi", "agents", "nested-coder-204.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n# nested-coder-204\n')
  const nested = join(workdir, "role-root-204", "packages", "app")
  mkdirSync(join(nested, "allowed"), { recursive: true })
  mkdirSync(join(nested, "outside"), { recursive: true })
  const run = await childRun({
    cwd: nested,
    home,
    systemPrompt: '<active_agent name="nested-coder-204"/>\nhello',
  })
  assert.equal(await run.call("read", { path: join(nested, "allowed", "x.ts") }), undefined, "the md at the root is active")
  const outside = await run.call("read", { path: join(nested, "outside", "x.ts") })
  assert.ok(outside && outside.block, "a path outside the root md scope is refused")
  assert.match(outside.reason, /outside the read scope/)
  run.restore()
  console.log("  ok   a dispatch in a nested package finds the md at the project root")
}

// 205. A child with no identifiable role warns once that the md limits are not applied.
{
  const home = join(workdir, "role-home-205")
  const proj = join(workdir, "role-proj-205")
  mkdirSync(proj, { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: "a prompt with no active_agent tag" })
  const warnings = run.ui.filter((message) => message.includes("role md limits are NOT applied"))
  assert.equal(warnings.length, 1, `exactly one warning about the missing md limits, got: ${run.ui.join(" | ")}`)
  assert.match(warnings[0], /no active_agent role was found/)
  assert.equal(await run.call("read", { path: join(proj, "anything.ts") }), undefined, "an unbound child is unchanged")
  run.restore()
  console.log("  ok   a child with no identifiable role warns once and does not crash")
}

// 206. An md write grant cannot restore writes the bindings suppressed.
{
  const home = join(workdir, "role-home-206")
  const md = join(home, ".agents", "readonly-coder-206.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n    write: ["reports/**"]\n---\n')
  const proj = join(workdir, "role-proj-206")
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(join(proj, "reports"), { recursive: true })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="readonly-coder-206"/>\nhello',
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], readOnly: true } }),
  })
  const write = await run.call("write", { path: join(proj, "reports", "x.md"), content: "x" })
  assert.ok(write && write.block, "the md cannot re-grant a write the bindings suppressed")
  assert.match(write.reason, /no write grant/)
  run.restore()
  console.log("  ok   a readOnly binding keeps its empty write scope against the md")
}

// 207. A known role with no md anywhere warns once and names the directories tried.
{
  const home = join(workdir, "role-home-207")
  const proj = join(workdir, "role-proj-207")
  mkdirSync(proj, { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="missing-coder-207"/>\nhello' })
  const warnings = run.ui.filter((message) => message.includes("role md limits are NOT applied"))
  assert.equal(warnings.length, 1, `exactly one warning about the missing md, got: ${run.ui.join(" | ")}`)
  assert.ok(warnings[0].includes("missing-coder-207"), "the role is named")
  assert.ok(warnings[0].includes(join(proj, ".pi", "agents")), "the project directory is named")
  assert.ok(warnings[0].includes(join(home, ".agents")), "the home fallback directory is named")
  run.restore()
  console.log("  ok   a missing role md warns once and names the directories tried")
}

// 208. No role tag and no bindings/profile: the warning must say the child is unconstrained.
{
  const home = join(workdir, "role-home-208")
  const proj = join(workdir, "role-proj-208")
  mkdirSync(proj, { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: "a prompt with no active_agent tag" })
  const warnings = run.ui.filter((message) => message.includes("no active_agent role was found"))
  assert.equal(warnings.length, 1, `exactly one no-role warning, got: ${run.ui.join(" | ")}`)
  assert.match(warnings[0], /no configuration is in effect/, "the warning says no configuration is active")
  assert.match(warnings[0], /tool calls in this child are unconstrained/, "the warning says the child is unconstrained")
  run.restore()
  console.log("  ok   an unconfigured child warns that no configuration is in effect and it is unconstrained")
}

// 209–220. Role-config phase 2: the single bash.allow column, with read/write judged internally.

// 209. commandAccess: every writer in the table classifies as write.
{
  const writers = [
    "mkdir d", "cp a b", "mv a b", "rm f", "touch f", "chmod +x f", "chown u f",
    "ln -s a b", "tee f", "dd if=a of=b", "truncate -s 0 f", "install a b", "rsync a b",
    "sed -i s/a/b/ f", "sed --in-place s/a/b/ f",
    "git add .", "git commit -m x", "git switch x", "git stash", "git init",
    "git worktree add x", "git rm f", "git mv a b", "git apply p", "git cherry-pick x",
    "git merge x", "git rebase x", "git tag v1",
    "pnpm install", "npm add x", "yarn remove x", "bun uninstall x", "pnpm update", "npm ci", "pnpm test",
    "node a.mjs", "python a.py", "python3 a.py", "sh a.sh", "bash a.sh", "zsh a.sh",
    "ruby a.rb", "perl a.pl",
  ]
  for (const cmd of writers) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `writer must be write: ${cmd}`)
  }
  console.log("  ok   commandAccess puts every writer in the write class")
}

// 210. commandAccess: readers, unknown programs and non-writing subcommands stay read.
{
  const readers = [
    "cat f", "ls", "rg x", "find .", "grep x f", "head f", "tail f", "wc f", "file f",
    "stat f", "diff a b", "cmp a b", "du .", "df .", "echo hi", "pwd", "which node", "type ls",
    "git status", "git diff", "git log", "git show HEAD", "git rev-parse HEAD", "git branch",
    "git remote -v", "git blame f", "git describe",
    "frobnicate --things",
  ]
  for (const cmd of readers) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `reader/unknown must be read: ${cmd}`)
  }
  console.log("  ok   commandAccess leaves readers, unknown programs and non-writing subcommands as read")
}

// 211. commandAccess peels assignments, wrappers and paths, and judges every chain segment.
{
  const peeled = [
    "env rm x", "sudo rm x", "nice rm x", "timeout 5 rm x", "xargs rm x",
    "/usr/bin/rm x", "./rm x", "FOO=1 rm x", "env FOO=1 rm x",
  ]
  for (const cmd of peeled) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `peeled writer must be write: ${cmd}`)
  }
  assert.equal(bashApi.commandAccess("cat x; rm y", true), "write", "a chain with a writer writes")
  assert.equal(bashApi.commandAccess("cat x && rm y", true), "write", "&& with a writer writes")
  assert.equal(bashApi.commandAccess("cat x | grep y", true), "read", "an all-reader pipe stays read")
  console.log("  ok   commandAccess peels assignments/wrappers/paths and scans every chain segment")
}

// 212. commandAccess honours the writable ceiling; isUnknownProgram names unlisted programs.
{
  assert.equal(bashApi.commandAccess("rm x", false), "read", "no write grant forces read for a writer")
  assert.equal(bashApi.commandAccess("cat x; rm y", false), "read", "the ceiling wins even for a chain")
  assert.equal(bashApi.isUnknownProgram("frobnicate x"), true, "a program outside both tables is unknown")
  assert.equal(bashApi.isUnknownProgram("rm x"), false, "a listed writer is not unknown")
  assert.equal(bashApi.isUnknownProgram("cat x"), false, "a listed reader is not unknown")
  console.log("  ok   writable=false forces read; unknown programs are distinguishable")
}

// 213. parseBashRule gives allow its own column and keeps legacy read/write unchanged.
{
  const only = bashApi.parseBashRule({ allow: ["git status"] })
  assert.deepEqual(only?.read, [], "allow alone does not populate read")
  assert.deepEqual(only?.write, [], "allow alone no longer populates write")
  assert.deepEqual(only?.allow, ["git status"], "allow alone populates allow")

  const legacy = bashApi.parseBashRule({ read: ["cat f"], write: ["rm f"], allow: ["git status"] })
  assert.deepEqual(legacy?.read, ["cat f"], "legacy read is unchanged")
  assert.deepEqual(legacy?.write, ["rm f"], "legacy write no longer absorbs allow")
  assert.deepEqual(legacy?.allow, ["git status"], "allow stays separate")

  assert.equal(bashApi.parseBashRule({}), undefined, "all three columns empty means no bash")
  assert.equal(bashApi.parseBashRule({ allow: [] }), undefined, "an explicitly empty allow is still no bash")
  console.log("  ok   parseBashRule keeps allow as its own column")
}

// 214. classifyCommand takes access from the column that matched; allEntries includes allow.
{
  const legacy = bashApi.parseBashRule({ read: ["cat f"], write: ["rm f"] })
  assert.ok(legacy)
  assert.equal(bashApi.classifyCommand(legacy, "rm f")?.access, "write", "legacy write is still write")
  assert.equal(bashApi.classifyCommand(legacy, "rm f")?.column, "write", "and reports the write column")
  assert.equal(bashApi.classifyCommand(legacy, "cat f")?.access, "read", "legacy read is still read")
  assert.equal(bashApi.classifyCommand(legacy, "cat f")?.column, "read", "and reports the read column")

  const allowed = bashApi.parseBashRule({ allow: ["rm w", "cat r", "frobnicate u"], writable: true })
  assert.ok(allowed)
  const w = bashApi.classifyCommand(allowed, "rm w")
  assert.equal(w?.access, "write", "allow + writer program is write")
  assert.equal(w?.column, "allow", "and reports the allow column")
  assert.equal(bashApi.classifyCommand(allowed, "cat r")?.access, "read", "allow + reader program is read")
  const unknown = bashApi.classifyCommand(allowed, "frobnicate u")
  assert.equal(unknown?.access, "read", "allow + unknown program is read")
  assert.ok(unknown && bashApi.isUnknownProgram("frobnicate u"), "and the program is flagged unknown")
  assert.deepEqual(bashApi.allEntries(allowed), ["rm w", "cat r", "frobnicate u"], "allow shows up in allEntries")

  const ceiling = bashApi.parseBashRule({ allow: ["rm w"], writable: false })
  assert.ok(ceiling)
  assert.equal(bashApi.classifyCommand(ceiling, "rm w")?.access, "read", "writable:false ceilings an allow writer")
  console.log("  ok   classifyCommand derives allow access from the program, legacy columns untouched")
}

// 215. An allow-listed writer with writable:false is refused before spawn, on the write budget.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["rm x"], writable: false }, maxWriteDenies: 1 },
    }),
  })
  const input = { command: "rm x" }
  const outcome = await h.call("bash", input)
  assert.equal(outcome?.block, true, "the writer is refused")
  assert.match(outcome?.reason ?? "", /the role may run this command/, "the allow grant is acknowledged")
  assert.match(outcome?.reason ?? "", /bash\.writable: false gives no write access/, "the cause is named")
  assert.match(outcome?.reason ?? "", /Write refusal 1 in a row/i, "it counts on the write budget")
  assert.equal(input.command, "rm x", "the command is not rewritten, so nothing was spawned")
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m) => h.ui.push(m) } })
  assert.match(h.ui.at(-1) ?? "", /write denials: 1\/1/, "the write budget was consumed")
  assert.match(h.ui.at(-1) ?? "", /read denials: 0\//i, "the grant budget was untouched")
  h.restore()
  console.log("  ok   allow + writer + writable:false is a write-budget refusal before spawn")
}

// 216. An allow-listed reader runs through the sandbox like any bash call.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["cat src/auth/x.ts"] } } }),
  })
  const input = { command: "cat src/auth/x.ts" }
  assert.equal(await h.call("bash", input), undefined, "the reader is allowlisted and runs")
  assert.match(input.command, /pi-subagents-extend-helper/, "it goes through the sandbox")
  assert.deepEqual(specOf(input.command).read, ["/"], "the spec is the usual read-only sandbox")
  h.restore()
  console.log("  ok   allow + reader runs under the sandbox")
}

// 217. The md's permissions.bash accepts the new keys and reports bad/unknown ones.
{
  const good = rc.policyFromBlock({
    permissions: { scope: ["."], bash: { allow: ["cat f", "rm x"], deny: ["rm f"], writable: true, network: false } },
  })
  assert.deepEqual(good.problems, [], "a well-formed bash block is accepted")
  assert.deepEqual(good.policy?.bash, {
    allow: ["cat f", "rm x"], deny: ["rm f"], writable: true, network: false,
  }, "the bash keys map onto the role policy")

  const bad = rc.policyFromBlock({
    permissions: { scope: ["."], bash: { allow: "cat f", writable: "yes", mystery: 1 } },
  })
  assert.ok(bad.problems.some((p) => p.includes("permissions.bash.allow")), "a non-array allow is reported")
  assert.ok(bad.problems.some((p) => p.includes("permissions.bash.writable")), "a non-boolean writable is reported")
  assert.ok(bad.problems.some((p) => p.includes("mystery")), "unknown keys are still reported")
  assert.equal(bad.policy?.bash?.allow, undefined, "a bad allow is omitted")

  const legacy = rc.policyFromBlock({ permissions: { scope: ["."], bash: { write: ["rm f"] } } })
  assert.ok(legacy.problems.some((p) => p.includes('use "allow"')), "the md legacy spelling points to allow")
  assert.equal(legacy.policy?.bash, undefined, "and is not accepted")
  console.log("  ok   md permissions.bash takes allow/deny/writable/network and reports bad keys")
}

// 218. md permissions.bash.allow reaches a child session and gates bash end to end.
{
  const home = join(workdir, "role-home-218")
  const md = join(home, ".agents", "md-bash-coder.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["**"]\n    bash:\n      allow: ["cat src/auth/x.ts"]\n      writable: false\n---\n# md-bash-coder\n')
  const proj = join(workdir, "role-proj-218")
  mkdirSync(join(proj, "src", "auth"), { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="md-bash-coder"/>\nhello' })
  assert.equal(await run.call("bash", { command: "cat src/auth/x.ts" }), undefined, "the md allowlist runs the reader")
  const blocked = await run.call("bash", { command: "rm src/auth/x.ts" })
  assert.ok(blocked && blocked.block, "a command outside the md allowlist is refused")
  run.restore()
  console.log("  ok   md permissions.bash.allow reaches the child and gates bash")
}

// 219. A legacy bash.read/bash.write config warns once about the migration.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { read: ["cat f"], write: ["rm f"] } } }),
  })
  const warnings = h.ui.filter((m) => m.includes("legacy columns"))
  assert.equal(warnings.length, 1, "one migration warning for the legacy config")
  assert.match(warnings[0], /bash\.allow/, "the warning names the new column")
  assert.match(warnings[0], /read\/write is judged internally/, "it says access is judged internally")
  const before = h.ui.length
  await h.call("bash", { command: "cat f" })
  assert.equal(h.ui.length, before, "no repeat warning on a later call")
  h.restore()
  console.log("  ok   a legacy bash.read/write config warns once about bash.allow")
}

// 220. A failed write by an allow-listed unknown program explains that it ran read-only.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["frobnicate"] } } }),
  })
  const input = { command: "frobnicate" }
  assert.equal(await h.call("bash", input), undefined, "the unknown program is allowlisted and runs")
  const target = `/var/tmp/pi-extend-${process.pid}/out.txt`
  const outcome = await h.result("bash", `error: cannot write '${target}': Permission denied`, true)
  const content: unknown = outcome?.content
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("\n") : ""
  assert.match(text, /outside the writes the parent granted/, "the ordinary write-refusal note is present")
  assert.match(text, /could not tell that this program writes, so it was not treated as a write/, "the read-only cause sentence is corrected")
  assert.doesNotMatch(text, /ran read-only/, "it no longer claims the program ran read-only")
  assert.match(text, /ask for bash\.writable: true/, "a role without the ceiling is asked for the ceiling")
  assert.doesNotMatch(text, /ask for writablePaths/, "and not for writablePaths it cannot use")
  h.restore()
  console.log("  ok   a failed write by an unknown allow-listed program explains the ceiling, not a read-only run")
}

