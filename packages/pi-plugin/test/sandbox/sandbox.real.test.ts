// Sandbox refusals: offline network commands and the pre-spawn gate.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, specOf, repo, stateDir, workdir } from "../harness.ts"


// The suite must not write into the developer's real home. Spec files, `git-excludes` and the
// `xdg-cache` tree live in the extension's state directory, so point that at a throwaway one for
// the run. Not `tmpdir()`: the helper mounts a private tmpfs over `/tmp`, so a grant underneath
// it cannot take effect — the helper refuses such a spec (exit 77) and names the tmpfs as the
// cause.
// Redirecting `HOME` instead is too blunt: on CI `cargo` is rustup's shim and tries to create
// `$HOME/.rustup`, which the sandbox refuses because the package directory is not a write grant.
const realState = process.env.PI_SUBAGENTS_EXTEND_STATE
const testState = stateDir(".test-state-")
process.env.PI_SUBAGENTS_EXTEND_STATE = testState

// Cleanup runs on `exit` too, not only on the success path: a failed assertion would otherwise
// leave `.test-state-*` behind as an untracked directory, and pi-subagents' own patch capture
// (`git add -A`) would sweep it into a patch. Both steps are idempotent.
const restoreState = (): void => {
  if (realState === undefined) delete process.env.PI_SUBAGENTS_EXTEND_STATE
  else process.env.PI_SUBAGENTS_EXTEND_STATE = realState
  rmSync(testState, { recursive: true, force: true })
}
process.on("exit", restoreState)
// `exit` does not run on a signal: Ctrl-C during a run would leave the directory behind.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restoreState()
    process.exit(130)
  })
}

// The sandbox helper is a Rust binary. Tests execute the cargo build output and
// never the copy in `bin/`: that copy belongs to a loaded extension, so writing to
// it during a test run would swap the binary out from under a running session —
// `ETXTBSY` at best, a silent behaviour change between calls at worst. An explicit
// override wins, so a stub can be substituted; then the build output; a packaged
// `bin/` copy is the last resort for a checkout with no Rust toolchain.
function resolveHelperBin(): string {
  const candidates = [
    process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH?.trim(),
    join(repo, "..", "helper", "target", "release", "pi-subagents-extend-helper"),
    join(repo, "bin", "pi-subagents-extend-helper"),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    "no sandbox helper found; run `cargo build --release --manifest-path packages/helper/Cargo.toml`",
  )
}
const helperBin = resolveHelperBin()

// These cases inspect the command the extension rewrites and the spec it writes;
// none of them executes the helper, so the kernel's Landlock ABI only decides
// whether bash is offered at all. Where the ABI is below the required 7 the real
// helper refuses bash, and the suite would report a failure that says nothing about
// the extension. Point the environment at a stub instead: enforcement is covered by
// the helper's own cargo tests and by running this suite on a 6.15 or later kernel.
interface HelperDescription {
  landlock?: { kernel_abi?: number; supported?: boolean }
  network_namespace?: boolean
}

function helperAbi(bin: string): HelperDescription | undefined {
  const out = spawnSync(bin, ["--describe"], { encoding: "utf8" });
  try {
    return JSON.parse(out.stdout) as HelperDescription;
  } catch {
    return undefined;
  }
}

const described = helperAbi(helperBin);
// Cases that execute the helper for real need a kernel that can enforce the
// sandbox. With the stub there is nothing to enforce, so those parts are skipped
// instead of asserting on the stub's silence.
if (described?.landlock?.supported) {
  process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = helperBin
} else {
  const stubDir = mkdtempSync(join(tmpdir(), "pi-subagents-extend-stub-"))
  const stub = join(stubDir, "pi-subagents-extend-helper")
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' '{"landlock":{"kernel_abi":7,"required_abi":7,"supported":true,"reason":null},"network_namespace":true,"resolver_sockets":[]}'\n`,
  )
  chmodSync(stub, 0o755)
  process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = stub
  console.log(
    `  note  kernel Landlock ABI ${described?.landlock?.kernel_abi ?? "unknown"} is below the required 7;` +
      " the suite runs against a stub helper that reports ABI 7",
  )
}

// 156 起：离线网络拒绝。判定函数放在共用层，拒绝点放在 bash 判定链里，两处分开钉。
const networkMatcher = (await import(join(repo, "src", "bash/index.ts"))) as unknown as {
	requiresNetwork?: (command: string) => string | null
}
function requiresNetworkOf(command: string): string | null {
	assert.equal(typeof networkMatcher.requiresNetwork, "function", "src/bash-match.ts must export requiresNetwork")
	return (networkMatcher.requiresNetwork as (command: string) => string | null)(command)
}

