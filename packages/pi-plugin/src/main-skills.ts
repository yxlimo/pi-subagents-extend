/**
 * 主会话侧的 skill 可见性：frontmatter 里声明 `subagent-only: true` 的 skill，从主会话的
 * systemPromptOptions.skills 里摘掉；子会话的列表一个不动（主/子的判定住在
 * wiring/agent-start.ts，这里只做摘除本身）。
 *
 * 为什么不用 frontmatter 的 disable-model-invocation 达成同一目的：那个标志会把 skill 从
 * 主代理的 <available_skills> 广告里也藏掉（pi 的 formatSkillsForPrompt 按它过滤），而
 * pi-subagents 是把 skill 内容直接注入子代理提示文本的——子代理没有 pi 层的 skill 目录
 * 可剥，却会跟着这个标志一起失去 skill。两个机制必须分开，这正是本模块存在的理由。
 *
 * frontmatter 用逐行扫描而不是 yaml 解析：这里只需要读一个布尔值，扫描对写坏的 YAML
 * 天然容忍（没闭合、值不合法都安静地按 false 处理），一个 skill 文件坏掉不该把别的
 * skill 一起弄坏，也不能靠 try/catch 把「解析失败」和「没声明」搅在一起。（来源扩展的
 * 注释给的理由是加载期 import yaml 会拖进 SDK barrel、慢几百毫秒；本仓库 role-config.ts
 * 在加载期就已经 import yaml，那个理由在这里不成立——留下扫描是为了上面的容错。）
 *
 * 读结果按路径 + mtime 缓存：before_agent_start 每轮发射都过这里，同一个 skill 文件
 * 没必要每轮重读盘；文件被改过（mtime 变了）才重读。
 */

import { readFileSync, statSync } from "node:fs";
import type { BeforeAgentStartEvent, Skill } from "@earendil-works/pi-coding-agent";

/** 把 skill 标成子代理专用的 frontmatter 键。 */
const FRONTMATTER_KEY = "subagent-only";

/** frontmatter 的读结果，按文件路径缓存；mtime 没变就直接用缓存值。 */
const cache = new Map<string, { mtimeMs: number; subagentOnly: boolean }>();

/**
 * 从 frontmatter 原文里扫出一个键的布尔值；没有 frontmatter、没闭合、键的值不是 true
 * 都算 false。只认 `key: true`（大小写不敏感），别的值一律不展开。
 */
function frontmatterFlag(raw: string, key: string): boolean {
	if (!raw.startsWith("---")) return false;
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return false;
	for (const line of raw.slice(3, end).split("\n")) {
		const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!match || match[1] !== key) continue;
		return match[2].trim().toLowerCase() === "true";
	}
	return false;
}

/** 这个 skill 文件有没有声明 subagent-only。读不到的 skill 不藏：pi 找到了它，就保留。 */
function isSubagentOnly(skill: Skill): boolean {
	try {
		const stat = statSync(skill.filePath);
		const cached = cache.get(skill.filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.subagentOnly;
		const subagentOnly = frontmatterFlag(readFileSync(skill.filePath, "utf8"), FRONTMATTER_KEY);
		cache.set(skill.filePath, { mtimeMs: stat.mtimeMs, subagentOnly });
		return subagentOnly;
	} catch {
		return false;
	}
}

/**
 * 主会话路径的 skill 过滤（调用点在 wiring/agent-start.ts 的 !child 分支）：
 *
 * - frontmatter 声明 `subagent-only: true` 的 skill 摘掉，其余保留；
 * - 用户提示里点名了的 skill 保留——主代理明确点名要它，摘掉就是抗旨。判据读的是
 *   event.prompt（宿主在 messageType: "user" 的发射里带的原始用户提示），不是
 *   event.systemPrompt：渲染后的 system prompt 含 <available_skills> 广告，本来就有
 *   每个 skill 的名字，拿它判「点名」等于永远保留，这个功能就死了；
 * - 一条都摘不掉就不动 options——不凭空换一个新数组给宿主。
 */
export function dropSubagentOnlySkills(event: BeforeAgentStartEvent): void {
	const options = event.systemPromptOptions;
	const skills = options?.skills;
	if (!skills?.length) return;
	const request = typeof (event as { prompt?: unknown }).prompt === "string" ? (event as { prompt: string }).prompt : "";
	const kept = skills.filter((skill) => request.includes(skill.name) || !isSubagentOnly(skill));
	if (kept.length !== skills.length) options.skills = kept;
}
