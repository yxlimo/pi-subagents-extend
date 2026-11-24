/**
 * 角色 md 的配置源：从 agent 定义文件的 YAML frontmatter 里读出 extend 段，
 * 转换成扩展已有的策略字段。这里只做解析与转换，不参与工具判定。
 *
 * 本阶段接 permissions 下的 scope / write / readOnly / allowTools / budgets / bash；
 * worktree、setup、output 也各有类型化解析入口；各块的接线在 index.ts 里完成，
 * policyFromBlock 只对真正不认识的块名报错。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

import { mainRepoRoot } from "./deliverable.ts";
export const BINDING_NAMESPACE = "pi-subagents-extend";
export const BINDING_VERSION = 1;

export const bindingKey = (): string => `${BINDING_NAMESPACE}/${BINDING_VERSION}`;

/** md 里的 bash 单列授权。 */
export interface RoleBashPolicy {
	allow?: string[];
	deny?: string[];
	writable?: boolean;
	network?: boolean;
}

/** md 基线能提供的字段，名字与现有 bindings 的策略字段对齐。 */
export interface RolePolicy {
	scope?: string[];
	writeScope?: string[];
	readOnly?: boolean;
	allowTools?: string[];
	maxDenies?: number;
	maxWriteDenies?: number;
	bash?: RoleBashPolicy;
}


/** md 里的工作树策略：块缺席表示不介入；块存在但没写 nodeModules 时默认 keep。 */
export interface RoleWorktreeConfig {
	enabled?: boolean;
	nodeModules?: "keep" | "remove";
}

/** md 里的执行前脚本。 */
export interface RoleSetupConfig {
	preExec?: string;
}

/** md 里的交付物相对路径。 */
export interface RoleOutputConfig {
	deliverable?: string;
}
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const XML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

/**
/**
 * 子代理提示里的 `<active_agent name="…"/>` 跟在重写后的提示后面，不一定在第一行。
 * 逐行找第一条「整行只有这个标签」的行：上下文里引用到的同类标签不能当成当前角色。
 * 属性值做过 XML 转义，找到以后再解码。
 */
export function parseRoleName(systemPrompt: string): string | null {
	for (const line of systemPrompt.split(/\r?\n/)) {
		const match = /^\s*<active_agent\s+name="([^"]*)"\s*\/>\s*$/.exec(line);
		if (!match || !match[1]) continue;
		const name = match[1].replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, code: string) => {
			if (code.startsWith("#")) {
				const hex = code[1] === "x";
				const value = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
				return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
			}
			return XML_ENTITIES[code] ?? whole;
		});
		return name.trim() ? name : null;
	}
	return null;
}

const MAX_MD_PARENT_LEVELS = 8;

/**
 * 链接工作树属于某个主检出，而角色 md 是「项目」的配置，不是这块磁盘位置的配置：工作树建在
 * ~/.pi/worktrees 下时，从它向上找不到工作目录的 .pi，子代理于是拿不到任何策略 —— 实测就是
 * 这么 fail-open 的（子代理在工作树里 `git commit --allow-empty` 直接成功）。
 *
 * 主检出锚点不在这里重算：deliverable.ts 的 mainRepoRoot 已经回答过同一个问题（gitfile 的
 * commondir、git worktree list、子目录情形都在它里面，且有测试）。这里只在锚点确实不是当前
 * 目录时补一段向上链，普通检出下与改动前完全一致。
 */
function mainCheckoutRoots(cwd: string): string[] {
	const { root } = mainRepoRoot(cwd);
	return root && root !== resolve(cwd) ? [root] : [];
}

/**
 * md 的查找目录：从会话 cwd 起逐级向上，每级先看 .pi/agents 再看 .agents；链接工作树
 * 再按主检出向上走一遍；最后才是用户目录的两级。向上封顶 8 层，异常深的路径也不至于无限扫。
 */