// 156. 离线时 `curl` 必须在 spawn 之前被拒：裸 netns 是丢包，失败文本根本不会出现，
//      事后注解等不到触发（实测一条挂了 254 秒，父代理手动 kill 才解开）。
{
	assert.equal(requiresNetworkOf("curl https://example.com"), "curl", "the shared matcher names curl")
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				maxDenies: 0,
				bash: { allow: ["curl", "git fetch", "pnpm install", "git status", "rg"], writable: true },
			},
		}),
	})
	const denied = await h.call("bash", { command: "curl https://example.com" })
	assert.equal(denied?.block, true, "an offline curl is refused before the helper starts")
	const text = String(denied?.reason ?? "")
	assert.match(text, /the network is off per the parent's bindings/, "it names the cause")
	assert.match(text, /`curl` would hang here rather than fail/, "it names the tool that would hang")
	assert.match(text, /packets are dropped, not refused/, "it says why there is no failure text to annotate")
	assert.match(text, /contact_supervisor/, "it names the escalation channel")
	assert.match(text, /"network": true/, "it names what the parent can grant")
	assert.match(text, /\(source: /, "it carries the bindings source")
	h.restore()
	console.log("  ok   离线 curl 事前被拒，文案点名工具与授权出路")
}

// 157. `git fetch` 确定要往返：`git` 本身在白名单里，也不能把它的网络子命令一起放过。
{
	assert.equal(requiresNetworkOf("git fetch origin"), "git fetch", "the matcher names the subcommand")
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], maxDenies: 0, bash: { allow: ["git fetch"], writable: true } },
		}),
	})
	const denied = await h.call("bash", { command: "git fetch origin" })
	assert.equal(denied?.block, true, "an offline git fetch is refused")
	assert.match(String(denied?.reason), /`git fetch` would hang here/, "the refusal names git fetch, not just git")
	h.restore()
	console.log("  ok   离线 git fetch 事前被拒，点名到子命令")
}

// 158. 拒绝条件是离线，不是「这条命令看起来像网络」：network: true 必须放行到 helper。
{
	const input = { command: "curl https://example.com" }
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], bash: { allow: ["curl"], network: true } },
		}),
	})
	assert.equal(await h.call("bash", input), undefined, "an online session still allows curl")
	assert.equal(specOf(input.command).offline, false, "the spec keeps the network on")
	h.restore()
	console.log("  ok   network: true 时 curl 放行到 helper")
}

// 159. `pnpm install` / `npm ci` / `cargo fetch` 不是这一层的目标：离线也能从缓存工作，
//      拒了就是误拒（父代理要为一次正常的本地安装去放宽权限，代价远超这条引导）。
{
	for (const command of ["pnpm install", "npm ci", "cargo fetch", "npm run build", "pnpm --dir packages/pi-plugin run typecheck"]) {
		assert.equal(requiresNetworkOf(command), null, `${command} is not a network command: ${command}`)
	}
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				bash: { allow: ["pnpm install", "npm ci", "cargo fetch", "npm run build", "pnpm --dir packages/pi-plugin run typecheck"], writable: true },
			},
		}),
	})
	for (const command of ["pnpm install", "npm ci", "cargo fetch", "npm run build", "pnpm --dir packages/pi-plugin run typecheck"]) {
		assert.equal(await h.call("bash", { command }), undefined, `${command} is not refused offline`)
	}
	h.restore()
	console.log("  ok   离线安装与包脚本不在拒绝名单里")
}

// 160. 纯本地命令不受影响：白名单与路径判定照常走，不因为「名字像工具链」被顺手拒掉。
{
	assert.equal(requiresNetworkOf("git status"), null, "git status is local")
	assert.equal(requiresNetworkOf("rg foo ."), null, "rg is local")
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], bash: { allow: ["git status", "rg"] } },
		}),
	})
	assert.equal(await h.call("bash", { command: "git status" }), undefined, "git status still runs")
	assert.equal(await h.call("bash", { command: "rg foo ." }), undefined, "rg still runs")
	h.restore()
	console.log("  ok   git status 与 rg 照常放行")
}

// 161. 前置赋值要先剥掉再判，否则 `FOO=1 curl` 就从这条引导旁边绕过去了。
{
	assert.equal(requiresNetworkOf("FOO=1 curl https://x"), "curl", "leading assignments are stripped")
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], maxDenies: 0, bash: { allow: ["curl"] } },
		}),
	})
	const denied = await h.call("bash", { command: "FOO=1 curl https://x" })
	assert.equal(denied?.block, true, "an assigned curl is still refused")
	assert.match(String(denied?.reason), /`curl` would hang here/, "the refusal still names curl")
	h.restore()
	console.log("  ok   前置赋值剥掉后仍判出 curl")
}

