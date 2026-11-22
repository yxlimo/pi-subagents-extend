/**
 * 「授权写了却永远命中不了」的判定。
 *
 * 这里说的「命中不了」不是语法不匹配（那种情况命令会被拒，拒绝文案里会说清），而是这条命令
 * 在会话的工作目录下**根本跑不起来**：仓库根没有 package.json，`pnpm run x` 只会报
 * "No package.json found"。子代理没有 `cd`、也没有 `&&`，于是这条授权永远用不上，
 * 它只能自己找一个等价写法 —— 那正是要避免的坑。
 *
 * 只判能确定的事实，不猜：
 * - `re:` 正则条目无法静态判断，跳过；
 * - 程序名是工具链里到处都有的（`git`、`rg`、`node`）时，工作目录语义太杂，一律不判：
 *   误报比漏报糟；
 * - 判据与理由文本必须一致：manifest 按工具自己的规矩**向上**找（cwd 的祖先也算，
 *   两条链都查：字面路径与真实路径），所以 `why` 写的是 "in <cwd> or its ancestors"。
 *
 * 从 bash/index.ts 拆出来的诊断层：只判文件系统上能确定的事实。
 * bash/index.ts 仍是唯一入口，这里的东西由它转出口。
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PACKAGE_DIR_FLAGS, PACKAGE_MANAGERS } from "./programs.ts";
import { RE_PREFIX, tokens } from "./tokens.ts";
import { firstToken, type UnreachableEntry } from "./rules.ts";

/** 条目里指定的包目录（`--dir <p>` / `--prefix <p>` / `-C <p>` / `--cwd <p>`）。 */
interface PackageDir {
	/** 旗标原文。 */
	flag: string;
	/** 条目里写的路径。 */
	path: string;
	/** 旗标在条目里的位置：`<p>` 与旗标分写时，值在下一个位置。 */
	index: number;
}

/** 找出条目里那个「换包目录」的旗标；判不了时返回 undefined（不猜）。 */
function packageDirFlag(entry: string): PackageDir | undefined {
	const words = tokens(entry);
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i] as string;
		for (const flag of PACKAGE_DIR_FLAGS) {
			if (word === flag) {
				const value = words[i + 1] as string | undefined;
				// 旗标后面没有值：判不了，不猜。
				if (value === undefined) return undefined;
				return { flag, path: value, index: i };
			}
			if (word.startsWith(`${flag}=`)) {
				const value = word.slice(flag.length + 1);
				if (!value) return undefined;
				return { flag, path: value, index: i };
			}
		}
	}
	return undefined;
}

/** 找包目录时最多往下走几层。 */
const MAX_PACKAGE_SEARCH_DEPTH = 4;

/** 向上找 manifest 时最多走几层：病态的深路径不至于把判定拖成扫盘。 */
const MAX_MANIFEST_SEARCH_DEPTH = 8;

/**
 * 从 cwd 向上找 manifest（`package.json` / `Cargo.toml`）。
 *
 * npm/pnpm/yarn/bun 与 cargo 都是**向上**找 manifest：cwd 是仓库里的子目录时，
 * 祖先目录里有 manifest 就说明这条命令跑得起来。只看 cwd 会把它误判成不可达，
 * 而误报会让父代理去改一条本来没坏的配置。
 *
 * 起点是**物理**路径（见 `searchRoots`）：工具看到的是 `process.cwd()`，软链已经被解开。
 * 依据是「工具自己的规矩」，不是「把可能的路径都试一遍」——后者只会多报可达，
 * 把一条死授权藏起来，而那正是这个判据要防的事。
 *
 */
