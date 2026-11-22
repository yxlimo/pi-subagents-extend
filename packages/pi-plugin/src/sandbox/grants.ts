/**
 * SANDBOX 层 · grants 模块：沙箱允许碰什么 —— 写范围派生的可写路径（子树 glob 给目录、
 * 文件级 glob 展开成实际存在的文件）、git 需要的额外可写目录、产物目录、工具链缓存、
 * 交付物目标路径，以及 spec 帮手 stateDir / toolchainCacheDir 与被剔授权的一次性上报。
 *
 * stateDir / toolchainCacheDir 放在本模块而不是它们多数调用方所在的 spec 模块：
 * grants 侧的 sandboxWritableDirs 也消费它们，放在这里让 spec → grants 保持单向依赖、
 * 不出现模块间的环。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { BashRule } from "../bash/index.ts";
import { DETECT_SKIP, detectScratchDirs } from "../dependencies.ts";
import { canonical, expandPath, insideTree } from "../paths/index.ts";
import { globToRegExp, normalizeGlob, type Policy } from "../policy/index.ts";

/**
 * linked worktree 的 git 公共目录（主仓的 .git）。只有 .git 是文件（worktree）时才问 git，
 * 普通仓库直接返回 undefined：那边 .git 在 cwd 之内，不需要额外授权，也省掉一次 spawn。
 * 结果按 cwd 缓存：bash 白名单命令会反复拼 spec。
 */
const gitDirsCache = new Map<string, { gitDir: string; common: string } | undefined>();
/**
 * git 需要可写的路径。
 *
 * 索引、HEAD 与它们的锁文件（`index.lock`、`HEAD.lock`）建在本次 checkout 的 gitdir 根上，
 * 所以那个目录必须整个授权 —— Landlock 只能正向授权，没有「授权目录但排除 hooks/」的写法。
 *
 * 区别在 gitdir 是谁：linked worktree 里它是 `<common>/worktrees/<id>`，里面只有 HEAD /
 * index / logs / refs，没有 hooks 也没有 config；于是 hooks/config 留在 common dir 里，
 * 那里只给 git 真正要写的三个子目录，不再整目录授权（否则子代理能植入 hook 或改
 * core.hooksPath，之后以父代理身份执行）。四个路径全部实测过：少给哪一个都有具体命令
 * 先失败（per-worktree gitdir → index.lock / HEAD.lock；objects → 对象库；refs → ref 锁；
 * logs → reflog 追加）。
 *
 * 普通 checkout 里 gitdir 与 common 就是同一个目录，hooks、config 和索引挤在一起：只能整
 * 目录授权。这是 Landlock 的能力边界，不是实现取舍 —— 只给 objects/refs/logs 加根级文件时，
 * `git add` 第一个死在 `.git/index.lock` 上（实测）。
 */
function gitWritablePaths(git: { gitDir: string; common: string }): string[] {
	if (canonical(git.gitDir) === canonical(git.common)) return [git.gitDir];
	const paths = [git.gitDir];
	for (const name of ["objects", "refs", "logs"]) {
		const abs = resolve(git.common, name);
		// helper 会拒掉不存在的 spec 路径，所以这里先滤一遍。
		if (existsSync(abs)) paths.push(abs);
	}
	return paths;
}

/**
 * git 需要可写的两个目录：本次 checkout 的 gitdir，以及（linked worktree 时）主仓的
 * 公共目录。索引与 ref 分别住在两处，所以两个都要问出来；具体授权哪几层见
 * gitWritablePaths。
 */
