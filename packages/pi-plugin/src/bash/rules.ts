/**
 * bash 白名单的匹配与读写归类。
 *
 * 条目两种写法：
 * - 字面量：按空白切词的前缀匹配。`"pnpm test"` 放行 `pnpm test -t foo`，不放行 `pnpm publish`。
 * - `re:` 前缀：正则，整串锚定（不写 ^$ 也整串）。用来表达一个命令族的多种参数。
 *
 * 不自动探测正则：命令参数本身就常含 `*`、`.`、`(`（glob 输入、shell 分支），
 * 猜错方向是误授权，比误拒绝危险得多。
 *
 * 本层只回答「这条命令在不在白名单里」。命令会不会写、写不写得出去，不在这里判 ——
 * 写是目录授权（writeScope / writablePaths）与内核（Landlock）的事。
 *
 * 从 bash/index.ts 拆出来的规则层：白名单的匹配与 bash 配置的解析。
 * 两层接线（角色 md 基线逐字段补进派单载荷、bash.deny 并集作硬底线）在
 * wiring/context.ts 的 applyRoleBaseline。
 * bash/index.ts 仍是唯一入口，这里的东西由它转出口。
 */

import { leadingAssignments } from "./env.ts";
import { RE_PREFIX, tokens } from "./tokens.ts";


export interface BashRule {
	/** 白名单：只回答「这条命令能不能跑」。写不写由沙箱的目录授权决定，不在这里判。 */
	allow: string[];
	/** 允许网络（默认关闭，沙箱内使用私有网络命名空间）。 */
	network: boolean;
	/**
	 * 额外给予写权限的路径（绝对路径、`~` 开头或相对 cwd）。
	 * pnpm store、mise 的 state 目录这类全局可写区，不在 scope 里，但工具链要写。
	 */
	writablePaths: string[];
	/** 注入到沙箱里的环境变量（写进 spec 的 env 字段）。 */
	env: Record<string, string>;
	/**
	 * 项目内构建/测试产物目录。默认按工具链 marker 判断后放行（并创建），
	 * `false` 关闭整份内置清单，数组在内置清单之上追加。
	 */
	scratchPaths: string[] | false;
	/**
	 * 结构性禁掉的命令，**不可被 bindings 放宽**。来自项目 profile 的 bash.deny，
	 * 与调用方写的 read/write 取并集：即便调用方把同一条命令列进白名单也进不来。
	 */
	deny: string[];
	/**
	 * 命令树停止消耗 CPU 超过这么多秒就杀掉（默认关）。
	 *
	 * 墙钟超时分不开「死锁」和「长编译」，累计 CPU 分得开：干活的树每次采样都在涨，卡住的
	 * 树一动不动。判据由 helper 实现 —— 它是子进程 PID 命名空间的 PID 1，看得见整棵子树。
	 */
	cpuStallSeconds: number | false;
	/**
	 * 是否给沙箱里的 git 注入全局排除规则（node_modules/、.pnpm-store/）。
	 * 默认开：防止子代理 `git add -A` 把依赖目录吸进索引。
	 */
	gitExcludes: boolean;
}


/**
 * 单条模式是否匹配整条命令。`re:` 条目按正则整串匹配；否则按 token 前缀匹配。
 * 空命令永不匹配。
 */
export function commandMatches(pattern: string, command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	const entry = pattern.trim();
	if (entry.startsWith(RE_PREFIX)) {
		const source = entry.slice(RE_PREFIX.length).trim();
		if (!source) return false;
		try {
			return new RegExp(`^(?:${source})$`).test(cmd);
		} catch {
			// 写坏的正则不匹配任何命令（fail closed），而不是让整条规则消失。
			return false;
		}
	}
	const want = tokens(entry);
	if (want.length === 0) return false;
	// 赋值前缀先剥掉再比：条目的第一个 token 指的是程序名，不是它前面的环境变量。
	const have = tokens(leadingAssignments(cmd).rest);
	return want.every((token, i) => have[i] === token);
}


/** 全部条目（供拒绝文案与诊断）。 */
export function allEntries(rule: BashRule): string[] {
	return [...rule.allow];
}

/** 命中禁止列表时返回该条目原文，否则 undefined。 */
export function deniedEntry(rule: BashRule, command: string): string | undefined {
	return rule.deny.find((entry) => commandMatches(entry, command));
}

export function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return (value as unknown[])
		.filter((v): v is string => typeof v === "string" && v.trim() !== "")
		.map((v) => v.trim());
}

function stringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!key.trim()) continue;
		if (typeof raw !== "string" && typeof raw !== "number") continue;
		out[key.trim()] = String(raw);
	}
	return out;
}

/**
 * 解析 bindings 里的 bash 字段。没写、写坏、没给白名单都返回 undefined（= 拒绝 bash）。
 */
export function parseBashRule(raw: unknown): BashRule | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const cfg = raw as Record<string, unknown>;
	const allow = stringList(cfg.allow);
	if (allow.length === 0) return undefined;
	return {
		allow,
		network: cfg.network === true,
		writablePaths: stringList(cfg.writablePaths),
		env: stringMap(cfg.env),
		scratchPaths: cfg.scratchPaths === false ? false : stringList(cfg.scratchPaths),
		gitExcludes: cfg.gitExcludes !== false,
		deny: stringList(cfg.deny),
		// 未写 = 关。这条看门狗杀掉整棵进程树，默认打开会误杀刻意等待的命令（sleep、退避轮询），
		// 而 helper 看不到输出（stdio 是继承的，不走管道），没法用「无输出」佐证。
		cpuStallSeconds: stallSeconds(cfg.cpuStallSeconds),
	};
}

/** `cpuStallSeconds`：未写、写坏、`false`、小于等于 0 一律当关闭。 */
function stallSeconds(value: unknown): number | false {
	// 先 floor 再判断：否则 0.5 会得到 0，而 0 !== false 会把 `stallSeconds: 0` 写进 spec ——
	// 旧版 helper 的 deny_unknown_fields 会因此整份拒绝（退出码 77），正好是「关掉时不写键」
	// 想避免的那种失败。也不接受非数字：`true` 经 Number() 会变成 1，即「静默 1 秒就杀」。
	if (typeof value !== "number" || !Number.isFinite(value)) return false;
	const n = Math.floor(value);
	if (n <= 0) return false;
	return n;
}

/**
 * 「授权写了却永远命中不了」的判定结果。
 */
export interface UnreachableEntry {
	/** 条目原文。 */
	entry: string;
	/** 为什么命中不了：一句可核对的事实。 */
	why: string;
	/**
	 * 判定时实际查看的目录：cwd 的**解析后**路径（`realpathSync`），解不出时才是字面路径。
	 *
	 * 文案要印这个而不是字面 cwd：cwd 经软链进来时，读者按字面链一查就能找到 manifest，
	 * 那条「永远命中不了」的结论于是看起来是错的。
	 */
	lookedIn?: string;
	/** 改成什么：拿不到可靠改法时没有这个字段。 */
	fix?: string;
	/**
	 * cwd 下面所有带 package.json 的目录（相对 cwd 的路径）。
	 *
	 * 有多个候选时给不出可靠的改法：这条授权原本指哪个包只有父代理知道。
	 */
	candidates?: string[];
	/**
	 * 恰好一个候选包、但那个包里没有条目点名的脚本（`pnpm run typecheck` 而包里只有 `lint`）。
	 *
	 * 这是「脚本不存在」，不是「授权不可达」：命令跑起来会得到 pnpm 自己的
	 * "Command not found"，改包目录也治不好。有了这个标记，文案才能说清「没有候选包带这个
	 * 脚本」，而不是让读者去几个候选里「挑一个」—— 挑哪一个都不行。
	 */
	scriptMissing?: string;
}

/** 首个词：条目与命令的程序位。 */
export function firstToken(text: string): string {
	const head = tokens(text.trim())[0];
	return head && head !== "" ? head : "";
}

/** 一条文案里最多列几项。monorepo 下候选包可能有几百个，一条告警不该被它撑爆。 */
export const MAX_LISTED = 8;

/**
 * 把一组路径拼进一条文案，超过上限就截断并说还剩几条。
 *
 * 截断放在**渲染**这一层，不放在收集处：`candidates.length !== 1` 决定「给不给改法」，
 * 收集时就截断会把「12 个候选，判不了」写成「8 个候选，判不了」—— 结论没变，但读者
 * 以为只有 8 个，而且 `… and N more` 里的 N 也没地方算。收集保持完整，只有给人看的
 * 那串字有上限。
 */
export function listedJoin(items: string[]): string {
	if (items.length <= MAX_LISTED) return items.join(", ");
	const rest = items.length - MAX_LISTED;
	return `${items.slice(0, MAX_LISTED).join(", ")}, … and ${rest} more`;
}
