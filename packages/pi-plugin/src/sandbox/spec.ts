/**
 * SANDBOX 层 · spec 模块：一次 bash 调用的装配与运行 —— 沙箱内环境变量、命令自己的
 * 临时目录、spec 的构建与落盘（spec 文件的生命周期：写入、清理、按龄清扫），以及把
 * 命令交给 helper 执行的包装。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { BashRule } from "../bash/index.ts";
import { CONVENTIONAL_TMP, dropHiddenGrants, expandPath, privatisedDirs, resolveComparable } from "../paths/index.ts";
import type { Policy } from "../policy/index.ts";
import { hasWriteGrant, reportHiddenGrants, sandboxWritableDirs, SANDBOX_DEVICE_PATHS, stateDir, toolchainCacheDir } from "./grants.ts";

/** 沙箱里 git 用的全局排除规则：依赖目录不进索引。 */
const GIT_EXCLUDE_PATTERNS = ["node_modules/", ".pnpm-store/"];

/**
 * 写出 git 的全局排除文件。放在 cache 目录下（不是 /tmp：沙箱里的 /tmp 是
 * tmpfs，会把宿主的文件挡住）。
 */
function gitExcludesFile(): string | undefined {
	try {
		const dir = stateDir();
		const file = resolve(dir, "git-excludes");
		const wanted = `${GIT_EXCLUDE_PATTERNS.join("\n")}\n`;
		if (!existsSync(file) || readFileSync(file, "utf8") !== wanted) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, wanted);
		}
		return file;
	} catch {
		return undefined;
	}
}

/**
 * 沙箱里的环境变量：
 * - bindings 给的 bash.env
 * - XDG_RUNTIME_DIR：默认指向沙箱私有的 /tmp。pnpm 12 把自己的锁目录放在
 *   XDG_RUNTIME_DIR（/run/user/<uid>）下，只读根下连 `pnpm run` 都跑不起来。
 * - MISE_STATE_DIR：总是指向沙箱里一个可写的目录（理由见下）。
 *
 * MISE_STATE_DIR 之前只在「工作树里有 mise.toml」时才设，前提是错的。mise 是 node
 * 工具链（npm / pnpm / node）的 shim 入口：任何 node 命令都可能 exec 进 mise，而 mise
 * 会把发现的配置文件登记进 <state>/tracked-configs/，登记面**含 package.json**（宿主
 * 全局开了 idiomatic_version_file_enable_tools）。所以没有 mise.toml 的仓库里
 * `npm pack` 同样会去写 ~/.local/state/mise/ → Landlock 拒绝。登记面与「仓库里有没有
 * mise.toml」无关，就不能拿那个条件决定要不要挪。
 *
 * 实测排除掉的开关（免得下次再找一遍）：`tracked_config_files` 不是真设置名
 *（Unknown setting）；MISE_OFFLINE / MISE_RAW / MISE_DISABLE_TOOLS / MISE_NO_ENV /
 * MISE_SAFE_MODE 全都照样写；MISE_NO_CONFIG=1 有效但代价太大（禁掉全部配置加载，工具链
 * 跟着没了）。只有 MISE_STATE_DIR 真的有效：symlink 全落指定目录、真实目录 0 条、
 * WARN 归零。
 *
 * 落在哪：有写授权时放工具链缓存目录下的 mise-state/（与上面 XDG_CACHE_HOME 同构，
 * 且跨调用持久 —— trusted-configs / task-history 在里面）；只读沙箱没有可写的宿主目录，
 * 放沙箱私有的 /tmp。
 *
 * 两者都可以被父代理用 bash.env 覆盖。
 */
