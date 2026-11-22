import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { allEntries, classifyCommand, commandAccess, commandMatches, deniedEntry, deniedEnvAssignment, pathCandidates, requiresNetwork, type BashRule } from "../../bash/index.ts";
import { dispatchToolFaceRefusal, headEntriesHint, warnUnresolvedAgentName, warnUntrackedWorktreeProfile } from "../../notices.ts";
import { STOP_NOTICE } from "../../probe.ts";
import { shouldDefaultWorktree, WORKTREE_TOOLS } from "../../worktree-default.ts";
import { agentMdDirs, BINDING_NAMESPACE, bindingKey, readExtendBlock, resolveAgentFile, worktreeFromBlock } from "../../role-config.ts";
import { asObject, matches, type Policy } from "../../policy/index.ts";
import { dependencyGateVerdict } from "../../dependencies.ts";
import { expandPath, privatisedDirs, resolveComparable, underRoot } from "../../paths/index.ts";
import { buildSpec, detectPnpmStore, describeHelper, dropSpecFile, helperPath, SANDBOX_DEVICE_PATHS, scratchDir, wrapInSandbox, writeSpecFile } from "../../sandbox/index.ts";
import type { Wiring } from "../context.ts";
import { bail, deny, pathToolVerdict, preview, writeBail } from "./paths.ts";

/**
 * tool_call 的总判定（judgeToolCall）从 index.ts 的 activate() 闭包整体移入。
 * 判定函数不持有会话状态：会话状态都在 Wiring 上，由调用方传入；per-activation 的
 * schema 缓存（schemaPathArgs）、pi 与 ctx 也经入参对象由 activate 传入 —— 与 paths.ts
 * 同一形状（imports 只来自 node:* 与叶子模块，不来自 index.ts）。
 *
 * 闸门顺序是有意为之，别打乱（自上而下）：
 * 1. 派单预检（工具面冲突的拒绝、解析不到角色 md 的告警）、派单默认值补值与版本
 *    告警先于范围判定 —— 预检判的是 pi-subagents 自己的解析与宿主工具面，与本层
 *    策略激活无关；补值不是拒绝，预检的拒绝是配置冲突，只拒不计入预算；
 * 2. 策略未激活直接放行；
 * 3. SAFE_TOOLS（求援通道）最先放行，不受任何停机影响；
 * 4. 已停机的会话挡住其后的一切（terminate）；
 * 5. 探针边界先于本工具的判定；
 * 6. RUNTIME_TOOLS（todo 这类会话运行时工具）在停机闸门与探针边界之后放行：
 *    活着的会话永远有它，停机的会话一个也没有；排在探针边界之后，纯 todo
 *    空转的会话仍会被探针判据停掉；
 * 7. bash → 其他执行器 → 路径类工具 → allowTools → 其余一律拒（fail closed）。
 */

/**
 * 已知路径类工具的访问类别：读认读范围，写认写范围。
 *
 * 名字只是**默认值**，不是判据的全部。目标路径从工具自己的入参 schema 里取（见
 * `pathArgOf`），父代理还能用 bindings.tools 覆盖。名字表之所以省不掉，是因为
 * 「这个工具会不会改文件」推不出来，必须有人声明。
 *
 * 为什么必须收录 hashline 那一套：pi-hashline-edit-pro 把内置 `edit` 从活动工具集里
 * 删掉（它自己 `setActiveTools(active.filter(t => t !== "edit"))`），换上一组以行锚点
 * 定位的编辑工具。只认 `edit` / `write` 的名单在这种宿主上会把整套编辑能力判成
 * 「未知工具」而拒绝——子代理一个改文件的工具都拿不到。
 */
const DEFAULT_TOOL_ACCESS: Record<string, "read" | "write"> = {
	read: "read",
	grep: "read",
	find: "read",
	ls: "read",
	outline: "read",
	edit: "write",
	write: "write",
	replace: "write",
	replace_match: "write",
	insert: "write",
	copy: "write",
	move: "write",
	undo_last_change: "write",
};

const EXEC_TOOLS = ["bash", "powershell", "codemode"];

