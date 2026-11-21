import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DenyCounter } from "../budgets.ts";
import { deliverableTarget, ensureDeliverableLink, mainRepoRoot } from "../deliverable.ts";
import { canonical } from "../paths.ts";
import { denyAll } from "../policy.ts";
import { agentMdDirs, outputFromBlock, parseRoleName, policyFromBlock, readExtendBlock, resolveAgentFile, resolveRoleFromPrompt, setupFromBlock, worktreeFromBlock } from "../role-config.ts";
import { setDeliverableTargetPath } from "../sandbox.ts";
import { dropSubagentOnlySkills } from "../main-skills.ts";
import type { Wiring } from "./context.ts";

/**
 * before_agent_start 的正文，连同它专用的接线簇（deliverableGrant / wireDeliverable /
 * wireWorktree / wirePreExec / nodeModulesWriteHint）逐字搬自 index.ts。模块级状态
 * worktreeNodeModules 只被这条链写入，所以住在本模块；uiWarning 曾经也是（模块级 let
 * + setUiWarning），现在是 Wiring 的字段（见 wiring/context.ts）：session_start、
 * judgeToolCall 与本处理器都注册各自的通道，最近一次写入的生效。四个导出的接线函数
 * 由 index.ts 原样再导出（阶段 3 的测试从 index.ts 取它们）。
 */

const DELIVERABLE_SECTION = "pi_subagents_extend_deliverable";

/**
 * 交付物授权只给主检出里的一个普通文件：目录会把整棵子树变成写面，软链会把授权指到树外。
 * 不存在时用 wx 落位——检查和落位之间被换成软链就宁可失败，绝不跟着链接写。
 * 落位前后都按 canonical 的主检出根做边界检查：先挡住软链父目录，再校验最终授权。
 */
function deliverableGrant(target: string, root: string, warn: (message: string) => void): string | undefined {
	let stat: ReturnType<typeof lstatSync> | undefined;
	try {
		stat = lstatSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warn(`pi-subagents-extend: cannot inspect deliverable ${target}: ${error instanceof Error ? error.message : String(error)}; granting nothing`);
			return undefined;
		}
	}
	if (stat) {
		if (stat.isSymbolicLink() || !stat.isFile()) {
			const kind = stat.isSymbolicLink() ? "a symbolic link" : "a directory or special file";
			warn(`pi-subagents-extend: deliverable ${target} is not a regular file (${kind}); granting nothing (a directory would open its whole subtree, a link could point outside the main checkout)`);
			return undefined;
		}
	}

	const rootCanonical = canonical(root);
	const insideCheckout = (candidate: string): boolean =>
		candidate === rootCanonical || candidate.startsWith(rootCanonical + sep);

	// 落位前先解析父目录（取最深已存在祖先）：软链父目录会把新文件写到主检出之外。
	// 旧的 realpathSync(grant) !== resolve(grant) 是空操作——grant 已由 canonical 解析，两边必然相等。
	const parentCanonical = canonical(dirname(target));
	if (!insideCheckout(parentCanonical)) {
		warn(`pi-subagents-extend: deliverable ${target} resolves outside the main checkout (${join(parentCanonical, basename(target))}); granting nothing`);
		return undefined;
	}

	if (!stat) {
		try {
			// helper 只接受已存在的路径；空文件先落位，真正的写入仍交给子代理。
			mkdirSync(dirname(target), { recursive: true });
			closeSync(openSync(target, "wx"));
		} catch (error) {
			warn(`pi-subagents-extend: unable to create deliverable file ${target}: ${error instanceof Error ? error.message : String(error)}; granting nothing`);
			return undefined;
		}
	}

	const grant = canonical(target);
	if (!insideCheckout(grant)) {
		warn(`pi-subagents-extend: deliverable ${target} resolves outside the main checkout (${grant}); granting nothing`);
		return undefined;
	}
	return grant;
}

/**
 * output.deliverable 的接线：建软链、把真实文件加进写授权、并给子代理一条提示段落。
 * 抽成具名函数是为了让阶段 3 的测试能直接走同一条路径，而不是复制一份判定。
 */