function sandboxEnv(rule: BashRule, policy: Policy): Record<string, string> {
	const env: Record<string, string> = { ...rule.env };
	const privateDir = `/tmp/.pi-subagents-extend-${process.pid}`;
	// git 的全局排除：子代理 `git add -A` 时不把依赖目录吸进索引。
	// 宿主已经设了 GIT_CONFIG_COUNT 就不插手，免得覆盖别人的配置。
	if (rule.gitExcludes && !process.env.GIT_CONFIG_COUNT) {
		const excludes = gitExcludesFile();
		if (excludes) {
			env.GIT_CONFIG_COUNT = "1";
			env.GIT_CONFIG_KEY_0 = "core.excludesFile";
			env.GIT_CONFIG_VALUE_0 = excludes;
		}
	}
	if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `${privateDir}/runtime`;
	// 构建缓存要跨调用持久，所以放 ~/.cache 而不是私有的 /tmp；只在沙箱可写时给，
	// 只读沙箱里指向一个不可写目录只会让报错更难读。
	if (hasWriteGrant(policy, rule)) {
		const cache = toolchainCacheDir();
		if (cache && !env.XDG_CACHE_HOME) env.XDG_CACHE_HOME = cache;
	}
	if (!env.MISE_STATE_DIR) {
		// 有写授权：落在工具链缓存目录里，跨调用持久（trusted-configs / task-history 在里面）。
		if (hasWriteGrant(policy, rule)) {
			const cache = toolchainCacheDir();
			if (cache) {
				const miseState = `${cache}/mise-state`;
				try {
					mkdirSync(miseState, { recursive: true });
					env.MISE_STATE_DIR = miseState;
				} catch {
					// 建不出来就退回私有的 /tmp（下面的兜底）。
				}
			}
		}
		// 只读沙箱：没有可写的宿主目录，落在沙箱私有的 /tmp（helper 挂的私有 tmpfs）。
		if (!env.MISE_STATE_DIR) env.MISE_STATE_DIR = `${privateDir}/mise`;
	}
	return env;
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * 命令自己用的临时目录：宿主的 TMPDIR（os.tmpdir() 认它），或 bash.env 里钉住的那一个。
 *
 * 它必须和 helper 挂私有 tmpfs 的目录是**同一个**：只授权、不挂载的目录，写下来落在宿主上，
 * 不是落在沙箱里。所以它既写进 spec 的 `tmp`，也被下面的 `write` 引用，两处不再各说各话。
 */
export function scratchDir(cwd: string, rule: BashRule): string {
	const pinned = rule.env.TMPDIR?.trim();
	// expandPath 对空串返回 undefined，这里已经排除了空串，剩下的只是类型上的可能。
	const wanted = ((pinned ? expandPath(cwd, pinned) : tmpdir()) ?? "").replace(/\/+$/, "") || "/";
	// 根目录不能当挂载点（会盖掉整棵树），不存在的目录既挂不上、Landlock 也会拒绝整个 spec。
	// 这两种情况退回 /tmp：它对 helper 是既有默认值，不会因为一个坏掉的 TMPDIR 让 bash 全灭。
	return wanted !== "/" && existsSync(wanted) ? wanted : CONVENTIONAL_TMP;
}

/**
 * 已提示过的「解析后的工作树落进私有化目录」：一次会话只提示一遍，不反复打扰。
 */
const reportedPrivatisedCwd = new Set<string>();

/**
 * 词法路径 → realpath，两侧共用 paths.ts 的 resolveComparable（与 dropHiddenGrants
 * 同一把尺子），不在这里再发明一种比较。
 */
function privatisedRootHolding(cwd: string, rule: BashRule): string | undefined {
	const resolved = resolveComparable(cwd);
	return privatisedDirs(cwd, scratchDir(cwd, rule))
		.map(resolveComparable)
		.find((dir) => resolved === dir || resolved.startsWith(`${dir}/`));
}

/**
 * 解析后的工作树是否落进一个**仍会被私有 tmpfs 盖住**的目录（含恰好等于它）。
 *
 * helper 对词法上含 cwd 的目录不挂 tmpfs（namespace.rs 的 should_private_tmp），所以
 * cwd 直写 /tmp/pi93-fix 这类形状是安全的，树照常可见 —— 这个谓词对它必须保持沉默，
 * 否则每棵健康的 /tmp worktree 都会被误报。真正无法工作的是另一种形状：cwd 的字面
 * 路径不含那个目录、realpath 却落进去（典型是经一个前导软链）。此时挂载把工作树整个
 * 盖掉，写授权也会被剔光（dropHiddenGrants 两侧都按 realpath 比较），症状读起来像
 * 一场权限故障。
 *
 * 目录集合只用 spec 已经算出来的那两个来源：scratchDir（spec 的 `tmp`）与
 * privatisedDirs（helper 的 privatised_dirs 镜像），没有第二个「临时目录」的定义。
 */
export function cwdInsidePrivatisedTmp(cwd: string, rule: BashRule): boolean {
	return privatisedRootHolding(cwd, rule) !== undefined;
}

/**
 * 把「工作树解析后落进私有化目录」告诉父代理一次。
 *
 * 只提示不拒：这层判断不出宿主上挂载是否真的成立（挂载失败时 helper 静默退回宿主
 * 目录，命令照样能跑），拒了会把还能跑的会话掐死；但这个形状一旦碰上真挂载，就是
 * 「每条写授权被剔、git 看到空目录」，值得点名出路而不是让子代理去猜。
 */
export function reportCwdInsidePrivatisedTmp(cwd: string, rule: BashRule, warn?: (message: string) => void): void {
	const root = privatisedRootHolding(cwd, rule);
	if (!root) return;
	const resolved = resolveComparable(cwd);
	if (reportedPrivatisedCwd.has(resolved)) return;
	reportedPrivatisedCwd.add(resolved);
	warn?.(
		`pi-subagents-extend: the working tree resolves into a directory that gets a private tmpfs: ${cwd} resolves to ${resolved}, which is inside ${root}; the write grants beneath it are dropped and the spec may be refused outright. Put the worktree under the home directory or inside the repository instead of under the temp dir.`,
	);
}

/**
 * 沙箱 spec：每个会话写一次，所有 bash 调用复用。
 *
 * helper 只认绝对路径，这里给的都是 resolve 过的；路径不存在时 helper 会直接拒绝，
 * 所以不存在的可写目录要提前滤掉。
 */
export function buildSpec(
	cwd: string,
	rule: BashRule,
	policy: Policy,
	warn?: (message: string) => void,
	/** 要观察写的目录；只有探针开着才给，helper 据此在 spec 旁写回观察结果。 */
	watchRoots?: string[],
) {
	const scratch = scratchDir(cwd, rule);
	// 落在私有 tmpfs 之下的授权 helper 一律拒（整份 spec 连带 bash 一起死），所以在这里先剔掉：
	// 授权与挂载互相抵消是父代理的配置问题，不该让一条命令整个跑不起来。
	const { kept, dropped } = dropHiddenGrants(
		[
			...new Set([
				...sandboxWritableDirs(policy, cwd, rule),
				// 两个会被私有化的临时目录都放行：命令自己的那个，和约定俗成的 /tmp。
				...[scratch, CONVENTIONAL_TMP].filter((dir) => existsSync(dir)),
				// The helper refuses a spec path that does not exist, so filter here.
				...SANDBOX_DEVICE_PATHS.filter((path) => existsSync(path)),
			]),
		],
		cwd,
		scratch,
	);
	reportHiddenGrants(dropped, warn);
	// cwd 解析进仍会被私有化的目录时点名：那是挂载与整棵工作树互相抵消的形状，与上面的
	// 「授权被剔」同源但更致命，且同样只该提示一次。
	reportCwdInsidePrivatisedTmp(cwd, rule, warn);
	return {
		cwd,
		read: ["/"],
		// helper 在这个目录上挂一个私有 tmpfs，所以命令写的临时文件留在沙箱里，不落在宿主上。
		// 只在它不等于 helper 的默认值（/tmp）时才写进 spec：约定值本来就不言自明，而且不带这个
		// 字段的 spec 仍能被旧版 helper 解开（它 deny_unknown_fields）。
		...(scratch === CONVENTIONAL_TMP ? {} : { tmp: scratch }),
		write: kept,
		offline: rule.network !== true,
		// 观察目录也只在需要时出现，理由同下面一条：旧版 helper 见到未知键会拒掉整份 spec。
		// helper 把观察结果写在 `<spec>.observe` 里，所以这里不需要携带结果路径。
		...(watchRoots?.length ? { watch: watchRoots } : {}),
		// 只在开启时写：spec 是 deny_unknown_fields，旧版 helper 拿到这个键会直接拒掉整份
		// spec，所以关闭时必须连键都不出现。
		...(rule.cpuStallSeconds === false ? {} : { stallSeconds: rule.cpuStallSeconds }),
		env: sandboxEnv(rule, policy),
	};
}

/**
 * 把 spec 写到 helper 读的位置，返回文件路径。
 *
 * 文件名必须**每次调用都唯一**：pi 会并行发出多个工具调用，而 helper 是启动后才读
 * 这份文件。早先用 `spec-<pid>.json`（一个进程一个名字），并行 bash 会互相覆盖——
 * 先起的那条 helper 可能读到后一条的 spec，拿到错的写清单与 cwd，症状是随机、不可
 * 复现的授权失败或命令走错目录。序号只要求进程内唯一，toolCallId 不可打印字符换成下划线。
 */
let specSeq = 0;
export function writeSpecFile(spec: ReturnType<typeof buildSpec>, toolCallId: string): string | undefined {
	const safeId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
	let temp: string | undefined;
	let file: string | undefined;
	try {
		// homedir() 在 try 里面算：它靠 $HOME 与 passwd，两者都取不到时会抛。抛在这里就让
		// 调用方走「拿不到 spec 就拒绝」的路，而不是把异常抛出判定层。
		const dir = stateDir();
		mkdirSync(dir, { recursive: true });
		specSeq += 1;
		file = resolve(dir, `spec-${process.pid}-${specSeq}-${safeId}.json`);
		// 先写临时文件再改名：helper 只会看到完整内容，不会读到半截 JSON（半截会被
		// deny_unknown_fields / 解析失败拒掉，表现为莫名其妙的 exit 77）。
		temp = `${file}.tmp`;
		writeFileSync(temp, JSON.stringify(spec));
		renameSync(temp, file);
		return file;
	} catch {
		// 写成功、改名失败时暂存文件会留下来。我们不知道失败发生在哪一步，所以两个路径
		// 都试一遍（force 让多删一次无害），别让一次失败变成一份永久垃圾。
		for (const path of [temp, file]) {
			if (path === undefined) continue;
			try {
				rmSync(path, { force: true });
			} catch {
				// 清不掉也不影响本次判定。
			}
		}
		return undefined;
	}
}

/** 删掉某次调用的 spec 文件。结果不会再回来时（结果回来了、或者被挤出上限）靠它收尾。 */
export function dropSpecFile(entry: { specFile?: string } | undefined): void {
	if (!entry?.specFile) return;
	try {
		rmSync(entry.specFile, { force: true });
		// 观察结果与 spec 同生共死：留着它只会在 ~/.cache 里堆垃圾。
		rmSync(`${entry.specFile}.observe`, { force: true });
	} catch {
		// 删不掉不影响判定，session_shutdown 的清扫会兜底。
	}
}

/**
 * 清掉遗留的 spec 文件。
 *
 * 正常路径（tool_result）删自己那份，但会话被中断、进程被杀、或者一次 bash 调用的结果
 * 永不回来时，文件就留在 ~/.cache/pi-subagents-extend 里。这里按**年龄**清：只删 10 分钟
 * 以前的，别的 pi 进程正在用的新文件不会被碰。只认 `spec-` 前缀，因为同一个目录里还放着
 * `git-excludes` 文件和 `xdg-cache` 目录。
 */
export function sweepStaleSpecFiles(): void {
	const cutoff = Date.now() - 10 * 60 * 1000;
	try {
		const dir = stateDir();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.startsWith("spec-") || !/\.json(\.tmp)?$/.test(entry.name)) continue;
			const path = resolve(dir, entry.name);
			try {
				if (statSync(path).mtimeMs > cutoff) continue;
				rmSync(path, { force: true });
			} catch {
				// 单个文件失败不影响其它文件。
			}
		}
	} catch {
		// 目录不存在或读不了：没有可清扫的东西。
	}
}

