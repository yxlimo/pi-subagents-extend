// 端到端守卫：模块切分将要下刀的三条接缝 + 零配置对照，全部走真 pi 会话。
//
// 与既有套件的分界：extension.test.ts 用假 pi 测判定函数本身；mock-session.test.ts
// 覆盖范围判定、停机与求援；dispatch-payload.test.ts 覆盖派单载荷契约的合法形。
// 这里不重复那些，专测三条接缝在真运行时里的「送达」：
//
//   1. 启动告警（reportUnreachableEntries 走 UI 通知、unreachableCommandNote
//      走工具结果）：授权写了却永远命中不了时，谁被告知、被告知什么；
//   2. 工具结果注解（tool_result 里的 writeRefusalNote）：沙箱写拒要带解释，
//      且注解以 isError 为门控，不看结果文本里出现没出现拒绝字样；
//   3. 派单版本契约（extractCallConfig 的命名空间键检查）：载荷用错版本键时，
//      父会话被警告、子会话被整体拒绝，什么都不会被静默应用。
//
// 第 4 条是对照：不挂任何 bindings 的普通会话不受任何判定 —— 没有它，前三条
// 在「什么都拒」的世界里也能全绿。
//
//   node test/e2e-guards.test.ts    单独跑（包目录内）
//   PI_MOCK_KEEP=1 ...              保留临时工程，便于翻会话记录

import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piDriver } from "../hosts/pi.ts";
import type { HostRun } from "../hosts/types.ts";
import { loadMockFixture } from "../mock-fixture.ts";
import { startMockLlm, startMockLlmFromFixture } from "../mock-llm.ts";
import type { ScriptedStep } from "../mock-llm.ts";
import { redirectStateDir, stateDir } from "../state-dir.ts";

const PKG_DIR = fileURLToPath(new URL("../..", import.meta.url));
const EXT = join(PKG_DIR, "src", "index.ts");
const FAKE_TOOLS = join(PKG_DIR, "test", "fixtures", "fake-tools.ts");
const FIXTURES = join(PKG_DIR, "test", "fixtures", "mock");
const SDK_DIR = realpathSync(join(PKG_DIR, "node_modules", "@earendil-works", "pi-coding-agent"));
const { RpcClient } = await import(new URL(`file://${join(SDK_DIR, "dist", "index.js")}`).href);
const PI_CLI = join(SDK_DIR, "dist", "cli.js");
const KEEP = process.env.PI_MOCK_KEEP === "1";
const TIMEOUT_MS = Number(process.env.PI_MOCK_TIMEOUT_MS ?? 60_000);
// 派单要跑两轮（父派单 + 子执行），与 dispatch-payload.test.ts 同一预算。
const DISPATCH_TIMEOUT_MS = Number(process.env.PI_MOCK_TIMEOUT_MS ?? 120_000);

/** 每条断言消息都带会话 stderr 尾部：挂了先看真会话怎么死的。 */
function tail(stderr: string): string {
	return stderr.slice(-800);
}


// 会话内扩展自己的状态目录（沙箱 spec、git-excludes、xdg-cache）也挪出真实 ~/.cache：
// 受限子代理对 ~/.cache 没有写授权，第一条沙箱 bash 就会死在 spec 落盘上。
redirectStateDir("pi-e2e-guards-state-", ".test-e2e-guards-state-");

/**
 * 临时根。走 test/state-dir.ts 的共享 scratch 约定：有共享 .test-state 时落在那里
 * （受限子代理的写授权覆盖它）；否则退回包目录下的 .test-* 前缀（已 gitignore）。
 */
function tempRoot(prefix: string): string {
	return stateDir(prefix, `.test-${prefix}`);
}
/**
 * 探针工程。关键特征：整棵目录树（含祖先）里没有 package.json —— 用例 1 的
 * 不可达判定靠的就是这个事实。in-scope.txt / outside.md 服务其余用例；
 * .pi/agents/probe-guard.md 只被用例 3 的派单子会话用到，对单会话无害。
 */