export function wireDeliverable(
	cwd: string,
	block: Record<string, unknown> | undefined,
	policy: { absoluteWrite: string[] },
	options: { sections?: Record<string, string> } | undefined,
	warn: (message: string) => void,
): { link?: ReturnType<typeof ensureDeliverableLink>; target?: string } {
	setDeliverableTargetPath(undefined);
	const { output, problems } = outputFromBlock(block ?? {});
	for (const problem of problems) warn(`pi-subagents-extend: ${problem}`);
	if (!output?.deliverable) return {};
	const deliverable = output.deliverable;
	const anchor = mainRepoRoot(cwd);
	if (anchor.root === null) {
		warn(`pi-subagents-extend: cannot locate the main repository from ${cwd}; tried: ${anchor.tried.join(" | ")}`);
		return {};
	}
	const link = ensureDeliverableLink(cwd, anchor.root, deliverable);
	if ("warning" in link) warn(`pi-subagents-extend: ${link.warning}`);
	const target = deliverableTarget(anchor.root, deliverable);
	const grant = deliverableGrant(target, anchor.root, warn);
	if (!grant) return { link, target };
	if (!policy.absoluteWrite.includes(grant)) policy.absoluteWrite.push(grant);
	setDeliverableTargetPath(grant);
	if (options) {
		options.sections = {
			...(options.sections ?? {}),
			[DELIVERABLE_SECTION]: `Write the deliverable to \`${deliverable}\`. Name the file in your final message; the parent reads it at \`${grant}\`.`,
		};
	}
	return { link, target };
}

/** 会话级记住 nodeModules 的选择；写在拒绝文案里的提示只在 keep / 缺席时给，remove 后给就是假提示。 */
let worktreeNodeModules: "keep" | "remove" = "keep";

/** 写目标是否穿过 cwd/node_modules 这条软链，包括子代理直接写出主检出的真实路径。 */
export function nodeModulesWriteHint(cwd: string, target: string): string {
	if (worktreeNodeModules !== "keep") return "";
	const link = resolve(cwd, "node_modules");
	let absolute: string;
	try {
		if (!lstatSync(link).isSymbolicLink()) return "";
		absolute = resolve(cwd, target);
	} catch {
		return "";
	}
	if (absolute !== link && !absolute.startsWith(link + sep)) {
		try {
			const real = realpathSync(link);
			if (!absolute.startsWith(real + sep)) return "";
		} catch {
			return "";
		}
	}
	return " Set worktree.nodeModules: remove in the role md to unlink the shared node_modules link.";
}

/** worktree.nodeModules: remove 只解掉工作树侧的软链，目标（主检出里的依赖）必须留下。 */
export function wireWorktree(
	cwd: string,
	block: Record<string, unknown> | undefined,
	warn: (message: string) => void,
): { action: "none" | "removed" | "skipped" } {
	const { worktree, problems } = worktreeFromBlock(block ?? {});
	for (const problem of problems) warn(`pi-subagents-extend: ${problem}`);
	worktreeNodeModules = worktree?.nodeModules ?? "keep";
	if (worktree?.nodeModules !== "remove") return { action: "none" };

	const link = resolve(cwd, "node_modules");
	let target: string;
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(link);
	} catch {
		return { action: "none" };
	}
	if (!stat.isSymbolicLink()) {
		warn(`pi-subagents-extend: ${link} is a real directory; left it untouched`);
		return { action: "skipped" };
	}
	try {
		target = resolve(dirname(link), readlinkSync(link));
	} catch (error) {
		warn(`pi-subagents-extend: unable to read link ${link}: ${error instanceof Error ? error.message : String(error)}`);
		return { action: "skipped" };
	}
	const anchor = mainRepoRoot(cwd);
	if (anchor.root === null || (target !== anchor.root && !target.startsWith(anchor.root + sep))) {
		warn(`pi-subagents-extend: ${link} points to ${target}, outside the main checkout; left it untouched`);
		return { action: "skipped" };
	}
	try {
		unlinkSync(link);
	} catch (error) {
		warn(`pi-subagents-extend: unable to unlink ${link}: ${error instanceof Error ? error.message : String(error)}`);
		return { action: "skipped" };
	}
	warn(`pi-subagents-extend: removed ${link}; the target ${target} was left untouched`);
	return { action: "removed" };
}