export function agentMdDirs(cwd: string, home: string): string[] {
	const dirs: string[] = [];
	const seen = new Set<string>();
	const walk = (from: string) => {
		let current = resolve(from);
		for (let level = 0; level < MAX_MD_PARENT_LEVELS; level += 1) {
			for (const dir of [join(current, ".pi", "agents"), join(current, ".agents")]) {
				if (seen.has(dir)) continue;
				seen.add(dir);
				dirs.push(dir);
			}
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	};
	walk(cwd);
	for (const root of mainCheckoutRoots(cwd)) walk(root);
	dirs.push(join(home, ".pi", "agent", "agents"), join(home, ".agents"));
	return dirs;
}

/** agent md 的解析顺序：项目两级在用户两级之前，逐级向上，命中即停。 */
export function resolveAgentFile(role: string, cwd: string, home: string): string | null {
	if (!role) return null;
	for (const dir of agentMdDirs(cwd, home)) {
		const file = join(dir, `${role}.md`);
		if (existsSync(file)) return file;
	}
	return null;
}

/** 一次 md 扫描得到的候选：角色名、文件、正文探针，以及 frontmatter 是否声明了 extend。 */
interface RoleMdCandidate {
	role: string;
	file: string;
	probe: string;
	declaresExtend: boolean;
}

/** 探针长度：够长以避开「# reviewer」这类通用开头，够短以容忍宿主截掉正文尾部。 */
const BODY_PROBE_LENGTH = 120;
/** 一次扫描最多看多少个 md，异常目录不该把接线拖慢。 */
const MAX_ROLE_MD_FILES = 32;

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * 扫描角色 md 目录，取正文（去掉 frontmatter）归一化后的前 120 字符当探针。
 * 读不到、frontmatter 没闭合、正文为空的文件都跳过；同一路径只算一次，否则重复目录会误报歧义。
 */
function scanRoleMdCandidates(cwd: string, home: string): RoleMdCandidate[] {
	const candidates: RoleMdCandidate[] = [];
	const seen = new Set<string>();
	for (const dir of agentMdDirs(cwd, home)) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue; // 目录不存在或不可读：跳过
		}
		for (const name of names) {
			if (!name.endsWith(".md") || candidates.length >= MAX_ROLE_MD_FILES) continue;
			const file = join(dir, name);
			const key = resolve(file);
			if (seen.has(key)) continue;
			seen.add(key);
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue; // 角色 md 可能不可读：静默跳过
			}
			const lines = text.split(/\r?\n/);
			let body = text;
			let frontmatter: string | undefined;
			if (lines[0]?.trim() === "---") {
				const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
				if (end < 0) continue; // frontmatter 没闭合：不拿它判身份
				frontmatter = lines.slice(1, end).join("\n");
				body = lines.slice(end + 1).join("\n");
			}
			const normalised = collapseWhitespace(body);
			if (!normalised) continue; // 空正文不参与匹配，否则空探针会命中所有提示
			let declaresExtend = false;
			if (frontmatter !== undefined) {
				try {
					declaresExtend = asRecord(parse(frontmatter))?.extend !== undefined;
				} catch {
					// frontmatter 不是合法 YAML：不算声明了 extend
				}
			}
			candidates.push({ role: name.slice(0, -3), file, probe: normalised.slice(0, BODY_PROBE_LENGTH), declaresExtend });
		}
	}
	return candidates;
}

export interface RoleResolution {
	role: string | null;
	warnings: string[];
	extendMdSeen: boolean;
}

/**
 * 先找 <active_agent> 标签；找不到（如 systemPromptMode: replace 丢了标签）再用每个 md 的正文
 * 探针匹配提示。唯一命中才认角色；零命中交回调用方按原样告警；多命中一律当没身份并点名候选，
 * 绝不猜一个。标签优先保证原有宿主行为不变，也保证正文误命中时标签仍能定案。
 */