function makeProject(): string {
	const root = tempRoot("pi-guards-");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "export const ok = 1;\n");
	writeFileSync(join(root, "outside.md"), "outside the task scope\n");
	writeFileSync(join(root, "in-scope.txt"), "IN-SCOPE-OK\n");
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	writeFileSync(
		join(root, ".pi", "agents", "probe-guard.md"),
		[
			"---",
			"name: probe-guard",
			"description: Guard probe agent for the dispatch version contract test",
			"inheritSkills: false",
			"inheritProjectContext: true",
			"tools: read",
			`subagentOnlyExtensions: "${EXT}"`,
			"---",
			"",
			"You are probe-guard: do exactly what the task says and quote file contents verbatim.",
			"",
		].join("\n"),
	);
	return root;
}

/**
 * 隔离的 agent 目录：models.json 把 provider `mock` 指到 mock 服务，不碰用户配置。
 * settings.json 钉住 defaultProjectTrust: "always"：派单用例的子代理定义写在工程的
 * .pi/agents 里，agent 目录解析只在工程受信时才读它。真 HOME 下 ~/tmp 工程默认受信
 * （唯一的信任点 ~/.agents/skills 是用户资源，被排除）；沙箱里 HOME 被指到别处时
 * 这条排除失效，受信询问在无 UI 的 RPC 模式里只能落到 false —— 在测试自己的隔离
 * agent 目录里显式定为 always，两种环境行为一致。
 */
function makeAgentDir(mockUrl: string): string {
	const dir = tempRoot("pi-guards-agent-");
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
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }, null, 2));
	return dir;
}

/** 扩展 UI 通知在 RPC 协议里的形状：rpc-mode 把 ui.notify 转成这样发到 stdout。 */
interface UiNotifyEvent {
	type?: string;
	method?: string;
	message?: string;
	notifyType?: string;
}

function isNotifyEvent(event: unknown): event is UiNotifyEvent {
	const candidate = event as UiNotifyEvent;
	return candidate?.type === "extension_ui_request" && candidate.method === "notify";
}

interface SessionRun {
	results: { tool?: string; text: string }[];
	assistantText: string;
	/** 整个进程生命周期里的 UI 通知（含 session_start 阶段，早于 promptAndWait）。 */
	uiNotifications: UiNotifyEvent[];
	consumed: number;
	stderr: string;
}

interface RunOptions {
	/** 二选一：fixture 文件名（guards-*.yaml）或内联脚本。 */
	fixture?: string;
	steps?: ScriptedStep[];
	/** undefined = 不挂 bindings（零配置对照）；JSON.stringify(undefined) 是 undefined，spawn 会丢掉该键。 */
	bindings?: Record<string, unknown> | undefined;
	project: string;
	prompt?: string;
}

/**
 * 跑一个单会话用例：mock 服务 + 临时工程 → 真 pi 会话。
 * 事件监听在 start() 之前挂上 —— session_start 的告警不能因为订阅晚了而漏收。
 */
async function runSession({ fixture, steps, bindings, project, prompt = "Go." }: RunOptions): Promise<SessionRun> {
	const mock = fixture
		? await startMockLlmFromFixture(loadMockFixture(join(FIXTURES, fixture)))
		: await startMockLlm({ steps: steps ?? [] });
	const agentDir = makeAgentDir(mock.url);
	const client = new RpcClient({
		cwd: project,
		cliPath: PI_CLI,
		provider: "mock",
		model: "mock-1",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_SUBAGENT_EXTENSION_BINDINGS: bindings === undefined ? undefined : JSON.stringify(bindings),
		},
		args: ["-e", EXT, "-e", FAKE_TOOLS],
	});
	const uiNotifications: UiNotifyEvent[] = [];
	client.onEvent((event: unknown) => {
		if (isNotifyEvent(event)) uiNotifications.push(event);
	});
	try {
		await client.start();
		const events = (await client.promptAndWait(prompt, undefined, TIMEOUT_MS)) as Array<{
			type?: string;
			message?: { role?: string; toolName?: string; content?: Array<{ type?: string; text?: string }> };
		}>;
		const results: { tool?: string; text: string }[] = [];
		const assistant: string[] = [];
		for (const event of events) {
			if (event?.type !== "message_end") continue;
			const message = event.message;
			if (message?.role === "toolResult") {
				const text = (Array.isArray(message.content) ? message.content : [])
					.map((part) => (typeof part?.text === "string" ? part.text : ""))
					.join("\n");
				results.push({ tool: message.toolName, text });
			}
			if (message?.role === "assistant") {
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (part.type === "text" && typeof part.text === "string") assistant.push(part.text);
				}
			}
		}
		return { results, assistantText: assistant.join("\n"), uiNotifications, consumed: mock.consumed, stderr: client.getStderr() };
	} finally {
		await client.stop();
		await mock.stop();
		if (!KEEP) rmSync(agentDir, { recursive: true, force: true });
	}
}