/** setup.preExec 每个子会话跑一次；失败只告警，绝不让派单半路停下。 */
export async function wirePreExec(
	cwd: string,
	block: Record<string, unknown> | undefined,
	warn: (message: string) => void,
): Promise<{ ran: boolean; status?: number | null }> {
	const { setup, problems } = setupFromBlock(block ?? {});
	for (const problem of problems) warn(`pi-subagents-extend: ${problem}`);
	const command = setup?.preExec;
	if (!command) return { ran: false };

	// 冷工作树里装依赖常常要好几分钟，所以给足 10 分钟。这里故意不走 helper：命令要往
	// 工作树（以及包管理器缓存）里写，而 helper 的可写面只覆盖本次写授权，天然罩不住安装。
	let child: ReturnType<typeof spawn>;
	try {
		// detached 让命令自带进程组；超时杀整组，不留装依赖时 fork 出去的孙进程。
		child = spawn(command, { shell: true, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		warn(`pi-subagents-extend: setup.preExec could not start: ${error instanceof Error ? error.message : String(error)}; continuing`);
		return { ran: true };
	}

	const pid = child.pid;
	const maxOutput = 4 * 1024 * 1024;
	let output = "";
	const collect = (chunk: Buffer | string): void => {
		output = (output + chunk.toString("utf8")).slice(-maxOutput);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		if (pid !== undefined) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// 进程组已经退出；组杀失败无需处理。
			}
		}
	}, 600_000);
	// 子进程及其 stdout/stderr 管道会撑住事件循环，超时对运行中的子进程照样生效；unref 只防止
	// 会话先结束时被这个十分钟的定时器吊住（进程退出时 clearTimeout 会把它摘掉）。
	timer.unref();

	const outcome = await new Promise<{ status: number | null; error?: Error }>((resolve) => {
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve({ status: null, error });
		});
		child.once("close", (status) => {
			clearTimeout(timer);
			resolve({ status });
		});
	});

	if (outcome.error || outcome.status !== 0) {
		const tail = output.split(/\r?\n/).slice(-20).join("\n").slice(-2000) || "(no output)";
		const code = outcome.error
			? `no exit code (${outcome.error.message})`
			: timedOut
				? "no exit code (timed out after 600000ms; killed the process group)"
				: outcome.status === null
					? "no exit code (killed by signal)"
					: String(outcome.status);
		warn(`pi-subagents-extend: setup.preExec exited with code ${code}; continuing. Output tail:\n${tail}`);
	}
	return { ran: true, status: outcome.status };
}

/**
 * before_agent_start 的正文（逐字搬自 index.ts 的处理器）：认子会话身份，按角色 md 补
 * 基线，再依次接交付物、worktree 与 preExec。preExec 最长等十分钟，期间同一键的再次
 * 触发在 roleWirings 上 await 在飞的接线，不重跑。
 */
