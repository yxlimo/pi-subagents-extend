import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, specOf, workdir, ext } from "../harness.ts"

// 58. A temporary directory outside /tmp has to be privatized, not just granted. The
// extension used to grant os.tmpdir() while the helper only ever mounted a tmpfs on the
// hard-coded /tmp, so a host with TMPDIR set elsewhere got a directory that was writable
// through Landlock with no mount over it: temp files landed on the host, outside the
// sandbox. The spec now names that directory, and the helper mounts on what it names.
{
  const previousTmpdir = process.env.TMPDIR
  const scratch = join(workdir, "scratch-outside-tmp")
  mkdirSync(scratch, { recursive: true })
  process.env.TMPDIR = scratch
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["pnpm run typecheck"] } } }),
  })
  const input = { command: "pnpm run typecheck" }
  assert.equal(await h.call("bash", input), undefined, "a listed command still passes with a custom TMPDIR")
  const spec = specOf(input.command)
  assert.equal(
    spec.tmp,
    scratch,
    "the spec names the directory the command's temp files land in, so the helper puts its tmpfs there",
  )
  assert.ok(spec.write.includes(scratch), "that directory is writable, which is only safe together with the mount above")
  assert.ok(spec.write.includes("/tmp"), "the conventional /tmp stays writable: XDG_RUNTIME_DIR and MISE_STATE_DIR point into it")
  h.restore()
  if (previousTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpdir

  // 没有自定义 TMPDIR 时字段省略：/tmp 本来就是 helper 的默认值，而不带这个字段的 spec
  // 仍能被旧版 helper 解开（它的 spec 解析是 deny_unknown_fields）。
  delete process.env.TMPDIR
  const plain = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["pnpm run typecheck"] } } }),
  })
  const plainInput = { command: "pnpm run typecheck" }
  assert.equal(await plain.call("bash", plainInput), undefined, "listed command passes")
  assert.equal(
    specOf(plainInput.command).tmp,
    tmpdir() === "/tmp" ? undefined : tmpdir(),
    "only a scratch dir that differs from the helper's default is spelled out",
  )
  plain.restore()
  if (previousTmpdir !== undefined) process.env.TMPDIR = previousTmpdir
  console.log("  ok   TMPDIR 不在 /tmp 下时，那个目录也写进 spec 并被私有化；默认值时不写")
}



// 63. 启动前的依赖完整性闸门：有 lockfile 却没有 node_modules/.bin 的目录，构建/测试命令直接失败并点名。
//     代价是每个目录一次 readdir；换来的是第一条构建命令不会在沙箱里自己去装依赖然后卡住。
//     计数归属：它拒的是环境，不是授权 —— 重试也不会变好，所以不进任何预算。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  mkdirSync(join(tree, "web"), { recursive: true })
  writeFileSync(join(tree, "web", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true })

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["."],
        maxDenies: 1,
        bash: { read: ["git status", "rg"], write: ["git commit", "pnpm test", "mise run test", "mkdir docs"] },
      },
    }),
  })
  const first = await h.call("bash", { command: "pnpm test" })
  assert.equal(first?.block, true, "a build is refused while a lockfile directory has no node_modules")
  assert.match(first.reason, /web/, "the refusal names the directory that is missing")
  assert.match(first.reason, /node_modules\/\.bin/, "and names what is missing in it")
  assert.match(first.reason, /contact_supervisor/, "and the way out")
  assert.equal(first.terminate, undefined, "the first refusal does not stop the run")

  // 判别式：授权预算压到 1。若这类拒绝记在预算上，第二次就 warn、第三次就硬停。
  const second = await h.call("bash", { command: "pnpm test" })
  assert.doesNotMatch(String(second?.reason), /in a row/, "an uninstalled dependency is not an authorisation refusal")
  const third = await h.call("bash", { command: "pnpm test" })
  assert.equal(third?.terminate, undefined, "retrying never reaches a hard stop: retrying cannot install anything")

  // git 不受闸门管：它不需要 node_modules，而「先落任务日志再提交」的保树纪律
  // 恰恰在依赖缺失时最要用得上。只读命令同理。
  // 判据是「写类」还是「包管理器」，不是名字里有没有 pnpm：写类但非包管理器的
  // 构建入口（mise run test）与写类命令（mkdir）同样会对着没装好的依赖去跑。
  const mise = await h.call("bash", { command: "mise run test" })
  assert.equal(mise?.block, true, "a write-classified build entry is gated though it is not a package manager")
  const mkdir = await h.call("bash", { command: "mkdir docs" })
  assert.equal(mkdir?.block, true, "so is an ordinary write command")

  const gitRead = await h.call("bash", { command: "git status" })
  assert.notEqual(gitRead?.block, true, "a read-class git command passes the gate")
  const gitWrite = await h.call("bash", { command: "git commit" })
  assert.notEqual(gitWrite?.block, true, "even a write-class git command passes it")
  const readOnly = await h.call("bash", { command: "rg foo" })
  assert.notEqual(readOnly?.block, true, "a read-class non-git command passes too")

  // 包管理器即使被写在 read 列也拦：那条路就是去装依赖。
  const pm = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm typecheck"] } } }),
  })
  const install = await pm.call("bash", { command: "pnpm typecheck" })
  assert.equal(install?.block, true, "a package manager is gated even when the allowlist calls it read-only")
  pm.restore()

  // 补上 .bin 之后立刻可用（目录清单有缓存，缺的那一项每轮重查）。
  mkdirSync(join(tree, "web", "node_modules", ".bin"), { recursive: true })
  const allowed = await h.call("bash", { command: "pnpm test" })
  assert.notEqual(allowed?.block, true, "once every lockfile directory has node_modules/.bin the gate opens")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门：缺 node_modules/.bin 拦构建与包管理器，放行 git 与只读命令，且不占任何预算")
}

