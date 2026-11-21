/**
 * NOTICES 层：扩展说给人（父代理的 UI 告警）与模型（注解、提示）听的话里，关于授权本身的
 * 那一部分：不可达条目的原因与改法、legacy 配置的迁移提示、角色 md 未跟踪的告警。
 * 措辞只在这里写一份；index.ts 只做接线。UI 告警通道由调用方传入：模块级函数拿不到 `ctx`。
 * 模块拆分第五步：以下声明从 index.ts 原样搬出，行为不变。
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { allEntries, classifyCommand, commandNeedsNoManifest, firstToken, leadingAssignments, listedJoin, MAX_LISTED, unreachableEntries, type BashRule, type UnreachableEntry } from "./bash-match.ts";
import { mainRepoRoot } from "./deliverable.ts";

/** 旧一代 bindings 文件的位置（相对会话 cwd），仅用于兼容层提示。 */
export const PROFILE_FILE = ".pi/subagent-bindings.json";

/** 老一代 agent profile 目录（相对会话 cwd），仅用于兼容层提示。 */
const AGENT_PROFILES_DIR = ".pi/agent-profiles";

/** worktree 默认值依赖的角色 md：确认未被 git 跟踪的只提示一次（session_start 清空）。 */
export const reportedUntrackedWorktreeProfiles = new Set<string>();
/** 迁移告警：legacy bash.read / bash.write 只说一次（session_start 清空）。 */
export const warnedLegacyBashColumns = new Set<string>();

/** 兼容层文件提示按绝对路径去重，整进程只说一次；不在 session_start 清空。 */
const warnedCompatLayer = new Set<string>();

/** 沙箱注解的前缀：与 `sandbox-note.ts` 里的注解同一个标记。 */
const SANDBOX_MARK = "[sandbox]";

/**
 * 「没有候选包带这个脚本」这一句：告警和工具结果共用，措辞只能有一份。
 *
 * 分成两处各写一遍，两边的措辞就会慢慢分开（一边大写、一边小写就够让读者以为是两件
 * 不同的事），而这条消息的全部价值就在于它说的是一件确定的事。
 */
function scriptMissingClause(script: string): string {
	return `no candidate has a \`${script}\` script`;
}

