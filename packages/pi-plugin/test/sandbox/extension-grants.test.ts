import assert from "node:assert/strict"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import type {
  CommandSpec,
  EventHandler,
  FakeExtensionApi,
  Outcome,
  SessionContext,
} from "../types.ts"
import { handler, writeAgentMd, childSystemPrompt, specOf, liveSandbox, workdir, ext } from "../harness.ts"
import { restoreState } from "../support.ts"

// 22. Worktree ergonomics: writablePaths, env injection, and a worktree root that is NOT granted.
{
  const store = join(workdir, "pnpm-store")
  mkdirSync(store, { recursive: true })
  const wt = join(workdir, "wt")
  mkdirSync(join(wt, "web/src"), { recursive: true })
  // A worktree has .git as a file pointing at the real gitdir.
  writeFileSync(join(wt, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n")
  writeFileSync(join(wt, "mise.toml"), "[tools]\nnode = \"lts\"\n")

  const h = await handler({
    cwd: join(wt, "web"),
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: {
          write: ["pnpm install"],
          writable: true,
          writablePaths: [store],
          env: { FOO: "bar" },
        },
      },
    }),
  })
  const input = { command: "pnpm install" }
  assert.equal(await h.call("bash", input), undefined, "listed command passes")
  const spec = specOf(input.command)
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/wt/web/src")),
    `scope dir inside the worktree is writable, got: ${spec.write.join(", ")}`,
  )
  assert.ok(
    !spec.write.some((dir) => dir.endsWith("/wt")),
    `the worktree root itself is not writable (only the write scope is), got: ${spec.write.join(", ")}`,
  )
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/pnpm-store")),
    `writablePaths are writable, got: ${spec.write.join(", ")}`,
  )
  assert.equal(spec.env.FOO, "bar", "bash.env is injected")
  assert.match(
    spec.env.MISE_STATE_DIR ?? "",
    /mise$/,
    "mise state moves off the read-only root so trust registration is not needed",
  )
  assert.match(spec.env.XDG_RUNTIME_DIR ?? "", /runtime$/, "pnpm's runtime lock dir moves off the read-only root")
  h.restore()
  console.log("  ok   worktree 场景：writablePaths、env 注入、worktree 根不整体授权、mise 信任绕过")
}


// 24. /permission reports the writable paths and the pnpm store probe.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["pnpm run typecheck"], writable: true, writablePaths: ["/tmp"] },
      },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.match(text, /Sandbox writable paths/, "the command lists the writable paths")
  assert.match(text, /pnpm store/, "the command probes the pnpm store")
  h.restore()
  console.log("  ok   /permission 列出可写路径并探测 pnpm store")
}

// 25. A denied bash command carries the pnpm store path, so the model can report it.
{
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["pnpm run typecheck"] }, maxDenies: 0 },
    }),
  })
  const denied = await h.call("bash", { command: "pnpm install" })
  assert.equal(denied?.block, true, "unlisted command is denied")
  assert.match(denied.reason, /pnpm store/, "the refusal tells the model where the pnpm store is")
  assert.match(denied.reason, /writablePaths/, "and says how the parent would allow it")
  h.restore()
  console.log("  ok   bash 拒绝文案带上 pnpm store 路径")
}

// 26. node_modules is writable when the sandbox is writable; git excludes keep
// dependency directories out of the index.
{
  mkdirSync(join(workdir, "node_modules", ".bin"), { recursive: true })
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { write: ["pnpm install"], writable: true },
      },
    }),
  })
  const input = { command: "pnpm install" }
  assert.equal(await h.call("bash", input), undefined, "listed command passes")
  const spec = specOf(input.command)
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/node_modules")),
    `node_modules is writable, got: ${spec.write.join(", ")}`,
  )
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/src")),
    `the write scope is writable, got: ${spec.write.join(", ")}`,
  )
  assert.ok(!spec.write.includes(workdir), `the working directory is not writable by default, got: ${spec.write.join(", ")}`)
  assert.equal(spec.env.GIT_CONFIG_COUNT, "1", "git excludes are configured")
  assert.equal(spec.env.GIT_CONFIG_KEY_0, "core.excludesFile", "the exclude key is passed to git")
  assert.match(
    spec.env.GIT_CONFIG_VALUE_0 ?? "",
    /git-excludes$/,
    "the exclude file is readable from the sandbox (read covers all of /)",
  )
  h.restore()
  console.log("  ok   可写沙箱里 node_modules 也可写；git 排除规则防止依赖目录进索引")
}