interface DispatchOutcome {
	run: HostRun;
	subagent: { tool?: string; text: string };
}

/** 跑一个派单用例：mock 分流服务 + 临时工程 → 真 pi 会话 → 父会话的 subagent 结果。 */
async function runDispatch(fixture: string, project: string): Promise<DispatchOutcome> {
	const mock = await startMockLlmFromFixture(loadMockFixture(join(FIXTURES, fixture)));
	const agentDir = makeAgentDir(mock.url);
	let run: HostRun | undefined;
	try {
		// pi-subagents 激活工具默认是懒的；脚本化的父会话没有机会调 subagents_enable，改成预激活。
		const configPath = join(agentDir, "extensions", "subagent", "config.json");
		mkdirSync(dirname(configPath), { recursive: true });
		if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ toolActivation: "eager" }));
		run = await piDriver.run({
			project,
			mockUrl: mock.url,
			agentDir,
			prompt: "Go.",
			timeoutMs: DISPATCH_TIMEOUT_MS,
		});
		const subagent = run.toolResults.find((r) => r.tool === "subagent");
		assert.ok(
			subagent,
			`the parent's subagent call produced no tool result — likeliest causes: a leaked PI_* env key stopping pi-subagents from registering its tools, or the session crashed. stderr: ${tail(run.stderr)}`,
		);
		return { run, subagent };
	} finally {
		if (run) await run.stop();
		await mock.stop();
		if (!KEEP) rmSync(agentDir, { recursive: true, force: true });
	}
}

// 1. 不可达授权：allow 列里的 `pnpm test` 在没有 package.json 的工程里永远命中不了。
//    启动时报告一次（UI 通知 → RPC 事件流），点了名、说了原因、说了「没有 cd」；
//    模型真跑这条命令失败时，工具结果里补上 [sandbox] 注解 —— 那才是进模型上下文的一份。
{
	const project = makeProject();
	try {
		const run = await runSession({
			fixture: "guards-unreachable.yaml",
			project,
			bindings: {
				"pi-subagents-extend/1": {
					permissions: { scope: ["src/**"], bash: { allow: ["pnpm test"], writable: true } },
				},
			},
		});
		const startup = run.uiNotifications.filter((n) => (n.message ?? "").includes("can never match"));
		assert.equal(
			startup.length,
			1,
			`exactly one startup report is expected for one unreachable entry (session_start fires once; extra or missing reports mean the once-only contract broke). saw ${startup.length}. stderr: ${tail(run.stderr)}`,
		);
		const report = startup[0]?.message ?? "";
		assert.match(
			report,
			/pnpm test/,
			`the report must name the entry that can never match. got: ${JSON.stringify(report)} stderr: ${tail(run.stderr)}`,
		);
		assert.match(
			report,
			/no package\.json in/,
			`the report must state why the entry can never match (decidable fact, not a guess). got: ${JSON.stringify(report)} stderr: ${tail(run.stderr)}`,
		);
		assert.match(
			report,
			/there is no `cd`/,
			`the report must be actionable: commands run in the working directory and there is no cd, so the entry needs a package-relative form. got: ${JSON.stringify(report)} stderr: ${tail(run.stderr)}`,
		);
		const bash = run.results.find((r) => r.tool === "bash");
		assert.ok(bash, `the scripted bash call produced no tool result. stderr: ${tail(run.stderr)}`);
		assert.match(
			bash.text,
			/\[sandbox\] this command ran, but "pnpm test" cannot work from/,
			`the failed result must carry the unreachable-entry annotation — that is the copy the model actually sees. got: ${JSON.stringify(bash.text.slice(0, 400))} stderr: ${tail(run.stderr)}`,
		);
		assert.match(
			bash.text,
			/The parent has to point this entry at a directory that has the manifest\./,
			`the annotation must say what to do (no candidate package dirs exist, so the remedy is the parent's). got: ${JSON.stringify(bash.text.slice(0, 400))} stderr: ${tail(run.stderr)}`,
		);
		console.log("  ok   不可达授权：启动报告一次且可执行，失败结果带 [sandbox] 注解进模型上下文");
	} finally {
		if (!KEEP) rmSync(project, { recursive: true, force: true });
	}
}

