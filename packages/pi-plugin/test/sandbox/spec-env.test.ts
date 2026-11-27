import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { handler, specOf, workdir } from "../harness.ts"
import { toolchainCacheDir } from "../../src/sandbox/grants.ts"

// MISE_STATE_DIR 的环境语义：mise 即使在没有 mise.toml 的仓库里也会因为 npm/node/pnpm
// 这些 shim 去登记 tracked-configs（package.json 也算），所以 state 目录必须无条件挪走，
// 不能只看 worktree 根有没有 mise.toml。这里全部走 handler + specOf 的真实装配路径。
//
// 172. 回归本缺陷：cwd 里没有 mise.toml，MISE_STATE_DIR 也必须存在。
{
	const cwd = join(workdir, "spec-env-no-mise")
	mkdirSync(cwd, { recursive: true })
	assert.equal(existsSync(join(cwd, "mise.toml")), false, "the fixture deliberately has no mise.toml")
	const h = await handler({
		cwd,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["**"], writeScope: ["**"], bash: { allow: ["git status"] } },
		}),
	})
	const input = { command: "git status" }
	assert.equal(await h.call("bash", input), undefined, "the listed command passes")
	const spec = specOf(input.command)
	// 断严格值而不是「有值」：只判 truthy 时，把有写授权分支改回私有 tmp（M2）它照样绿，
	// 也分不出「旧实现靠 mise.toml 才设」——本用例的整个意义就是钉住这两点。
	const cache = toolchainCacheDir()
	assert.ok(cache, "the harness redirects the toolchain cache into the test state dir")
	assert.equal(
		spec.env.MISE_STATE_DIR,
		`${cache}/mise-state`,
		`without a mise.toml the state still moves into the writable cache, got: ${spec.env.MISE_STATE_DIR} (cache: ${cache})`,
	)
	h.restore()
	console.log("  ok   没有 mise.toml 的目录也有 MISE_STATE_DIR（mise shim 仍会登记配置）")
}

// 173. 有写授权：state 落在持久的工具链缓存下（与 XDG_CACHE_HOME 同构），目录真的建好。
{
	const cwd = join(workdir, "spec-env-writable")
	mkdirSync(cwd, { recursive: true })
	const cache = toolchainCacheDir()
	assert.ok(cache, "the harness redirects the toolchain cache into the test state dir")
	const h = await handler({
		cwd,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["**"], writeScope: ["**"], bash: { allow: ["git status"] } },
		}),
	})
	const input = { command: "git status" }
	assert.equal(await h.call("bash", input), undefined, "the listed command passes")
	const spec = specOf(input.command)
	const state = spec.env.MISE_STATE_DIR ?? ""
	assert.ok(state.startsWith(`${cache}/`), `mise state lives under the writable cache, got: ${state} (cache: ${cache})`)
	assert.ok(existsSync(state), `the mise state directory really exists, got: ${state}`)
	// 「目录建好了」不等于「沙箱里能写」：真正决定能不能写的是 spec.write。mise 会在
	// mise-state/ 下建 tracked-configs 与 task-history，没人授权它的话目录存在也白搭。
	assert.ok(
		spec.write.some((dir) => state === dir || state.startsWith(`${dir}/`)),
		`a granted write dir covers the mise state dir, got: ${state} in [${spec.write.join(", ")}]`,
	)
	h.restore()
	console.log("  ok   有写授权时 MISE_STATE_DIR 落在 toolchainCacheDir 下且目录已创建")
}

// 174. 无写授权（只读任务）：state 退回私有 /tmp，绝不指向可写缓存。
{
	const cwd = join(workdir, "spec-env-readonly")
	mkdirSync(cwd, { recursive: true })
	const h = await handler({
		cwd,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["**"], writeScope: [], bash: { allow: ["git status"] } },
		}),
	})
	const input = { command: "git status" }
	assert.equal(await h.call("bash", input), undefined, "the listed command passes")
	const state = specOf(input.command).env.MISE_STATE_DIR ?? ""
	const privateMise = `/tmp/.pi-subagents-extend-${process.pid}/mise`
	assert.equal(state, privateMise, `a read-only task uses the private tmp dir, got: ${state}`)
	const cache = toolchainCacheDir()
	assert.ok(cache, "the harness still resolves the toolchain cache")
	assert.ok(!state.startsWith(cache), `a read-only task never points at the cache, got: ${state}`)
	h.restore()
	console.log("  ok   只读任务的 MISE_STATE_DIR 落在私有 tmp 下，不指向 cache")
}

// 175. 父代理显式给的值优先：sandboxEnv 不能覆盖 bash.env 里钉住的路径。
{
	const cwd = join(workdir, "spec-env-parent-pinned")
	mkdirSync(cwd, { recursive: true })
	const pinned = "/tmp/parent-pinned-mise-state"
	const h = await handler({
		cwd,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["**"],
				writeScope: ["**"],
				bash: { allow: ["git status"], env: { MISE_STATE_DIR: pinned } },
			},
		}),
	})
	const input = { command: "git status" }
	assert.equal(await h.call("bash", input), undefined, "the listed command passes")
	assert.equal(specOf(input.command).env.MISE_STATE_DIR, pinned, "the parent's explicit value survives verbatim")
	h.restore()
	console.log("  ok   父代理 bash.env 钉住的 MISE_STATE_DIR 逐字保留")
}

// 176. cwd 里有 mise.toml 时同样设 MISE_STATE_DIR（旧的触发条件不回归）。
//
// 这条**不能**分辨新旧实现：旧实现恰恰只在有 mise.toml 时才设，所以它在旧实现下也绿。
// 它现在的价值是防止有人把整段 env 设置删掉，而「没有 mise.toml 也必须设」由 172 钉住。
//
// 上一版把它改名成「任意 cwd（含 tmp 目录）都设」，与夹具不符：夹具在 cwd 里写了 mise.toml
// （见下面的 writeFileSync），声称测「任意 cwd」就抓不到「依赖 mise.toml」这一类回归。
{
	const cwd = join(workdir, "spec-env-with-mise")
	mkdirSync(cwd, { recursive: true })
	writeFileSync(join(cwd, "mise.toml"), "[tools]\nnode = 'lts'\n")
	const h = await handler({
		cwd,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["**"], writeScope: ["**"], bash: { allow: ["git status"] } },
		}),
	})
	const input = { command: "git status" }
	assert.equal(await h.call("bash", input), undefined, "the listed command passes")
	assert.ok(specOf(input.command).env.MISE_STATE_DIR, "a cwd with a mise.toml still gets MISE_STATE_DIR")
	h.restore()
	console.log("  ok   有 mise.toml 的 cwd 同样设置 MISE_STATE_DIR（旧触发条件不回归）")
}
