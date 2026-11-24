/**
 * pi-subagents-extend — 把一个会话（主要是子代理）能碰的文件限制在任务范围内。
 *
 * 设计目标：父代理委派子代理时指定本次任务的文件/目录范围，子代理会话里
 * 范围之外的 tool_call 一律拒绝（fail closed），防止子代理漫无目的地扫仓库。
 *
 * 配置有两条来源：
 * 1. pi-subagents 的 extensionBindings（派单载荷）。父代理在 subagent 工具调用里传：
 *      extensionBindings: { "pi-subagents-extend/1": { "permissions": { "scope": ["src/auth/**"], "maxReads": 20 } } }
 *    命名空间键下只放 permissions；worktree 是它的同级键，不放进 permissions。
 *    pi-subagents 把它编码进 PI_SUBAGENT_EXTENSION_BINDINGS 传给子代理，本扩展在
 *    激活时（factory）一次性读取。前台子代理的这个环境变量只在会话启动前存在，
 *    之后父进程环境被恢复，所以不能在 tool_call 里懒读。
 * 2. 角色 md（.pi/agents/<role>.md 等，见 role-config.ts）的 extend 块：子代理侧按
 *    <active_agent> 身份解析成基线，只补 bindings 没给的字段；worktree 的派单默认值
 *    也从这里解析。
 *
 * 两条都没有时扩展不生效：父会话和未绑定范围的子代理不受影响。
 *
 * 扩展还随包带一个用法 skill（../skills/pi-subagents-extend），经 resources_discover
 * 注册给会话：扩展加载到哪个会话，父代理侧就能看到「委派时如何传 bindings」的约定，
 * 不需要往 AGENTS.md 里写。
 *
 * 生效时的规则：
 * - read / edit / write / grep / find / ls：解析 path（缺省为 cwd），命中范围
 *   放行，否则拒绝；readOnly 时 edit / write 一律拒绝（走写预算，出路是回报告）
 * - bash：默认拒绝。bindings 里写 bash.allow（命令前缀白名单，如 "pnpm run typecheck"）
 *   后，只有命中白名单的命令放行，并且改写成交给沙箱 helper 执行：读写范围由
 *   Landlock 强制（内核 ABI 7 起），网络默认断（bash.network 可开）：断网时连
 *   UDP/DNS 一起断，靠私有网络命名空间 + 盖掉解析器套接字；可写面只有写范围覆盖到的路径、
 *   git 真正要写的目录与 bash.writablePaths，防止用 shell 绕过范围去改文件
 *   读面不收紧（工具链在 /nix/store，收窄读根会打死所有命令）；另加一条路径引导：
 *   参数里看起来像路径的 token 按真实路径判，落在范围外就被点名拒绝，并指回去用 read 工具
 * - powershell / codemode：一律拒绝（没有路径可判，能绕过范围）
 * - structured_output / todo 与 allowTools 里列出的工具：放行（执行器类不可放行；
 *   todo 是会话运行时工具，只在停机闸门之后放行，也不豁免拒绝计数的归零）
 * - 其余未知工具：拒绝
 *
 * 通配符：** 任意层目录；* 单层内任意字符；? 单个字符。纯路径 glob 额外匹配
 * 该目录自身与其下所有内容；"dir/**" 也匹配 "dir" 本身。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BashRule } from "./bash/index.ts";
import { bindingKey } from "./role-config.ts";
import { judgeToolCall, RUNTIME_TOOLS, SAFE_TOOLS } from "./wiring/tool-call/judge.ts";
import { annotateToolResult } from "./wiring/tool-result.ts";
import { discoverResources, disposeOnShutdown, injectHandoffNotes } from "./wiring/misc.ts";
import { wireAgentStart } from "./wiring/agent-start.ts";
import { wireSessionStart } from "./wiring/session-start.ts";
import { createWiring, type ActivateOptions } from "./wiring/context.ts";
import { bashBlocker, describePnpmStore, helperPath, sandboxWritableDirs } from "./sandbox/index.ts";
export { dropHiddenGrants, findWorktreeRoot, privatisedDirs, resolveComparable } from "./paths/index.ts";
export { sortedEntries, sortByName } from "./dependencies.ts";
export { buildSpec, detectPnpmStore, describeHelper, helperCandidates, sandboxWritableDirs, wrapInSandbox, type HelperCapabilities } from "./sandbox/index.ts";
export { nodeModulesWriteHint, wireDeliverable, wirePreExec, wireWorktree } from "./wiring/agent-start.ts";
export { hasUnquotedShellControl } from "./wiring/tool-call/judge.ts";

/**
 * /permission 的 allow 列。写不写由目录授权决定，与「命令在不在白名单」无关，
 * 所以这里只报白名单本身，不再对整列下读写结论。
 */