// 2. 沙箱写拒注解：写到授权目录之外 → 失败结果带 [sandbox] 注解，点名路径与已授权清单；
//    对照命令成功但输出里原样包含拒绝文案与越界路径 → 不得有注解。注解的门控是
//    isError，不是文本匹配 —— 这正是它要钉住的行为。
{
	const project = makeProject();
	const leakPath = join(project, "outside.txt");
	try {
		const run = await runSession({
			project,
			bindings: {
				"pi-subagents-extend/1": {
					permissions: { scope: ["src/**"], bash: { write: ["touch"], read: ["echo"], writable: true } },
				},
			},
			steps: [
				// 写在 src（唯一授权目录）之外：沙箱拒掉，isError。
				{ calls: [{ name: "bash", args: { command: `touch ${leakPath}` } }] },
				// 对照：成功命令，输出里原样复刻一条「越界 + Permission denied」。
				// 若注解按文本匹配，这条成功的 echo 也会被追加注解。
				{
					calls: [
						{ name: "bash", args: { command: `echo "touch: cannot touch '${leakPath}': Permission denied"` } },
					],
				},
				{ text: "DONE" },
			],
		});
		// 两条 bash 结果的输出文本同形（真失败与对照 echo 输出完全一样），只能按脚本顺序定位：
		// 第 0 条是越界写（isError），第 1 条是成功命令。
		const refused = run.results[0];
		const control = run.results[1];
		assert.ok(
			run.results.length >= 2,
			`both scripted bash calls must produce results. saw ${run.results.length}. stderr: ${tail(run.stderr)}`,
		);
		assert.match(
			refused.text,
			/Permission denied/,
			`results[0] must be the failed out-of-scope touch, not the control echo. got: ${JSON.stringify(refused.text.slice(0, 300))} stderr: ${tail(run.stderr)}`,
		);
		assert.ok(control, `the control echo produced no result — it must have run to completion. results: ${JSON.stringify(run.results.map((r) => r.text.slice(0, 200)))} stderr: ${tail(run.stderr)}`);
		assert.match(
			refused.text,
			/\[sandbox\] .*outside\.txt is outside the writes the parent granted/,
			`the sandbox write refusal must carry the annotation naming the refused path. got: ${JSON.stringify(refused.text.slice(0, 400))} stderr: ${tail(run.stderr)}`,
		);
		assert.match(
			refused.text,
			/use contact_supervisor to ask for writablePaths\./,
			`the annotation must say what to do. got: ${JSON.stringify(refused.text.slice(0, 400))} stderr: ${tail(run.stderr)}`,
		);
		assert.equal(
			control.text.includes("[sandbox]"),
			false,
			`a successful command must never carry the annotation even when its output quotes a refusal verbatim — the gate is isError, not text matching. got: ${JSON.stringify(control.text.slice(0, 400))} stderr: ${tail(run.stderr)}`,
		);
		assert.equal(
			run.consumed,
			3,
			`the run must continue through both scripted bash turns to the closing text. stderr: ${tail(run.stderr)}`,
		);
		console.log("  ok   沙箱写拒带 [sandbox] 注解，成功命令（含拒绝文案原样输出）不带");
	} finally {
		if (!KEEP) rmSync(project, { recursive: true, force: true });
	}
}

