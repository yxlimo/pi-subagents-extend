// 预算与工具闸门的真会话覆盖：mock-session.test.ts 的 fixture 变体。
//
// 模块拆分会从这两条缝上切过去，今天却没有任何真会话碰过它们：
// - allowTools 闸门（fail closed 的放行/拒绝两支路）；
// - 两个拒绝预算（deny 与 write），它们各自的警告/停机节拍与相互独立。
//
// 与 mock-session.test.ts 的分界：那边已经钉住「两次越界 → 硬停」主链路，脚本
// 内联在用例里；这里每个用例一份 YAML fixture（test/fixtures/mock/budget-*.yaml），
// 经 loadMockFixture 装载。断言落在模型真正看到的工具结果上，轮次判据是 mock
// 收到的请求数（requests.length：耗尽后的多余额请求不会被计入 consumed）。
//
//   套件里跑（package.json test 串）；单独跑：node test/e2e-budgets.test.ts（包目录内）
//   PI_MOCK_KEEP=1 ...        保留临时工程，便于翻会话记录

import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMockFixture } from "../mock-fixture.ts";
import { startMockLlmFromFixture } from "../mock-llm.ts";
import { stateDir } from "../state-dir.ts";

const PKG_DIR = fileURLToPath(new URL("../..", import.meta.url));
const EXT = join(PKG_DIR, "src", "index.ts");
const FAKE_TOOLS = join(PKG_DIR, "test", "fixtures", "fake-tools.ts");
const FIXTURES = join(PKG_DIR, "test", "fixtures", "mock");
const SDK_DIR = realpathSync(join(PKG_DIR, "node_modules", "@earendil-works", "pi-coding-agent"));
const { RpcClient } = await import(new URL(`file://${join(SDK_DIR, "dist", "index.js")}`).href);
const PI_CLI = join(SDK_DIR, "dist", "cli.js");
const KEEP = process.env.PI_MOCK_KEEP === "1";
const TIMEOUT_MS = Number(process.env.PI_MOCK_TIMEOUT_MS ?? 60_000);
const MARKER = "DONE";

/**
 * 临时根。走 test/state-dir.ts 的共享 scratch 约定：有共享 .test-state 时落在那里
 * （受限子代理的写授权覆盖它）；否则退回包目录下的 .test-* 前缀（已 gitignore）。
 */
function tempRoot(prefix: string): string {
	return stateDir(prefix, `.test-${prefix}`);
}

/** 一个最小工程：src/a.ts 在范围内，outside.md 在范围外。 */
function makeProject(): string {
	const root = tempRoot("pi-budget-");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "export const ok = 1;\n");
	writeFileSync(join(root, "outside.md"), "outside the task scope\n");
	return root;
}