/**
 * 不碰文件系统的会话级运行时工具，范围生效时照常放行。
 * contact_supervisor / intercom 是子代理向父代理（监督者）转告的正当通道——探针的
 * 停机判据本来就要它立刻上报，封锁它只会把信息憋在死掉的会话里。
 */
export const SAFE_TOOLS = ["structured_output", "contact_supervisor", "intercom"];

/**
 * 会话级运行时工具：不碰文件系统、不与外界通信，只维护会话自己的任务清单。
 * 与 SAFE_TOOLS 的差别有两条，都是刻意的：
 * - 判定位置在停机闸门**之后**（SAFE_TOOLS 在之前）：停机的会话不该再改任何东西，
 *   任务清单也不例外；
 * - 不豁免 index.ts 的计数归零：放行的 todo 不得清空拒绝预算，否则子代理可以在
 *   两次拒之间插一句 todo 把连续计数洗掉，永远到不了硬停 —— 与求援通道被排除在
 *   归零之外是同一个道理，所以这里开第三个名单而不是往 SAFE_TOOLS 里加一员。
 */
export const RUNTIME_TOOLS = ["todo"];

/**
 * 命令里是否有**未加引号**的 shell 控制字符。
 *
 * 命令最终以 `bash -lc <command>` 执行，所以引号语义就是 bash 的语义：
 * 单引号内一切惰性；双引号内只有 `$`、反引号、反斜杠仍会展开，`; & | < > ( )`
 * 都是普通字符。之前是纯文本正则匹配，于是 `python3 -c "print(1)"` 这种引号内的
 * 括号也被拒——dogfooding 时一个子代理因此无法自验 YAML。
 *
 * 不进引号的正斜杠也一律拒；引号闭合不对（子代理手写错）也拒，交给它重写。
 */
export function hasUnquotedShellControl(command: string): boolean {
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			// 双引号内反斜杠仍会转义，跳过后一个字符（保守：当成惰性）
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			if (ch === "$" || ch === "`") return true;
			continue;
		}
		if (ch === "'") {
			quote = "'";
			continue;
		}
		if (ch === '"') {
			quote = '"';
			continue;
		}
		if (ch === "\\" || ch === "\n" || ch === "\r") return true;
		if (";&|<>()`$".includes(ch)) return true;
	}
	// 引号没闭合：命令本身是坏的，直接拒
	return quote !== undefined;
}

/**
 * 只读类 bash 命令的参数路径可以指向、且无需再解释的系统目录：设备与系统信息，不是工具。
 *
 * 沙箱的读面仍是 `/`：node、rg、cargo 全在 /nix/store，收窄读根会一次打死所有命令。所以这一层
 * 不判「能不能读」，只在插件层把参数里的路径引到任务范围上 —— 引导，不是墙。
 *
 * 刻意**不**含 /nix/store、/usr、/bin、/sbin、/lib、/lib64：工具住在这些目录里，不代表命令的参数
 * 会包含它们 —— 程序位由 bash 经 PATH 解析，根本不进参数表（见 bash/index.ts 的 `pathCandidates`）。
 * 参数里真的出现 store 或系统二进制目录，就是子代理在工具链里翻东西，正是要把路径引回范围的场景
 * （实测：一个子代理在 258MB 的包体里 rg 了 140 次，全部为空）。
 */
const BASH_READ_EXEMPT_ROOTS = ["/etc", "/proc", "/dev", "/sys"];

/**
 * 一条只读类命令的参数路径是否可放行。任一条成立即放行：在工作树内 / 在设备与系统信息豁免集内 /
 * 在 cwd 或私有 scratch 之下 / 是沙箱默认可写的设备。
 *
 * 方向是宁可漏放：漏放只是少一次引导，误拒会让一条本来能跑的命令死在插件层，而子代理多半把它读成
 * 「这台机器坏了」，然后换一百个写法再试。
 *
 * 下面 `expandPath` 那道守卫（返回 undefined 即放行）是防御性代码，当前**不可达**：候选由
 * `pathCandidates` 产出，必含斜杠因而非空，而 `expandPath` 只在空串时返回 undefined。
 */
