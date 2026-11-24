// 沙箱的端到端覆盖：用真 pi 会话把 bash 沙箱的四种边界各走一遍。
//
// 与 extension.test.ts 的分界：那边用假 pi 测判定函数；这边走真 pi 的
// tool_call → 拦截 → helper 沙箱 → 文件系统，判据落在「盘上到底发生了什么」
// 与工具结果文本，不落在任何内部函数。与 mock-session.test.ts 的分界：
// 那边测范围对路径工具的约束，这边专门补上 bash 沙箱这一块——此前没有任何
// 端到端用例碰它，而模块拆分最先动的就是这些接缝。
//
// 断言在临时工程还活着的时候跑（withSandbox 的回调里），跑完才清理：
// 「盘上有没有那个文件」是这套用例的主要判据，先删盘再断言等于什么都没测。
//
// 三个用例（fixture 与套件一一对应）：
//   1. bash-write-ok          授权内的写命令真的写进盘
//   2. bash-write-outside     授权外的写不落盘，结果点名 [sandbox] 授权
//   3. bash-network           网络命令在 spawn 前被拒，绝不挂住
//
//   单独跑：node test/e2e-bash.test.ts（包目录内）
//   PI_MOCK_KEEP=1 ...       保留临时工程，便于翻会话记录

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMockFixture } from "../mock-fixture.ts";
import { startMockLlmFromFixture } from "../mock-llm.ts";
import { redirectStateDir, stateDir } from "../state-dir.ts";

const PKG_DIR = fileURLToPath(new URL("../..", import.meta.url));
const EXT = join(PKG_DIR, "src", "index.ts");
const FIXTURES = join(PKG_DIR, "test", "fixtures", "mock");
const SDK_DIR = realpathSync(join(PKG_DIR, "node_modules", "@earendil-works", "pi-coding-agent"));
const { RpcClient } = await import(new URL(`file://${join(SDK_DIR, "dist", "index.js")}`).href);
const PI_CLI = join(SDK_DIR, "dist", "cli.js");
const KEEP = process.env.PI_MOCK_KEEP === "1";
const TIMEOUT_MS = Number(process.env.PI_MOCK_TIMEOUT_MS ?? 60_000);
const MARKER = "DONE";
// seed.txt 的内容：case 1 断言沙箱里的 cp 把它原样搬进 out/ok.txt。
const SEED = "SEED-FOR-SANDBOX-WRITE\n";

// 会话内扩展自己的状态目录（沙箱 spec、git-excludes、xdg-cache）也挪出真实 ~/.cache：
// 受限子代理对 ~/.cache 没有写授权，第一条沙箱 bash 就会死在 spec 落盘上。
redirectStateDir("pi-e2e-bash-state-", ".test-e2e-bash-state-");

/**
 * 临时根。走 test/state-dir.ts 的共享 scratch 约定：有共享 .test-state 时落在那里
 * （受限子代理的写授权覆盖它）；否则退回包目录下的 .test-* 前缀（已 gitignore）。
 */
function tempRoot(prefix: string): string {
	return stateDir(prefix, `.test-${prefix}`);
}
/**
 * 探针工程：
 * - seed.txt      被 cp 的源文件（读面是 /，读它不需要授权）
 * - out/          写授权的子树（writeScope: ["out/**"]）
 * - blocked/      授权外、但就在工程根下的目录（case 2 的越界写目标）
 */
function makeProject(): string {
	const root = tempRoot("pi-e2e-bash-");
	writeFileSync(join(root, "seed.txt"), SEED);
	mkdirSync(join(root, "out"), { recursive: true });
	mkdirSync(join(root, "blocked"), { recursive: true });
	return root;
}

/** 隔离的 agent 目录：models.json 把 provider `mock` 指到 mock 服务，不碰用户配置。 */
function makeAgentDir(mockUrl: string): string {
	const dir = tempRoot("pi-e2e-bash-agent-");
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify(
			{
				providers: {
					mock: {
						baseUrl: mockUrl,
						api: "openai-completions",
						apiKey: "mock-key",
						models: [{ id: "mock-1", contextWindow: 128_000, maxTokens: 8192 }],
					},
				},
			},
			null,
			2,
		),
	);
	return dir;
}