/** 同一句话放在句首时用这个：只动首字母，措辞不另写一份。 */
function sentenceCase(text: string): string {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** 候选超过上限时的补充说明；没被截断时不给。 */
function truncationNote(list: string[]): string {
	return list.length > MAX_LISTED ? ` (only the first ${MAX_LISTED} are listed)` : "";
}

/**
 * 候选提示：给不出可靠改法时，把候选列出来让父代理挑。
 *
 * 多个包时「这条授权原本指哪个包」只有父代理知道：随便挑一个再给一条 `--dir`
 * 建议，会把命令指到别的包上。
 *
 * `scriptMissing` 有值时不许再写「挑一个」：那个包里连脚本都没有，挑它跑出来是
 * "Command not found"，改包目录治不好这件事。说清「没有候选带这个脚本」才是真事实。
 * 候选超过上限时截断（见 `listedJoin`），并用 `truncationNote` 说一句「没列全」：
 * 几百个包路径拼进一条告警没人读得完，但让人去挑看不见的那几个同样不行。
 */

function candidateHint(item: UnreachableEntry): string {
	if (item.fix) return "";
	if (item.scriptMissing) return `; ${scriptMissingClause(item.scriptMissing)}`;
	const list = item.candidates ?? [];
	if (!list.length) return "";
	return `; candidates: ${listedJoin(list)} — pick the one this entry meant${truncationNote(list)}`;
}

/**
 * 注解里「那该怎么办」的那一句。四种事实各说各的，不含糊：
 *
 * - 有可靠改法（恰好一个候选、且它有这个脚本）→ 直接给改法；
 * - 一个候选但缺脚本 → 说清「没有候选带这个脚本」，别再让人去挑；
 * - 多个候选 → 列出来让父代理挑（它才知道这条授权原本指谁）；
 * - 连候选都没有 → 只能由父代理指明一个带 manifest 的目录。
 *
 * 顺序不能换：`scriptMissing` 一定同时有 `candidates`，先判候选就会把「脚本不存在」
 * 说成「包选错了」，而改包目录治不好后者。
 */
function remedyFor(item: UnreachableEntry): string {
	if (item.fix) return `Use ${item.fix} instead.`;
	if (item.scriptMissing) return `${sentenceCase(scriptMissingClause(item.scriptMissing))}.`;
	if (item.candidates && item.candidates.length) {
		return `Candidates: ${listedJoin(item.candidates)} — pick the one this entry meant${truncationNote(item.candidates)}.`;
	}
	return "The parent has to point this entry at a directory that has the manifest.";
}

/**
 * 「命令被放行了，但它在 cwd 下跑不起来」的注解。
 *
 * 白名单里的命令进了沙箱，包管理器自己报 "No package.json found"：子代理只看到那句
 * 原始报错，看不出这是配置问题（授权指向的地方没有 manifest）。这条注解把原因与改法
 * 写进工具结果，父代理与子代理在同一条消息里看到。
 *
 * 只在失败时补：成功的输出里混一句「跑不起来」会误导。
 */
export function unreachableCommandNote(text: string, command: string, rule: BashRule, cwd: string): string | undefined {
	if (text.includes(SANDBOX_MARK)) return undefined;
	// 别在这里再推一遍匹配：直接问 allowlist「是**哪一条**放行这条命令的」，再查那一条是否
	// 不可达。自己匹配会出错，而且已经错过两次：按首 token 比，会让同程序名的无关条目被点名；
	// 在不可达子集里按 `allEntries` 顺序取第一条命中，会让一条**比命令更短**的宽条目（`pnpm`）
	// 顶替真正放行它的那条。`classifyCommand` 用的是判定本身的规则（write 列优先、第一条命中），
	// 所以它给的答案就是唯一的答案。
	// 命令**自己**不需要 manifest 时，一句都不要说：宽条目 `pnpm` 会被判成不可达，但它放行的
	// `pnpm --version` / `pnpm store path` / `pnpm --dir x run build` 跟 cwd 有没有 manifest
	// 无关，失败原因是别的东西。把原因安到不成立的前提上，比不说更糟。
	if (commandNeedsNoManifest(command)) return undefined;
	const granted = classifyCommand(rule, command);
	const bad = granted === undefined ? undefined : unreachableEntries([granted.entry], cwd)[0];
	if (!bad) return undefined;
	const remedy = remedyFor(bad);
	return `${SANDBOX_MARK} this command ran, but "${bad.entry}" cannot work from ${bad.lookedIn ?? cwd}: ${bad.why}. ${remedy}`;
}

/**
 * 把「授权写了却永远命中不了」这件事告诉父代理一次。
 *
 * 命中不了指的不是语法不匹配（那种情况命令会被拒，拒绝文案里会说清），而是这条命令在会话的
 * 工作目录下**根本跑不起来**：仓库根没有 package.json，`pnpm run x` 只会报
 * "No package.json found"。子代理没有 `cd`、也没有 `&&`，于是这条授权永远用不上，它只能
 * 自己找一个等价写法 —— 那正是要避免的坑。
 *
 * 聚合成一条发出去：一条警告说清全部，比 N 条各说一条更容易被父代理一次读完。
 */
export function reportUnreachableEntries(rule: BashRule, cwd: string, warn: ((message: string) => void) | undefined): void {
	const unreachable = unreachableEntries(allEntries(rule), cwd);
	if (unreachable.length === 0) return;
	// 条目本身也要封顶：一个大白名单里十几条 pnpm 条目同时不可达时，一条告警会长到没人读。
	const shown = unreachable.slice(0, MAX_LISTED);
	const hidden = unreachable.length - shown.length;
	const list = `${shown.map((item) => `${item.entry} (${item.why}${candidateHint(item)})`).join(", ")}${hidden > 0 ? `, … and ${hidden} more` : ""}`;
	// 改法按条目给：每条建议里带着自己的脚本名，读者能对上是哪一条。
	const fixes = shown.map((item) => item.fix).filter((fix): fix is string => fix !== undefined);
	// 隐藏条目的改法换不出来：候选是同一份列表，全列一遍只会让这条告警更长。总数照实说，
	// 并明说下面的改法只覆盖列出来的这几条 —— 不说的话读者会以为改法覆盖了全部。
	const covered = hidden > 0 ? " (the forms below cover the listed entries only)" : "";
	const tail = fixes.length > 0 ? ` Use the package-relative form instead: ${fixes.join("; ")}${covered}` : "";
	warn?.(
		`pi-subagents-extend: ${unreachable.length} allowlist entries can never match from ${unreachable[0]?.lookedIn ?? cwd}: ${list}. Commands run in the session's working directory; there is no \`cd\`.${tail}`
	);
}

/**
 * 拒绝文案里的「同首 token 条目」提示。
 *
 * 命令被拒时，子代理最想知道的是「为什么没匹配上、该改哪里」。同首 token 的条目就是它该看的
 * 地方：条目按词前缀匹配，`pnpm run lint` 放行 `pnpm run lint --x`，但不放行
 * `pnpm run typecheck`。首 token 不同的条目与此无关，不写进来（不臆测）。
 *
 * 这些条目里若有永远命中不了的（见 `unreachableEntries`），把「为什么」与「改成什么」一起
 * 写进这条拒绝文案：撞墙的原因和出路在同一条消息里，子代理不必再猜。
 */
export function headEntriesHint(rule: BashRule, command: string, cwd: string): string {
	// 前缀赋值先剥掉：匹配时剥得掉，这里也得剥，否则 `HOME=/tmp/x pnpm test` 的首 token
	// 会算成 `HOME=/tmp/x`，与白名单里的 `pnpm` 对不上。
	const head = firstToken(leadingAssignments(command).rest);
	if (!head) return "";
	const mine = allEntries(rule).filter((entry) => entry.startsWith("re:") ? false : firstToken(entry) === head);
	// 正则条目无法按首 token 归到某一组，但又确实可能是唯一放行这条命令的条目：只数不列，
	// 否则既可能很长，也可能让子代理以为「列出的都对不上 = 这个程序没被允许」。
	const patterns = allEntries(rule).filter((entry) => entry.startsWith("re:")).length;
	const siblings = mine.slice(0, 3);
	if (siblings.length === 0 && patterns === 0) return "";
	const unreachable = unreachableEntries(allEntries(rule), cwd);
	const details = siblings.map((entry) => {
		const bad = unreachable.find((item) => item.entry === entry);
		if (!bad) return entry;
		const fix = bad.fix ? `; use instead: ${bad.fix}` : "";
		return `${entry} (${bad.why}${candidateHint(bad)}${fix})`;
	});
	// 被拒的这条命令本身也可能跑不起来（同一个 cwd、同一个程序名）：那是子代理真正要改的
	// 东西，所以它的改法也写进去。
	const own = unreachableEntries([command], cwd)[0];
	const ownFix = own?.fix ? `; run it as: ${own.fix}` : "";
	const listed = details.length > 0 ? details.join(", ") : "none";
	const other = patterns > 0 ? ` (plus ${patterns} regex ${patterns === 1 ? "entry" : "entries"} that may match anything, not evaluated here)` : "";
	return ` — entries for \`${head}\`: ${listed}${other}; a prefix entry matches only if the command starts with it word for word, and there is no \`cd\` — commands run in ${cwd}${ownFix}`;
}

/**
 * 文件在 git 里是否被跟踪。三态：true 已跟踪、false 确认未跟踪、undefined 判不了
 * （不在仓库里、git 不在 PATH、超时）。`--error-unmatch` 的退出码 1 才是「没跟踪」这个确定
 * 答案；其它失败一律当未知，宁可少说也不误报。
 */
function trackedInGit(cwd: string, relPath: string): boolean | undefined {
	try {
		execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && (error as { status?: number }).status === 1
			? false
			: undefined;
	}
}

/** 还在用 legacy bash.read / bash.write 的配置提示一次：新写法是单列 bash.allow。 */
export function warnLegacyBashColumns(config: Record<string, unknown> | undefined, source: string, warn: ((message: string) => void) | undefined): void {
	if (!config || warnedLegacyBashColumns.has(source)) return;
	const bash = config.bash;
	if (!bash || typeof bash !== "object" || Array.isArray(bash)) return;
	const legacy = ["read", "write"].filter((key) => Object.hasOwn(bash, key));
	if (legacy.length === 0) return;
	warnedLegacyBashColumns.add(source);
	warn?.(
		`pi-subagents-extend: ${source} still spells bash.${legacy.join(" and bash.")}, which are legacy columns; bash.allow is the single allowlist column now and read/write is judged internally. The legacy columns keep working until the compatibility layer is removed.`
	);
}

/**
 * 老的 .pi 配置文件还在时各提示一次：它们已被忽略，也不会再被读取；配置写在角色 md 的 extend 块。
 * worktree 的 cwd 里没有主检出的配置，所以主检出根和 cwd 都查；两个文件路径只认普通文件，
 * 目录会让 existsSync 为真；老一代 profile 目录本身就是一个目录，由下面的 existsSync 分支单独判。
 */
export function warnCompatLayer(cwd: string, warn: ((message: string) => void) | undefined): void {
	const isFile = (path: string): boolean => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	};
	const anchor = mainRepoRoot(cwd);
	const roots = anchor.root === null ? [cwd] : [...new Set([cwd, anchor.root])];
	for (const root of roots) {
		const bindingsFile = resolve(root, PROFILE_FILE);
		if (isFile(bindingsFile) && !warnedCompatLayer.has(bindingsFile)) {
			warnedCompatLayer.add(bindingsFile);
			warn?.(
				`pi-subagents-extend: ${PROFILE_FILE} is from the older configuration layer and is now ignored; put configuration in the role md's extend: block.`
			);
		}
		// 目录按目录判：老一代 profile 目录本身就是一个目录，不能套用上面的 isFile。
		const profilesDir = resolve(root, AGENT_PROFILES_DIR);
		if (existsSync(profilesDir) && !warnedCompatLayer.has(profilesDir)) {
			warnedCompatLayer.add(profilesDir);
			warn?.(
				`pi-subagents-extend: ${AGENT_PROFILES_DIR}/*.ts is from the older configuration layer and is now ignored; put configuration in the role md's extend: block.`
			);
		}
	}
}
/**
 * 补 worktree 默认值时，若默认值来自角色 md 而该文件没被 git 跟踪，告诉父代理一次：
 * worktree 副本里不会有这份 md，子代理认不出自己的角色，也就没有任何角色策略
 * （fail open）。只在确认未跟踪时提示，判不了就不说；同一路径只提示一次
 * （集合在 session_start 清空）。
 */