export function resolveRoleFromPrompt(systemPrompt: string, cwd: string, home: string): RoleResolution {
	const tag = parseRoleName(systemPrompt);
	if (tag) return { role: tag, warnings: [], extendMdSeen: false };

	const candidates = scanRoleMdCandidates(cwd, home);
	const extendMdSeen = candidates.some((candidate) => candidate.declaresExtend);
	const normalisedPrompt = collapseWhitespace(systemPrompt);
	const matches = candidates.filter((candidate) => normalisedPrompt.includes(candidate.probe));
	if (matches.length === 1) return { role: matches[0].role, warnings: [], extendMdSeen };
	if (matches.length > 1) {
		const names = matches.map((candidate) => `${candidate.role} (${candidate.file})`).join(", ");
		return {
			role: null,
			warnings: [`pi-subagents-extend: the prompt body matches more than one role md, so no role was selected; candidates: ${names}. Add a <active_agent> tag to disambiguate.`],
			extendMdSeen,
		};
	}
	return { role: null, warnings: [], extendMdSeen };
}
/** 读 frontmatter 里的 extend 对象；没有 frontmatter 或没有 extend 都不算问题。 */
export function readExtendBlock(file: string): { block?: Record<string, unknown>; problems: string[] } {
	const problems: string[] = [];
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		problems.push(`unable to read ${file}: ${error instanceof Error ? error.message : String(error)}`);
		return { problems };
	}
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { problems };
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return { problems };
	let parsed: unknown;
	try {
		parsed = parse(lines.slice(1, end).join("\n"));
	} catch (error) {
		problems.push(`invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`);
		return { problems };
	}
	const extend = asRecord(parsed)?.extend;
	if (extend === undefined) return { problems };
	const block = asRecord(extend);
	if (!block) {
		problems.push("extend must be an object");
		return { problems };
	}
	return { block, problems };
}

const TOP_LEVEL_KEYS = new Set(["permissions", "worktree", "setup", "output"]);
const PERMISSION_KEYS = new Set(["scope", "write", "readOnly", "allowTools", "budgets", "bash"]);

/** permissions → 现有策略字段；写错的键报出来并省掉，不让坏值混进策略。 */
export function policyFromBlock(block: Record<string, unknown>): { policy?: RolePolicy; problems: string[] } {
	const problems: string[] = [];
	const policy: RolePolicy = {};

	for (const key of Object.keys(block)) {
		if (!TOP_LEVEL_KEYS.has(key)) problems.push(`${key}: unknown block`);
	}

	const permissions = asRecord(block.permissions);
	if (block.permissions !== undefined && !permissions) {
		problems.push("permissions must be an object");
		return { policy, problems };
	}
	if (!permissions) return { policy, problems };

	const stringList = (key: "scope" | "write" | "allowTools"): string[] | undefined => {
		const value = permissions[key];
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
			problems.push(`permissions.${key} must be an array of strings`);
			return undefined;
		}
		return value as string[];
	};
	const scope = stringList("scope");
	if (scope) policy.scope = scope;
	const write = stringList("write");
	if (write) policy.writeScope = write;
	const allowTools = stringList("allowTools");
	if (allowTools) policy.allowTools = allowTools;

	if (permissions.readOnly !== undefined) {
		if (typeof permissions.readOnly === "boolean") policy.readOnly = permissions.readOnly;
		else problems.push("permissions.readOnly must be a boolean");
	}
	if (permissions.bash !== undefined) {
		const bash = asRecord(permissions.bash);
		if (!bash) {
			problems.push("permissions.bash must be an object");
		} else {
			const converted: RoleBashPolicy = {};
			const bashList = (key: "allow" | "deny"): string[] | undefined => {
				const value = bash[key];
				if (value === undefined) return undefined;
				if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
					problems.push(`permissions.bash.${key} must be an array of strings`);
					return undefined;
				}
				return value as string[];
			};
			const allow = bashList("allow");
			if (allow) converted.allow = allow;
			const deny = bashList("deny");
			if (deny) converted.deny = deny;
			for (const key of ["writable", "network"] as const) {
				const value = bash[key];
				if (value === undefined) continue;
				if (typeof value !== "boolean") {
					problems.push(`permissions.bash.${key} must be a boolean`);
					continue;
				}
				converted[key] = value;
			}
			for (const key of Object.keys(bash)) {
				if (!["allow", "deny", "writable", "network", "dependencyGate"].includes(key)) {
					problems.push(`permissions.bash.${key}: unknown key`);
				}
			}
			if (Object.keys(converted).length > 0) policy.bash = converted;
		}
	}
	for (const key of Object.keys(permissions)) {
		if (!PERMISSION_KEYS.has(key)) problems.push(`permissions.${key}: unknown key`);
	}

	const budgets = asRecord(permissions.budgets);
	if (permissions.budgets !== undefined && !budgets) {
		problems.push("permissions.budgets must be an object");
	} else if (budgets) {
		const budgetNumber = (key: "deny" | "writeDeny"): number | undefined => {
			const value = budgets[key];
			if (value === undefined) return undefined;
			if (typeof value !== "number" || !Number.isFinite(value)) {
				problems.push(`permissions.budgets.${key} must be a number`);
				return undefined;
			}
			return value;
		};
		const deny = budgetNumber("deny");
		if (deny !== undefined) policy.maxDenies = deny;
		const writeDeny = budgetNumber("writeDeny");
		if (writeDeny !== undefined) policy.maxWriteDenies = writeDeny;
	}

	return { policy, problems };
}