function bashPathArgAllowed(token: string, cwd: string, rule: BashRule, policy: Policy): boolean {
	const expanded = expandPath(cwd, token);
	if (!expanded) return true;
	// 范围判定内部已经按真实路径比过软链，传绝对路径进去不影响它的语义。
	if (matches(policy.regexps, cwd, expanded)) return true;
	// 豁免集要按字面与真实两种形态各比一次：有些系统上 /etc 自己就是软链（macOS 上是 /private/etc），
	// 只比一种会让同一个路径有时豁免、有时不豁免。
	//
	// 真实路径用 `resolveComparable` 而不是 `canonical`：前者是与 helper 的 `fs::canonicalize` 对齐的
	// 实现（OS 的 realpath + 字面拼尾），后者是 Node 的自实现版，两边在部分输入上结果不同。
	const real = resolveComparable(expanded);
	if (BASH_READ_EXEMPT_ROOTS.some((root) => underRoot(root, expanded) || underRoot(root, real))) return true;
	if (underRoot(resolveComparable(cwd), real)) return true;
	// scratch 用 privatisedDirs：cwd 落在 /tmp 之下时 helper 并不挂那个 tmpfs，那就不算
	// 「命令自己的临时目录」，免得 /tmp 顺带把整片宿主机路径放进来。
	for (const dir of privatisedDirs(cwd, scratchDir(cwd, rule))) {
		if (underRoot(resolveComparable(dir), real)) return true;
	}
	return SANDBOX_DEVICE_PATHS.some((device) => underRoot(device, real));
}

/**
 * 只读类命令里第一个指向范围之外的路径参数；没有就返回 undefined。
 *
 * 只看读类命令：写类命令的文件面由 Landlock 与写范围管，而这里判的是「它在读什么」。候选的抽取
 * 在 bash/index.ts 里（纯字符串），放行判定留在这里，因为豁免集、scratch 与 `resolveComparable` 都在这边。
 */
function foreignBashPath(command: string, cwd: string, rule: BashRule, policy: Policy): string | undefined {
	return pathCandidates(command).find((token) => !bashPathArgAllowed(token, cwd, rule, policy));
}

/** 派单版本号写错的提示整进程只说一次；不在 session_start 清空。 */
let warnedDispatchVersion = false;

/**
 * 派单目标角色的 worktree 默认值。按 input.agent 解析角色 md（与子代理侧同一套
 * resolveAgentFile / readExtendBlock，父子不会对「md 在哪」各说各话），取
 * extend.worktree.enabled。enabled: true 且派单没带 worktree（undefined / null，
 * `??=` 语义）时补一个 true；显式 false 或其它值一律不动。md 缺席、没有 extend 块、
 * 块写坏、enabled: false 都按「没配置」处理：不拒绝、不计数、不告警（fail open）。
 *
 * `fromMd` 标记这个值是否来自角色 md：派单自带 bindings 走的不是 md，补值时
 * 不需要提示「worktree 副本里没有那份 md」。mdFile 只在 fromMd 时有意义，
 * 未跟踪告警要用它点名文件。
 */
interface WorktreeStrategy {
	worktree?: unknown;
	fromMd: boolean;
	mdFile?: string;
}

function worktreePolicyFor(
	cwd: string,
	call: Record<string, unknown> | undefined,
	agent: string,
	/** 调用方（预检）已解析过的 md 文件；缺省时按 agent 现场解析，目录序与 resolveAgentFile 相同。 */
	resolvedMdFile?: string,
): WorktreeStrategy {
	const mdFile = resolvedMdFile ?? (resolveAgentFile(agent, cwd, homedir()) ?? undefined);
	const block = mdFile ? readExtendBlock(mdFile).block : undefined;
	const enabled = worktreeFromBlock(block ?? {}).worktree?.enabled === true;
	if (enabled && (call?.worktree === undefined || call?.worktree === null)) {
		return { worktree: true, fromMd: true, mdFile };
	}
	return call?.worktree === true ? { worktree: true, fromMd: false } : { fromMd: false };
}

