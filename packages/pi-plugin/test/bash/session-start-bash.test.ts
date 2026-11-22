import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { handler, specOf, workdir, stateDir, bashApi, childRun } from "../harness.ts"
import "../support.ts"

// 221. A writablePaths grant must not widen a bash.writable:false role, even for a read command.
//      The ceiling is the role's own contract: a grant reaches the sandbox spec only when the role
//      is writable. Put the grant in the repo (not /tmp), where dropHiddenGrants keeps it when it is
//      present, so its absence pins the writable gate rather than tmpfs filtering.
{
  const cwd = stateDir(".test-cwd-")
  const grant = join(cwd, "no-write-grant")
  mkdirSync(grant, { recursive: true })
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: false, writablePaths: [grant] },
      },
    }),
    cwd,
  })
  const input = { command: "git status" }
  assert.equal(await h.call("bash", input), undefined, "the read command passes")
  const spec = specOf(input.command)
  assert.ok(
    !spec.write.includes(grant),
    `a writable:false role must not mount its writablePaths grant, got: ${spec.write.join(", ")}`
  )
  h.restore()
  rmSync(cwd, { recursive: true, force: true })
  console.log("  ok   a writable:false role does not mount its writablePaths grant")
}

// 222. The git write table must cover every subcommand that rewrites the work tree or history.
//      A missed verb is the worst failure: the command runs as a read and nothing says so.
{
  const writers = [
    "git reset --hard", "git clean -fd", "git checkout b", "git restore f",
    "git pull", "git revert HEAD", "git tag v1",
    "git branch -d x", "git remote add o u",
  ];
  for (const cmd of writers) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `git writer must be write: ${cmd}`)
  }
  const readers = ["git status", "git log", "git tag -l", "git branch", "git remote -v"]
  for (const cmd of readers) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `git reader must be read: ${cmd}`)
  }
  console.log("  ok   git write/read subcommands and argument predicates are classified correctly")
}

// 223. find is a reader until an action argument appears; those arguments write on their own.
{
  for (const cmd of ["find . -delete", "find . -exec rm {} +"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `find action must be write: ${cmd}`)
  }
  assert.equal(bashApi.commandAccess("find . -name x", true), "read", "a plain find stays a reader")
  console.log("  ok   find's deleting/executing arguments are write, a plain find is read")
}

// 224. A package manager runs arbitrary code unless its subcommand is provably read-only.
{
  for (const cmd of ["pnpm run build", "pnpm exec rm x", "pnpm test", "npm run build"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `package manager must be write: ${cmd}`)
  }
  for (const cmd of ["pnpm list", "npm view x"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `read-only subcommand must be read: ${cmd}`)
  }
  console.log("  ok   package managers are write except for the read-only subcommand set")
}

// 225. xargs flags must be consumed so the program word is judged, not the flags.
{
  for (const cmd of ["xargs -0 rm", "xargs -a list rm", "xargs -n1 rm"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `flagged xargs must be write: ${cmd}`)
  }
  assert.equal(bashApi.commandAccess("xargs frobnicate", true), "write", "an unknown payload program is still write")
  // 这两条钉住旗标表本身：旗标吃掉后认出 reader，判 read；没有旗标表就会落到「判不准即 write」。
  for (const cmd of ["xargs -0 cat", "xargs -a list cat"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `flagged xargs with a reader must be read: ${cmd}`)
  }
  console.log("  ok   xargs flag tables expose the program word, and unknown programs are write")
}

// 226. sed -i takes an optional suffix: -i.bak and -i'' are in-place writes too.
{
  assert.equal(bashApi.commandAccess("sed -i.bak s/a/b/ f", true), "write", "a suffixed -i writes")
  assert.equal(bashApi.commandAccess("sed s/a/b/ f", true), "read", "plain sed stays a reader")
  console.log("  ok   every -i spelling is a write, plain sed is a read")
}

// 227. isUnknownProgram checks every segment, and known readers never masquerade as unknown
//      (otherwise the read side of the tables is unpinned: unknown also falls back to read).
{
  for (const cmd of ["git status", "find .", "cat x", "ls"]) {
    assert.equal(bashApi.isUnknownProgram(cmd), false, `known reader must not be unknown: ${cmd}`)
  }
  assert.equal(bashApi.isUnknownProgram("cat x; frobnicate y"), true, "an unknown later segment counts")
  assert.equal(bashApi.isUnknownProgram("frobnicate y; cat x"), true, "an unknown first segment counts")
  console.log("  ok   isUnknownProgram scans every segment and keeps known readers known")
}