// 64. 闸门可以关掉：任务可能只需要读文件，装依赖本就是另一件事。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-off-"))
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: false } },
    }),
  })
  const out = await h.call("bash", { command: "pnpm test" })
  assert.notEqual(out?.block, true, "dependencyGate: false turns the gate off")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门可以关：bash.dependencyGate=false 时不检查")
}

// 65. 只有 package.json 的目录不算依赖根：那可能只是个配置包，永远不会装依赖。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-nolock-"))
  writeFileSync(join(tree, "package.json"), "{}")
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["git status"] } } }),
  })
  const out = await h.call("bash", { command: "git status" })
  assert.notEqual(out?.block, true, "no lockfile means no dependency root, so the gate stays out of the way")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门只认 lockfile：只有 package.json 的目录不触发")
}

// 66. 包装器不能从侧面跳过闸门：`sh -c "pnpm test"`、`env pnpm test` 的载荷里是包管理器，
//     只看第一个词会把它们当成阅读类放过去。反过来，`rg pnpm` 是搜这个词，不该被拦。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-wrap-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["."],
        bash: { read: ["sh", "env", "exec", "rg", "command"], write: ["/usr/bin/pnpm test", "env git commit"] },
      },
    }),
  })
  for (const cmd of ['sh -c "pnpm test"', "env pnpm test", "exec pnpm test", "/usr/bin/pnpm test"]) {
    const out = await h.call("bash", { command: cmd })
    assert.equal(out?.block, true, `the gate sees the package manager through ${cmd}`)
    assert.match(String(out?.reason), /node_modules\/\.bin/, "and refuses for the documented reason")
  }
  const searching = await h.call("bash", { command: "rg pnpm" })
  assert.notEqual(searching?.block, true, "mentioning the word is not invoking it")
  const wrappedSearch = await h.call("bash", { command: 'sh -c "rg pnpm"' })
  assert.notEqual(wrappedSearch?.block, true, "a wrapper does not turn a search into an install")
  const lookup = await h.call("bash", { command: "command -v pnpm" })
  assert.notEqual(lookup?.block, true, "asking whether a tool exists is not running it")
  const gitInWrapper = await h.call("bash", { command: "env git commit" })
  assert.notEqual(gitInWrapper?.block, true, "the git exemption survives a wrapper")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门穿透包装器，但不误伤提到包管理器名字的搜索")
}

// 67. 深度要与工具链探测一致：lockfile 在第二代子目录（apps/web）里同样算依赖根。
//     只查一代的话，标准 monorepo 与「lockfile 在 packages/* 里」的仓库完全逃过闸门。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-depth-"))
  writeFileSync(join(tree, "package.json"), "{}")
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true })
  mkdirSync(join(tree, "apps", "web"), { recursive: true })
  writeFileSync(join(tree, "apps", "web", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"] } } }),
  })
  const out = await h.call("bash", { command: "pnpm test" })
  assert.equal(out?.block, true, "a lockfile one generation deeper is still a dependency root")
  assert.match(String(out?.reason), /apps\/web/, "and the refusal names it")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门看两层：apps/web 这种第二代目录不会漏")
}

// 68. Yarn 2+ 的 PnP 不建 node_modules，装好的凭据是 .pnp.cjs。
//     只认 node_modules/.bin 会把整套 PnP 仓库永久判成「没装」，每条写命令都被拒。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-pnp-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "yarn.lock"), "")
  writeFileSync(join(tree, ".pnp.cjs"), "// pnp\n")
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { write: ["yarn test"] } } }),
  })
  const out = await h.call("bash", { command: "yarn test" })
  assert.notEqual(out?.block, true, "a PnP install counts as installed")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门认 Yarn PnP：.pnp.cjs 等于装好了")
}