// 162. 名单按子命令收窄：`git remote -v` / `git submodule update` 只动本地，
//      而 `git remote update` / `git submodule update --remote` 会去网络上取。
//      动态拼出来的程序名不判（`hasUnquotedShellControl` 本来就会拒 `$TOOL`），这是刻意的。
{
	for (const command of ["git remote -v", "git submodule update", "npm run build", "$TOOL https://x"]) {
		assert.equal(requiresNetworkOf(command), null, `${command} is not judged: ${command}`)
	}
	for (const command of ["git remote update", "git submodule update --remote", "docker pull alpine", "npm publish"]) {
		assert.ok(requiresNetworkOf(command), `${command} is judged as network: ${command}`)
	}
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				maxDenies: 0,
				bash: { allow: ["git remote -v", "git submodule update", "git remote update"], writable: true },
			},
		}),
	})
	assert.equal(await h.call("bash", { command: "git remote -v" }), undefined, "local remote listing is allowed")
	assert.equal(await h.call("bash", { command: "git submodule update" }), undefined, "a local submodule update is allowed")
	const denied = await h.call("bash", { command: "git remote update" })
	assert.equal(denied?.block, true, "the network form is refused")
	assert.match(String(denied?.reason), /`git remote update` would hang here/, "the refusal names the exact form")
	h.restore()
	console.log("  ok   子命令口径收窄，动态程序名不猜")
}


// 163. 离线网络拒计入撞权限预算（grant），不占写预算：此前所有网络用例都用 maxDenies: 0，
//      docs/architecture.md 承诺的「计入 collision budget」没有任何用例钉住。
{
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				maxDenies: 2,
				maxWriteDenies: 2,
				bash: { allow: ["curl"] },
			},
		}),
	})
	const first = await h.call("bash", { command: "curl https://x" })
	assert.equal(first?.block, true, "the first offline curl is refused")
	assert.doesNotMatch(String(first?.reason), /in a row/, "refusal 1 is below the warning threshold")
	const second = await h.call("bash", { command: "curl https://y" })
	assert.equal(second?.block, true, "the second offline curl is refused")
	assert.match(String(second?.reason), /Refusal 2 in a row/, "a network refusal charges the collision budget")
	assert.doesNotMatch(String(second?.reason), /Write refusal/, "it is a grant refusal, not a write one")
	const third = await h.call("bash", { command: "curl https://z" })
	assert.equal(third?.terminate, true, "a third network refusal ends the run")
	assert.match(String(third?.reason), /criterion: denial budget/, "the stop names the grant budget")
	h.restore()
	// 写预算分文未动：若网络拒记进写预算，这里会是第 3 次写拒并硬停；直接断言没有停。
	const h2 = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				writeScope: ["src/**"],
				maxDenies: 0,
				maxWriteDenies: 2,
				bash: { allow: ["curl"] },
			},
		}),
	})
	await h2.call("bash", { command: "curl https://x" })
	await h2.call("bash", { command: "curl https://y" })
	const writeDenied = await h2.call("write", { path: "outside/report.md" })
	assert.equal(writeDenied?.block, true, "an out-of-write-scope write is still refused")
	assert.equal(writeDenied?.terminate, undefined, "the first write refusal does not stop: network refusals did not spend the write budget")
	assert.doesNotMatch(String(writeDenied?.reason), /criterion: write budget/, "no write-budget stop text either")
	h2.restore()
	console.log("  ok   离线网络拒计入撞权限预算并硬停，写预算分文未动")
}

// 164. git 的全局旗标排在子命令前，跳过它们才找得到 fetch/pull/push；
//      只认确定的旗标，`git log --fetch` 这类不能被参数里的 --fetch 骗到。
{
	for (const command of [
		"git -C repo fetch",
		"git --git-dir=/x pull",
		"git --git-dir /x push",
		"git --work-tree=/x fetch",
		"git --work-tree /x push",
		"git --no-pager fetch",
		"git --progress -C repo fetch",
		"git -c protocol.version=2 ls-remote origin",
		"git -C repo submodule update --remote",
		"git push /local/path",
	]) {
		assert.ok(requiresNetworkOf(command), `${command} is judged as network: ${command}`)
	}
	for (const command of [
		"git -C repo status",
		"git --git-dir=/x log --fetch",
		"git --work-tree=/x diff",
		"git -c foo=bar status",
		"git --no-pager status",
	]) {
		assert.equal(requiresNetworkOf(command), null, `${command} stays local: ${command}`)
	}
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				maxDenies: 0,
				bash: { allow: ["git"], writable: true },
			},
		}),
	})
	const denied = await h.call("bash", { command: "git -C repo fetch" })
	assert.equal(denied?.block, true, "a fetch behind global flags is refused")
	assert.match(String(denied?.reason), /`git fetch` would hang here/, "the refusal names git fetch")
	assert.equal(await h.call("bash", { command: "git -C repo status" }), undefined, "a local git command still runs")
	h.restore()
	console.log("  ok   git 全局旗标跳过后认出网络子命令，局部子命令仍放行")
}