function gitDirs(cwd: string): { gitDir: string; common: string } | undefined {
	const key = resolve(cwd);
	if (gitDirsCache.has(key)) return gitDirsCache.get(key);
	let found: { gitDir: string; common: string } | undefined;
	try {
		const out = execFileSync("git", ["rev-parse", "--absolute-git-dir", "--git-common-dir"], {
			cwd: key,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		const [gitDirRaw, commonRaw] = out.trim().split("\n");
		const gitDir = gitDirRaw?.trim();
		const common = commonRaw ? resolve(key, commonRaw.trim()) : "";
		if (gitDir && existsSync(gitDir)) {
			found = { gitDir, common: common && existsSync(common) ? common : gitDir };
		}
	} catch {
		found = undefined;
	}
	gitDirsCache.set(key, found);
	return found;
}

/**
 * 整棵子树写法 → 该子树根（相对路径，"" 表示 cwd）。`dir/**`、`**`，以及在 `dir/**`
 * 后面再跟一层单层通配的写法都算；`dir/*.ts` 不算 —— 它只覆盖一部分，须按文件展开。
 *
 * 判据是「第一个通配符段起，剩下的段是否都是 `**`（可带一个收尾的单层 `*`）」：`**`
 * 能吃任意层，所以 `**` 后面再跟一层单层通配仍然覆盖全部；而以单层通配开头只覆盖一层，
 * 例如 `dir` 下一层的 `*` 摸不到子目录里的文件，两层倒过来的写法也摸不到 dir 的直接子文件。
 */
function subtreeRoot(glob: string): string | undefined {
	const segments = glob.split("/");
	const first = segments.findIndex((segment) => /[*?]/.test(segment));
	if (first === -1) return undefined;
	const rest = segments.slice(first);
	if (rest[0] !== "**" || rest.some((segment) => segment !== "**" && segment !== "*")) return undefined;
	return segments.slice(0, first).join("/");
}

/** 展开文件级 glob 时的遍历上限：一条 glob 不该把大仓整个走一遍。 */
const GLOB_WALK_MAX_ENTRIES = 20000;

/**
 * 文件级 glob 展开成实际存在的文件。
 *
 * spec.write 可以列文件，Landlock 对文件路径只授权那个 inode，所以 `src/auth/*.ts`
 * 只打开它真正匹配到的文件，而不是整个 src/auth/。代价是「还没创建的新文件」不在
 * 这里 —— 那需要一个目录级的 MAKE_REG，也就等于把整个目录打开。
 *
 * 走过的目录用 DETECT_SKIP 同一张跳过表：那是「依赖/产物不往里走」的判据，展开 glob
 * 与探测清单是同一件事。软链指到树外的不收：Landlock 按目标 inode 授权，收了就等于
 * 授权树外那个文件。
 */
function expandFileGlob(cwd: string, glob: string): string[] {
	const re = globToRegExp(glob);
	const base = canonical(cwd);
	const segments = glob.split("/");
	const firstWild = segments.findIndex((segment) => /[*?]/.test(segment));
	// 静态前缀：第一个通配符段之前的那些段。调用方只传带通配符的 glob，prefix 不会等于整条。
	const prefix = firstWild === -1 ? "" : segments.slice(0, firstWild).join("/");
	const found: string[] = [];
	const stack = [resolve(cwd, prefix || ".")];
	let seen = 0;
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			seen += 1;
			if (seen > GLOB_WALK_MAX_ENTRIES) return found.sort();
			const abs = resolve(dir, entry.name);
			const rel = insideTree(base, abs);
			if (rel === undefined) continue;
			if (entry.isDirectory()) {
				if (!DETECT_SKIP.has(entry.name)) stack.push(abs);
			} else if (entry.isFile() && (re.test(rel) || re.test(abs))) {
				found.push(abs);
			}
		}
	}
	return found.sort();
}

/** Phase 3 output.deliverable: the real file in the main checkout, for write grants and refusals. */
let deliverableTargetPath: string | undefined;

/**
 * wireDeliverable 登记交付物目标路径（state 在本层，因为唯一的读者是 sandboxWritableDirs）。
 * index.ts 侧的赋值点全部走这一个入口，模块内可变状态只有这一份。
 */
export function setDeliverableTargetPath(path: string | undefined): void {
	deliverableTargetPath = path;
}

/**
 * 写范围 → 沙箱可写路径。
 *
 * 只有覆盖整棵子树的写法（`dir`、`dir/**`）才授权目录本身：授权目录就是授权它下面
 * 所有东西，而 Landlock 只能正向授权、无法从已授权的目录里再排除子目录，所以「目录
 * 授权」必须恰好等于「这条 glob 覆盖到的范围」。文件级写法（`src/auth/*.ts`，以及通配符
 * 在中间层的写法）因此展开成实际存在的文件 —— 旧做法是截到第一个通配符，于是
 * `src/auth/*.ts` 把整个 src/auth/ 打开，中间层通配则把 src/ 整个打开。
 */