/**
 * helper 的「网络已隔离」成功提示只在会话第一条离线命令上有新闻；之后由调用方给
 * helper 的环境设这个变量（值固定 "1"），helper 读到它就不再播报成功行。只静音
 * 成功行：降级警告（cannot enter the namespaces …）每次都要说 —— 那条才是「这条
 * 命令没有真命名空间」的信号。
 */
export const QUIET_NETWORK_NOTICE_ENV = "PI_SUBAGENTS_EXTEND_QUIET_NETWORK_NOTICE";

/**
 * 把命令交给 helper：它在 exec 前给自己套上 Landlock 与网络命名空间，所以白名单命令
 * 拿到的就是已经限定好范围、断好网的进程。announce=false 表示本会话已经播报过
 * 「网络已隔离」：给 helper 调用加 `QUIET_NETWORK_NOTICE_ENV=1` 前缀让它安静。
 * 前缀只落在 helper 本身上，`--` 之后的用户命令段逐字节不变 —— 命令匹配规则看到的
 * 仍是原来那条命令。
 */
export function wrapInSandbox(command: string, specFile: string, helper: string, announce = true): string {
	const argv = [helper, "--spec", specFile, "--", "bash", "-lc", command].map(shellQuote);
	const prefix = announce ? "" : `${QUIET_NETWORK_NOTICE_ENV}=1 `;
	return `${prefix}${argv.join(" ")}`;
}
