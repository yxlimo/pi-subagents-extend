// Notices: which allowlist entries can never match, and what happens when one
// runs anyway. The rendered texts — session-start warnings, deny-reason hints,
// annotation wording — live in notices-hints.test.ts; this file holds the
// judgement (`unreachableEntries`) and the cases that drive it.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/notices.test.ts

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, repo } from "../harness.ts"

// pathCandidates 的纯抽取用例已随 paths.test.ts 拆走；判定用例与接线用例共用这一个导入。
const bashMatch = (await import(join(repo, "src", "bash/index.ts"))) as unknown as {
  unreachableEntries?: (entries: string[], cwd: string) => UnreachableEntry[]
}

/** `src/bash-match.ts` 判出的「不可达条目」：本文件只用它断言判定结果。 */
interface UnreachableEntry {
  entry: string
  why: string
  fix?: string
  /** cwd 下面所有带 package.json 的目录：多个候选时给不出单一的改法。 */
  candidates?: string[]
  /** 恰好一个候选、但那个包里没有条目点名的脚本时，记下缺的脚本名。 */
  scriptMissing?: string
}

/** 调「不可达条目」判定；导出缺失时给一句可读的失败，而不是 TypeError。 */
function unreachableEntries(entries: string[], cwd: string): UnreachableEntry[] {
  assert.equal(typeof bashMatch.unreachableEntries, "function", "src/bash-match.ts must export unreachableEntries")
  return (bashMatch.unreachableEntries as (entries: string[], cwd: string) => UnreachableEntry[])(entries, cwd)
}

// 122. 授权里写了 `pnpm run typecheck`、工作目录却没有 package.json 时，这条授权永远命中不了：
//      子代理没有 `cd`，它只能自己找一个等价写法。判据是 cwd 本身，改法必须指向真正装着包的
//      目录，并且用这家包管理器自己的旗标 —— 给 npm 建议 `--dir`，那条建议自己就跑不起来。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-"))
  mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
  writeFileSync(join(tree, "packages", "pi-plugin", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))

  const found = unreachableEntries(["pnpm run typecheck"], tree)
  assert.equal(found.length, 1, "an entry whose cwd has no package.json can never match")
  assert.equal(found[0].entry, "pnpm run typecheck", "the entry is reported verbatim")
  assert.match(found[0].why, /no package\.json/, "the reason is the checkable fact, not advice")
  assert.ok(found[0].fix?.includes("--dir"), `the fix uses this manager's own flag, got: ${found[0].fix}`)
  assert.ok(
    found[0].fix?.includes(join("packages", "pi-plugin")),
    `the fix points at the directory that really has a package.json, got: ${found[0].fix}`,
  )
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   cwd 没有 package.json 的包管理器条目判为不可达，改法指回真正的包目录")
}

// 123. 条目自己带包目录旗标时判的是那个目录：它是上一条的对照组 —— 判定看事实，
//      不许把「cwd 没有 package.json」一律当成不可达，否则一条正确的授权会被建议改掉。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-reach-"))
  mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
  writeFileSync(join(tree, "packages", "pi-plugin", "package.json"), "{}")

  assert.deepEqual(
    unreachableEntries(["pnpm --dir packages/pi-plugin run typecheck"], tree),
    [],
    "an entry that names its own package directory is reachable",
  )
  assert.deepEqual(
    unreachableEntries(["npm --prefix=packages/pi-plugin run build"], tree),
    [],
    "the --flag=value form is honoured too",
  )
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   条目自带包目录旗标且目录有 package.json 时判为可达")
}

// 124. `cargo` 条目看 cwd 的 Cargo.toml；条目自己用 `--manifest-path` 指名了包时判不了，
//      跳过不判 —— 猜错方向会让一条本来跑得起来的命令被建议改掉。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-cargo-"))
  const before = unreachableEntries(["cargo test"], tree)
  assert.equal(before.length, 1, "cargo with no Cargo.toml in the cwd can never match")
  assert.match(before[0].why, /no Cargo\.toml/, "the reason names the missing manifest")
  assert.equal(before[0].fix, undefined, "no fix is invented for cargo")
  assert.deepEqual(
    unreachableEntries(["cargo --manifest-path ../helper/Cargo.toml test"], tree),
    [],
    "an entry that names its own manifest is not judged",
  )
  writeFileSync(join(tree, "Cargo.toml"), "[package]\nname = \"x\"\n")
  assert.deepEqual(unreachableEntries(["cargo test"], tree), [], "with a Cargo.toml in the cwd the entry is reachable")
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   cargo 条目看 cwd 的 Cargo.toml；--manifest-path 条目不判")
}