function writablePaths(policy: Policy, cwd: string): string[] {
	const paths = new Set<string>();
	// 按写范围派生，不用读范围：bash 的可写面不该比 edit / write 更宽。
	for (const raw of policy.writeGlobs) {
		const glob = normalizeGlob(raw);
		if (!glob) continue;
		const root = subtreeRoot(glob);
		if (root !== undefined) {
			const abs = resolve(cwd, root || ".");
			if (abs !== "/" && existsSync(abs)) paths.add(abs);
			continue;
		}
		if (!/[*?]/.test(glob)) {
			// 纯路径：是目录就授权整棵子树，是文件就授权该文件。
			const abs = resolve(cwd, glob);
			if (abs !== "/" && existsSync(abs)) paths.add(abs);
			continue;
		}
		for (const file of expandFileGlob(cwd, glob)) paths.add(file);
	}
	return [...paths];
}

/**
 * 产物目录：探测结果 + 显式追加。已存在的直接放行；探测到的主产物缺了就创建，
 * 其余缺了不管（空目录本身没有意义）；显式追加的缺了也创建 —— 那是父代理点名的。
 */
function scratchDirs(cwd: string, rule: BashRule, options: { create: boolean }): string[] {
	if (rule.scratchPaths === false) return [];
	const dirs = new Set<string>();
	const add = (abs: string, create: boolean) => {
		if (existsSync(abs)) {
			dirs.add(abs);
			return;
		}
		// /permission 只报告「将要放行什么」：缺的也列出来，但不落盘。
		if (!options.create) {
			dirs.add(abs);
			return;
		}
		// 建 spec 时：只有主产物和显式追加的才创建。创建失败就不放行 —— 把不存在的路径
		// 写进 spec，helper 会拒绝整条命令，报错点离真正的原因太远。
		if (!create) return;
		try {
			mkdirSync(abs, { recursive: true });
			dirs.add(abs);
		} catch {
			// 只读树或权限不足：如实失败，别把它算成已授权。
		}
	};
	for (const { dir, primary } of detectScratchDirs(cwd)) add(dir, primary);
	for (const extra of rule.scratchPaths) add(resolve(cwd, extra), true);
	return [...dirs];
}

/**
 * 状态目录：spec 文件、`git-excludes` 与工具链缓存都放这里，默认 `~/.cache/pi-subagents-extend`。
 *
 * `PI_SUBAGENTS_EXTEND_STATE` 覆盖它，测试用它把套件的写入挪出真实 home。不给覆盖时改 HOME 也能达到
 * 同样效果，但那太粗暴：CI 上的 cargo 是 rustup 的 shim，会去建 `$HOME/.rustup`，而包目录不在沙箱
 * 写授权里，整条工具链用例就被 Landlock 拒掉。
 */
export function stateDir(): string {
	const override = process.env.PI_SUBAGENTS_EXTEND_STATE;
	if (override) return resolve(override);
	return resolve(homedir(), ".cache", "pi-subagents-extend");
}

/**
 * 工具链缓存目录。放 ~/.cache 下持久保存：沙箱里的 /tmp 是每次调用私有的 tmpfs，
 * 把 GOCACHE 放那里会让 `go test` 每次都全量重编译。
 * 只设一条 XDG_CACHE_HOME，而不是逐个数 GOCACHE / MYPY_CACHE_DIR / RUFF_CACHE_DIR：
 * 前者是约定（实测 go 的默认 cache 跟着它走），后者是一份要一直维护的工具名单。
 */
let toolchainCacheDirMemo: string | undefined | null = null;

export function toolchainCacheDir(): string | undefined {
	if (toolchainCacheDirMemo !== null) return toolchainCacheDirMemo;
	let dir: string | undefined;
	try {
		dir = resolve(stateDir(), "xdg-cache");
		mkdirSync(dir, { recursive: true });
	} catch {
		dir = undefined;
	}
	toolchainCacheDirMemo = dir;
	return dir;
}