export function warnUntrackedWorktreeProfile(cwd: string, mdFile: string, warn: ((message: string) => void) | undefined): void {
	if (reportedUntrackedWorktreeProfiles.has(mdFile)) return;
	const relPath = relative(cwd, mdFile);
	if (trackedInGit(cwd, relPath) !== false) return;
	reportedUntrackedWorktreeProfiles.add(mdFile);
	warn?.(
		`pi-subagents-extend: \`worktree: true\` runs the subagent in a worktree copy, but the role md ${relPath} is not tracked by git, so the worktree copy will not contain it and the child will run with no role policy. Commit the role md so the worktree child can identify its role.`
	);
}

/**
 * check 2 的护栏：派单点名了一个解析不到 md 的角色名，每个名字整进程只说一次。
 * 不挂在 session_start 清空的那组集合里（那份清单由 session-start.ts 负责，本文件
 * 的授权清单里没有它）；与 warnedCompatLayer 同一取舍 —— 同一个名字解析不到 md 这件
 * 事实在进程内不会变，重复提醒只是刷屏。
 */
export const warnedUnresolvedAgentNames = new Set<string>();

/**
 * check 2 —— 派单点名了一个从生效 cwd 解析不到任何角色 md 的名字。
 *
 * 只告警不拒绝：builtin 代理（worker、scout、delegate…）本来就没有 md，拒了会把
 * 现有最常见的用法打死。要说清三件事：生效 cwd、查过哪些目录、以及 pi-subagents
 * 可能把名字落到 builtin 别名上 —— 那时角色 md 的策略完全不生效，起作用的是
 * builtin 自己的工具面。这条告警本来能救的是这种派单：名字实际命中了别名，调用方
 * 却以为有一个带策略的角色 md 在管着子代理。
 */