// 165. 路径前缀与直通包装器都要看穿：`/usr/bin/curl` 和 `env curl` 都不能从名单旁边绕过去；
//      包装器没列出的旗标、查询型的 command -v、引号里的 bash -c 刻意不判。
{
	for (const command of [
		"/usr/bin/curl https://x",
		"env curl https://x",
		"sudo curl https://x",
		"nice curl https://x",
		"timeout 10 curl https://x",
		"command curl https://x",
		"stdbuf curl https://x",
		"env -i X=1 curl https://x",
		"sudo -u bob curl https://x",
		"nice -n 5 curl https://x",
		"timeout -s KILL 10 curl https://x",
		"stdbuf -oL curl https://x",
	]) {
		assert.equal(requiresNetworkOf(command), "curl", `${command} resolves to curl: ${command}`)
	}
	for (const command of [
		"env git status",
		"sudo rg foo .",
		"timeout 10 git status",
		"command -v curl",
		"command -V curl",
		"env --unknown curl https://x",
		'bash -c "curl https://x"',
	]) {
		assert.equal(requiresNetworkOf(command), null, `${command} is not judged: ${command}`)
	}
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				maxDenies: 0,
				bash: { allow: ["env", "git"] },
			},
		}),
	})
	const denied = await h.call("bash", { command: "env curl https://x" })
	assert.equal(denied?.block, true, "a wrapped curl is refused before the helper starts")
	assert.match(String(denied?.reason), /`curl` would hang here/, "the refusal names the inner program")
	assert.equal(await h.call("bash", { command: "env git status" }), undefined, "a wrapped local command still runs")
	h.restore()
	console.log("  ok   绝对路径与直通包装器被看穿，未列出的旗标与引号内容放行")
}

// 166. curl 读本地 file: URL 不出网，放行；带别的 scheme 仍是网络命令。
{
	for (const command of ["curl file:///tmp/x", "curl file:/tmp/x", "curl -o /tmp/y file:///tmp/x"]) {
		assert.equal(requiresNetworkOf(command), null, `${command} reads a local file: ${command}`)
	}
	for (const command of ["curl https://x", "curl http://x", "curl ftp://x", "curl -o file:///tmp/x https://y"]) {
		assert.equal(requiresNetworkOf(command), "curl", `${command} still needs the network: ${command}`)
	}
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				maxDenies: 0,
				bash: { allow: ["curl"] },
			},
		}),
	})
	assert.equal(await h.call("bash", { command: "curl file:///tmp/x" }), undefined, "a local file URL is allowed")
	const denied = await h.call("bash", { command: "curl https://x" })
	assert.equal(denied?.block, true, "an http URL is still refused")
	h.restore()
	console.log("  ok   curl 的 file: URL 放行，其他 scheme 仍拒")
}

// 167. gh 的查询子命令只读本地，照常放行；其余 gh 子命令仍按网络拒。
{
	for (const command of ["gh --version", "gh version", "gh help", "gh config get user.name"]) {
		assert.equal(requiresNetworkOf(command), null, `${command} stays local: ${command}`)
	}
	for (const command of ["gh pr list", "gh repo view", "gh config set user.name x"]) {
		assert.equal(requiresNetworkOf(command), "gh", `${command} needs the network: ${command}`)
	}
	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				maxDenies: 0,
				bash: { allow: ["gh"] },
			},
		}),
	})
	assert.equal(await h.call("bash", { command: "gh --version" }), undefined, "a version query is allowed")
	const denied = await h.call("bash", { command: "gh pr list" })
	assert.equal(denied?.block, true, "a real gh API call is refused")
	assert.match(String(denied?.reason), /`gh` would hang here/, "the refusal names gh")
	h.restore()
	console.log("  ok   gh 的只读查询放行，其余子命令仍拒")
}