// 69. 没人安装的 lockfile 目录可以点名忽略。树上常年躺着 fixtures/ 这种样例工程、或者
//     vendored 了一份样例仓库，一纸没人会去安装的 lockfile 于是把所有写类命令都挡了；
//     只关整道闸门等于把真包也一起交出去。忽略的是目录前缀：按 cwd 解析、对齐目录边界，
//     被忽略的那棵树里第一代与第二代目录都不再贡献拒绝，而名字相近的邻居不算被忽略。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-ignore-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true })
  // 被忽略的样例工程：自己一层和下一代目录都有 lockfile，都没装。
  mkdirSync(join(tree, "fixtures", "sample"), { recursive: true })
  writeFileSync(join(tree, "fixtures", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  writeFileSync(join(tree, "fixtures", "sample", "package-lock.json"), "{}\n")
  // 真包：没人忽略它，它缺安装就应该继续拦。
  mkdirSync(join(tree, "apps", "web"), { recursive: true })
  writeFileSync(join(tree, "apps", "web", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: ["fixtures"] } },
    }),
  })
  const blocked = await h.call("bash", { command: "pnpm test" })
  assert.equal(blocked?.block, true, "a directory nobody ignores still blocks the write")
  assert.match(String(blocked?.reason), /apps\/web/, "and it is still named")
  assert.doesNotMatch(
    String(blocked?.reason),
    /fixtures/,
    "the ignored tree is not named, neither its first nor its second generation",
  )

  // 边界对齐：前缀是目录，不是字符串开头。
  mkdirSync(join(tree, "fixtures-old"), { recursive: true })
  writeFileSync(join(tree, "fixtures-old", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  const neighbour = await h.call("bash", { command: "pnpm test" })
  assert.equal(neighbour?.block, true, "an ignored prefix does not swallow a directory that merely starts the same")
  assert.match(String(neighbour?.reason), /fixtures-old/, "the neighbour outside the prefix is named")

  // 装上真包之后，被忽略的那棵树照旧没装，写类命令应当畅通：这就是这条配置的全部意义。
  mkdirSync(join(tree, "apps", "web", "node_modules", ".bin"), { recursive: true })
  mkdirSync(join(tree, "fixtures-old", "node_modules", ".bin"), { recursive: true })
  const allowed = await h.call("bash", { command: "pnpm test" })
  assert.notEqual(allowed?.block, true, "an uninstalled ignored directory does not block a write once the real ones are installed")
  h.restore()

  // cwd 自己落在被忽略的前缀里（任务被限制在那个样例目录内）同样不查。
  // 这一条只能用**绝对**前缀表达：相对前缀永远在 cwd 之下，包含不了 cwd。
  const inner = await handler({
    cwd: join(tree, "fixtures", "sample"),
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: [join(tree, "fixtures")] } },
    }),
  })
  const atCwd = await inner.call("bash", { command: "pnpm test" })
  assert.notEqual(atCwd?.block, true, "an absolute prefix containing the cwd means nothing is gated")
  inner.restore()

  // 同一个目录，同一份 lockfile，只把前缀换成相对写法：这一次必须被拦。
  // 这条钉住「相对前缀在 cwd 之下」，否则上面那条会被误读成「任意写法都行」。
  const relInner = await handler({
    cwd: join(tree, "fixtures", "sample"),
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: ["fixtures"] } },
    }),
  })
  const relCwd = await relInner.call("bash", { command: "pnpm test" })
  assert.equal(relCwd?.block, true, "a relative prefix cannot contain the cwd, so this one still blocks")
  relInner.restore()

  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门可忽略目录前缀：忽略的树不贡献拒绝，真包照拦，cwd 同样适用")
}