// 125. 程序位写成绝对路径的条目可以静态核对：文件不在，这条授权永远命中不了。
//      对照组是同一函数对着真实存在的文件，防止「一律判不可达」也能过这一条。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-abs-"))
  const missing = join(tree, "missing-tool")
  const present = join(tree, "present-tool")
  writeFileSync(present, "")
  const gone = unreachableEntries([missing], tree)
  assert.equal(gone.length, 1, "an absolute-path entry whose file does not exist can never match")
  assert.equal(gone[0].why, `${missing} does not exist`, "the reason is the fact, with the path in it")
  assert.equal(gone[0].fix, undefined, "no fix is invented for a missing binary")
  assert.deepEqual(unreachableEntries([present], tree), [], "the same entry with an existing file is reachable")
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   绝对路径条目按文件是否存在判定，存在即可达")
}

// 126. 不猜：工作目录语义到处都杂的程序名（git、rg）与 `re:` 正则条目一律不判。
//      误报会让父代理改掉一条本来正确的授权，比漏报糟。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-skip-"))
  assert.deepEqual(
    unreachableEntries(["git status", "rg foo", "re:^git .*", "re:pnpm run .*"], tree),
    [],
    "only entries whose facts can be checked are judged",
  )
  assert.deepEqual(unreachableEntries([], tree), [], "an empty allowlist reports nothing")
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   工具链通用程序名与 re: 条目不判，空列表不报")
}

// 139. `npm`/`pnpm`/`yarn`/`bun` 与 `cargo` 都是**向上**找 manifest：cwd 是仓库里的子目录时，
//      祖先目录里有 manifest 就说明这条命令跑得起来。只看 cwd 会把它误报成不可达，
//      父代理于是去改一条本来没坏的配置 —— 误报比漏报糟。
//      不需要 manifest 的子命令（`pnpm --version`、`pnpm store path`、`npm --help`）本来就能跑，不判。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-upward-"))
	writeFileSync(join(tree, "package.json"), "{}")
	writeFileSync(join(tree, "Cargo.toml"), "[package]\nname = \"x\"\n")
	mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
	const sub = join(tree, "packages", "pi-plugin")
	assert.deepEqual(unreachableEntries(["pnpm test"], sub), [], "pnpm finds the manifest in an ancestor")
	assert.deepEqual(unreachableEntries(["npm run build"], sub), [], "npm finds it the same way")
	assert.deepEqual(unreachableEntries(["cargo test"], sub), [], "cargo finds Cargo.toml the same way")
	// 祖先也没有 manifest：仍然判不可达。
	const bare = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-nomanifest-"))
	assert.equal(unreachableEntries(["pnpm test"], bare).length, 1, "without a manifest anywhere the entry cannot match")
	assert.equal(unreachableEntries(["cargo test"], bare).length, 1, "the same holds for cargo")
	// 本来就不需要 manifest 的子命令：不判。
	assert.deepEqual(unreachableEntries(["pnpm --version"], bare), [], "pnpm --version needs no manifest")
	assert.deepEqual(unreachableEntries(["pnpm store path"], bare), [], "pnpm store path needs no manifest")
	assert.deepEqual(unreachableEntries(["npm --help"], bare), [], "npm --help needs no manifest")
	rmSync(tree, { recursive: true, force: true })
	rmSync(bare, { recursive: true, force: true })
	console.log("  ok   manifest 向上找：子目录里跑得起来；不需要 manifest 的子命令不判")
}