// 3. 派单版本契约：载荷用 pi-subagents-extend/2 → 父会话被警告这份构建只认 /1，
//    子会话被整体拒绝（denyAll），范围内的读也拿不到内容 —— 什么都没被静默应用。
{
	const project = makeProject();
	try {
		const { run, subagent } = await runDispatch("guards-dispatch-version.yaml", project);
		const warnings = run.transcript.filter(
			(event) =>
				isNotifyEvent(event) &&
				(event.message ?? "").includes('declares binding "pi-subagents-extend/2"'),
		);
		assert.equal(
			warnings.length,
			1,
			`the parent must be warned exactly once about the mismatched namespace key. saw ${warnings.length}. stderr: ${tail(run.stderr)}`,
		);
		assert.match(
			(warnings[0] as UiNotifyEvent).message ?? "",
			/this build supports "pi-subagents-extend\/1"/,
			`the warning must state which namespace key this build actually supports. stderr: ${tail(run.stderr)}`,
		);
		assert.match(
			subagent.text,
			/this build supports pi-subagents-extend\/1, got pi-subagents-extend\/2/,
			`the child refusal traveling back must name both the supported and the declared namespace version. result head: ${JSON.stringify(subagent.text.slice(0, 300))} stderr: ${tail(run.stderr)}`,
		);
		assert.match(
			subagent.text,
			/everything is refused/,
			`the version mismatch must refuse everything, not partially apply the payload. result head: ${JSON.stringify(subagent.text.slice(0, 300))} stderr: ${tail(run.stderr)}`,
		);
		assert.equal(
			subagent.text.includes("IN-SCOPE-OK"),
			false,
			`nothing may be silently applied: even the in-scope read must not deliver content. result head: ${JSON.stringify(subagent.text.slice(0, 300))} stderr: ${tail(run.stderr)}`,
		);
		console.log("  ok   版本不匹配派单：父会话被警告一次，子会话整体拒绝，范围内读也不放行");
	} finally {
		if (!KEEP) rmSync(project, { recursive: true, force: true });
	}
}

// 4. 零配置对照：不挂任何 bindings，模型读一个任何策略都会拒的路径 → 原样成功。
//    没有它，前三个用例在「什么都拒」的世界里也能全绿。
{
	const project = makeProject();
	try {
		const run = await runSession({ fixture: "guards-zero-config.yaml", project, bindings: undefined });
		const read = run.results.find((r) => r.tool === "read");
		assert.ok(read, `the unbound session's read produced no tool result. stderr: ${tail(run.stderr)}`);
		assert.ok(
			read.text.includes("outside the task scope"),
			`with no bindings the out-of-scope read must SUCCEED and deliver the file content. got: ${JSON.stringify(read.text.slice(0, 300))} stderr: ${tail(run.stderr)}`,
		);
		assert.equal(
			/outside the read scope|denial budget/.test(read.text),
			false,
			`the unbound session must not be judged at all — no scope refusal, no budget language. got: ${JSON.stringify(read.text.slice(0, 300))} stderr: ${tail(run.stderr)}`,
		);
		assert.equal(
			run.consumed,
			2,
			`the run must continue to the closing turn — nothing was refused. stderr: ${tail(run.stderr)}`,
		);
		console.log("  ok   零配置对照：无 bindings 的会话不受判定，范围外读原样成功");
	} finally {
		if (!KEEP) rmSync(project, { recursive: true, force: true });
	}
}

console.log("pi-subagents-extend e2e guard tests passed (4 cases)");