function permissionAllowColumn(rule: BashRule): string {
	const entries = rule.allow.join(" | ") || "(none)";
	return `bash allow: ${entries}`;
}




/**
 * 同一个会话里激活两次，只注册一次。
 *
 * 两份来源很容易同时存在：包装好了（ambient 加载），角色 md / agent frontmatter 又声明了一份
 * 路径。后台子代理（单独进程）会把两份都加载进来，于是同一条命令被判两遍 —— 第一份把它包装成
 * 沙箱调用，第二份看到的是包装后的字符串，拿去比对 bash.allow，永远匹配不上，整个子会话的 bash
 * 全被拒。这不是某个用户的配置问题：只要「装了包」和「声明了路径」同时成立就会撞上。
 *
 * 闸门挂在 pi 传进来的 api 对象上：它是每个会话一份的，所以进程内的前台子代理（它不加载
 * ambient，只加载声明的路径）照样会注册自己那一份，跨会话不会互相顶掉。
 * Symbol.for 走全局符号表，两份是不同文件也能认同一个键。
 */
const ACTIVATION_MARK = Symbol.for("pi-subagents-extend.activation");

export type { ActivateOptions } from "./wiring/context.ts";



export function activate(pi: ExtensionAPI, options: ActivateOptions = {}) {
	// 已在本会话注册过就退出：第二份 handler 会把第一份包装过的命令再判一遍（见 ACTIVATION_MARK）。
	// 宿主若给了不可写的 api 对象，就按没有闸门继续 —— 少一层去重比整个扩展不激活好。
	try {
		// SAFETY: `pi` is the host's ExtensionAPI object; the only key read or written through this cast
		// is our own `Symbol.for` one, which no host type declares. No other property is touched, and a
		// host that rejects the write lands in the catch below.
		const marked = pi as unknown as Record<symbol, unknown>;
		if (marked[ACTIVATION_MARK]) return;
		marked[ACTIVATION_MARK] = true;
	} catch {
		// 只读 api：退化成没有去重。
	}
	const w = createWiring();
	// 绑定与方法约定（skill）一起提供给会话：扩展被加载，skill 就进系统提示的
	// 可用列表；父代理据此知道委派时传 extensionBindings。已上锁的会话不注册——
	// 它不委派，也不该去读一个自己被范围拦住的文件。

	/** 工具名 → schema 里的路径入参名；一处缓存，避免每次调用都问一遍注册表。 */
	const schemaPathArgs = new Map<string, string | undefined>();



	pi.on("resources_discover", async () => discoverResources(w));
	pi.on("before_agent_start", async (event, ctx) => wireAgentStart(w, event, ctx));

	pi.on("session_start", async (event, ctx) => wireSessionStart(w, options, event, ctx));

	pi.on("session_shutdown", async () => disposeOnShutdown(w));

	// tool_result 干三件事：
	// 1. 探针 3 要看 bash 的输出；
	// 2. 子代理的 worktree 单会在这里返回交接单路径，就地补一句「该看哪个键」；
	// 3. 离线沙箱里的网络失败要就地说明「这是主代理没授权」，否则子代理会当成
	//    环境坏了，换 registry / 加 timeout 反复重试。
	pi.on("tool_result", async (event) => annotateToolResult(w, event));

	// 后台子代理完成后，pi-subagents 用 sendMessage 把通知注入会话（正文带 `Parallel handoff:`）。
	// 实测 message_end 不会为这种注入消息触发，所以改用 context：每次 LLM 调用前拿到完整
	// 消息表，就地补一句。它就是模型实际看到的内容，不依赖通知用什么 role 送达。
	pi.on("context", async (event) => injectHandoffNotes(event));


	pi.on("tool_call", async (event, ctx) => {
		const verdict = await judgeToolCall({ pi, w, schemaPathArgs, event, ctx });
		// 放行的调用把两类「连续」计数都清零。判据是连续而不是累计：子代理改了做法就该重新计数，
		// 否则早期的一次误判会在几十轮之后把任务判死。
		//
		// 求援通道不清零：它是报告，不是进展。否则每次试探之间插一句 contact_supervisor 就能
	// 求援通道不清零：它是报告，不是进展。否则每次试探之间插一句 contact_supervisor 就能
	// 永远停在「警告」档，硬停判据直接失效。
	//
	// RUNTIME_TOOLS（todo）同样不清零，理由同源：它是会话自身的簿记，不是任务进展。
	// 若放行的 todo 也归零，子代理就能在两次拒之间插一句 todo 把连续计数洗掉，
	// 永远到不了硬停 —— 与求援通道被排除在归零之外是同一个道理。
	if (verdict === undefined && !SAFE_TOOLS.includes(event.toolName) && !RUNTIME_TOOLS.includes(event.toolName)) {
			w.denyCounter.reset();
			w.writeDenyCounter.reset();
		}
		return verdict;
	});

	pi.registerCommand("permission", {
		description: "Show the current task scope, the bash allowlist and the probe state",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			// helper 只查一次：它要 fork 一个进程读 --describe。
			const helper = helperPath();
			const helperLine = w.policy.bash
				? `Helper: ${bashBlocker(helper) ?? helper}`
				: undefined;
			const lines = w.policy.active
				? [
					`Source: ${w.policy.source}`,
					`Bindings: ${bindingKey()}`,
					`Mode: ${w.policy.readOnly ? "read-only" : "read-write"}`,
					w.policy.readOnly || [...w.policy.writeGlobs, ...w.policy.absoluteWrite].join("\n") === w.policy.globs.join("\n")
						? undefined
						: `Write scope: ${[...w.policy.writeGlobs, ...w.policy.absoluteWrite].join(" | ") || "(none)"}`,
					`Read scope: ${w.policy.globs.join(" | ") || "(none)"}`,
					`Read denials: ${w.denyCounter.status()} · write denials: ${w.writeDenyCounter.status()}`,
					w.policy.bash
						? permissionAllowColumn(w.policy.bash)
						: "bash: off",
					w.policy.bash && w.policy.bash.deny.length > 0
						? `bash deny (cannot be lifted): ${w.policy.bash.deny.join(" | ")}`
						: undefined,
					w.policy.bash
						? `Sandbox: ${w.policy.bash.network ? "network on" : "offline"}`
						: undefined,
					helperLine,
					w.policy.bash
						? `Sandbox writable paths: ${
							sandboxWritableDirs(w.policy, cwd, w.policy.bash, { create: false })
								.map((d) => d.replace(cwd, "."))
								.join(" | ") || "(none)"
						}`
						: undefined,
					w.policy.bash ? `pnpm store: ${describePnpmStore(cwd)}` : undefined,
					`Reads: ${w.allowedReads}${w.policy.maxReads > 0 ? `/${w.policy.maxReads}` : ""}`,
					...(w.probe ? w.probe.status() : ["Probe: off"]),
				].filter((l): l is string => Boolean(l))
				: ["Inactive (no pi-subagents-extend bindings in this session)"];
			ctx.ui.notify(`pi-subagents-extend:\n${lines.join("\n")}`, "info");
		},
	});
}

export default function (pi: ExtensionAPI) {
	activate(pi);
}