// 27. The helper gates on kernel support: a kernel below Landlock ABI 7 means no bash.
{
  const fake = join(workdir, "fake-helper")
  writeFileSync(
    fake,
    `#!/bin/sh\necho '{"landlock":{"kernel_abi":3,"required_abi":7,"supported":false,"reason":"kernel Landlock ABI is 3, but ABI 7 is required"},"network_namespace":true,"resolver_sockets":[]}'\nexit 76\n`,
  )
  chmodSync(fake, 0o755)
  const previous = process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH
  process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = fake
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { write: ["pnpm test"] } } }),
  })
  const denied = await h.call("bash", { command: "pnpm test" })
  assert.equal(denied?.block, true, "an unsupported kernel denies bash")
  assert.match(denied.reason, /ABI 7 is required/, "the denial names the ABI the plugin needs")
  h.restore()
  if (previous === undefined) delete process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH
  else process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = previous
  console.log("  ok   内核 ABI 不足时 bash 被拒绝，文案说清缺的版本")
}

/**
 * A child whose policy comes from a role md instead of bindings. The role wiring runs in
 * before_agent_start, which `handler()` never emits, and this suite may only touch this file —
 * so the two events are driven here, mirroring handler()'s activation exactly. `bindings` is
 * the env value verbatim, already in the documented dispatch shape.
 */
interface MdChild {
  call(toolName: string, input?: Record<string, unknown>): Promise<Outcome>
  commands: Record<string, CommandSpec>
  restore(): void
}

async function mdChild({ cwd, prompt, bindings }: { cwd: string; prompt: string; bindings?: string }): Promise<MdChild> {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  if (bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = bindings
  const handlers: Record<string, EventHandler> = {}
  const commands: Record<string, CommandSpec> = {}
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand(name, spec) {
      commands[name] = spec
    },
  }
  ext.activate(api)
  const ctx: SessionContext = { cwd, ui: { notify() {} }, actions: { abort() {} } }
  if (handlers.session_start) await handlers.session_start({ type: "session_start" }, ctx)
  if (handlers.before_agent_start) await handlers.before_agent_start({ type: "before_agent_start", systemPrompt: prompt }, ctx)
  let seq = 0
  return {
    call: async (toolName, input) =>
      (await handlers.tool_call({ type: "tool_call", toolCallId: `t${++seq}`, toolName, input }, ctx)) as Outcome,
    commands,
    restore: () => {
      if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
    },
  }
}

// 28. A role md whose extend block has no scope denies file access (the role does not know the
//     task's paths), but its bash allowlist still applies when the dispatch passes no bindings:
//     the md is the only policy source left.
{
  const proj = join(workdir, "proj-role-md")
  mkdirSync(join(proj, "src"), { recursive: true })
  const body = "Role policy for impl: run the listed commands; report instead of writing files."
  writeAgentMd({ cwd: proj, role: "impl", extend: { permissions: { bash: { allow: ["mise run test"] } } }, body })
  const h = await mdChild({ cwd: proj, prompt: childSystemPrompt("impl", body) })
  const blocked = await h.call("read", { path: "src/a.ts" })
  assert.equal(blocked?.block, true, "a role md without scope denies file access")
  assert.match(blocked.reason, /role md/, "the denial names the role md as the source")
  const input = { command: "mise run test" }
  assert.equal(await h.call("bash", input), undefined, "the md's allowlist applies with no bindings")
  assert.match(input.command, /--spec/, "allowed commands still run under the sandbox")
  const outside = await h.call("bash", { command: "curl https://example.com" })
  assert.equal(outside?.block, true, "commands outside the md allowlist are denied")
  h.restore()
  console.log("  ok   角色 md 默认值：漏传 bindings 时文件全拒、命令只放白名单")
}


