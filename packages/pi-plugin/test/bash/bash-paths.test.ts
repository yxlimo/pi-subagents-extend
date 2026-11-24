// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session.
//
// The path candidates a bash command yields, and the working-tree check that
// refuses a command pointing outside the tree.
//   node test/bash-paths.test.ts

import assert from "node:assert/strict"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { handler, workdir, repo } from "../harness.ts"

// pathCandidates 的纯抽取用例（101–107、115）与接线用例（108–114）共用这一个导入。
const bashMatch = (await import(join(repo, "src", "bash/index.ts"))) as unknown as {
  pathCandidates?: (command: string) => string[]
}

function pathCandidates(command: string): string[] {
  assert.equal(typeof bashMatch.pathCandidates, "function", "src/bash-match.ts must export pathCandidates")
  return (bashMatch.pathCandidates as (command: string) => string[])(command)
}


// 101. 绝对路径候选：选项与引号里的碎片不是路径。
{
  assert.deepEqual(
    pathCandidates("rg -a -o 'x' /nix/store/anything"),
    ["/nix/store/anything"],
    "only the absolute path is a candidate: flags and the quoted fragment are not paths",
  )
  console.log("  ok   pathCandidates extracts the absolute path candidate only")
}

// 102. 相对路径也是候选：只认绝对路径的话，最常见的 `rg foo src/index.ts` 写法就漏了。
{
  assert.deepEqual(pathCandidates("rg foo src/index.ts"), ["src/index.ts"], "a relative path is a candidate too")
  console.log("  ok   pathCandidates extracts relative path candidates")
}

// 103. 代码片段不是路径：引号与括号一律跳过 —— 宁可漏放，不许误拒。
{
  assert.deepEqual(
    pathCandidates(`node -e 'require("/nix/store/x")'`),
    [],
    "a quoted code fragment yields no candidate",
  )
  console.log("  ok   pathCandidates skips quoted code fragments")
}

// 104. 动态拼接不是路径：`$DIR` 这类 token 跳过，同一条命令里的静态路径留着。
{
  assert.deepEqual(pathCandidates("rg $DIR /home/x"), ["/home/x"], "a variable reference is skipped, the static path stays")
  console.log("  ok   pathCandidates skips dynamic references")
}

// 105. URL 不是路径：含 `:` 的 token 跳过，否则 `rg foo https://…` 会被当成树外路径而误拒。
{
  assert.deepEqual(pathCandidates("rg foo https://example.com/a"), [], "a URL yields no candidate")
  console.log("  ok   pathCandidates skips URLs")
}

// 106. 引号旁边的路径仍要抽出来：引号只影响切词，不影响路径本身。
{
  const candidates = pathCandidates("rg 'foo bar' ./src/a.ts")
  assert.ok(candidates.includes("./src/a.ts"), "the path next to the quoted fragment is extracted")
  assert.ok(
    candidates.every((candidate) => !candidate.includes("'")),
    `quoted fragments are not candidates, got: ${candidates.join(", ")}`,
  )
  console.log("  ok   pathCandidates extracts the path next to a quoted fragment")
}

// 107. 候选最多 32 个：参数可以很长，全量收集会让判定成本随参数个数漂移。
{
  const many = Array.from({ length: 40 }, (_, index) => `/tmp/p${index}`)
  const candidates = pathCandidates(`rg x ${many.join(" ")}`)
  assert.equal(candidates.length, 32, "at most 32 candidates")
  assert.deepEqual(candidates, many.slice(0, 32), "the first 32 candidates, in order")
  console.log("  ok   pathCandidates caps the candidate list at 32")
}

// 108. 只读类 bash 指向树外绝对路径要拒：文案点名路径、说清撞的是工作树，
//      并且说这是提醒不是墙 —— 模型要知道自己该改路径，而不是以为整条命令被禁。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  const outside = "/home/other-notes"
  const denied = await h.call("bash", { command: `rg foo ${outside}` })
  assert.equal(denied?.block, true, "the command pointing outside the tree is refused")
  assert.match(denied.reason, /is outside the working tree/, "the refusal names the working tree")
  assert.doesNotMatch(denied.reason, /read scope/, "the refusal no longer talks about the read scope")
  assert.match(denied.reason, /path nudge, not a wall/, "the refusal says it is a nudge, not a wall")
  assert.ok(denied.reason.includes(outside), `the refusal names the path verbatim, got: ${denied.reason}`)
  h.restore()
  console.log("  ok   bash outside the tree is refused with a nudge message")
}