export function warnUnresolvedAgentName(agent: string, cwd: string, dirs: string[], warn: ((message: string) => void) | undefined): void {
	if (warnedUnresolvedAgentNames.has(agent)) return;
	warnedUnresolvedAgentNames.add(agent);
	warn?.(
		`pi-subagents-extend: no ${agent}.md is visible from the dispatch cwd ${cwd} — consulted: ${listedJoin(dirs)}. pi-subagents may resolve "${agent}" to a builtin alias instead, in which case the role md's policy will not apply and the builtin agent's own tool list governs. If a role md was meant, put it in one of the consulted directories, or dispatch with the cwd that contains it.`
	);
}

/**
 * check 1 —— 角色 md 的 frontmatter `tools:` 里声明了宿主工具面上没有的工具。
 * pi-subagents 在 spawn 之后会用同一份声明检查子代理的工具面，检查不过就是一句
 * 没人能照着改的拒绝（实测 fbdf1d81：md 声明 edit，宿主被 pi-hashline-edit-pro
 * 换掉了 edit，整条派单两秒内死掉）。这里在 spawn 之前拒掉同一件事，点名缺的
 * 工具与最可能的原因。
 */
export function dispatchToolFaceRefusal(agent: string, mdFile: string, missing: string[]): string {
	return `pi-subagents-extend: dispatch refused before spawn: the agent md ${mdFile} for "${agent}" declares tools this host does not offer: ${missing.join(", ")}. Most likely an extension in this host replaced the tool set (pi-hashline-edit-pro, for example, swaps out the built-in edit family), so the agent definition and the host disagree; pi-subagents would refuse this dispatch anyway, with a message nobody can act on. Fix the md's tools: list, or restore the tools in the host's active tool set.`;
}
