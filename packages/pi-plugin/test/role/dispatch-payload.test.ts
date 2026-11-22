// 派单载荷契约：父会话 subagent 调用里带的 extensionBindings 必须真的约束住子会话，
// 且判定结果要沿 subagent 工具结果回到父会话。用 mock 会话分流（父/子按 systemPrompt
// 区分）驱动**真 pi 会话**，断言落在父会话收到的 subagent 工具结果上。
//
//   wrapped：载荷合法（permissions.scope）→ 子代理的越界读被拒，拒因点名
//            extensionBindings，且文件内容不外泄；
//   flat：   旧式平铺载荷（缺 permissions）→ 派单契约直接拒绝，连范围内的读都
//            不该发生，in-scope.txt 的内容不进答案。
//
//   单独跑：node test/dispatch-payload.test.ts（包目录内）

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { piDriver } from "../hosts/pi.ts";
import type { HostRun } from "../hosts/types.ts";
import { loadMockFixture } from "../mock-fixture.ts";
import { startMockLlmFromFixture } from "../mock-llm.ts";
import { stateDir } from "../state-dir.ts";

const PKG_DIR = fileURLToPath(new URL("../..", import.meta.url));
const EXT = join(PKG_DIR, "src", "index.ts");
const FIXTURES = join(PKG_DIR, "test", "fixtures", "mock");
const KEEP = process.env.PI_MOCK_KEEP === "1";
// 真会话要跑两轮（父派单 + 子执行），比单会话的 mock-session 预算放宽一倍。
const TIMEOUT_MS = Number(process.env.PI_MOCK_TIMEOUT_MS ?? 120_000);

/**
 * 临时根。走 test/state-dir.ts 的共享 scratch 约定：有共享 .test-state 时落在那里
 * （受限子代理的写授权覆盖它）；否则退回包目录下的 .test-* 前缀（已 gitignore）。
 */
function tempRoot(prefix: string): string {
	return stateDir(prefix, `.test-${prefix}`);
}

/**
 * 探针工程：in-scope.txt 在范围内，outside/out-of-scope.txt 在范围外。
 * probe-scope 角色只挂本扩展，正文带 probe-scope 以命中场景的子会话谓词。
 */
function makeProject(): string {
	const root = tempRoot("pi-dispatch-");
	writeFileSync(join(root, "in-scope.txt"), "IN-SCOPE-OK\n");
	mkdirSync(join(root, "outside"), { recursive: true });
	writeFileSync(join(root, "outside", "out-of-scope.txt"), "OUT-OF-SCOPE-LEAK\n");
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	writeFileSync(
		join(root, ".pi", "agents", "probe-scope.md"),
		[
			"---",
			"name: probe-scope",
			"description: Scope probe agent for the dispatch payload contract tests",
			"inheritSkills: false",
			"inheritProjectContext: true",
			"tools: read, write",
			`subagentOnlyExtensions: "${EXT}"`,
			"---",
			"",
			"You are probe-scope: do exactly what the task says and quote file contents verbatim.",
			"",
		].join("\n"),
	);
	return root;
}

/** 隔离的 agent 目录：models.json 把 provider `mock` 指到 mock 服务，不碰用户配置。 */
function makeAgentDir(mockUrl: string): string {
	const dir = tempRoot("pi-dispatch-agent-");
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

interface CaseOutcome {
	run: HostRun;
	subagent: { tool?: string; text: string };
}

/** 跑一个场景：起 mock 分流服务 + 临时工程 → 真 pi 会话 → 找父会话的 subagent 结果。 */
async function runCase(fixture: string, prompt: string): Promise<CaseOutcome> {
	const mock = await startMockLlmFromFixture(loadMockFixture(join(FIXTURES, fixture)));
	const project = makeProject();
	const agentDir = makeAgentDir(mock.url);
	let run: HostRun | undefined;
	try {
		run = await piDriver.run({
			project,
			mockUrl: mock.url,
			agentDir,
			prompt,
			timeoutMs: TIMEOUT_MS,
		});
		const subagent = run.toolResults.find((r) => r.tool === "subagent");
		assert.ok(
			subagent,
			`the parent's subagent call produced no tool result — likeliest causes: a leaked PI_* env key stopping pi-subagents from registering its tools, or the session crashed. stderr: ${run.stderr.slice(-800)}`,
		);
		return { run, subagent };
	} finally {
		if (run) await run.stop();
		await mock.stop();
		if (!KEEP) {
			rmSync(project, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	}
}

const HEAD = (text: string): string => `result head: ${JSON.stringify(text.slice(0, 300))}`;

// 1. wrapped：合法派单载荷 → 子代理的越界读被范围拒掉，拒因沿 subagent 结果回到父会话。
{
	const { run, subagent } = await runCase("dispatch-payload-wrapped.yaml", "Go.");
	assert.ok(
		subagent.text.includes("outside the read scope"),
		`the dispatch scope binding must refuse the child's out-of-scope read, and the refusal must travel back to the parent. ${HEAD(subagent.text)} stderr: ${run.stderr.slice(-800)}`,
	);
	assert.ok(
		subagent.text.includes("extensionBindings"),
		`the refusal must name the dispatch payload as its source — an unrelated refusal (e.g. a generic tool error) satisfies the first assertion alone. ${HEAD(subagent.text)} stderr: ${run.stderr.slice(-800)}`,
	);
	assert.equal(
		subagent.text.includes("OUT-OF-SCOPE-LEAK"),
		false,
		`a refused read must not leak the file's content into the child's answer. ${HEAD(subagent.text)} stderr: ${run.stderr.slice(-800)}`,
	);
	assert.ok(
		subagent.text.includes("IN-SCOPE-OK"),
		`positive control: the same payload must PERMIT the in-scope read and its content must reach the parent — without this, a scope that refuses everything (a dead binding) would pass the three assertions above. ${HEAD(subagent.text)} stderr: ${run.stderr.slice(-800)}`,
	);
	console.log("  ok   wrapped 载荷：越界读被拒，拒因点名 extensionBindings，内容不外泄，且范围内读放行并回流");
}

// 2. flat：缺 permissions 的旧式载荷 → 派单契约当场拒绝，子会话连范围读都不该发生。
{
	const { run, subagent } = await runCase("dispatch-payload-flat.yaml", "Go.");
	assert.ok(
		subagent.text.includes('missing "permissions" object'),
		`the flat payload must be refused at dispatch with the missing-permissions complaint. ${HEAD(subagent.text)} stderr: ${run.stderr.slice(-800)}`,
	);
	assert.equal(
		subagent.text.includes("IN-SCOPE-OK"),
		false,
		`a refused dispatch means no child read happened: even in-scope content must not surface. ${HEAD(subagent.text)} stderr: ${run.stderr.slice(-800)}`,
	);
	console.log("  ok   flat 载荷：派单即拒，in-scope 内容也不出现");
}

console.log("dispatch payload tests passed (2 cases)");
