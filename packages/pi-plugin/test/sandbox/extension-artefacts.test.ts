import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import type {
  Harness,
  SandboxSpec,
} from "../types.ts"
import { handler, specOf, liveSandbox, workdir, stateDir } from "../harness.ts"
import { described, testState } from "../support.ts"

// 47. Build/test artefact directories are derived from what the project uses.
{
  const bindings = (extra: Record<string, unknown>): string =>
    JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { write: ["pnpm test"], writable: true, ...extra } } })
  const grantedIn = (spec: SandboxSpec, ...parts: string[]): boolean => spec.write.some((d: string) => d.endsWith(`/${join(...parts)}`))

  // A Node project: the toolchain is recognised, but its output directory is not
  // created — only granted when the project already has one.
  const nodeRepo = join(workdir, "detect-node")
  mkdirSync(join(nodeRepo, "src"), { recursive: true })
  writeFileSync(join(nodeRepo, "package.json"), '{"name":"x"}\n')
  mkdirSync(join(nodeRepo, "coverage"), { recursive: true })
  writeFileSync(join(nodeRepo, "coverage", "l.txt"), "x\n")

  const h = await handler({ cwd: nodeRepo, bindings: bindings({}) })
  const input = { command: "pnpm test" }
  assert.equal(await h.call("bash", input), undefined, "the listed command passes")
  const spec = specOf(input.command)
  assert.ok(grantedIn(spec, "coverage"), `an existing artefact directory is writable, got: ${spec.write.join(", ")}`)
  assert.ok(!grantedIn(spec, "dist"), "a directory the project does not have is not invented")
  assert.equal(existsSync(join(nodeRepo, "dist")), false, "and nothing is created")
  h.restore()

  // A Rust project: target/ is that toolchain's main output, so it is created —
  // otherwise the first cargo test fails.
  const rustRepo = join(workdir, "detect-rust")
  mkdirSync(join(rustRepo, "src"), { recursive: true })
  writeFileSync(join(rustRepo, "Cargo.toml"), '[package]\nname="x"\n')
  const rust = await handler({ cwd: rustRepo, bindings: bindings({}) })
  const rustInput = { command: "pnpm test" }
  assert.equal(await rust.call("bash", rustInput), undefined, "the command passes in the rust repo")
  assert.ok(grantedIn(specOf(rustInput.command), "target"), "target/ is granted from Cargo.toml")
  assert.ok(existsSync(join(rustRepo, "target")), "and created, so the first run works")
  rust.restore()

  // A monorepo: a manifest one level down is found, and its directories resolve
  // next to that manifest rather than at the repository root.
  const mono = join(workdir, "detect-mono")
  mkdirSync(join(mono, "packages", "web", "coverage"), { recursive: true })
  writeFileSync(join(mono, "packages", "web", "package.json"), '{"name":"web"}\n')
  const mh = await handler({ cwd: mono, bindings: bindings({}) })
  const mInput = { command: "pnpm test" }
  assert.equal(await mh.call("bash", mInput), undefined, "the command passes in the monorepo")
  assert.ok(
    grantedIn(specOf(mInput.command), "packages", "web", "coverage"),
    `a nested project's artefacts are granted next to its manifest, got: ${specOf(mInput.command).write.join(", ")}`,
  )
  mh.restore()

  // Explicit override: false turns detection off, an array appends and creates.
  const off = await handler({ cwd: nodeRepo, bindings: bindings({ scratchPaths: false }) })
  const offInput = { command: "pnpm test" }
  assert.equal(await off.call("bash", offInput), undefined, "the command still passes")
  assert.ok(
    !specOf(offInput.command).write.some((d) => d.endsWith("/coverage")),
    `scratchPaths: false disables detection, got: ${specOf(offInput.command).write.join(", ")}`,
  )
  off.restore()

  const extra = await handler({ cwd: nodeRepo, bindings: bindings({ scratchPaths: ["out/generated"] }) })
  const extraInput = { command: "pnpm test" }
  assert.equal(await extra.call("bash", extraInput), undefined, "the command passes with extras")
  const extraSpec = specOf(extraInput.command)
  assert.ok(grantedIn(extraSpec, "out", "generated"), "an explicit scratch path is granted on top of detection")
  assert.ok(grantedIn(extraSpec, "coverage"), "detection still applies alongside it")
  assert.ok(existsSync(join(nodeRepo, "out", "generated")), "and is created")
  extra.restore()
  console.log("  ok   产物目录按项目清单探测；可显式关闭或追加")
}