/** 隔离的 agent 目录：models.json 把 provider `mock` 指到 mock 服务，不碰用户配置。 */
function makeAgentDir(mockUrl: string): string {
	const dir = tempRoot("pi-budget-agent-");
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

interface RunOptions {
	/** test/fixtures/mock/ 下的 fixture 文件名。 */
	fixture: string;
	bindings: Record<string, unknown>;
}

interface RunOutcome {
	results: { tool?: string; text: string }[];
	assistantText: string;
	requests: Record<string, unknown>[];
	stderr: string;
}

/** 跑一个用例：fixture 脚本 + 范围绑定 → 真 pi 会话 → 工具结果与 mock 请求数。 */
async function runCase({ fixture, bindings }: RunOptions): Promise<RunOutcome> {
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
		args: ["-e", EXT, "-e", FAKE_TOOLS],
	});
	try {
		await client.start();
		const events = await client.promptAndWait("Go.", undefined, TIMEOUT_MS);
		return {
			results: toolResults(events),
			assistantText: assistantText(events),
			requests: mock.requests,
			stderr: client.getStderr(),
		};
	} finally {
		await client.stop();
		await mock.stop();
		if (!KEEP) {
			rmSync(project, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	}
}

/** 每条断言消息都带 stderr 尾巴：会话起不来时能直接看出原因。 */
const TAIL = (run: RunOutcome): string => ` stderr tail: ${run.stderr.slice(-500)}`;

// 1. allowTools 双向闸门：名单内的 read 真执行；名单外的 subagent 被拒，拒因点名
//    allowTools；重试被预算掐断——第 1 次拒绝是警告，第 2 次是硬停，之后 mock
//    不再收到请求。
//
//    名单内为什么用 read：裸 pi 会话注册的工具除 bash 外全是路径类（按范围判，
//    先于 allowTools），唯一走到 allowTools 支路的注册工具是 fake-tools 的
//    subagent——而它在这里扮演名单外的探针，一个会话里没有第二个非路径工具可当
//    名单内探针。allowTools 放行 subagent 的那一面由 mock-session 用例 5 钉住。
{
	const run1 = await runCase({
		fixture: "budget-allowtools.yaml",
		bindings: { "pi-subagents-extend/1": { permissions: { scope: ["src/**"], allowTools: ["read"], maxDenies: 1 } } },
	});
	const read = run1.results.find((r) => r.tool === "read");
	assert.ok(read, `the in-list read must produce a tool result.${TAIL(run1)}`);
	assert.equal(
		/outside the read scope|not on the allow list|denial budget/.test(read.text),
		false,
		`the in-list tool must work, got: ${JSON.stringify(read.text.slice(0, 200))}.${TAIL(run1)}`,
	);
	assert.match(
		read.text,
		/export const ok = 1/,
		`it must really have executed: the file content must reach the model.${TAIL(run1)}`,
	);
	const refusals = run1.results.filter((r) => r.tool === "subagent");
	assert.equal(refusals.length, 2, `two allowTools refusals expected, saw ${refusals.length}.${TAIL(run1)}`);
	assert.match(refusals[0].text, /not on the allow list/, `the refusal must name the gate.${TAIL(run1)}`);
	assert.match(refusals[0].text, /allowTools/, `and name the binding key the parent widens.${TAIL(run1)}`);
	assert.match(refusals[0].text, /Refusal 1 in a row/, `the first refusal is the budget warning.${TAIL(run1)}`);
	assert.doesNotMatch(refusals[0].text, /criterion: denial budget/, `the first refusal must not be the stop.${TAIL(run1)}`);
	assert.match(refusals[1].text, /criterion: denial budget/, `the retry meets the hard stop, still naming the gate.${TAIL(run1)}`);
	assert.equal(
		run1.requests.length,
		3,
		`the stop ends the run: the mock got exactly 3 requests, saw ${run1.requests.length}.${TAIL(run1)}`,
	);
	assert.equal(run1.assistantText.includes(MARKER), false, `no closing assistant turn after the hard stop.${TAIL(run1)}`);
	console.log("  ok   allowTools 双向：名单内 read 执行，名单外 subagent 被拒点名 allowTools，重试被预算停掉");
}

// 2. deny 预算先警告后停机。maxDenies: 2 的实测节拍（DenyCounter 在第 maxDenies
//    次连续拒绝时给警告，deny-count.ts）：
//      第 1 次拒绝 = 平拒，不带预算措辞（还不到阈值）；
//      第 2 次 = 警告，"Refusal 2 in a row ... one more ends the run"；
//      第 3 次 = 硬停，"criterion: denial budget ... the run is over"。
//    停机后 mock 不再被请求。（任务书里「第 1 次拒绝就是警告」对应 maxDenies: 1
//    的节拍；这里按实测语义断言，三档各自钉住。）
{
	const run2 = await runCase({
		fixture: "budget-deny-warn.yaml",
		bindings: { "pi-subagents-extend/1": { permissions: { scope: ["src/**"], maxDenies: 2 } } },
	});
	const refusals = run2.results.filter((r) => /"outside\.md" is outside the read scope/.test(r.text));
	assert.equal(refusals.length, 3, `three refusals expected, saw ${refusals.length}.${TAIL(run2)}`);
	assert.match(refusals[0].text, /outside the read scope/, `the first refusal is the scope refusal.${TAIL(run2)}`);
	assert.doesNotMatch(
		refusals[0].text,
		/in a row|denial budget/,
		`below the threshold the refusal carries no budget wording.${TAIL(run2)}`,
	);
	assert.match(refusals[1].text, /Refusal 2 in a row/, `at maxDenies the refusal warns and counts the row.${TAIL(run2)}`);
	assert.match(refusals[1].text, /one more ends the run/, `the warning names the criterion: one more ends the run.${TAIL(run2)}`);
	assert.doesNotMatch(
		refusals[1].text,
		/the run is over|criterion: denial budget/,
		`the warning must not be the stop.${TAIL(run2)}`,
	);
	assert.match(refusals[2].text, /criterion: denial budget/, `the third refusal is the hard stop and names the budget.${TAIL(run2)}`);
	assert.match(refusals[2].text, /the run is over/, `and it says the run is over, not "try again".${TAIL(run2)}`);
	assert.equal(
		run2.requests.length,
		3,
		`the mock was never asked for another turn after the stop, saw ${run2.requests.length}.${TAIL(run2)}`,
	);
	assert.equal(run2.assistantText.includes(MARKER), false, `no closing assistant turn after the hard stop.${TAIL(run2)}`);
	console.log("  ok   deny 预算：不到阈值不带预算措辞，到阈值警告点名节拍，超阈值硬停，停机后无下一轮");
}

// 3. 写预算与 deny 预算是两个计数器。writeScope 只授 src/report.md：写 src/a.ts
//    是「读得到、写不到」→ 写预算（maxWriteDenies: 1：第 1 次警告、第 2 次硬停）；
//    中间夹一次越界读 → deny 预算（maxDenies: 3，只用到 1，不带任何预算措辞）。
//    判据：停机文案点名 write budget，全程没有出现 denial budget——写预算耗尽时
//    deny 预算远未耗尽；且中间的读拒没有重置写计数（只有放行的调用才清零）。
{
	const run3 = await runCase({
		fixture: "budget-write-split.yaml",
		bindings: {
			"pi-subagents-extend/1": {
				permissions: { scope: ["src/**"], writeScope: ["src/report.md"], maxDenies: 3, maxWriteDenies: 1 },
			},
		},
	});
	const writeRefusals = run3.results.filter((r) => /readable but not writable/.test(r.text));
	assert.equal(writeRefusals.length, 2, `two write refusals expected, saw ${writeRefusals.length}.${TAIL(run3)}`);
	assert.match(
		writeRefusals[0].text,
		/Write refusal 1 in a row/,
		`the first write refusal warns on the write budget.${TAIL(run3)}`,
	);
	assert.match(
		writeRefusals[0].text,
		/one more refusal ends the run/,
		`the write warning names its own criterion and the way out (a report).${TAIL(run3)}`,
	);
	assert.match(
		writeRefusals[1].text,
		/criterion: write budget/,
		`the second write refusal is the hard stop and names the write budget, not the deny budget.${TAIL(run3)}`,
	);
	assert.match(writeRefusals[1].text, /the run is over/, `and it says the run is over.${TAIL(run3)}`);
	const readRefusal = run3.results.find((r) => /"outside\.md" is outside the read scope/.test(r.text));
	assert.ok(readRefusal, `the read refusal must happen in the same session.${TAIL(run3)}`);
	assert.doesNotMatch(
		readRefusal.text,
		/in a row|write budget|denial budget/,
		`the read refusal is governed by maxDenies alone (1 of 3: no budget wording yet).${TAIL(run3)}`,
	);
	assert.equal(
		run3.results.some((r) => /denial budget/.test(r.text)),
		false,
		`the write stop happened with the deny budget unexhausted: the two counters are independent.${TAIL(run3)}`,
	);
	assert.equal(
		run3.requests.length,
		3,
		`the write stop ends the run: the mock got exactly 3 requests, saw ${run3.requests.length}.${TAIL(run3)}`,
	);
	assert.equal(run3.assistantText.includes(MARKER), false, `no closing assistant turn after the write stop.${TAIL(run3)}`);
	console.log("  ok   写预算独立：夹着读拒的写拒照样第 2 次硬停，判据点名 write budget，deny 预算未被耗尽");
}

// 4. 用法错误不消耗预算。read 带空 path 过得了宿主的参数校验（path 是 string，
//    空串合法；缺参的调用根本到不了本层——宿主先校验），到本层才是「缺目标」的
//    用法错：deny 不计数（src/index.ts 的拒绝三分类）。连撞 3 次（超过 maxDenies: 1）
//    之后，真授权拒绝必须还是警告档：计数器显示 "Refusal 1 in a row"，那个 1 就是
//    「三次用法错误都没进预算」的直接证据。若实现把它们计了进去，第 2 次用法错误
//    就已经是硬停，后面两轮根本到不了。
{
	const run4 = await runCase({
		fixture: "budget-usage-error.yaml",
		bindings: { "pi-subagents-extend/1": { permissions: { scope: ["src/**"], maxDenies: 1 } } },
	});
	const usage = run4.results.filter((r) => /no path was given/.test(r.text));
	assert.equal(usage.length, 3, `three usage-error refusals expected, saw ${usage.length}.${TAIL(run4)}`);
	for (const refusal of usage) {
		assert.doesNotMatch(
			refusal.text,
			/in a row|denial budget|the run is over/,
			`a usage error carries no budget wording: it must not consume the budget.${TAIL(run4)}`,
		);
	}
	const real = run4.results.find((r) => /"outside\.md" is outside the read scope/.test(r.text));
	assert.ok(real, `the real authorization refusal must happen after the usage errors.${TAIL(run4)}`);
	assert.match(
		real.text,
		/Refusal 1 in a row/,
		`the counter shows 1: the three usage errors did not consume the budget.${TAIL(run4)}`,
	);
	assert.match(real.text, /one more ends the run/, `and it is the budget warning, not the stop.${TAIL(run4)}`);
	assert.doesNotMatch(
		real.text,
		/the run is over|criterion: denial budget/,
		`a warning must not end the run.${TAIL(run4)}`,
	);
	assert.equal(
		run4.assistantText.includes(MARKER),
		true,
		`the warning handed the model its next turn: the closing text was reached.${TAIL(run4)}`,
	);
	assert.equal(
		run4.requests.length,
		5,
		`all five scripted turns were consumed, saw ${run4.requests.length}.${TAIL(run4)}`,
	);
	console.log("  ok   用法错误不进预算：3 次缺 path 之后，真授权拒绝仍是警告档（Refusal 1 in a row）");
}

console.log("pi-subagents-extend 预算与工具闸门真会话测试通过（4 项）");