// 109. 树内路径照旧放行：这条是正控，防止「一律拒绝」也能过上一条。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["rg"] } },
    }),
    cwd: workdir,
  })
  const inside = join(workdir, "src", "auth", "notes.txt")
  writeFileSync(inside, "x\n")
  assert.equal(await h.call("bash", { command: "rg foo src/auth/notes.txt" }), undefined, "a relative in-tree path passes")
  assert.equal(await h.call("bash", { command: `rg foo ${inside}` }), undefined, "an absolute in-tree path passes")
  h.restore()
  console.log("  ok   bash inside the tree still passes")
}

// 110. 工具链目录不再是豁免集：`/nix/store` 作为参数指向树外，要拒。
//      豁免集收窄成设备与系统信息（/etc、/proc、/dev、/sys）之后，工具链目录回到了「树外」这一侧。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  const denied = await h.call("bash", { command: "rg foo /nix/store/anything" })
  assert.equal(denied?.block, true, "a toolchain path passed as an argument is refused")
  assert.match(denied.reason, /is outside the working tree/, "the refusal names the working tree")
  assert.ok(denied.reason.includes("/nix/store/anything"), `the refusal names the offending argument, got: ${denied.reason}`)
  h.restore()
  console.log("  ok   工具链目录不再豁免：作为参数的 /nix/store 路径被拒")
}

// 111. 引号里的代码片段不误拒：跳过规则生效时，`node -e 'require("/home/other/x")'` 照旧放行。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], writeScope: ["src/**"], bash: { allow: ["node"] } },
    }),
    cwd: workdir,
  })
  assert.equal(
    await h.call("bash", { command: `node -e 'require("/home/other/x")'` }),
    undefined,
    "a path quoted inside code is not a candidate, so the command passes",
  )
  h.restore()
  console.log("  ok   quoted code fragments do not trigger the working-tree path check")
}


// 113. 裸相对路径带斜杠、解析后落在树外：必须拒。
//      斜杠是「路径」与「裸词/包名」在文本上唯一稳定的分界，所以 `escape-link/x` 这种
//      相对写法也是候选：cwd 下有 escape-link -> 树外目录时，它能读到树外（真实逃逸形态）。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  // 指向树外目录的软链：它在 cwd 之下，解析后却在树外。
  const link = join(workdir, "escape-link")
  symlinkSync(dirname(repo), link)
  const denied = await h.call("bash", { command: "rg foo escape-link/x" })
  assert.equal(denied?.block, true, "a relative path with a slash that resolves outside the tree is refused")
  assert.match(denied.reason, /is outside the working tree/, "the refusal names the working tree")
  assert.doesNotMatch(denied.reason, /read scope/, "the refusal no longer talks about the read scope")
  assert.match(denied.reason, /path nudge, not a wall/, "the refusal says it is a nudge, not a wall")
  assert.ok(denied.reason.includes("escape-link/x"), `the refusal names the offending argument, got: ${denied.reason}`)
  // 另一条逃逸形态：`..` 抬出 cwd。
  const up = await h.call("bash", { command: "rg foo ../outside/x" })
  assert.equal(up?.block, true, "a relative path that climbs out of the tree is refused")
  h.restore()
  rmSync(link, { force: true })
  console.log("  ok   relative paths with a slash that resolve outside the tree are refused")
}

// 114. 正向控制：树内的相对路径（带斜杠）照旧放行 —— 上一条的对照组。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["rg"] } },
    }),
    cwd: workdir,
  })
  mkdirSync(join(workdir, "src", "nested"), { recursive: true })
  writeFileSync(join(workdir, "src", "nested", "a.ts"), "x\n")
  assert.equal(
    await h.call("bash", { command: "rg foo src/nested/a.ts" }),
    undefined,
    "an in-tree relative path with a slash passes",
  )
  h.restore()
  console.log("  ok   in-tree relative paths with a slash still pass")
}

// 115. 没有斜杠的裸词不是路径候选：`foo`、`pattern` 不收；包名（`@scope`、`@scope/pkg`）也不收 ——
//      全收只是噪声，还会把 32 个候选的额度挤掉。
{
  assert.deepEqual(pathCandidates("rg foo"), [], "a bare word is not a candidate")
  assert.deepEqual(pathCandidates("rg pattern"), [], "a search pattern is not a candidate")
  assert.deepEqual(pathCandidates("rg @scope"), [], "a package scope without a slash is not a candidate")
  assert.deepEqual(pathCandidates("rg @scope/pkg"), [], "a package spec is not a candidate")
  console.log("  ok   pathCandidates skips words without a slash")
}