/**
 * 沙箱里要绑成可写的路径集合：
 * - 写范围覆盖到的路径（bash.writable 时）：整棵子树的 glob 给目录，文件级 glob 给文件
 * - git 真正要写的目录（见 gitWritablePaths）：不给的话 add / commit / stash 全拼在 index.lock 上
 * - `<cwd>/node_modules`：pnpm install 要写 .bin 里的 shim；worktree 里它是软链，给真实路径
 * - 项目声明的产物目录 + 工具链缓存目录（XDG_CACHE_HOME）
 * - bash.writablePaths 里的全局可写区（pnpm store、mise state 等；bash.writable 时）
 *
 * cwd 本身不在其中：整棵授权等于把整个 checkout 打开，读范围的宽窄不该自动变成写权限。
 * 各项都以 bash.writable 为前提：false 是角色自己定下的上限，任何一层都不该把它放宽。
 */
export function sandboxWritableDirs(
	policy: Policy,
	cwd: string,
	rule: BashRule,
	options: { create: boolean } = { create: true },
): string[] {
	const dirs = new Set<string>();
	if (rule.writable) {
		for (const dir of writablePaths(policy, cwd)) dirs.add(dir);
		// git 的索引与 ref 必须可写，否则 add / commit / stash 全拼在 index.lock 上；但只给
		// git 真正要写的部分，不因此把整个 checkout 打开。linked worktree 的索引在
		// <common>/worktrees/<id> 里，ref 与对象在 common dir 的 refs / logs / objects 里，
		// hooks 和 config 不在授权范围内。
		const git = gitDirs(cwd);
		if (git) {
			for (const path of gitWritablePaths(git)) dirs.add(path);
		}
		// node_modules 也要可写：pnpm install 要写 .bin 里的 shim。它通常不在
		// scope 里，但装依赖是任务的必要步骤。worktree 里它是符号链接，要给
		// 解析后的真实路径：Landlock 规则落在 inode 上，符号链接自身不覆盖目标。
		const nodeModules = resolve(cwd, "node_modules");
		if (existsSync(nodeModules)) {
			try {
				dirs.add(realpathSync(nodeModules));
			} catch {
				dirs.add(nodeModules);
			}
		}
		// 项目自己声明过的产物目录（git 忽略的）：build/test 往这里写。
		for (const dir of scratchDirs(cwd, rule, options)) dirs.add(dir);
		const cache = toolchainCacheDir();
		if (cache) dirs.add(cache);
		for (const raw of rule.writablePaths) {
			const abs = expandPath(cwd, raw);
			if (abs && abs !== "/" && existsSync(abs)) dirs.add(abs);
		}
		// 交付物是文件级授权：只放真实文件，不打开它所在的目录。
		if (deliverableTargetPath) dirs.add(deliverableTargetPath);
	}
	return [...dirs];
}

/**
 * 沙箱里默认可写的设备。没有它们，`2>/dev/null` 这种写法会直接 EPERM。
 */
export const SANDBOX_DEVICE_PATHS = [
	"/dev/null",
	"/dev/zero",
	"/dev/full",
	"/dev/random",
	"/dev/urandom",
	"/dev/tty",
	"/dev/pts",
];

/** 已提示过的被剔授权：每条命令一份 spec，不记下来就会每调一次重复提示一次。 */
export const reportedHiddenGrants = new Set<string>();

/**
 * 把「授权落在私有 tmpfs 之下、已被剔掉」这件事告诉父代理一次。
 *
 * 不提示的话，子代理只会看到自己的写被 Landlock 拒掉，而真正的原因在配置里：那个目录每次调用都
 * 被挂上一个空的 tmpfs。提示走 UI，不进模型上下文 —— 这是给父代理看的配置告警，不是给子代理的
 * 行动指令（子代理那边已经有「拿报告代替写文件」的既定退路）。
 */
export function reportHiddenGrants(dropped: string[], warn: ((message: string) => void) | undefined): void {
	const fresh = dropped.filter((path) => !reportedHiddenGrants.has(path));
	if (fresh.length === 0) return;
	for (const path of fresh) reportedHiddenGrants.add(path);
	warn?.(
		`pi-subagents-extend: write grant(s) dropped: the sandbox mounts a private tmpfs over that path when it can, and a grant below a mount point is hidden inside it: ${fresh.join(", ")}. Write the file with the write tool, or point bash.env.TMPDIR outside /tmp.`
	);
}