// 81. 闸门的扫描同样停在 200 个目录，而且忽略项写成 glob 会被点名。
//     缺陷一：`dependencyScope` 只有内层 break，外层 frontier 里每个剩余目录还会各推一个子
//     目录，250 个目录的树能得 246 个 root，而文档说的是 200。
//     缺陷二：忽略项是字面路径，`fixtures/*` 静默匹配不到任何目录，正是文档自称要避免的调试题。
{
  // 25 × 10 = 250 个第二代目录，加树根与 25 个第一代目录共 276 个名额，上限 200。
  // 判别点放在 a24/b0：内层 break 一旦在 200 处停住，外层若不断，frontier 里剩下的每个
  // 第一代目录还会各推一个 b0 进来（a18..a24），a24/b0 就落到范围内；外层断了就不会。
  // 所以这里放 lockfile 且不装依赖：上限生效 → 放行，上限失效 → 被拦。名字补零，字典序即自然序。
  // 25 × 10 = 250 个第二代目录，加树根与 25 个第一代目录共 276 个候选名额，上限 200。
  // 直接测扫描结果本身：内层 break 只退出当前目录，外层若不断，frontier 里剩下的每个
  // 第一代目录还会各推一个 b0 进来，总数会变成 207 而不是 200。
  const wide = mkdtempSync(join(tmpdir(), "pi-subagents-extend-cap-"))
  for (let a = 0; a < 25; a += 1) {
    for (let b = 0; b < 10; b += 1) mkdirSync(join(wide, `a${String(a).padStart(2, "0")}`, `b${b}`), { recursive: true })
  }
  const scanned = ext.dependencyScope(wide, [])
  assert.equal(scanned.length, 200, "the scan stops at the 200-directory cap")
  assert.ok(!scanned.includes(join(wide, "a24", "b0")), "and the directories beyond it are not scanned")
  assert.ok(scanned.includes(join(wide, "a00", "b0")), "while the early ones are")
  rmSync(wide, { recursive: true, force: true })

  // glob 写成忽略项：闸门照旧拒绝，但文案要点名它匹配不到任何目录。
  // 必须是「有 lockfile、没装依赖」的目录，闸门才会真的拒绝并给出提示。
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-glob-"))
  mkdirSync(join(tree, "fixtures"), { recursive: true })
  writeFileSync(join(tree, "fixtures", "package.json"), "{}")
  writeFileSync(join(tree, "fixtures", "pnpm-lock.yaml"), "lockfileVersion: 9\n")
  const globH = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: ["fixtures/*"] } },
    }),
  })
  const globbed = await globH.call("bash", { command: "pnpm test" })
  assert.equal(globbed?.block, true, "a glob ignore entry matches nothing, so the gate still refuses")
  assert.match(globbed.reason, /literal paths, not globs/, "and says so instead of leaving it to be discovered")
  assert.match(globbed.reason, /fixtures\/\*/, "naming the entry that did not apply")
  globH.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   闸门扫描封在 200 个目录；忽略项写成 glob 会被点名")
}

// 70. 数组写法不能顺手改掉两个老含义：`false` 仍是整道闸门的开关，显式 `true` 仍是「查全部」。
//     把 false 解析成「空清单」、或把 true 当成清单，闸门都会静默失效或静默全开。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-switch-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")

  const bind = (gate: unknown) =>
    JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: gate } } })

  const off = await handler({ cwd: tree, bindings: bind(false) })
  const unchecked = await off.call("bash", { command: "pnpm test" })
  assert.notEqual(unchecked?.block, true, "false still means check nothing, not an empty ignore list")
  off.restore()

  const on = await handler({ cwd: tree, bindings: bind(true) })
  const checked = await on.call("bash", { command: "pnpm test" })
  assert.equal(checked?.block, true, "explicit true still checks every directory")
  assert.match(String(checked?.reason), /node_modules\/\.bin/, "and refuses for the documented reason")
  on.restore()

  // 空清单是「不忽略任何目录」，不是「不查」：两个含义只差一个词，后果却是闸门全关。
  const empty = await handler({ cwd: tree, bindings: bind([]) })
  const stillChecked = await empty.call("bash", { command: "pnpm test" })
  assert.equal(stillChecked?.block, true, "an empty ignore list still checks every directory")
  empty.restore()

  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门开关没变：false 全不查，true 查全部")
}

// 71. 缺陷：两处广度优先扫描（工具链探测、依赖闸门）都按 readdir 的顺序取前
// DETECT_MAX_ROOTS 个目录，而这个顺序由文件系统决定 —— 这台机器上 tmpfs 给的是排序
// 结果，ext4 的 dir_index、XFS、NFS 给的是哈希序。同一个仓库在两台机器上因此可能扫到
// 不同的目录，闸门在一台机器上放行、在另一台上拒绝，而且没有任何日志能看出差别。
// 磁盘上的顺序在本机造不出来（readdir 已经是有序的），所以这里钉的是比较器本身：
// 扫描用的排序必须是字典序、且不受 locale 影响。
{
  const shuffled = ["mike", "alpha", "zeta", "delta", "Bravo"].map((name) => ({ name }))
  const sorted = ext.sortByName(shuffled).map((entry) => entry.name)
  assert.deepEqual(
    sorted,
    ["Bravo", "alpha", "delta", "mike", "zeta"],
    "the scan sorts by code unit, so the same tree yields the same directories on any filesystem",
  )

  // 排序不能是 localeCompare：在 sv-SE 之类的 locale 下 "zeta" 会排到 "Bravo" 前面，
  // 那样顺序又变成了环境依赖。
  const pairs = ["zeta", "Bravo", "ä", "A"].map((name) => ({ name }))
  assert.deepEqual(
    ext.sortByName(pairs).map((entry) => entry.name),
    ["A", "Bravo", "zeta", "ä"],
    "sorting is not locale-sensitive",
  )
  console.log("  ok   扫描顺序是字典序，不随文件系统与 locale 变化")
}