// 228. A command granted by `allow` is refused for writable:false even when a legacy write
//      column also matches it: the gate keys off the allow grant and intrinsic write, not off
//      which column classifyCommand reported first.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { write: ["rm"], allow: ["rm x"], writable: false }, maxWriteDenies: 1 },
    }),
  })
  const input = { command: "rm x" }
  const outcome = await h.call("bash", input)
  assert.equal(outcome?.block, true, "the writer is refused before spawn")
  assert.match(outcome?.reason ?? "", /the role may run this command/, "the allow grant is acknowledged")
  assert.match(outcome?.reason ?? "", /bash\.writable: false gives no write access/, "the cause is named")
  assert.match(outcome?.reason ?? "", /matched the legacy write column, which does not grant writes/, "the shadowing legacy column is named")
  assert.equal(input.command, "rm x", "the command is not rewritten, so nothing was spawned")
  h.restore()
  console.log("  ok   an allow grant is refused for a writer even when a legacy write column matches first")
}

// 229. The same columns with the write ceiling granted run through the sandbox.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { write: ["rm"], allow: ["rm x"], writable: true }, maxWriteDenies: 1 },
    }),
  })
  const input = { command: "rm x" }
  assert.equal(await h.call("bash", input), undefined, "the writer runs when the role can write")
  assert.match(input.command, /pi-subagents-extend-helper/, "it goes through the sandbox")
  h.restore()
  console.log("  ok   the same command runs when bash.writable is true")
}

// 230. An allow-only config with writable:false is still refused, with no legacy clause invented.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["rm x"], writable: false }, maxWriteDenies: 1 },
    }),
  })
  const outcome = await h.call("bash", { command: "rm x" })
  assert.equal(outcome?.block, true, "an allow-only writer is refused")
  assert.match(outcome?.reason ?? "", /bash\.writable: false gives no write access/, "the cause is named")
  assert.doesNotMatch(outcome?.reason ?? "", /matched the legacy/, "and no legacy column is invented")
  h.restore()
  console.log("  ok   allow-only + writable:false is still refused, with no legacy clause")
}

// 231. A legacy-only config with writable:false is NOT refused before spawn: the early refusal
//      belongs to the new single-column path, not to existing bindings.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { write: ["rm"], writable: false }, maxWriteDenies: 1 },
    }),
  })
  const input = { command: "rm x" }
  assert.equal(await h.call("bash", input), undefined, "a legacy write command is not refused early")
  assert.match(input.command, /pi-subagents-extend-helper/, "it still goes through the sandbox")
  h.restore()
  console.log("  ok   a legacy-only writer config has no new early refusal")
}

// 232. A role WITH the write ceiling does not get the "could not tell" sentence: the note's
//      advice and cause must follow the role's actual grant.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["frobnicate"], writable: true } } }),
  })
  const input = { command: "frobnicate" }
  assert.equal(await h.call("bash", input), undefined, "the unknown program is allowlisted and runs")
  const target = `/var/tmp/pi-extend-${process.pid}/out-232.txt`
  const outcome = await h.result("bash", `error: cannot write '${target}': Permission denied`, true)
  const content: unknown = outcome?.content
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("\n") : ""
  assert.match(text, /outside the writes the parent granted/, "the ordinary write-refusal note is present")
  assert.doesNotMatch(text, /could not tell that this program writes|not in the write table/, "no read-only cause sentence is added for a writable role")
  assert.match(text, /ask for writablePaths/, "a role with the ceiling is still asked for writablePaths")
  h.restore()
  console.log("  ok   a writable role's write note keeps the writablePaths advice and drops the cause")
}