/**
 * 角色 md frontmatter 顶层的 `tools:` 列表 —— pi-subagents 检查子代理工具面用的
 * 就是这份声明，预检读同一份事实，不自己发明检查。
 *
 * 没有读得到文件、没有 frontmatter、没有 `tools:`、不是非空字符串数组、YAML 解不开
 * —— 一律 undefined（fail open）：预检漏报只是少一次提前拒绝，误报会把一条本来能跑
 * 的派单打死在插件层。文件切片这一段与 readExtendBlock 的 frontmatter 外壳重复，
 * 但那份代码在 role-config.ts 里只返回 extend 块，而本文件被授权改动的清单里没有
 * role-config.ts —— 能把外壳提进共享层时再合，先不为此越权。
 */
const declaredToolsOf = (mdFile: string): string[] | undefined => {
	let text: string;
	try {
		text = readFileSync(mdFile, "utf8");
	} catch {
		return undefined;
	}
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return undefined;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return undefined;
	let parsed: unknown;
	try {
		parsed = parse(lines.slice(1, end).join("\n"));
	} catch {
		return undefined;
	}
	const frontmatter =
		parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	const tools = frontmatter?.tools;
	if (!Array.isArray(tools) || tools.length === 0 || tools.some((tool) => typeof tool !== "string")) return undefined;
	return tools as string[];
};

/** 工具名 → schema 里的路径入参名；一处缓存，避免每次调用都问一遍注册表。缓存由 activate 持有并传入。 */
const pathArgFromSchema = (
	pi: ExtensionAPI,
	schemaPathArgs: Map<string, string | undefined>,
	toolName: string,
): string | undefined => {
	if (schemaPathArgs.has(toolName)) return schemaPathArgs.get(toolName);
	let found: string | undefined;
	try {
		const registered = (
			pi as { getAllTools?: () => { name: string; parameters?: unknown }[] }
		).getAllTools?.();
		const tool = registered?.find((entry) => entry.name === toolName);
		const properties = (tool?.parameters as { properties?: Record<string, { type?: string }> } | undefined)
			?.properties;
		if (properties?.path?.type === "string") found = "path";
		else if (properties?.file_path?.type === "string") found = "file_path";
	} catch {
		// 宿主没暴露 getAllTools（老版本、测试桩）：退回缺省的 "path"。
	}
	schemaPathArgs.set(toolName, found);
	return found;
};

/**
 * 名字 → 类别。undefined 表示它不是路径类工具，交给 allowTools 那条路。
 *
 * 路径入参名的取值顺序：父代理显式声明 → 工具自己的 schema → "path"。中间那层是为了
 * 不靠猜：hashline 那套工具的 schema 里就有 `path`，而换个宿主可能叫 `file_path`。
 */
const toolKindOf = (
	w: Wiring,
	pi: ExtensionAPI,
	schemaPathArgs: Map<string, string | undefined>,
	toolName: string,
): { access: "read" | "write"; pathArg: string | false; transferSource?: "read" | "write" } | undefined => {
	const declared = Object.hasOwn(w.policy.tools, toolName) ? w.policy.tools[toolName] : undefined;
	const fallback = Object.hasOwn(DEFAULT_TOOL_ACCESS, toolName) ? DEFAULT_TOOL_ACCESS[toolName] : undefined;
	const access = declared?.access ?? fallback;
	if (!access) return undefined;
	return {
		access,
		pathArg: declared?.path ?? pathArgFromSchema(pi, schemaPathArgs, toolName) ?? "path",
		...(declared?.transferSource === undefined ? {} : { transferSource: declared.transferSource }),
	};
};

/**
 * judgeToolCall 的入参对象。原先六个位置参数（pi、w、options、schemaPathArgs、
 * event、ctx）只有 index.ts 的 tool_call 处理器一个调用方，位置序已经到了读不动的
 * 边界；options 字段从来没人读，收对象时一并去掉。
 */
export interface JudgeToolCallOptions {
	pi: ExtensionAPI;
	w: Wiring;
	/** activate 持有的 schema 路径入参缓存（见 pathArgFromSchema）。 */
	schemaPathArgs: Map<string, string | undefined>;
	event: ToolCallEvent;
	ctx: ExtensionContext;
}