// 48. /permission reports the artefact directories without creating them.
{
  const repo = join(workdir, "probeonly")
  mkdirSync(join(repo, "src"), { recursive: true })
  writeFileSync(join(repo, "Cargo.toml"), '[package]\nname="x"\n')
  writeFileSync(join(repo, "src", "a.ts"), "x\n")

  const h = await handler({
    cwd: repo,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["pnpm test"], writable: true } },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: repo, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.match(text, /target/, "the command lists the artefact directory")
  assert.equal(existsSync(join(repo, "target")), false, "but looking at the policy does not create it")
  h.restore()
  console.log("  ok   /permission 只报告产物目录，不创建")
}



// 49. A real toolchain can write its own artefacts through the rewritten command.
// Guards: a real sandbox on this kernel, and the toolchain installed.
{
  const liveSandbox = described()?.landlock?.supported === true
  const have = (bin: string): boolean => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  }

  const runLive = async (dir: string, bindings: string, command: string): Promise<import("node:child_process").SpawnSyncReturns<string> | undefined> => {
    const h = await handler({ cwd: dir, bindings })
    const input = { command }
    assert.equal(await h.call("bash", input), undefined, `${command} is allowlisted`)
    const rewritten = input.command
    h.restore()
    if (!liveSandbox) return undefined
    return spawnSync("/bin/sh", ["-c", rewritten], { cwd: dir, encoding: "utf8", env: gitEnv })
  }

  // Rust: `target/` does not exist yet, so the extension has to create and grant it.
  if (have("cargo")) {
    const dir = join(workdir, "live-rust")
    mkdirSync(join(dir, "src"), { recursive: true })
    spawnSync("git", ["init", "-q"], { cwd: dir, env: gitEnv })
    writeFileSync(join(dir, ".gitignore"), "target/\n")
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="x"\nversion="0.1.0"\nedition="2021"\n')
    writeFileSync(join(dir, "src", "lib.rs"), "pub fn add(a:i32,b:i32)->i32{a+b}\n#[test]\nfn t(){assert_eq!(add(1,2),3);}\n")
    spawnSync("git", ["add", "-A"], { cwd: dir, env: gitEnv })
    const out = await runLive(
      dir,
      JSON.stringify({
        "pi-subagents-extend/1": { scope: ["src/**"], bash: { write: ["cargo test"], writable: true } },
      }),
      "cargo test --offline",
    )
    if (out) {
      assert.equal(out.status, 0, `sandboxed cargo test failed: ${out.stderr}`)
      assert.ok(existsSync(join(dir, "target")), "cargo wrote target/ inside the sandbox")
    } else {
      console.log("  skip  live cargo test: no real sandbox on this kernel")
    }
  }

  // Go: writes nothing into the project, so this only proves a real toolchain runs
  // under the sandbox at all. The cache redirect itself is pinned by the spec
  // assertion above: it is not about go failing (it tolerates a read-only cache and
  // reads what the host already has) but about being able to write one — measured
  // 3.5s cold / 51ms warm with the redirect, against 158ms of read-only reuse.
  if (have("go")) {
    const dir = join(workdir, "live-go")
    mkdirSync(dir, { recursive: true })
    spawnSync("git", ["init", "-q"], { cwd: dir, env: gitEnv })
    spawnSync("go", ["mod", "init", "example.com/x"], { cwd: dir, env: gitEnv, encoding: "utf8" })
    writeFileSync(join(dir, "x.go"), "package x\nfunc Add(a, b int) int { return a + b }\n")
    writeFileSync(join(dir, "x_test.go"), 'package x\nimport "testing"\nfunc TestAdd(t *testing.T){ if Add(1,2)!=3 { t.Fatal("no") } }\n')
    spawnSync("git", ["add", "-A"], { cwd: dir, env: gitEnv })
    const out = await runLive(
      dir,
      JSON.stringify({
        "pi-subagents-extend/1": { scope: ["*.go"], bash: { write: ["go test"], writable: true } },
      }),
      "go test ./...",
    )
    if (out) {
      assert.equal(out.status, 0, `sandboxed go test failed: ${out.stderr}`)
      assert.ok(existsSync(join(testState, "xdg-cache")), "the build cache lives in the state directory")
    } else {
      console.log("  skip  live go test: no real sandbox on this kernel")
    }
  }
  console.log("  ok   真实工具链在沙箱里能写出自己的产物（cargo target/、go build cache）")
}