// 233. A legacy bash column supplied by the dispatch bindings warns under that bindings
//      source alone, not merged into any role-md attribution. (The profile layer is gone;
//      the bindings env is the only non-md source that can still carry legacy columns.)
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["cat f"], write: ["rm f"] } } }),
  })
  const warnings = h.ui.filter((m) => m.includes("legacy columns"))
  assert.equal(warnings.length, 1, "the bindings' legacy columns produce one warning")
  assert.match(
    warnings[0],
    /^pi-subagents-extend: extensionBindings pi-subagents-extend\/1 still spells/,
    "the warning is attributed to the bindings source alone",
  )
  h.restore()
  console.log("  ok   a legacy column from the dispatch bindings warns under the bindings source")
}


// 234. A quoted value in a git global flag must not hide the verb: whitespace splitting used to
//      make `x'` the "subcommand", so the real `reset` was never examined.
{
  const writer = "git -c core.pager='rm x' reset --hard"
  assert.equal(bashApi.commandAccess(writer, true), "write", "a quoted global value does not hide reset")
  // `log` is safe to call read: the quote fragment belongs to the flag's value, not the verb.
  assert.equal(bashApi.commandAccess("git -c core.pager='rm x' log", true), "read", "the quote fragment is not the verb")
  assert.equal(bashApi.requiresNetwork(writer), null, "reset stays local behind a quoted global value")
  assert.equal(
    bashApi.requiresNetwork("git -c core.pager='rm x' fetch"),
    "git fetch",
    "the network verb is found behind the same quoted global value"
  )
  assert.equal(bashApi.commandAccess('git -c core.pager="rm x" clean -fd', true), "write", "double-quoted values too")
  console.log("  ok   quoted git global values no longer hide the verb from write and network checks")
}

// 235. No-argument git globals must be skipped; when an unlisted global makes the verb
//      unlocatable, the verdict is write rather than the read of a guessed subcommand.
{
  for (const cmd of ["git -p reset --hard", "git --paginate clean -fd", "git -P rm x", "git --bare reset --hard"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a no-argument global must not hide the verb: ${cmd}`)
  }
  assert.equal(
    bashApi.commandAccess("git --namespace foo reset --hard", true),
    "write",
    "an unlisted global with an argument leaves the verb unlocatable"
  )
  assert.equal(bashApi.requiresNetwork("git -p fetch"), "git fetch", "a no-argument global does not hide a network verb")
  console.log("  ok   no-argument git globals are skipped, and an unlocatable verb is a write")
}

// 236. config/store/version are not blanket readers: the second token decides whether they write.
{
  for (const cmd of [
    "npm config set registry https://x", "pnpm config set a b", "yarn config set k v",
    "npm config delete k", "pnpm store prune", "npm version patch",
    "npm config", "pnpm store",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a package-manager writer must be write: ${cmd}`)
  }
  for (const cmd of [
    "pnpm config get registry", "pnpm config list", "pnpm store path", "pnpm store status",
    "npm version", "pnpm --version", "npm --help", "yarn -v",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a package-manager query must be read: ${cmd}`)
  }
  console.log("  ok   package-manager config/store/version writes are found, queries and flags-only stay read")
}

// 237. More git branch/remote writes: each argument rewrites a branch, a remote or its refs.
{
  for (const cmd of [
    "git branch -M x", "git branch -C x", "git branch -c x", "git branch -f x",
    "git branch --delete x", "git branch --copy x", "git branch --force x", "git branch --unset-upstream x",
    "git remote prune origin", "git remote set-branches origin main", "git remote update",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a git ref/remote writer must be write: ${cmd}`)
  }
  for (const cmd of ["git branch", "git branch -v", "git remote", "git remote -v", "git remote get-url origin"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a git listing must be read: ${cmd}`)
  }
  console.log("  ok   git branch and remote write arguments are classified correctly")
}

// 238. find -fprint0 writes a file just like -fprint and -fprintf.
{
  assert.equal(bashApi.commandAccess("find . -fprint0 /tmp/out", true), "write", "fprint0 writes a file")
  assert.equal(bashApi.commandAccess("find . -print0", true), "read", "plain stdout printing stays read")
  console.log("  ok   find -fprint0 is a write, -print0 is not")
}

// 239. The writable:false advice is live: buildSpec still grants /tmp and device paths with no
//      write ceiling, so writeRefusalNote's empty-grant early return does not suppress it.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["cat f"], writable: false } } }),
  })
  const input = { command: "cat f" }
  assert.equal(await h.call("bash", input), undefined, "the reader runs")
  const write = specOf(input.command).write
  assert.ok(write.length > 0, "a writable:false spec still has write paths, so the advice branch is reachable")
  const target = `/var/tmp/pi-extend-${process.pid}/out-239.txt`
  const outcome = await h.result("bash", `error: cannot write '${target}': Permission denied`, true)
  const content: unknown = outcome?.content
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("\n") : ""
  assert.match(text, /ask for bash\.writable: true/, "a role with no write ceiling is told how to get one")
  assert.doesNotMatch(text, /ask for writablePaths/, "and is not asked to extend grants it cannot use")
  h.restore()
  console.log("  ok   a writable:false role still receives the ceiling advice on a write refusal")
}

// 240. Package-manager flags that take a value must not donate that value as the subcommand:
//      `pnpm -C dir list` used to be classified write, so a read-only query burned the write budget.
{
  for (const cmd of [
    "pnpm -C dir list", "pnpm --dir pkgs/a list", "npm --prefix /tmp/x ls", "pnpm -C dir why x",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a read-only query behind a value-taking flag must be read: ${cmd}`)
  }
  for (const cmd of [
    "pnpm -C dir install", "pnpm --dir pkgs/a run typecheck", "npm --prefix /tmp/x run build",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `the real subcommand still decides the verdict: ${cmd}`)
  }
  // The = forms are one token; they must reach the same verdict as the split forms.
  assert.equal(bashApi.commandAccess("pnpm --dir=pkgs/a list", true), "read", "an inline flag value is not the subcommand")
  assert.equal(bashApi.commandAccess("npm --prefix=/tmp/x ls", true), "read", "the npm inline form too")
  console.log("  ok   value-taking package-manager flags no longer hide the subcommand")
}