// 140. 多个候选包时给不出可靠的改法：这条授权原本指哪个包只有父代理知道，随便挑一个
//      再给一条 `--dir` 建议，会把命令指到别的包上。候选列表交回去让父代理挑。
//      只有一个候选、但那个包里没有这个脚本时同样不给改法：pnpm 会自己报脚本不存在，
//      那是「脚本不存在」，不是「授权不可达」。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-candidates-"))
	mkdirSync(join(tree, "pkg-a"), { recursive: true })
	mkdirSync(join(tree, "pkg-b"), { recursive: true })
	writeFileSync(join(tree, "pkg-a", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
	writeFileSync(join(tree, "pkg-b", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
	const found = unreachableEntries(["pnpm run typecheck"], tree)
	assert.equal(found.length, 1, "the entry is still reported: there is no manifest anywhere")
	assert.equal(found[0].fix, undefined, "two candidates: no single fix is invented")
	assert.deepEqual(found[0].candidates, ["pkg-a", "pkg-b"], "both candidates are listed instead")
	// 一个候选，但那个包里没有这个脚本：不给改法。
	const single = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-noscript-"))
	mkdirSync(join(single, "pkg-a"), { recursive: true })
	writeFileSync(join(single, "pkg-a", "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }))
	const one = unreachableEntries(["pnpm run typecheck"], single)
	assert.equal(one.length, 1, "the entry is reported")
	assert.equal(one[0].fix, undefined, "no fix is invented when the candidate has no such script")
	assert.deepEqual(one[0].candidates, ["pkg-a"], "the candidate is still listed")
	rmSync(tree, { recursive: true, force: true })
	rmSync(single, { recursive: true, force: true })
	console.log("  ok   多个候选包时给候选列表不给改法；包里没有该脚本时也不给改法")
}

// 141. 绝对路径条目指向构建产物目录时，文件不存在只说明还没构建
//      （`packages/helper/target/release/…` 要等一次 cargo build），不说明授权命中不了。
//      指向普通目录的不存在路径仍然判不可达。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-artifact-"))
	const artifact = join(tree, "packages", "helper", "target", "release", "pi-subagents-extend-helper")
	const plain = join(tree, "packages", "helper", "bin", "pi-subagents-extend-helper")
	assert.deepEqual(unreachableEntries([artifact], tree), [], "an artefact that does not exist yet is not unreachable")
	assert.equal(unreachableEntries([plain], tree).length, 1, "a missing file outside an artefact directory is unreachable")
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   构建产物目录里的缺失文件不判不可达；普通缺失路径照旧判")
}

// 145. 恰好一个候选、但那个包里没有条目点名的脚本时，说「没有候选带这个脚本」，而不是让人
//      去候选里「挑一个」：挑哪一个都跑不通（pnpm 自己报 Command not found）。这是「脚本
//      不存在」，不是「授权不可达」。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-no-script-"))
	mkdirSync(join(tree, "pkg-a"), { recursive: true })
	writeFileSync(join(tree, "pkg-a", "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], writeScope: ["."], bash: { allow: ["pnpm run typecheck"]} } }),
	})
	const found = unreachableEntries(["pnpm run typecheck"], tree)
	assert.equal(found[0]?.fix, undefined, "no fix is invented when the only candidate lacks the script")
	assert.equal(found[0]?.scriptMissing, "typecheck", "the entry carries the missing script name")
	const notices = h.ui.join("\n")
	assert.match(notices, /no candidate has a `typecheck` script/, "the warning says the script is missing")
	assert.doesNotMatch(notices, /pick the one this entry meant/, "and does not send the reader off to pick one")
	assert.equal(await h.call("bash", { command: "pnpm run typecheck" }), undefined, "the entry is allowlisted")
	const noteResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const note = String(noteResult?.content)
	// 句首大写：这条注解里它另起一句，措辞本身与告警那一处相同。
	assert.match(note, /no candidate has a `typecheck` script/i, "the tool-result note says it too")
	assert.doesNotMatch(note, /pick the one this entry meant/, "instead of asking which candidate was meant")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   候选缺该脚本时明说「没有候选带这个脚本」，不让读者去挑")
}

// 146. cwd 是经软链进来的时候，字面祖先链与真实祖先链不是同一棵树。命令跑在**物理**目录里，
//      所以只有真实祖先里的 package.json 算数 —— 只按字面路径上行会漏掉它，一条能跑的命令
//      被判成永远不可达，父代理于是被建议去改一条正确的授权。判据只走解析后的路径。
{
	const real = mkdtempSync(join(tmpdir(), "pi-subagents-extend-realpath-real-"))
	// 软链要指向包**之下一层**（`pkg/deep`），manifest 在 `pkg`：这样字面链上每一级都没有
	// `package.json`，只有真实链查得到。指向包根本身就会失效 —— 那时 `link/package.json`
	// 经软链本身就命中，判据不查真实链也照样通过（实测：那一版用例撤销实现后仍然绿）。
	mkdirSync(join(real, "pkg", "deep", "sub"), { recursive: true })
	writeFileSync(join(real, "pkg", "package.json"), "{}")
	const holder = mkdtempSync(join(tmpdir(), "pi-subagents-extend-realpath-link-"))
	const link = join(holder, "link")
	symlinkSync(join(real, "pkg", "deep"), link)
	assert.deepEqual(
		unreachableEntries(["pnpm test"], join(link, "sub")),
		[],
		"the manifest above the real path makes the entry reachable through the symlink",
	)
	// 对照组：同样的子目录结构，没有软链也没有祖先 manifest 时仍判不可达。
	const bare = mkdtempSync(join(tmpdir(), "pi-subagents-extend-realpath-bare-"))
	mkdirSync(join(bare, "sub"), { recursive: true })
	assert.equal(unreachableEntries(["pnpm test"], join(bare, "sub")).length, 1, "without a manifest anywhere it is still unreachable")
	rmSync(real, { recursive: true, force: true })
	rmSync(holder, { recursive: true, force: true })
	rmSync(bare, { recursive: true, force: true })
	console.log("  ok   软链 cwd：真实祖先里的 manifest 也算；没有 manifest 时照旧判不可达")
}

// 149. 与 146 反方向：字面祖先里有 manifest、真实祖先里没有。工具走 `chdir` 后的**物理**路径，
//      字面链上的那份 manifest 它永远看不到，所以这条授权**确实**跑不起来，必须被报出来。
//      两条链取并集只会把死授权判成可达、永不报告 —— 正是这个判据要防的事。
{
	const repo = mkdtempSync(join(tmpdir(), "pi-subagents-extend-link-lexical-"))
	writeFileSync(join(repo, "package.json"), "{}")
	const outside = mkdtempSync(join(tmpdir(), "pi-subagents-extend-link-real-"))
	mkdirSync(join(outside, "pkg", "deep", "sub"), { recursive: true })
	symlinkSync(join(outside, "pkg", "deep"), join(repo, "link"))
	assert.equal(
		unreachableEntries(["pnpm test"], join(repo, "link", "sub")).length,
		1,
		"a manifest on the lexical chain only is invisible to the tool, so the entry stays unreachable",
	)
	rmSync(repo, { recursive: true, force: true })
	rmSync(outside, { recursive: true, force: true })
	console.log("  ok   只看物理祖先链：字面链上的 manifest 不把死授权洗成可达")
}

// 154. `bun test` 跑的是 bun 自带的运行器：不看 `scripts.test`，连 `package.json` 都不需要。
//      把它判成「没有 manifest 所以永远命中不了」是误报（它在空目录里照样能跑），
//      文案里那句「没有候选带这个脚本」对它就更是假话。
{
	const empty = mkdtempSync(join(tmpdir(), "pi-subagents-extend-bun-test-"))
	assert.deepEqual(unreachableEntries(["bun test"], empty), [], "`bun test` runs without any manifest, so it is never reported")
	assert.equal(unreachableEntries(["bun run test"], empty).length, 1, "but `bun run test` is a package script and still needs one")
	// 旗标不是子命令：`bun --bun test`、`bun test --watch` 跑的仍是自带 runner。
	assert.deepEqual(unreachableEntries(["bun --bun test"], empty), [], "a leading flag does not hide the builtin runner")
	assert.deepEqual(unreachableEntries(["bun test --watch"], empty), [], "and neither does a trailing one")
	rmSync(empty, { recursive: true, force: true })
	console.log("  ok   bun test 不判不可达；bun run test 仍按脚本判")
}

// 155. 注解只能按「这条**命令**需不需要 manifest」归因。宽条目 `pnpm` 会被判成不可达，
//      但它放行的 `pnpm --version` 根本不需要 manifest：失败原因是网络或别的什么，
//      拿「没有 manifest」去解释它是把原因安到了不成立的前提上（误报比漏报糟）。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-wide-entry-"))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], writeScope: ["."], bash: { allow: ["pnpm"] } } }),
	})
	// 正控：条目本身确实被报成不可达，否则「没有注解」证明不了任何事。
	assert.match(h.ui.join("\n"), /can never match/, "the wide entry is reported as unreachable")
	assert.equal(await h.call("bash", { command: "pnpm --version" }), undefined, "the wide entry allowlists it")
	const versionResult = await h.result("bash", "ENETUNREACH: network is unreachable", true)
	const versionText = String(versionResult?.content)
	assert.doesNotMatch(versionText, /"pnpm" cannot work from/, "a command that needs no manifest gets no manifest diagnosis")
	// 对照：同一条条目放行的 `pnpm run build` 确实需要 manifest，注解必须出现。
	assert.equal(await h.call("bash", { command: "pnpm run build" }), undefined, "the same entry allowlists this too")
	const buildResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const buildText = String(buildResult?.content)
	assert.match(buildText, /"pnpm" cannot work from/, "a command that does need one is still explained")
	// P3-7：旗标带值与 bun 的 dlx 都不需要 manifest，不能被当成「需要」。
	assert.deepEqual(unreachableEntries(["bun --cwd /tmp test"], tree), [], "a flag's value is not the subcommand")
	assert.deepEqual(unreachableEntries(["bun x cowsay"], tree), [], "bun's dlx needs no manifest either")
	assert.equal(unreachableEntries(["bun --cwd /tmp run test"], tree).length, 1, "but a script behind the flags still does")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   注解只按命令自身是否需要 manifest 归因；bun 的旗标值与 dlx 也认")
}