/** 派单载荷：读写范围都钉在 out/ 子树上，bash 白名单由各用例给出。 */
function bashPolicy(bash: Record<string, unknown>): Record<string, unknown> {
	return {
		"pi-subagents-extend/1": {
			permissions: {
				scope: ["out/**"],
				writeScope: ["out/**"],
				bash,
			},
		},
	};
}

interface SandboxOutcome {
	results: { tool?: string; text: string }[];
	consumed: number;
	assistantText: string;
	stderr: string;
	project: string;
	/** promptAndWait 的墙钟毫秒数：case 4 用它证明「快速失败，而不是挂住」。 */
	elapsedMs: number;
}

/**
 * 跑一个用例：fixture 脚本 + 沙箱绑定 → 真 pi 会话 → 工具结果与盘上事实。
 * 断言回调执行完（或抛出）才清理临时工程；回调里的磁盘断言因此是有效的。
 */
async function withSandbox(
	{ fixture, bindings, timeoutMs = TIMEOUT_MS }: { fixture: string; bindings: Record<string, unknown>; timeoutMs?: number },
	assertOn: (run: SandboxOutcome) => void,
): Promise<void> {
	const mock = await startMockLlmFromFixture(loadMockFixture(join(FIXTURES, fixture)));
	const project = makeProject();
	const agentDir = makeAgentDir(mock.url);
	const client = new RpcClient({
		cwd: project,
		cliPath: PI_CLI,
		provider: "mock",
		model: "mock-1",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify(bindings),
		},
		args: ["-e", EXT],
	});

	try {
		await client.start();
		const started = Date.now();
		const events = await client.promptAndWait("Go.", undefined, timeoutMs);
		const run: SandboxOutcome = {
			results: toolResults(events),
			consumed: mock.consumed,
			assistantText: assistantText(events),
			stderr: client.getStderr(),
			project,
			elapsedMs: Date.now() - started,
		};
		assertOn(run);
	} finally {
		await client.stop();
		await mock.stop();
		if (!KEEP) {
			rmSync(project, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	}
}

/** 工具结果以 message_end + role=toolResult 到达。 */
type PiPart = { type?: string; text?: string };
type PiEvent = { type?: string; message?: { role?: string; toolName?: string; content?: PiPart[] | string } };

function toolResults(events: PiEvent[] | undefined): { tool?: string; text: string }[] {
	const out: { tool?: string; text: string }[] = [];
	for (const event of events ?? []) {
		if (event?.type !== "message_end") continue;
		const message = event.message;
		if (message?.role !== "toolResult") continue;
		const text = (Array.isArray(message.content) ? message.content : [])
			.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.join("\n");
		out.push({ tool: message.toolName, text });
	}
	return out;
}

function assistantText(events: PiEvent[] | undefined): string {
	const parts: string[] = [];
	for (const event of events ?? []) {
		if (event?.type !== "message_end" || event.message?.role !== "assistant") continue;
		const content = event.message.content ?? [];
		for (const part of Array.isArray(content) ? content : []) {
			if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		}
	}
	return parts.join("\n");
}

/** bash 工具的那条结果；没有就是会话根本没走起来。 */
function bashResult(run: SandboxOutcome): { tool?: string; text: string } {
	const result = run.results.find((r) => r.tool === "bash");
	assert.ok(
		result,
		`the scripted bash call produced no tool result — likeliest causes: the sandbox helper is missing (run pnpm run build:helper) or the session crashed. stderr: ${run.stderr.slice(-800)}`,
	);
	return result;
}

// 1. 授权内的写命令真的写进盘。拒了却报成功（exit 0）、或沙箱悄悄丢掉写入，
//    都会在「盘上有文件且内容正确」这一条上现形。
await withSandbox({ fixture: "bash-write-ok.yaml", bindings: bashPolicy({ allow: ["cp"] }) }, (run) => {
	const result = bashResult(run);
	assert.equal(
		/not in the allowlist|\[sandbox\]|write refusal|network is off/.test(result.text),
		false,
		`an in-scope write must run without any refusal, got: ${JSON.stringify(result.text.slice(0, 300))} stderr: ${run.stderr.slice(-500)}`,
	);
	const written = join(run.project, "out", "ok.txt");
	assert.equal(
		existsSync(written),
		true,
		`the sandboxed cp must leave out/ok.txt on the host — a silently dropped write fails here. result: ${JSON.stringify(result.text.slice(0, 300))} stderr: ${run.stderr.slice(-500)}`,
	);
	assert.equal(readFileSync(written, "utf8"), SEED, "the written file carries the seed's content byte for byte");
	assert.equal(run.consumed, 2, "the run continued to the closing turn");
	assert.match(run.assistantText, new RegExp(MARKER), "and the model got its final turn");
	console.log("  ok   授权内的写命令真的写进盘（out/ok.txt 内容与 seed 一致）");
});

// 2. 授权外的写不落盘。目标是工程根下的 blocked/ 目录（不是系统路径）：
//    Landlock 拒掉 open，cp 以 Permission denied 失败，tool_result 补上
//    「[sandbox] … outside the writes the parent granted」注解点名真实机制。
await withSandbox({ fixture: "bash-write-outside.yaml", bindings: bashPolicy({ allow: ["cp"] }) }, (run) => {
	const escaped = join(run.project, "blocked", "escape.md");
	assert.equal(existsSync(escaped), false, "the write outside the granted scope never lands on disk");
	const result = bashResult(run);
	assert.match(
		result.text,
		/Permission denied/i,
		`the sandbox must actually fail the command (EACCES from Landlock), not let it through. result: ${JSON.stringify(result.text.slice(0, 400))} stderr: ${run.stderr.slice(-500)}`,
	);
	assert.match(
		result.text,
		/\[sandbox\]/,
		`the result carries the sandbox annotation, so the failure is attributed to the write grant. result: ${JSON.stringify(result.text.slice(0, 400))} stderr: ${run.stderr.slice(-500)}`,
	);
	assert.match(
		result.text,
		/outside the writes the parent granted/,
		`the annotation names the real mechanism (the write grant), not a generic error. result: ${JSON.stringify(result.text.slice(0, 400))}`,
	);
	assert.equal(run.consumed, 2, "the run continued past the failed command");
	console.log("  ok   授权外的写不落盘，结果带 [sandbox] 注解点名写授权");
});


// 4. 网络命令快速失败而不是挂住。离线沙箱是裸 netns：包被丢而不是被拒，
//    curl 一旦真被 spawn 就没有任何输出地挂到超时。插件按名单在 spawn 前
//    拒掉它；整条用例的墙钟远小于会话超时——挂住本身就是本用例的失败判据。
{
	const budget = 20_000; // 比默认会话超时短：真挂住时 20s 就大声失败。
	await withSandbox(
		{ fixture: "bash-network.yaml", bindings: bashPolicy({ allow: ["curl"] }), timeoutMs: budget },
		(run) => {
			const result = bashResult(run);
			assert.match(
				result.text,
				/would hang here rather than fail/,
				`the wording must be the pre-spawn network refusal — only that path says "would hang here rather than fail (packets are dropped, not refused)". result: ${JSON.stringify(result.text.slice(0, 400))} stderr: ${run.stderr.slice(-500)}`,
			);
			assert.doesNotMatch(
				result.text,
				/\[sandbox\]/,
				`no [sandbox] annotation: that marker is the post-hoc sandbox-note, which is only appended to a result from a command that actually ran (and failed) inside the sandbox. If it appears here, curl was spawned. result: ${JSON.stringify(result.text.slice(0, 400))}`,
			);
			assert.match(
				result.text,
				/curl/,
				`it names the program it refused to spawn. result: ${JSON.stringify(result.text.slice(0, 400))}`,
			);
			assert.ok(
				run.elapsedMs < budget,
				`the case must finish fast (${run.elapsedMs} ms, budget ${budget} ms) — a hang means curl was spawned into the offline netns instead of being refused pre-spawn`,
			);
			assert.equal(run.consumed, 2, "the run continued past the refusal");
			console.log(`  ok   网络命令 spawn 前被拒，用例 ${run.elapsedMs} ms 完成（预算 ${budget} ms）`);
		},
	);
}

console.log("pi-subagents-extend bash 沙箱端到端测试通过（3 项）");