function manifestAbove(cwd: string, manifest: string): string | undefined {
	for (const root of searchRoots(cwd)) {
		const found = manifestUp(root, manifest);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * 上行的起点：**物理**路径优先。
 *
 * 工具看到的是 `process.cwd()`，它已经把软链解开（内核在 `chdir` 时解析），沙箱 helper
 * 也是 `chdir(spec.cwd)` 起的进程。所以字面链上命中的 manifest 工具**永远看不到**：
 * 把两条链取并集，只会把一条真的跑不起来的授权判成可达、从此不再报告 —— 而这正是
 * 这个判据要防的事。`realpathSync` 失败（cwd 已不存在或没权限）时才退回字面路径：
 * 判定不该因为读不到目录而抛。
 */
function searchRoots(cwd: string): string[] {
	try {
		return [realpathSync(cwd)];
	} catch {
		return [resolve(cwd)];
	}
}

/** 一条链上的上行查找。 */
function manifestUp(start: string, manifest: string): string | undefined {
	let dir = start;
	for (let depth = 0; depth <= MAX_MANIFEST_SEARCH_DEPTH; depth += 1) {
		if (existsSync(join(dir, manifest))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/**
 * 这些子命令本来就不需要 manifest：版本号、帮助、store/config 之类。
 * 它们在没有任何 package.json 的目录里照样跑得起来，判成不可达就是误报。
 */
const MANIFEST_EXEMPT_SUBCOMMANDS = new Set([
	"--version",
	"--help",
	"-v",
	"-V",
	"store",
	"config",
	"setup",
	"env",
	"cache",
	"dlx",
]);

/**
 * 这些旗标让「从 cwd 找 manifest」这件事判不了：工作区范围（`-r`、`--filter`）
 * 或别的目录（cargo 的 `-C`）。带着它们猜 cwd 必然猜错。
 */
const MANIFEST_EXEMPT_FLAGS = new Set([
	"-w",
	"--workspace-root",
	"--filter",
	"-r",
	"--recursive",
	"--manifest-path",
	"-C",
]);

/** 条目里有没有这些旗标（`--flag=value` 形态也算）。 */
function hasExemptFlag(entry: string): boolean {
	return tokens(entry).some((word) => {
		if (MANIFEST_EXEMPT_FLAGS.has(word)) return true;
		for (const flag of MANIFEST_EXEMPT_FLAGS) {
			if (flag.startsWith("--") && word.startsWith(`${flag}=`)) return true;
		}
		return false;
	});
}

/** 条目的子命令位置上有没有不需要 manifest 的词（`pnpm store path`、`npm --help`…）。 */
function hasExemptSubcommand(entry: string): boolean {
	return tokens(entry).slice(1).some((word) => MANIFEST_EXEMPT_SUBCOMMANDS.has(word));
}

/**
 * bun 自带的子命令：`test` 用它自己的 runner，`x` 是它的 dlx —— 两者都不看 `package.json`。
 *
 * 判据是「`run` 出现在子命令之前 ⇒ 那是包脚本」，所以 `bun run test` 与
 * `bun --cwd <dir> run test` 不豁免，而 `bun test`、`bun --bun test`、`bun --cwd <dir> test`
 * 都豁免。这样不必知道每个旗标吃几个值，也就不会把旗标的**值**当成子命令。
 */
function bunBuiltin(entry: string): string | undefined {
	if (firstToken(entry) !== "bun") return undefined;
	const rest = tokens(entry).slice(1);
	const runAt = rest.indexOf("run");
	const testAt = rest.indexOf("test");
	const xAt = rest.indexOf("x");
	if (runAt !== -1 && testAt !== -1 && runAt < testAt) return undefined;
	if (testAt !== -1) return "test";
	if (xAt !== -1) return "x";
	return undefined;
}

/**
 * 这条**命令**自己需不需要 manifest —— 与「条目」的判据分开。
 *
 * 宽条目（`pnpm`）放行的 `pnpm --version` 并不需要 manifest，它失败的原因是网络、二进制
 * 缺失或别的什么；拿「这条条目没有 manifest 可用」去解释它，是把原因安到了不成立的前提上。
 */
export function commandNeedsNoManifest(command: string): boolean {
	const entry = command.trim();
	if (!entry) return false;
	if (hasExemptSubcommand(entry) || hasExemptFlag(entry)) return true;
	// 自己指了包目录（`pnpm --dir packages/a run build`）：cwd 有没有 manifest 与之无关。
	if (packageDirFlag(entry) !== undefined) return true;
	return bunBuiltin(entry) !== undefined;
}

/**
 * 构建产物目录：路径里有一段是这些目录时，文件不存在只说明还没构建，
 * 不说明这条授权命中不了（`packages/helper/target/release/…` 要等一次 cargo build）。
 */
const BUILD_ARTIFACT_DIRS = new Set([
	"target",
	"dist",
	"build",
	"out",
	"node_modules",
	".git",
	".venv",
	"__pycache__",
]);

/** 路径里有没有一段是构建产物目录。 */
function isBuildArtifactPath(path: string): boolean {
	return path.split(/[/\\]/).some((part) => BUILD_ARTIFACT_DIRS.has(part));
}

/**
 * cwd 下面**所有**带 package.json 的目录（相对 cwd 的路径）。
 *
 * 收集全部而不是第一个：仓库里常有多个包，「这条授权原本指哪个包」只有父代理知道，
 * 随便挑一个再给一条 `--dir` 建议，会把命令指到别的包上。
 */
function packageCandidatesUnder(cwd: string): string[] {
	const out: string[] = [];
	let frontier = [""];
	for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
		const next: string[] = [];
		for (const rel of frontier) {
			const abs = rel === "" ? cwd : join(cwd, rel);
			let names: string[];
			try {
				names = readdirSync(abs, { withFileTypes: true })
					.filter(
						(entry) =>
							(entry.isDirectory() || entry.isSymbolicLink()) &&
							!entry.name.startsWith(".") &&
							entry.name !== "node_modules",
					)
					.map((entry) => entry.name)
					.sort();
			} catch {
				continue;
			}
			for (const name of names) {
				const childRel = rel === "" ? name : join(rel, name);
				if (existsSync(join(cwd, childRel, "package.json"))) out.push(childRel);
				next.push(childRel);
			}
		}
		frontier = next;
	}
	return out;
}

/**
 * 条目里的脚本名：`run <script>` 与裸 `test` 两种形态。
 *
 * 只认这两种：别的裸词（`pnpm install`）是子命令还是脚本名猜不准，
 * 猜错就会把一条本来跑得起来的命令判成不可达。
 */
function scriptName(entry: string): string | undefined {
	const words = tokens(entry);
	if (words.length < 2) return undefined;
	if (words[1] === "run") return words[2];
	// `bun test` 跑的是 bun 自带的测试运行器，不看 `scripts.test`，连 package.json 都不需要；
	// 把它当成「包里的 test 脚本」会让文案说一句假话（"no candidate has a `test` script"）。
	// 只有 `bun run test` 才是脚本。
	if (words[1] === "test") return words[0] === "bun" ? undefined : "test";
	return undefined;
}

/** 候选包的 package.json 里真的有这个脚本吗。 */
function hasScript(cwd: string, pkgRel: string, script: string): boolean {
	try {
		const raw = readFileSync(join(cwd, pkgRel, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
		return parsed.scripts !== undefined && Object.prototype.hasOwnProperty.call(parsed.scripts, script);
	} catch {
		return false;
	}
}

/** `packageFixFor` 的答案：有改法就给改法，没有就说清为什么没有。 */
interface PackageFixOutcome {
	/** 可靠改法；给不出来时没有这个字段。 */
	fix?: string;
	/** 恰好一个候选、但那个包里没有这个脚本：交给文案去说明。 */
	scriptMissing?: string;
}

/**
 * 改法只在**恰好一个候选**、且那个包里真的有这个脚本时才给。
 *
 * 多个候选时给不出来：这条授权原本指哪个包只有父代理知道，随便挑一个会把命令
 * 指到别的包上。脚本不在包里时那条建议自己也跑不通（pnpm 报 "Command not found"），
 * 那是脚本不存在，不是授权不可达 —— 所以既不给改法，也要把「原因不是包选错了」
 * 带回去（`scriptMissing`），否则文案只会让人在候选里挑一个，而挑哪一个都不行。
 */
function packageFixFor(
	cwd: string,
	head: string,
	managerFlag: string,
	entry: string,
	candidates: string[],
	script: string | undefined,
	dir?: PackageDir,
): PackageFixOutcome {
	if (candidates.length !== 1) return {};
	const pkg = candidates[0] as string;
	if (script !== undefined && !hasScript(cwd, pkg, script)) return { scriptMissing: script };
	return { fix: packageFix(head, managerFlag, pkg, entry, dir) };
}

/** 造一条包管理器条目的不可达记录：候选列表，加上可靠时才有的改法。 */
function packagingItem(
	cwd: string,
	entry: string,
	head: string,
	managerFlag: string,
	why: string,
	candidates: string[],
	dir?: PackageDir,
): UnreachableEntry {
	const item: UnreachableEntry = { entry, why, lookedIn: searchRoots(cwd)[0] };
	if (candidates.length > 0) item.candidates = candidates;
	const { fix, scriptMissing } = packageFixFor(cwd, head, managerFlag, entry, candidates, scriptName(entry), dir);
	if (fix) item.fix = fix;
	if (scriptMissing) item.scriptMissing = scriptMissing;
	return item;
}

/**
 * 包管理器的改法：`pnpm --dir <pkg> run <script>` 这类形态。
 *
 * 原条目里的换目录旗标被换掉：那个路径正是失效的原因。
 */
function packageFix(head: string, managerFlag: string, pkgDir: string, entry: string, dir?: PackageDir): string {
	const words = tokens(entry);
	const rest: string[] = [];
	for (let i = 1; i < words.length; i += 1) {
		const word = words[i] as string;
		if (dir && i === dir.index) {
			// `--dir <p>`：旗标与值一起跳过；`--dir=<p>` 只跳过旗标本身。
			if (word === dir.flag) i += 1;
			continue;
		}
		rest.push(word);
	}
	return [head, managerFlag, pkgDir, ...rest].join(" ");
}

/** 一条包管理器条目在 cwd 下跑不跑得起来；跑不起来时给出记录。 */
function packageManagerItem(
	cwd: string,
	entry: string,
	head: string,
	managerFlag: string,
	candidates: string[],
): UnreachableEntry | undefined {
	// bun 自带的子命令先判：`bun --cwd <dir> test` 里的 `--cwd` 会被当成包目录旗标，
	// 于是它先掉进下面那个分支、被按「那个目录里没有 package.json」判成不可达 ——
	// 而 `bun test` 用的是它自己的 runner，跟 package.json 无关。
	if (bunBuiltin(entry) !== undefined) return undefined;
	const dir = packageDirFlag(entry);
	if (dir) {
		// 条目自己指了包目录：那个目录里没有 package.json 才算命中不了。
		const target = isAbsolute(dir.path) ? dir.path : resolve(cwd, dir.path);
		if (existsSync(join(target, "package.json"))) return undefined;
		return packagingItem(cwd, entry, head, managerFlag, `no package.json in ${dir.path}`, candidates, dir);
	}
	// 不需要 manifest 的子命令（`pnpm store path`）与判不了的旗标（`pnpm -r test`）：不判。
	if (hasExemptSubcommand(entry) || hasExemptFlag(entry)) return undefined;
	// manifest 向上找：cwd 是子目录时，祖先有 package.json 就说明跑得起来。
	if (manifestAbove(cwd, "package.json")) return undefined;
	return packagingItem(cwd, entry, head, managerFlag, `no package.json in ${cwd} or its ancestors`, candidates);
}

/** 一条 cargo 条目在 cwd 下跑不跑得起来。 */
function cargoItem(cwd: string, entry: string): UnreachableEntry | undefined {
	// `cargo --manifest-path <p>` / `cargo -C <dir>` 指了别的包：判不了，不判。
	if (hasExemptFlag(entry) || hasExemptSubcommand(entry)) return undefined;
	if (manifestAbove(cwd, "Cargo.toml")) return undefined;
	return { entry, why: `no Cargo.toml in ${cwd} or its ancestors` };
}

/**
 * 扫出永远命中不了的条目。
 *
 * 判据只有「这条命令在 cwd 下跑不起来」这一类事实：语法不匹配的条目不在这里（那条命令
 * 本来就会被拒，拒绝文案里会说）。判不出来的（正则、工具链里到处都有的程序名）一律放过。
 *
 * 「跑不起来」按工具自己的规矩算：manifest 向上找（cwd 与它的祖先），找不到才算。
 */
export function unreachableEntries(entries: string[], cwd: string): UnreachableEntry[] {
	const out: UnreachableEntry[] = [];
	// 候选目录只找一次：多个包管理器条目指向同一批候选目录，找一次就够。
	let candidates: string[] | undefined;
	const findCandidates = (): string[] => {
		if (candidates === undefined) candidates = packageCandidatesUnder(cwd);
		return candidates;
	};
	for (const raw of entries) {
		const entry = raw.trim();
		if (!entry) continue;
		// 正则条目无法静态判断：跳过，不猜。
		if (entry.startsWith(RE_PREFIX)) continue;
		const head = firstToken(entry);
		if (!head) continue;
		const managerFlag = PACKAGE_MANAGERS[head];
		if (managerFlag !== undefined) {
			const item = packageManagerItem(cwd, entry, head, managerFlag, findCandidates());
			if (item) out.push(item);
			continue;
		}
		if (head === "cargo") {
			const item = cargoItem(cwd, entry);
			if (item) out.push(item);
			continue;
		}
		if (head.startsWith("/")) {
			// 程序位写成绝对路径：这个可以静态核对。
			// 构建产物目录里的文件不存在只说明还没构建，不说明这条授权命中不了。
			if (isBuildArtifactPath(head)) continue;
			if (!existsSync(head)) {
				out.push({ entry, why: `${head} does not exist` });
			}
			continue;
		}
		// 其它程序名一律不判：`git`、`rg`、`node` 的工作目录语义太杂，误报比漏报糟。
	}
	return out;
}