/** 取 extend 下的一个子块；类型不对就报出来并当作缺席。 */
const subBlock = (
	block: Record<string, unknown>,
	key: "worktree" | "setup" | "output",
	problems: string[],
): Record<string, unknown> | undefined => {
	const value = block[key];
	if (value === undefined) return undefined;
	const record = asRecord(value);
	if (!record) problems.push(`${key} must be an object`);
	return record;
};

/** extend.worktree → 工作树策略；缺席时不返回 worktree 字段。 */
export function worktreeFromBlock(block: Record<string, unknown>): { worktree?: RoleWorktreeConfig; problems: string[] } {
	const problems: string[] = [];
	const raw = subBlock(block, "worktree", problems);
	if (!raw) return { problems };
	const worktree: RoleWorktreeConfig = { nodeModules: "keep" };
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") worktree.enabled = raw.enabled;
		else problems.push("worktree.enabled must be a boolean");
	}
	if (raw.nodeModules !== undefined) {
		if (raw.nodeModules === "keep" || raw.nodeModules === "remove") worktree.nodeModules = raw.nodeModules;
		else problems.push('worktree.nodeModules must be "keep" or "remove"');
	}
	for (const key of Object.keys(raw)) {
		if (key !== "enabled" && key !== "nodeModules") problems.push(`worktree.${key}: unknown key`);
	}
	return { worktree, problems };
}

/** extend.setup → 派单前要执行的命令。 */
export function setupFromBlock(block: Record<string, unknown>): { setup?: RoleSetupConfig; problems: string[] } {
	const problems: string[] = [];
	const raw = subBlock(block, "setup", problems);
	if (!raw) return { problems };
	const setup: RoleSetupConfig = {};
	if (raw.preExec !== undefined) {
		if (typeof raw.preExec === "string") setup.preExec = raw.preExec;
		else problems.push("setup.preExec must be a string");
	}
	for (const key of Object.keys(raw)) {
		if (key !== "preExec") problems.push(`setup.${key}: unknown key`);
	}
	return { setup, problems };
}

/** extend.output → 交付物；越界路径报出来并省掉，不让配置变成一个越权的链接。 */
export function outputFromBlock(block: Record<string, unknown>): { output?: RoleOutputConfig; problems: string[] } {
	const problems: string[] = [];
	const raw = subBlock(block, "output", problems);
	if (!raw) return { problems };
	const output: RoleOutputConfig = {};
	if (raw.deliverable !== undefined) {
		if (typeof raw.deliverable !== "string") {
			problems.push("output.deliverable must be a string");
		} else if (
			raw.deliverable.length === 0 ||
			raw.deliverable.startsWith("/") ||
			/^[a-zA-Z]:[\\/]/.test(raw.deliverable) ||
			raw.deliverable.split(/[\\/]/).includes("..")
		) {
			problems.push("output.deliverable must be a relative path inside the worktree");
		} else {
			output.deliverable = raw.deliverable;
		}
	}
	for (const key of Object.keys(raw)) {
		if (key !== "deliverable") problems.push(`output.${key}: unknown key`);
	}
	return { output, problems };
}