// 116. PR 的动机案例：参数指向工具链包体必须拒。
//      实测有一个子代理在 258MB 的包体里 rg 了 140 次，全部为空 —— 那些路径参数每次都指向
//      工具链而不是任务。工具链不再是豁免集的一员，这类参数要回到工作树这一侧。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  const denied = await h.call("bash", { command: "rg -a -o 'x' /nix/store/anything" })
  assert.equal(denied?.block, true, "the command pointing into the toolchain store is refused")
  assert.match(denied.reason, /is outside the working tree/, "the refusal names the working tree")
  assert.doesNotMatch(denied.reason, /read scope/, "the refusal no longer talks about the read scope")
  assert.ok(denied.reason.includes("/nix/store/anything"), `the refusal names the offending argument, got: ${denied.reason}`)
  h.restore()
  console.log("  ok   /nix/store 作为参数被拒（PR 的动机案例）")
}

// 117. 程序位豁免：程序本身写成绝对路径时不算参数候选。
//      可执行文件由 bash 经 PATH 解析，本来就不进参数表；把程序写成绝对路径时，那是在执行
//      工具，不是在工具链目录里翻东西。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["re:/nix/store/[^ ]+/bin/rg .+"] } },
    }),
    cwd: workdir,
  })
  assert.deepEqual(pathCandidates("/nix/store/abc/bin/rg foo"), [], "the program position is not a path candidate")
  assert.equal(
    await h.call("bash", { command: "/nix/store/abc/bin/rg foo" }),
    undefined,
    "a command whose program is an absolute path passes",
  )
  h.restore()
  console.log("  ok   程序位是绝对路径时不算候选，放行")
}

// 118. 判据是工作树，不是读范围：范围比树窄时，树内范围外的路径照旧放行。
//      这与 read 工具不同（read 按范围拒，范围外读不到），差异是有意的：构建要读整棵树，
//      按范围收窄会让一条本来能跑的构建命令死在插件层。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  mkdirSync(join(workdir, "docs"), { recursive: true })
  writeFileSync(join(workdir, "docs", "x.md"), "x\n")
  const read = await h.call("read", { path: "docs/x.md" })
  assert.equal(read?.block, true, "the read tool still refuses a path outside the scope")
  assert.equal(
    await h.call("bash", { command: "rg foo docs/x.md" }),
    undefined,
    "a command may name an in-tree path outside the scope",
  )
  h.restore()
  console.log("  ok   判据是工作树：树内但范围外的路径对 bash 放行")
}

// 119. 设备与系统信息仍豁免：`/etc` 下的路径不是任务文件，是系统状态，放行。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["sed"] } },
    }),
    cwd: workdir,
  })
  assert.equal(
    await h.call("bash", { command: "sed -n '1,5p' /etc/hosts" }),
    undefined,
    "a system information path stays exempt",
  )
  h.restore()
  console.log("  ok   设备与系统信息目录（/etc 等）仍豁免")
}

// 120. 引号包住整个路径时整 token 跳过：已知漏放，钉住现状。
//      抽取按 token 走，引号进了 token 就整个不算路径 —— 里面是什么内容不再判断。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["rg"] } },
    }),
    cwd: workdir,
  })
  assert.deepEqual(pathCandidates('rg foo "/home/other/x"'), [], "a quoted whole token is not a candidate")
  assert.equal(
    await h.call("bash", { command: 'rg foo "/home/other/x"' }),
    undefined,
    "a path wrapped in quotes passes",
  )
  h.restore()
  console.log("  ok   引号包住的整 token 被跳过（已知漏放）")
}

// 121. `~user` 不展开：只有 `~/` 会展开，`~root/...` 被当成树内相对路径 —— 已知缺口，钉住现状。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["rg"] } },
    }),
    cwd: workdir,
  })
  assert.deepEqual(pathCandidates("rg foo ~root/.ssh/id_rsa"), ["~root/.ssh/id_rsa"], "the token is a candidate")
  assert.equal(
    await h.call("bash", { command: "rg foo ~root/.ssh/id_rsa" }),
    undefined,
    "a ~user path is not expanded and resolves inside the tree",
  )
  h.restore()
  console.log("  ok   `~user` 不展开（已知缺口）")
}
rmSync(workdir, { recursive: true, force: true })
console.log("\nbash path tests passed")