// 56. 元字符判定要看引号：命令最终以 `bash -lc <command>` 执行，单引号内一切惰性，
//      双引号内只有 $ / 反引号 / 反斜杠仍展开。纯文本匹配会连引号内的括号一起拒，
//      dogfooding 时一个子代理因此无法自验 YAML（python3 -c "print(1)" 被拒）。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["python3", "echo", "node"] } },
    }),
  })
  const allowed = async (command: string, why: string): Promise<void> => {
    assert.equal(await h.call("bash", { command }), undefined, why)
  }
  const refused = async (command: string, why: string): Promise<void> => {
    const r = await h.call("bash", { command })
    assert.equal(r?.block, true, why)
    assert.match(r.reason, /metacharacters/, `${why} (names the cause)`)
  }

  // 引号内的控制字符是普通字符，不该被拒
  await allowed('python3 -c "print(1)"', "parentheses inside double quotes are inert")
  await allowed('echo "a|b"', "a pipe inside double quotes is inert")
  await allowed('echo "a; b"', "a semicolon inside double quotes is inert")
  await allowed("echo 'a;b'", "single quotes make everything inert")
  // 单引号内惰性：这等于「允许白名单里的解释器执行任意代码」。这是刻意接受的：
  // 沙箱边界是 Landlock 与命名空间，不是命令文本；解释器能不能用由 profile 决定。
  await allowed("python3 -c 'import os; os.system(\"id\")'", "single quotes are inert even for an interpreter")

  // 引号外的一律拒
  await refused("echo a; b", "an unquoted semicolon is refused")
  await refused("echo a && b", "an unquoted && is refused")
  await refused("echo $(id)", "command substitution is refused")
  await refused('echo "x$(id)"', "command substitution expands inside double quotes too")
  await refused("echo `id`", "a backtick is refused")
  await refused('echo "unclosed', "an unterminated quote is refused")
  h.restore()
  console.log("  ok   元字符判定看引号：引号内惰性放行，引号外与命令替换一律拒")
}

// 57. 打转判据是「同一件事没有进展地重复」：写活动就是进展，计数清零、已发出的 warn 撤掉。
//      dogfooding 实测的误杀：一个 coder 子代理第 3 次跑同一条测试收到 warn，中途改了代码，
//      宽限到期照样被停。写类命令按定义就是改动，因此不再受这条判据约束。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["node test/x.ts"], write: ["pnpm run fix"] },
      },
    }),
  })

  // 写类命令反复执行：每一次都是改动，不算打转
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await h.call("bash", { command: "pnpm run fix" }), undefined, `write-class repeat ${i + 1} runs`)
  }

  // 读类命令之间做一次改动（编辑文件），也不该被判打转
  for (let i = 0; i < 4; i += 1) {
    assert.equal(await h.call("bash", { command: "node test/x.ts" }), undefined, `test run ${i + 1} runs after a change`)
    assert.equal(await h.call("edit", { path: "src/a.ts", content: "x" }), undefined, "the edit between runs is allowed")
  }

  // 对照：没有改动时原地重复，判据照旧生效
  assert.equal(await h.call("bash", { command: "node test/x.ts" }), undefined, "first bare repeat runs")
  assert.equal(await h.call("bash", { command: "node test/x.ts" }), undefined, "second bare repeat runs")
  const warned = await h.call("bash", { command: "node test/x.ts" })
  assert.match(warned?.reason ?? "", /spinning/, "without a change in between, the third repeat still warns")
  h.restore()
  console.log("  ok   打转判据把写活动算作进展；无改动的原地重复照旧拦截")
}

