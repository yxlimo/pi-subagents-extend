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
	assert.ok(spec.env.MISE_STATE_DIR, "MISE_STATE_DIR is set even without a mise.toml in the cwd")
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
	const state = specOf(input.command).env.MISE_STATE_DIR ?? ""
	assert.ok(state.startsWith(`${cache}/`), `mise state lives under the writable cache, got: ${state} (cache: ${cache})`)
	assert.ok(existsSync(state), `the mise state directory really exists, got: ${state}`)
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

// 176. 任意 cwd（含 tmp 目录）都设 MISE_STATE_DIR。
//
// 旧名声称「cwd 有 mise.toml 时仍然有 MISE_STATE_DIR」，但 harness 的 workdir 是
// mkdtemp(tmpdir())，findWorktreeRoot 返回 undefined —— 那条从来没造出 worktree +
// mise.toml 的场景，它的红只是「旧实现不满足 worktree 条件就不设 env」的偶然事实。改成它
// 真正证明的：任意 cwd（含 tmp 目录）都设 MISE_STATE_DIR。
//
// 不补真 worktree fixture：新规则与 cwd 形状无关 —— sandboxEnv 现在连 cwd 形参都没有了，
// 造 worktree 只会增加夹具而不增加判别力。
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
	assert.ok(specOf(input.command).env.MISE_STATE_DIR, "any cwd, a tmp directory included, sets MISE_STATE_DIR")
	h.restore()
	console.log("  ok   任意 cwd（含 tmp 目录）都设置 MISE_STATE_DIR")
}