export async function wireAgentStart(w: Wiring, event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
	const raw = (event as { systemPrompt?: unknown }).systemPrompt;
	const prompt = typeof raw === "string" ? raw : "";
	const cwd = ctx.cwd ?? process.cwd();
	// 实测：前台子代理的 process.env.PI_SUBAGENT_CHILD 是 null —— pi-subagents 只为
	// host === "runner" 的后台子代理设它，前台在父进程里 restoreProcessEnv。
	// 所以子会话另看 bindings 载荷与提示里的角色身份；别把这行简化回只看 PI_SUBAGENT_CHILD。
	const child =
		process.env.PI_SUBAGENT_CHILD === "1" ||
		w.call.config !== undefined ||
		w.call.error !== undefined ||
		parseRoleName(prompt) !== null ||
		resolveRoleFromPrompt(prompt, cwd, homedir()).role !== null;
	if (!child) {
		// 主会话：把 frontmatter 声明 subagent-only: true 的 skill 从可用列表摘掉
		// （机制与理由见 main-skills.ts）。子会话不分前台后台一律不碰 skills——
		// 子代理的 skill 列表属于给它定的那次派单。
		dropSubagentOnlySkills(event);
		return;
	}
	if (w.roleResolved) return;
	const tag = parseRoleName(prompt);
	const wiringKey = `${cwd}\u0000${tag}`;
	const inFlight = w.roleWirings.get(wiringKey);
	if (inFlight) {
		await inFlight;
		return;
	}
	let finishWiring!: () => void;
	const wiring = new Promise<void>((resolve) => { finishWiring = resolve; });
	w.roleWirings.set(wiringKey, wiring);
	try {
		// 模块级状态在子会话开始时清零，不依赖 session_start 与 before_agent_start 的先后顺序。
		setDeliverableTargetPath(undefined);
		worktreeNodeModules = "keep";
		const ui = ctx.ui as { notify?: (m: string, t?: string) => void } | undefined;
		w.uiWarning = (message) => { ui?.notify?.(message, "warning"); };
		for (const name of w.call.ignored ?? []) {
			const mdKey = name === "setup" ? "setup.preExec" : "output.deliverable";
			w.uiWarning?.(`pi-subagents-extend: ${name} in extensionBindings is ignored; put ${mdKey} in the role md`);
		}
		const home = homedir();
		// 标签找不到时再用正文探针认角色（systemPromptMode: replace 会丢标签）。
		// 扫描只在这里发生：前面的 roleResolved / roleWirings 闸门保证每轮接线最多跑一次。
		const resolved = resolveRoleFromPrompt(prompt, cwd, home);
		for (const warning of resolved.warnings) w.uiWarning?.(warning);
		const role = resolved.role;
		if (!role) {
			let warning = w.policy.active
				? `pi-subagents-extend: no active_agent role was found in the system prompt, so the role md limits are NOT applied; the only configuration in effect is ${w.policy.source}.`
				: "pi-subagents-extend: no active_agent role was found in the system prompt, so the role md limits are NOT applied; no configuration is in effect, so tool calls in this child are unconstrained.";
			if (resolved.extendMdSeen) {
				// 有 md 声明了 extend 却没认出身份，点明最可能的成因与改法，免得反复撞限制。
				warning += `\npi-subagents-extend: a role md declares an extend block, but the prompt has no <active_agent> tag and no md body matched; systemPromptMode: replace drops the tag — use append (or keep the md body intact) so the role can be identified.`;
			}
			w.uiWarning?.(warning);
			// 这次发射没有身份（无标签、正文也无唯一命中）：不能在这里闩上
			// roleResolved——会话重发且第二次带上 <active_agent> 标签时，角色 md 必须
			// 仍然生效（preExec 也从未跑过，晚到的那次接线照跑一次）。落闩的只有两条
			// 路：认出角色走完整接线（见本函数末尾），以及 md 坏掉的 denyAll 路径
			// （坏 md 绝不静默降级成「无角色」，也不逐轮重试）。
			return;
		}
		const file = resolveAgentFile(role, cwd, home);
		if (!file) {
			w.uiWarning?.(
				`pi-subagents-extend: no role md was found for role "${role}"; the role md limits are NOT applied. Looked in: ${agentMdDirs(cwd, home).join(", ")}`,
			);
			w.roleResolved = true;
			return;
		}
		const read = readExtendBlock(file);
		const converted = read.block ? policyFromBlock(read.block) : { problems: [] as string[] };
		const problems = [...read.problems, ...converted.problems];
		for (const problem of problems) {
			w.uiWarning?.(`pi-subagents-extend: ${role} (${file}): ${problem}`);
		}
		// md 存在且声明了策略却用不上 = 配置坏了，必须 fail closed：用户配的限制一样都没生效，
		// 静默放开比全拒危险。全拒并把 md 路径与问题原文点名进拒绝文案——那是父代理改错的唯一线索。
		// 两个不算问题的缺口保持原样：md 没有 extend 块（不表达限制是合法角色）与找不到 md
		// （内置角色本来就没有，全拒会把普通子代理锁死）。
		if (problems.length > 0) {
			w.roleSource = `role md ${file}`;
			w.probe?.dispose();
			w.policy = denyAll(
				`role md ${file} could not be applied (${problems.join("; ")}); everything is refused — fix the extend block in the md, then dispatch again`,
			);
			w.denyCounter = new DenyCounter(w.policy.maxDenies);
			w.writeDenyCounter = new DenyCounter(w.policy.maxWriteDenies, "write");
			w.armProbe();
		} else if (converted.policy && Object.keys(converted.policy).length > 0) {
			w.roleBaseline = converted.policy;
			w.roleSource = `role md ${file}`;
			w.applyRoleBaseline();
		}
		wireDeliverable(
			cwd,
			read.block,
			w.policy,
			(event as { systemPromptOptions?: { sections?: Record<string, string> } }).systemPromptOptions,
			(message) => w.uiWarning?.(message),
		);
		wireWorktree(cwd, read.block, (message) => w.uiWarning?.(message));
		await wirePreExec(cwd, read.block, (message) => w.uiWarning?.(message));
	} finally {
		w.roleWirings.delete(wiringKey);
		finishWiring();
	}
	w.roleResolved = true;
}