// 241. config's action token stays decisive: a flag between the program and the action must not
//      change the verdict, and a global flag after the action must not be mistaken for it.
{
  assert.equal(bashApi.commandAccess("pnpm config --global set x y", true), "write", "config set writes even behind --global")
  assert.equal(bashApi.commandAccess("pnpm config get --global registry", true), "read", "config get stays read with --global")
  console.log("  ok   config's second token still decides read vs write around --global")
}

// 242. An unlisted package-manager flag must not turn a read-only query into a write: skip the
//      flag, then trust a located known subcommand, but never guess a read from an unknown token.
{
  for (const cmd of [
    "pnpm --silent list", "pnpm --ignore-workspace list", "pnpm --stream list",
    "yarn --silent list", "pnpm --parallel -r list",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a read-only subcommand after an unknown flag stays read: ${cmd}`)
  }
  for (const cmd of [
    "pnpm --silent run build", "pnpm --stream test", "pnpm --silent install",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a known writer subcommand after an unknown flag stays write: ${cmd}`)
  }
  assert.equal(bashApi.commandAccess("pnpm --mystery-flag dir list", true), "write", "an unknown token after an uncertain flag is not guessed as read")
  console.log("  ok   unlisted flags no longer hide read-only package-manager subcommands")
}

// 243. A quoted global value spanning three or more words used to be split into whitespace
//      fragments; the first bare fragment became the "subcommand" and hid the real verb.
{
  for (const cmd of [
    "git -c k='a b c' reset --hard",
    'git -c k="a b c" reset --hard',
    "git -C '/x y z' clean -fd",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a multi-word quoted global must not hide the verb: ${cmd}`)
  }
  // The quoted value belongs to the -c flag; the verb is log, which only reads.
  assert.equal(
    bashApi.commandAccess("git -c core.pager='less -R' log", true),
    "read",
    "a quoted global value is not the verb; log only reads"
  )
  assert.equal(
    bashApi.requiresNetwork("git -c k='a b c' fetch"),
    "git fetch",
    "the network verb is found behind a multi-word quoted global"
  )
  console.log("  ok   multi-word quoted globals no longer hide the verb from write and network checks")
}

// 244. git's version/help flags only print local information: they are read-only, and an
//      uncertain position behind them used to make the verdict write.
{
  for (const cmd of ["git --version", "git --help", "git -h"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a git version/help flag must be read: ${cmd}`)
  }
  console.log("  ok   git version/help flags are read")
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
      scope: ["."],
      bash: { read: ["git status"], writable: true },
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