// 54. git 的 hooks 与 config 不能让沙箱子进程写。植入一个 hook、或把 core.hooksPath 改到别处，
//     都会在父代理之后于这个 checkout 里跑 git 时以父代理身份执行 —— 这是从「能写 git 目录」
//     到手「以父代理身份执行」的一步。linked worktree 里 hooks/config 长在 common dir 根上，
//     而 git 真正要写的只有 worktree 自己的 gitdir 与 common 的 objects/refs/logs，所以那两处
//     必须留在授权之外，同时 git add 仍然要能成功。
{
  const gitOk = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
  if (!gitOk) {
    console.log("  skip  git hooks are out of reach（环境里没有 git）")
  } else {
    // 仓库不能放在 tmpdir() 下：spec.write 天然包含 tmpdir()，那里什么都能写，「写不进去」
    // 就永远测不出来。放在项目目录下的临时目录里，跑完删掉。
    const outside = stateDir(".test-git-hooks-")
    try {
      const repoDir = join(outside, "repo")
      const wtDir = join(outside, "wt")
      mkdirSync(repoDir, { recursive: true })
      const gitEnv = {
        ...process.env,
        HOME: outside,
        GIT_CONFIG_GLOBAL: join(outside, "gitconfig"),
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      }
      const git = (...args: string[]): string => {
        const r = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv })
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
      const hookPath = join(commonDir, "hooks", "pre-commit")
      const configPath = join(commonDir, "config")
      const configBefore = readFileSync(configPath, "utf8")
      writeFileSync(join(wtDir, "b.txt"), "two\n")

      // 正控目标单独放在一个只属于它的子目录里：这条用例要钉的是 git 的授权面，
      // 所以写授权用一份两个版本都认的写法（纯路径 → 目录本身），不靠 `**` 的解析。
      const plantedDir = join(wtDir, "planted")
      mkdirSync(plantedDir, { recursive: true })
      const planted = join(plantedDir, "planted.txt")
      writeFileSync(join(wtDir, "write.sh"), "#!/bin/sh\nprintf 'x\\n' > \"$1\"\n")
      const h = await handler({
        cwd: wtDir,
        bindings: JSON.stringify({
          "pi-subagents-extend/1": {
            scope: ["**"],
            writeScope: ["planted"],
            bash: { write: ["git add b.txt", "sh write.sh"], writable: true },
          },
        }),
      })
      // spec 按 toolCallId 存，所以每条命令都要各自经过一次 tool_call。id 必须各不相同：
      // 重复 id 会让前一次调用的 spec 文件在覆盖时被清掉（真 pi 每次调用都是新 id）。
      const sandboxed = async (command: string, toolCallId: string): Promise<string> => {
        const input = { command }
        assert.equal(await h.call("bash", input, toolCallId), undefined, `allowlisted: ${command}`)
        return input.command
      }
      const addCommand = await sandboxed("git add b.txt", "add")
      const controlCommand = await sandboxed(`sh write.sh ${planted}`, "control")
      const hookCommand = await sandboxed(`sh write.sh ${hookPath}`, "hook")
      const configCommand = await sandboxed(`sh write.sh ${configPath}`, "config")
      h.restore()

      // 授权面：hooks 与 config 都不在清单里（否则下面的真实执行只是在验证另一个事实）。
      const spec = specOf(addCommand)
      assert.equal(spec.write.includes(join(commonDir, "hooks")), false, `hooks are outside the grant, got: ${spec.write.join(", ")}`)
      assert.equal(spec.write.includes(configPath), false, `config is outside the grant, got: ${spec.write.join(", ")}`)

      if (liveSandbox) {
        const add = spawnSync("/bin/sh", ["-c", addCommand], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.equal(add.status, 0, `sandboxed git add failed: ${add.stderr}`)
        const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.match(staged.stdout, /b\.txt/, "the file is really staged inside the sandbox")

        // 正控：同一份脚本在授权目录里写得进去。
        const control = spawnSync("/bin/sh", ["-c", controlCommand], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.equal(control.status, 0, `the same script writes inside its granted directory: ${control.stderr}`)
        assert.ok(existsSync(planted), "the positive control really wrote its file")

        const hook = spawnSync("/bin/sh", ["-c", hookCommand], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.notEqual(hook.status, 0, "planting a hook is refused by the kernel")
        assert.match(`${hook.stdout}${hook.stderr}`, /permission denied/i, "the refusal is a permission denial")
        assert.equal(existsSync(hookPath), false, "no hook file was created")

        const config = spawnSync("/bin/sh", ["-c", configCommand], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.notEqual(config.status, 0, "rewriting the repository config is refused")
        assert.equal(readFileSync(configPath, "utf8"), configBefore, "the config is byte-for-byte unchanged")
      } else {
        console.log("  skip  live git hooks/config: no real sandbox on this kernel")
      }
      console.log("  ok   沙箱写不进 worktree 的 .git/hooks 与 config，git add 仍成功")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  }
}

// 55. 文件级 glob 不能把父目录整片打开：旧做法在第一个通配符处截断，于是
//     writeScope ["src/auth/*.ts"] 让整个 src/auth/ 对 bash 可写，["src/*/index.ts"] 让 src/ 可写。
//     Landlock 只能正向授权，所以「授权目录」必须恰好等于「这条 glob 覆盖的范围」：文件级写法
//     展开成实际存在的文件，只有覆盖整棵子树的写法（dir、dir/**）才授权目录本身。
{
  const outside = stateDir(".test-glob-scope-")
  try {
    const authDir = join(outside, "src", "auth")
    const matched = join(authDir, "session.ts")
    const sibling = join(authDir, "notes.md")
    const deepIndex = join(authDir, "index.ts")
    mkdirSync(authDir, { recursive: true })
    writeFileSync(matched, "export {}\n")
    writeFileSync(sibling, "notes\n")
    writeFileSync(deepIndex, "export {}\n")
    writeFileSync(join(outside, "write.sh"), "#!/bin/sh\nprintf 'w\\n' > \"$1\"\n")

    const bindingsFor = (writeScope: string[]): string =>
      JSON.stringify({
        "pi-subagents-extend/1": { scope: ["src/**"], writeScope, bash: { write: ["sh write.sh"], writable: true } },
      })
    const sandboxed = async (h: Harness, command: string): Promise<string> => {
      const input = { command }
      assert.equal(await h.call("bash", input), undefined, `allowlisted: ${command}`)
      return input.command
    }

    // 文件级 glob：只授权匹配到的文件。
    // spec 文件按 pid 共用，每次 tool_call 覆写一次，所以「取 spec」与「真实执行」都要紧跟在
    // 自己那次调用后面 —— 否则拿到的是下一个激活的授权，测的就不是这件事了。
    const fileScoped = await handler({ cwd: outside, bindings: bindingsFor(["src/auth/*.ts"]) })
    const matchedCommand = await sandboxed(fileScoped, `sh write.sh ${matched}`)
    const spec = specOf(matchedCommand)
    const siblingCommand = await sandboxed(fileScoped, `sh write.sh ${sibling}`)
    if (liveSandbox) {
      const write = spawnSync("/bin/sh", ["-c", matchedCommand], { cwd: outside, encoding: "utf8" })
      assert.equal(write.status, 0, `the matched file is writable: ${write.stderr}`)
      assert.equal(readFileSync(matched, "utf8"), "w\n", "the write really landed on the matched file")

      const blocked = spawnSync("/bin/sh", ["-c", siblingCommand], { cwd: outside, encoding: "utf8" })
      assert.notEqual(blocked.status, 0, "a sibling the glob does not match is refused")
      assert.equal(readFileSync(sibling, "utf8"), "notes\n", "and left untouched")
    } else {
      console.log("  skip  live file-glob writes: no real sandbox on this kernel")
    }
    fileScoped.restore()
    assert.equal(spec.write.includes(authDir), false, `the whole src/auth directory is not granted, got: ${spec.write.join(", ")}`)
    assert.equal(spec.write.includes(matched), true, `the file the glob matches is granted, got: ${spec.write.join(", ")}`)
    assert.equal(spec.write.includes(sibling), false, `a sibling the glob does not match is not granted, got: ${spec.write.join(", ")}`)

    // 通配符在中间层：同样不能把 src/ 打开。
    const midScoped = await handler({ cwd: outside, bindings: bindingsFor(["src/*/index.ts"]) })
    const midCommand = await sandboxed(midScoped, `sh write.sh ${deepIndex}`)
    const midSpec = specOf(midCommand)
    midScoped.restore()
    assert.equal(midSpec.write.includes(join(outside, "src")), false, `the whole src directory is not granted, got: ${midSpec.write.join(", ")}`)
    assert.equal(midSpec.write.includes(deepIndex), true, `the nested file the glob matches is granted, got: ${midSpec.write.join(", ")}`)

    // 整棵子树写法照旧授权目录本身：不然新建文件就没法写。
    const subtreeScoped = await handler({ cwd: outside, bindings: bindingsFor(["src/**"]) })
    const fresh = join(authDir, "brand-new.ts")
    const freshCommand = await sandboxed(subtreeScoped, `sh write.sh ${fresh}`)
    const subtreeSpec = specOf(freshCommand)
    if (liveSandbox) {
      const create = spawnSync("/bin/sh", ["-c", freshCommand], { cwd: outside, encoding: "utf8" })
      assert.equal(create.status, 0, `a new file under a subtree glob is writable: ${create.stderr}`)
      assert.ok(existsSync(fresh), "the new file really landed")
    }
    subtreeScoped.restore()
    assert.equal(subtreeSpec.write.includes(join(outside, "src")), true, "a subtree glob grants the directory itself")
    assert.equal(subtreeSpec.write.includes(sibling), false, "and it is the only thing that grants a directory")
    console.log("  ok   文件级 glob 只授权匹配到的文件，子树 glob 仍授权目录（新建文件可用）")
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}