// 31. `bash.deny` is a restriction: it applies however the session is configured, and no
//     allowlist re-allows it. The dispatch may carry scope and budgets, but the deny itself
//     lives in the role md.
{
  const proj = join(workdir, "proj-deny")
  const body = "Role policy for review: inspect with git; the deny list is a hard floor."
  writeAgentMd({
    cwd: proj,
    role: "review",
    extend: { permissions: { bash: { allow: ["git diff"], deny: ["git stash", "git checkout"] } } },
    body,
  })
  const h = await mdChild({
    cwd: proj,
    prompt: childSystemPrompt("review", body),
    bindings: JSON.stringify({ "pi-subagents-extend/1": { permissions: { scope: ["src/**"], maxDenies: 0 } } }),
  })
  const stash = await h.call("bash", { command: "git stash" })
  assert.equal(stash?.block, true, "a deny entry from the role md blocks the command")
  assert.match(stash.reason, /blocked by a deny entry/, "the denial says the command is forbidden")
  const checkout = await h.call("bash", { command: "git checkout -- src/a.ts" })
  assert.equal(checkout?.block, true, "deny entries use the same prefix matching")
  h.restore()

  // Without call-side bindings the md's own allowlist survives, so its read entry works.
  const plain = await mdChild({ cwd: proj, prompt: childSystemPrompt("review", body) })
  const diff = await plain.call("bash", { command: "git diff" })
  assert.equal(diff, undefined, "the md's own read entry passes when the call sends no bindings")
  const plainStash = await plain.call("bash", { command: "git stash" })
  assert.equal(plainStash?.block, true, "deny still applies")

  const messages: string[] = []
  await plain.commands.permission.handler("", { cwd: proj, ui: { notify: (m: string) => messages.push(m) } })
  assert.match(messages.join("\n"), /bash deny \(cannot be lifted\)/, "/permission shows the non-overridable list")
  plain.restore()
  console.log("  ok   bash.deny 是硬底线（含 /permission 可见），md 自己的白名单照常生效")
}