export const judgeToolCall = async ({
	pi,
	w,
	schemaPathArgs,
	event,
	ctx,
}: JudgeToolCallOptions): Promise<ToolCallEventResult | undefined | void> => {
	w.currentCtx = ctx;
	w.uiWarning = (message) => {
		const ui = ctx.ui as { notify?: (m: string, t?: string) => void } | undefined;
		ui?.notify?.(message, "warning");
	};
	// 派单预检与默认值补值先于范围判定：父会话常常根本没有 bindings（本层策略不激活），
	// 而这两条判的是 pi-subagents 自己的解析与宿主工具面，跟本层策略激活与否无关。
	// 补值不是拒绝，不进 deny 预算；预检的拒绝是配置冲突，只拒不计（放宽授权治不了它）。
	if (WORKTREE_TOOLS.has(event.toolName)) {
		const candidate = event.input as { agent?: unknown; worktree?: unknown; extensionBindings?: unknown } | undefined;
		const agent = candidate?.agent;
		if (candidate && typeof agent === "string" && agent.trim()) {
			const cwd = ctx.cwd ?? process.cwd();
			const name = agent.trim();
			// check 1 / check 2：md 解析得到就比工具面，解析不到就告警一次。都在 spawn 之前
			// 发生 —— 派单失败得快，是因为 pi-subagents 在子会话起来之后才检查这些，报出来的
			// 话没人能照着改；这里把同一件事提前到 tool_call，且带上因果。
			const mdFile = resolveAgentFile(name, cwd, homedir()) ?? undefined;
			if (!mdFile) {
				// check 2 只告警不拒：builtin 代理（worker、scout、delegate…）本来就没有
				// md，拒了会打死最常见的用法。告警让「名字其实落在了 builtin 别名上、
				// 角色 md 的策略根本没生效」这件事在派单前可见。
				warnUnresolvedAgentName(name, cwd, agentMdDirs(cwd, homedir()), w.uiWarning);
			} else {
				// check 1 只在 md 自己声明了 tools: 时才比：那是 pi-subagents 检查子代理
				// 工具面用的同一份声明，本层不替 pi-subagents 发明检查。声明缺失、类型
				// 不对、宿主没暴露活动面（测试桩）一律放行 —— 漏报只是少一次提前拒绝。
				const declared = declaredToolsOf(mdFile);
				const active = declared ? (pi as { getActiveTools?: () => string[] }).getActiveTools?.() : undefined;
				if (declared && active) {
					const missing = declared.filter((tool) => !active.includes(tool));
					if (missing.length > 0) {
						return deny(dispatchToolFaceRefusal(name, mdFile, missing));
					}
				}
			}
			// 只有 worktree 这一个决策把本次派单自带的 bindings 叠在会话 bindings 之上；
			// 其余策略解析仍用会话启动时定格的那一份，范围不因单次派单而变。
			const own = asObject(candidate.extensionBindings)?.[bindingKey()];
			const strategy = worktreePolicyFor(cwd, { ...w.call.config, ...w.call.blocks, ...asObject(own) }, name, mdFile);
			if (shouldDefaultWorktree(strategy, event.toolName, event.input)) {
				candidate.worktree = true;
				if (strategy.fromMd && strategy.mdFile) warnUntrackedWorktreeProfile(cwd, strategy.mdFile, w.uiWarning);
			}
		}
	}
	// 只有这个扩展被装进主会话时才看得到派单载荷（默认并非如此）：子会话在 session_start
	// 就消费掉 bindings，tool_call 里根本没有。别把「这里没告警」当成坏掉来报。
	if (!warnedDispatchVersion && (event.toolName === "subagent" || event.toolName === "subagent_launch")) {
		const candidate = event.input as { extensionBindings?: unknown } | undefined;
		const incoming = asObject(candidate?.extensionBindings);
		const wrongKey = incoming && Object.keys(incoming).find(
				(key) => key.startsWith(`${BINDING_NAMESPACE}/`) && key !== bindingKey(),
		);
		if (wrongKey) {
			warnedDispatchVersion = true;
			w.uiWarning?.(
				`pi-subagents-extend: a ${event.toolName} dispatch declares binding "${wrongKey}", but this build supports "${bindingKey()}"; use the matching key or the dispatch will be refused.`,
			);
		}
	}
	if (!w.policy.active) return;
	const cwd = ctx.cwd ?? process.cwd();
	// 求援通道不受任何停机影响：被停住的子代理最需要的就是「报告我卡在哪」。
	if (SAFE_TOOLS.includes(event.toolName)) return undefined;
	if (w.stopped) return { block: true, reason: STOP_NOTICE, terminate: true };
	// 探针在边界上的 warn / 到期停机，先于本工具的判定。
	const boundary = w.probe?.atToolBoundary();
	if (boundary) {
		if (boundary.stop) return w.stop(boundary.reason);
		return { block: true, reason: boundary.reason, terminate: false };
	}

	// 会话运行时工具（todo）：不碰文件，活着的会话照常放行。位置在停机闸门与探针
	// 边界**之后**：停机后不再放行（停了的会话不该再改任何东西，任务清单也不例外），
	// 探针判据对纯 todo 空转的会话也照常生效。
	if (RUNTIME_TOOLS.includes(event.toolName)) return undefined;
	// 拒绝分三类，分类标准只有一条：**父代理放宽授权能不能解决**。
	//   能 → 撞权限计数（bail）：范围外路径、命令不在白名单、read 预算、
	//         工具不在 allowTools、整个 bash 被关。这些是「授权与任务不匹配」的信号。
	//   写不了 → 写预算（writeBail）：写范围外、readOnly 会话里的写。放宽授权也解决不了，
	//          正解是改成交报告，所以计数与文案都跟授权那类分开。
	//   不能 → 只拒不计（deny）：用法错误（缺 path、空命令、shell 元字符）、
	//          bash deny 的硬禁令、永远不开放的工具、环境/内核缺能力。
	// 把后一类算进预算，会让一次参数写错就提前判死长任务。

	if (event.toolName === "bash") {
		const command = String((event.input as { command?: unknown })?.command ?? "").trim();
		const rule = w.policy.bash;
		if (!rule) {
			return bail(
				w,
				`pi-subagents-extend: bash is not allowed here (source: ${w.policy.source}). For tests or a typecheck the parent must list the commands in bash.allow.`,
			);
		}
		if (!command) return deny("pi-subagents-extend: empty bash command");
		// 禁止列表先于一切判定：deny 是硬底线（两层并集，任何一层都拆不掉），
		// 调用方的白名单不能放宽它。它不属于哪一层配置文件，来源只在 (source: …) 里。
		const forbidden = deniedEntry(rule, command);
		if (forbidden) {
			return deny(
				`pi-subagents-extend: command blocked by a deny entry: "${forbidden}" (source: ${w.policy.source}). A deny entry is a restriction; no layer can remove it.`,
			);
		}
		if (hasUnquotedShellControl(command)) {
			return deny(
				`pi-subagents-extend: shell metacharacters are not allowed (; & | < > \` $ …): run one allowlisted command. Refused: ${preview([command])} — allowed: ${preview(allEntries(rule))}`,
			);
		}
		// 前置赋值能把「被允许的命令」变成「跑我自己的代码」：`NODE_OPTIONS=--require=/tmp/x.js node`
		// 实测直接执行 /tmp/x.js，`GIT_EXTERNAL_DIFF` 对 git 同理。已知入口一律拒并点名；
		// 其余名字照常剥离放行（这一层是辅助上轨道，不是严格沙箱 —— 放行多了可以事后补）。
		const deniedEnv = deniedEnvAssignment(command);
		if (deniedEnv) {
			return deny(
				`pi-subagents-extend: bash refused: the leading assignment "${deniedEnv}=…" can change which program runs or load code into it, which would let an allowlisted command run arbitrary code. Drop it, or have the parent set it in bash.env. Refused: ${preview([command])}`,
			);
		}
		const match = classifyCommand(rule, command);
		if (!match) {
			// 模型能看见这段文案，所以把它需要的路径直接写进去，省得它再猜。
			const store = detectPnpmStore(cwd);
			const storeHint = store.path
				? ` (pnpm store at ${store.path}, not writable; the parent can add it to bash.writablePaths)`
				: "";
			// 点名被拒的**命令**，再列允许项。只印允许列表时，读起来像「列表里那条命令不被接受」：
			// 实测真有人把 `command not in the allowlist: ls` 读成「ls 被拒」，而实际拒的是别的命令。
			// 同首 token 的条目：让子代理知道**为什么**没匹配上、该改哪里。
			const headHint = headEntriesHint(rule, command, cwd);
			return bail(
				w,
				`pi-subagents-extend: command not in the allowlist: "${preview([command])}" — allowed: ${preview(allEntries(rule))} (source: ${w.policy.source})${storeHint}${headHint}`,
			);
		}
		// allow 列放行的写类命令，role 却没给写权限：这是写拒，计入写预算而非撞权限预算。
		// 判据是「确实有一条 allow 授权」+ 命令本身会写 + writable:false，不看 classifyCommand 报的列：
		// 同一条命令也命中 legacy 列时那列会先被报出来，但 legacy 不授予写权限。
		// classifyCommand 在 writable=false 时已把 access 压成 read，这里用固有判定（传 true）
		// 认出「这条命令本来会写」，否则它会以只读的名义被放行去写。
		if (rule.allow.some((entry) => commandMatches(entry, command)) && rule.writable === false && commandAccess(command, true) === "write") {
			return writeBail(
				w,
				`pi-subagents-extend: the role may run this command (it is in bash.allow)${match.column === "allow" ? "" : ` (matched the legacy ${match.column} column, which does not grant writes)`}, but bash.writable: false gives no write access: "${preview([command])}". This is a write refusal, not a grant error — deliver the result as a report, or have the parent set bash.writable: true.`
			);
		}
		// 只读类命令的参数路径：沙箱读面是 `/`（工具链要读 /nix/store），所以路径引导放在插件层。
		// 位置在元字符与注入型赋值之后、依赖闸门之前：前两条决定「这条命令能不能跑」，
		// 闸门判的是环境，这一条只是把参数里的路径引回范围，三者互不重叠。
		if (match.access === "read") {
			const foreign = foreignBashPath(command, cwd, rule, w.policy);
			if (foreign) {
				// 计入撞权限预算（bail）：父代理放宽范围就能解决，正是这一类。
				return bail(
					w,
					`pi-subagents-extend: "${foreign}" is outside the working tree (source: ${w.policy.source}). This is a path nudge, not a wall: the command runs in ${cwd}, and a file outside it is not yours to read — say what you need from it instead.\nWorking tree: ${cwd}`,
				);
			}
		}
		// 离线时网络是裸 netns：包被丢弃而不是被拒绝，curl 这类命令没有输出也没有错误，
		// 事后注解等不到触发文本，只能挂到超时。所以在 spawn 之前按名单拒掉确定要往返的
		// 工具；名单只收确定项，拿不准的一律放行（引导，不是沙箱边界）。
		if (rule.network !== true) {
			const networkTool = requiresNetwork(command);
			if (networkTool) {
				return bail(
					w,
					`pi-subagents-extend: the network is off per the parent's bindings — a permission, not a broken machine. \`${networkTool}\` would hang here rather than fail (packets are dropped, not refused). Ask the parent via contact_supervisor for "network": true.\n(source: ${w.policy.source})`,
				);
			}
		}
		// 依赖完整性闸门判的是环境，不是授权，子代理重试也不会变好，所以只拒不计。
		// 它已不再是「先于一切」的那一条：上面的路径 nudge 排在它之前，而且计入撞权限预算 ——
		// 路径出了工作树属于「授权与任务不匹配」，父代理放宽范围能解决。
		const gate = dependencyGateVerdict(rule, command, match.access, cwd);
		if (gate) return deny(gate);
		const repeatEvent = w.probe?.noteBashStart(command, match.access, event.toolCallId);
		if (repeatEvent) {
			return repeatEvent.stop
				? w.stop(repeatEvent.reason)
				: { block: true, reason: repeatEvent.reason, terminate: false };
		}
		const helper = helperPath();
		if (!helper) {
			return deny(
				"pi-subagents-extend: the sandbox helper (pi-subagents-extend-helper) was not found; run `pnpm run build:helper` in pi-plugin, or set PI_SUBAGENTS_EXTEND_HELPER.",
			);
		}
		const caps = describeHelper(helper);
		if (!caps?.landlock.supported) {
			const reason = caps?.landlock.reason ?? "helper --describe returned no usable information";
			return deny(`pi-subagents-extend: this kernel cannot enforce the task scope: ${reason}`);
		}
		const spec = buildSpec(cwd, rule, w.policy, w.uiWarning);
		const specFile = writeSpecFile(spec, event.toolCallId);
		if (!specFile) {
			return deny("pi-subagents-extend: cannot write the sandbox spec; check that ~/.cache/pi-subagents-extend is writable");
		}
		// 记下这条命令的写权限清单：tool_result 判「写越界」时要用它当事实依据，
		// 不靠文案猜。
		// 挡住条数上限，避免结果永远不回来的调用把表撑大。被挤出表的条目，结果按定义
		// 不会再回来，所以它的 spec 文件也得删 —— 只 delete 不删文件，「一次调用一份
		// 文件」就会变成永远堆在 ~/.cache 里的垃圾。
		if (w.sandboxSpecs.size >= 64) {
			const oldest = w.sandboxSpecs.keys().next().value as string | undefined;
			if (oldest !== undefined) {
				dropSpecFile(w.sandboxSpecs.get(oldest));
				w.sandboxSpecs.delete(oldest);
			}
		}
		// 同一个 toolCallId 又来一次（模型输出了重复 id）时，只覆盖条目、**不**删旧文件：
		// 重复 id 在真 pi 里只可能是畸形响应，我们无法判断先那次是否已经启动，删掉它就会让
		// 一个还在途的 helper 以 exit 77 死在「读不到 spec」上。留下的孤儿由 shutdown 清扫
		// 按年龄回收 —— 代价是多一份文件，和打死一条命令完全不对称。
		w.sandboxSpecs.set(event.toolCallId, {
			write: spec.write,
			cwd,
			command,
			offline: spec.offline,
			specFile,
		});
		(event.input as { command?: string }).command = wrapInSandbox(
			command,
			specFile,
			helper,
			// helper 的「网络已隔离」提示每会话只值一次：本会话还没播报过就照常播报；
			// 播报过之后（见下）的离线命令加 quiet 前缀让它安静。
			!w.sandboxNetworkNoticeAnnounced,
		);
		// 只有离线命令会让 helper 播报，所以只在这里翻牌：会话先跑了在线命令时，
		// 第一条离线命令仍然是全会话的第一次播报。
		if (spec.offline) w.sandboxNetworkNoticeAnnounced = true;
		return undefined;
	}
	if (EXEC_TOOLS.includes(event.toolName)) {
		// 从来不可用：给多宽的范围、多长的命令白名单都不会打开，所以不计入撞权限。
		return deny(
			`pi-subagents-extend: ${event.toolName} is never available in a scoped session; no grant can widen it. Use a path tool (read / write / the host's edit family) or an allowlisted bash command.`,
		);
	}
	// 路径类工具先判：它们的授权来自范围，不来自 allowTools。顺序反过来就意味着父代理
	// 一旦把名字写进 allowTools，路径判定整个被跳过——写范围在那种宿主上等于失效
	// （实测：allowTools 里写 replace 时，树外路径照写不误）。
	const kind = toolKindOf(w, pi, schemaPathArgs, event.toolName);
	if (kind) {
		const sessionFile =
			ctx?.sessionManager?.getSessionFile?.() ?? process.env.PI_SESSION_FILE ?? undefined;
		return pathToolVerdict(w, event as { toolName: string; input?: unknown }, cwd, kind, sessionFile);
	}

	// SAFE_TOOLS 与 RUNTIME_TOOLS 已经在前面处理过，这里只管调用方显式放行的工具。
	if (w.policy.allowTools.includes(event.toolName)) return undefined;

	return bail(
		w,
		`pi-subagents-extend: tool ${event.toolName} is not on the allow list (fail closed; the parent can add it to allowTools). Tools this layer already judges by scope: ${preview(Object.keys(DEFAULT_TOOL_ACCESS))}.`,
	);
};