// 168. 文档里写明的「接受的误拒」边界：解析 git remote 的 URL 与 nc 的目标主机代价大于收益，
//      这两类仍按网络拒，不引入 URL/host 解析；需要时用更具体的写法或求 network: true。
{
	assert.equal(requiresNetworkOf("git push /local/path"), "git push", "a local push target is still judged")
	assert.equal(requiresNetworkOf("nc -z localhost"), "nc", "a loopback probe is still judged")
	console.log("  ok   两类接受的误拒按文档边界判，不引入 URL/host 解析")
}

// 169. curl 的查询型旗标只输出本地信息就退出，不能按网络命令误拒（与 gh 的查询 carve-out 对齐）；
//      真实的 URL 仍要拒，「would hang here」只对它们为真。
{
	for (const command of ["curl --version", "curl -V", "curl --help", "curl -h"]) {
		assert.equal(requiresNetworkOf(command), null, `${command} only prints local information: ${command}`)
	}
	assert.equal(requiresNetworkOf("curl https://x"), "curl", "a real URL is still judged")

	const h = await handler({
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				maxDenies: 0,
				bash: { allow: ["curl"] },
			},
		}),
	})
	for (const command of ["curl --version", "curl -V", "curl -h"]) {
		assert.equal(await h.call("bash", { command }), undefined, `${command} runs offline: ${command}`)
	}
	const denied = await h.call("bash", { command: "curl https://x" })
	assert.equal(denied?.block, true, "an http URL is still refused")
	assert.match(String(denied?.reason), /`curl` would hang here/, "the hang warning names curl")
	h.restore()
	console.log("  ok   curl 的查询旗标放行，真实 URL 仍按网络拒")
}

// 170. cwd 经前导软链解析进仍会被私有化的目录：提示一次，点名经过的路径、解析后的
//      路径、私有化根与出路。helper 对词法上含 cwd 的目录不挂 tmpfs（should_private_tmp），
//      所以「cwd 直写临时目录之下」是安全的、不许告警；只有这种 realpath 落进去的形状
//      才会让挂载与整棵工作树互相抵消 —— 每条写授权被剔、git 看到空目录，读起来像权限故障。
{
	const root = stateDir("tmp-root-")
	const wt = join(root, "wt")
	mkdirSync(wt, { recursive: true })
	const link = join(workdir, "wt-link")
	rmSync(link, { force: true })
	symlinkSync(wt, link)
	const h = await handler({
		cwd: link,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				bash: { allow: ["git status"], env: { TMPDIR: root } },
			},
		}),
	})
	await h.call("bash", { command: "git status" })
	const notice = h.ui.find((message) => /resolves into a directory that gets a private tmpfs/.test(message))
	assert.ok(notice, "a cwd that resolves into the privatised root warns once")
	assert.ok(notice?.includes(link), "the warning names the path that came through the link")
	assert.ok(notice?.includes(wt), "the warning names the resolved path")
	assert.ok(notice?.includes(root), "the warning names the privatised root")
	assert.match(notice ?? "", /home directory or inside the repository/, "the warning names the remedy")
	// 一次会话只提示一遍：第二条命令不得把同一条告警再说一次。
	await h.call("bash", { command: "git status" })
	assert.equal(
		h.ui.filter((message) => /resolves into a directory that gets a private tmpfs/.test(message)).length,
		1,
		"the warning is one-shot per session",
	)
	h.restore()
	rmSync(link, { force: true })
	rmSync(root, { recursive: true, force: true })
	console.log("  ok   cwd 经软链解析进私有化目录时提示一次，点名路径与出路")
}

// 171. 词法上就在临时目录之下的 cwd 必须保持沉默：helper 对含 cwd 的目录不挂 tmpfs
//      （should_private_tmp），树照常可见、授权照常有效 —— 每棵健康的 /tmp worktree
//      都是这个形状。这条反例钉住「不误报」：这个警告的价值全在它罕见而真。
{
	const plain = mkdtempSync(join(tmpdir(), "pi-subagents-extend-plain-"))
	const h = await handler({
		cwd: plain,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], bash: { allow: ["git status"] } },
		}),
	})
	await h.call("bash", { command: "git status" })
	assert.equal(
		h.ui.find((message) => /resolves into a directory that gets a private tmpfs/.test(message)),
		undefined,
		"a plain cwd under the temp dir must not warn: the helper deliberately skips the mount when the cwd is lexically inside the dir (should_private_tmp), so the tree stays visible and this session is healthy",
	)
	h.restore()
	rmSync(plain, { recursive: true, force: true })
	console.log("  ok   词法在临时目录之下的 cwd 不告警（helper 刻意不挂，树仍可见）")
}