// 36. linked worktree：索引与 HEAD 在 worktree 自己的 gitdir 里，ref 与对象在主仓 common dir
//     的 refs / objects / logs 里，两处都得给；hooks 与 config 长在 common dir 根上，所以那里
//     不整目录授权（整目录授权 = 子代理能植入 hook 或改 core.hooksPath，之后以父代理身份执行）。
//     Lab 实测：只给 worktree 时 `git add`/`commit`/`stash`/`switch -c` 全失败在
//     <common>/worktrees/<id>/index.lock 上；再逐个去掉 common 的三个子目录，分别在对象库、
//     ref 锁、reflog 上失败 —— 四个路径都有具体命令在使用。
{
  const gitOk = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
  if (!gitOk) {
    console.log("  skip  linked worktree（环境里没有 git）")
  } else {
    const repoDir = join(workdir, "gitrepo")
    const wtDir = join(workdir, "gitwt")
    mkdirSync(repoDir, { recursive: true })
    const gitEnv = {
      ...process.env,
      HOME: workdir,
      GIT_CONFIG_GLOBAL: join(workdir, "gitconfig"),
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    }
    const git = (...args: string[]): string => {
      const r = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] })
      assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`)
      return r.stdout.trim()
    }
    git("init", "-q", "-b", "main")
    writeFileSync(join(repoDir, "a.txt"), "one\n")
    git("add", "-A")
    git("commit", "-qm", "init")
    git("worktree", "add", "-q", wtDir, "-b", "wtbranch")
    let commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: wtDir, encoding: "utf8", env: gitEnv }).stdout.trim()
    if (!commonDir.startsWith("/")) commonDir = join(wtDir, commonDir)

    const bindings = (writable: boolean): string =>
      JSON.stringify({
        "pi-subagents-extend/1": { scope: ["**"], bash: { [writable ? "write" : "read"]: ["git status"], writable } },
      })

    const h = await handler({ cwd: wtDir, bindings: bindings(true) })
    const input = { command: "git status" }
    assert.equal(await h.call("bash", input), undefined, "a writable sandbox passes the listed command")
    const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: wtDir, encoding: "utf8", env: gitEnv }).stdout.trim()
    // .git 是文件时 rev-parse 给的是 worktree 自己的 gitdir，不是主仓 common dir。
    assert.match(gitDir, /\/worktrees\/[^/]+$/, `the worktree has its own gitdir, got: ${gitDir}`)
    const spec = specOf(input.command)
    assert.ok(
      spec.write.includes(gitDir),
      `the worktree's own gitdir is writable (index.lock / HEAD.lock land there), got: ${spec.write.join(", ")}`,
    )
    for (const name of ["objects", "refs", "logs"]) {
      assert.ok(
        spec.write.includes(join(commonDir, name)),
        `the common ${name} directory is writable, got: ${spec.write.join(", ")}`,
      )
    }
    assert.equal(
      spec.write.includes(commonDir),
      false,
      `the common git dir is not granted wholesale — that is what opens hooks/ and config, got: ${spec.write.join(", ")}`,
    )
    assert.equal(spec.write.includes(join(commonDir, "hooks")), false, "hooks stay out of the grant")
    assert.equal(spec.write.includes(join(commonDir, "config")), false, "the repository config stays out of the grant")
    assert.ok(!spec.write.some((d) => d === join(repoDir, "a.txt")), "the main working tree is not granted")
    h.restore()

    // 不只是看 spec：让 helper 真的执行，文件必须真的进索引（修复前会失败在 index.lock）。
    writeFileSync(join(wtDir, "b.txt"), "two\n")
    const live = await handler({
      cwd: wtDir,
      bindings: JSON.stringify({
        "pi-subagents-extend/1": { scope: ["**"], bash: { write: ["git add b.txt"], writable: true } },
      }),
    })
    const liveInput = { command: "git add b.txt" }
    assert.equal(await live.call("bash", liveInput), undefined, "git add is allowlisted")
    if (liveSandbox) {
      const exec = spawnSync("/bin/sh", ["-c", liveInput.command], { cwd: wtDir, encoding: "utf8", env: gitEnv })
      assert.equal(exec.status, 0, `sandboxed git add failed: ${exec.stderr}`)
      const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: wtDir, encoding: "utf8", env: gitEnv })
      assert.match(staged.stdout, /b\.txt/, "the file is really staged inside the sandbox")
    } else {
      console.log("  skip  live git add: no real sandbox on this kernel")
    }
    live.restore()

    // 只读沙箱：父代理明确选了只读树，不因为「git 需要一个可写索引」偷偷放开主仓 .git。
    const ro = await handler({ cwd: wtDir, bindings: bindings(false) })
    const roInput = { command: "git status" }
    assert.equal(await ro.call("bash", roInput), undefined, "read-only passes the listed command")
    assert.equal(
      specOf(roInput.command).write.includes(commonDir),
      false,
      "a read-only sandbox does not get the common git dir",
    )
    ro.restore()

    // 普通仓库：cwd 不再整体授权，所以显式给 <repo>/.git（git add / commit 要写索引与 ref），
    // 但仓库根本身不给 —— 那等于把整个 checkout 打开。
    const plain = await handler({ cwd: repoDir, bindings: bindings(true) })
    const plainInput = { command: "git status" }
    assert.equal(await plain.call("bash", plainInput), undefined, "plain repo passes too")
    assert.equal(
      specOf(plainInput.command).write.some((d) => d.endsWith("/.git")),
      true,
      "a normal repository gets its .git granted",
    )
    plain.restore()
    console.log("  ok   linked worktree 给 gitdir 与 common 的 objects/refs/logs，hooks/config 不给；只读沙箱全不给；普通仓只给 .git")
  }
}
// 101. Regression pin for applyRoleBaseline: a dispatch that declares its own `bash` block used
//      to skip the role md's whole `bash` field — including `deny` — so a caller narrowing the
//      role with `bash: { allow: [...] }` could silently re-allow a banned command. deny is a
//      floor across layers (same contract as mergeConfig): the effective bash is the payload's
//      allowlist plus the md's deny union, and because the deny union is the md contributing,
//      the refusal's source must name the md too.
{
  const proj = join(workdir, "proj-deny-floor")
  const body = "Role policy for review: inspect with git; the deny list is a hard floor."
  writeAgentMd({
    cwd: proj,
    role: "review",
    extend: { permissions: { bash: { allow: ["git diff"], deny: ["git stash"] } } },
    body,
  })
  const h = await mdChild({
    cwd: proj,
    prompt: childSystemPrompt("review", body),
    // The dispatch declares bash and its own allowlist even names the banned command:
    // exactly the payload shape that used to strip the md's deny list.
    bindings: JSON.stringify({
      // `writable: true` so the write-class `git stash` is not refused for a second reason:
      // under the regression the only thing standing between it and execution is the md's deny.
      "pi-subagents-extend/1": { permissions: { scope: ["src/**"], bash: { allow: ["git status", "git stash"], writable: true } } },
    }),
  })
  const stash = await h.call("bash", { command: "git stash" })
  assert.equal(
    stash?.block,
    true,
    "the md's deny entry blocks the command even though the dispatch's own allowlist names it",
  )
  assert.match(stash.reason, /git stash/, "the refusal names the banned command")
  assert.match(stash.reason, /role md/, "the refusal's source names the md: the deny union is the md contributing")
  // The union only adds the md's deny entries; the payload's bash is otherwise intact, so a
  // command only the payload allowlists still passes (the md's bash was not substituted in).
  const status = await h.call("bash", { command: "git status" })
  assert.equal(
    status,
    undefined,
    "the dispatch's own allowlist still authorizes what the md does not deny",
  )
  h.restore()
  console.log("  ok   bash.deny 在 applyRoleBaseline 里也是硬底线：派单声明 bash 不拆 md 禁令")
}




rmSync(workdir, { recursive: true, force: true })
restoreState()
console.log("\npi-subagents-extend 测试通过")
