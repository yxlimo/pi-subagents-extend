/**
 * 程序的读写归类：直通包装器剥离、git / 包管理器的子命令定位、单程序的写判定。
 *
 * 从 bash/index.ts 拆出来的归类层：给 `allow` 列判读写。这里的表是白名单，
 * 漏一个条目就是把会写的命令判成 read —— 条目逐条照搬，不做「清理」。
 * bash/index.ts 仍是唯一入口，这里的东西由它转出口。
 */

import { basename } from "node:path";
import { ASSIGNMENT_LIKE, leadingAssignments } from "./env.ts";
import { commandSegments, shellTokens } from "./tokens.ts";

// 直通包装器会吃掉自己的旗标和旗标值；只认下面列出的，遇到不认识的旗标一律判不准而放行。
interface WrapperFlags {
	noArg?: string[];
	withArg?: string[];
	assignments?: boolean;
	duration?: boolean;
}
const WRAPPER_FLAGS: Record<string, WrapperFlags> = {
	env: {
		noArg: ["-i", "-0", "--ignore-environment", "--null"],
		withArg: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "--default-signal", "--skip-default-signal"],
		assignments: true,
	},
	sudo: {
		noArg: [
			"-n", "--non-interactive", "-b", "--background", "-E", "--preserve-env", "-H", "--set-home",
			"-i", "--login", "-s", "--shell", "-S", "--stdin", "-v", "--validate", "-k", "--reset-timestamp",
			"-K", "--remove-timestamp", "-l", "--list", "-h", "--help", "-V", "--version",
		],
		withArg: [
			"-u", "--user", "-g", "--group", "-G", "--group-list", "-p", "--prompt", "-r", "--role",
			"-t", "--type", "-C", "--close-from", "-D", "--chdir", "-R", "--chroot", "-T", "--command-timeout",
			"-A", "--askpass", "-P", "--preserve-fd",
		],
	},
	nice: {
		noArg: ["--version", "--help"],
		withArg: ["-n", "--adjustment"],
	},
	timeout: {
		noArg: ["--foreground", "--preserve-status", "--version", "--help"],
		withArg: ["-k", "--kill-after", "-s", "--signal"],
		duration: true,
	},
	command: {
		noArg: ["-p"],
	},
	stdbuf: {
		withArg: ["-i", "-o", "-e", "--input", "--output", "--error"],
	},
	// xargs 的旗标按「吃不吃下一个 token」分组；判不准就剥不到程序位，宁可按 write 处理。
	xargs: {
		noArg: ["-t", "-r", "-0"],
		withArg: [
			"-n", "--max-args", "-I", "--replace", "-P", "--max-procs",
			"-d", "--delimiter", "-E", "-L", "-s", "-a", "--arg-file",
		],
	},
};
const WRAPPERS = new Set(Object.keys(WRAPPER_FLAGS));

/**
 * 剥掉前置的直通包装器，返回从真正程序开始的 token；判不准返回 null。
 *
 * 带值旗标吃掉下一个 token（或等号右边），没列出的旗标一律当判不准而放行。
 * `command -v/-V` 只查询不执行，直接放弃判断。套得太深也放弃。
 */
export function peelWrappers(words: string[], seenWrappers?: Set<string>): string[] | null {
	let rest = words;
	for (let depth = 0; depth < 8; depth += 1) {
		const wrapper = rest[0];
		if (!wrapper || !WRAPPERS.has(wrapper)) return rest;
		seenWrappers?.add(wrapper);
		// `command -v curl` / `command -V curl` 只报路径不运行，不能算它要联网。
		if (wrapper === "command" && (rest[1] === "-v" || rest[1] === "-V")) return null;
		const flags = WRAPPER_FLAGS[wrapper] as WrapperFlags;
		const args = rest.slice(1);
		let i = 0;
		while (i < args.length) {
			const word = args[i] as string;
			if (flags.assignments && ASSIGNMENT_LIKE.test(word)) {
				i += 1;
				continue;
			}
			if (word === "--") {
				i += 1;
				break;
			}
			if (word.startsWith("--")) {
				const eq = word.indexOf("=");
				const name = eq < 0 ? word : word.slice(0, eq);
				if (flags.withArg?.includes(name)) i += eq < 0 ? 2 : 1;
				else if (flags.noArg?.includes(name) && eq < 0) i += 1;
				else return null; // 没见过的长旗标：吃不吃值不知道，放行
				continue;
			}
			if (word.startsWith("-") && word.length > 1) {
				const short = word.slice(0, 2);
				if (flags.withArg?.includes(short)) i += word.length > 2 ? 1 : 2; // -n5 / -n 5
				else if (flags.noArg?.includes(short) && word.length === 2) i += 1;
				else return null; // 没见过的短旗标：放行
				continue;
			}
			break; // 第一个非旗标 token 是 DURATION 或程序名
		}
		// timeout 的位置参数先是 DURATION，再是程序名。
		if (flags.duration) {
			const duration = args[i];
			if (!duration || !/^(?:infinity|[0-9]+(?:\.[0-9]+)?[smhd]?)$/.test(duration)) return null;
			i += 1;
		}
		rest = args.slice(i);
		if (rest.length === 0) return null;
	}
	return null; // 包装器套太深，判不准
}

interface GitSubcommand {
	/** 子命令所在的 token 下标。 */
	index: number;
	/** 全局旗标都认得、位置可靠时为 true；认不全时调用方必须按 write 处理。 */
	certain: boolean;
}

/**
 * git 的全局旗标排在子命令前面；跳过它们才知道真正要跑的子命令。
 *
 * 调用方用 quote-aware 的 shellTokens 切词：带引号的旗标值（`core.pager='rm x'`）是单个 token，
 * 吃掉值之后直接就到子命令，不必再把引号残片拼回去。
 * 没列进来的旗标（例如带参数的 `--namespace`）吃不吃值判不准，返回 `certain: false`：
 * 此时子命令位置不可靠，写判定必须落到 write，而不是顺着错位置把它当 read。
 */
export function gitSubcommandIndex(words: string[]): GitSubcommand {
	let i = 1;
	for (;;) {
		const word = words[i];
		if (word === undefined) return { index: i, certain: true };
		if (word === "-C" || word === "--git-dir" || word === "--work-tree" || word === "-c") {
			i += 2; // 吃一个参数
			continue;
		}
		if (
			word.startsWith("--git-dir=") ||
			word.startsWith("--work-tree=") ||
			word === "--no-pager" ||
			word === "--progress" ||
			// 这些没有参数（或只用 = 形式带参数），吃一个 token 就到子命令。
			word === "-p" ||
			word === "--paginate" ||
			word === "-P" ||
			word === "--exec-path" ||
			word === "--literal-pathspecs" ||
			word === "--no-replace-objects" ||
			word === "--no-optional-locks" ||
			word === "--bare" ||
			word === "--version" ||
			word === "--help" ||
			word === "-h"
		) {
			i += 1;
			continue;
		}
		// 没见过的短/长旗标：不知道它吃不吃下一个 token，子命令位置判不准。
		if (word.startsWith("-") && word !== "-") return { index: i, certain: false };
		return { index: i, certain: true };
	}
}

/**
 * 命令的固有写能力判定：给 `allow` 列归类用，只看命令本身，不看路径与白名单。
 *
 * 只认下面这些写得确定的程序与子命令，其余一律 read。把拿不准的程序判成 write 是误授权，
 * 反方向（判成 read）只是少给一点权限，所以这里一律取后者。
 *
 * 四种容易漏的形态都在这一层剥掉或判掉：
 * - 前置赋值（`FOO=1 rm x`）：先剥赋值，程序位是 `rm`，不是 `FOO=1`；
 * - 直通包装器（`env` / `sudo` / `nice` / `timeout` / `xargs`）：剥到真正跑的程序；
 * - 程序写成路径（`/usr/bin/rm`、`./rm`）：取 basename，和裸程序名落同一张表；
 * - `;` / `|` / `&&` 链：逐段判，任一段的程序会写，整条就算写 —— 只看第一段会把
 *   `cat x; rm y` 放过去，而它后半句确实会删文件。
 *
 * `writableCeiling` 是外部的写上限（role 的 `bash.writable`）：false 时表里怎么写都返回
 * read —— 没有写授权，判成 write 也拿不到写权限。要问「这个程序本身会不会写」时传 true。
 */
const WRITE_PROGRAMS = new Set([
	"mkdir", "cp", "mv", "rm", "touch", "chmod", "chown", "ln", "tee", "dd",
	"truncate", "install", "rsync",
]);
const READ_PROGRAMS = new Set([
	"cat", "ls", "rg", "find", "grep", "head", "tail", "wc", "file", "stat",
	"diff", "cmp", "du", "df", "echo", "pwd", "which", "type",
]);
const WRITE_GIT_SUBCOMMANDS = new Set([
	"add", "commit", "switch", "stash", "init", "worktree", "rm", "mv", "apply",
	"cherry-pick", "merge", "rebase", "tag",
	// 会改写工作树、索引或仓库历史的子命令：漏一个就会静默按 read 跑。
	"checkout", "restore", "reset", "clean", "revert", "pull", "fetch", "clone",
	"gc", "prune", "update-index", "submodule", "notes", "am", "sparse-checkout",
]);
const READ_GIT_SUBCOMMANDS = new Set([
	"status", "diff", "log", "show", "rev-parse", "branch", "remote", "blame", "describe",
]);
// branch / remote 平时只读，带上这些参数就改写分支或远端配置。
const WRITE_GIT_BRANCH_FLAGS = new Set(["-d", "-D", "-m", "-M", "-C", "-c", "-f", "--move", "--delete", "--copy", "--force", "--unset-upstream", "--set-upstream-to", "--edit-description"]);
const WRITE_GIT_REMOTE_ARGS = new Set(["add", "remove", "rename", "set-url", "set-head", "prune", "set-branches", "update"]);
// tag 平时算写（会打标签），纯列举的旗标与无标签名时才是读。
const GIT_TAG_LISTING_FLAGS = new Set(["-l", "--list", "--contains", "--points-at", "--sort", "--format"]);
const GIT_TAG_WRITE_FLAGS = new Set(["-d", "-a", "-f"]);
// find 默认只读，这些动作参数会改文件（find 自己就能删、能跑任意命令）。
const WRITE_FIND_ARGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const ACCESS_PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
// 包管理器只有这些子命令只读；run/exec/test/...
// 都会执行任意代码，没列进来的按 write（少一个误放比少一个误拒严重）。
const READ_ONLY_PACKAGE_SUBCOMMANDS = new Set(["list", "ls", "why", "view", "info", "show", "outdated"]);
// 这些子命令会执行代码或改文件；位置不确定时定位到它们，名字本身仍是子命令的强证据。
const WRITE_PACKAGE_SUBCOMMANDS = new Set(["run", "exec", "dlx", "test", "start", "create", "install", "add", "remove", "uninstall", "update", "ci", "publish"]);
// config / store 本身不写，但第二 token 决定动作：get/path 查询，set/prune 会改文件。
const READ_ONLY_PACKAGE_CONFIG_ARGS = new Set(["get", "list", "ls"]);
const READ_ONLY_PACKAGE_STORE_ARGS = new Set(["path", "status"]);
const INTERPRETERS = new Set(["node", "python", "python3", "sh", "bash", "zsh", "ruby", "perl"]);

type WriteVerdict = "write" | "read" | "unknown";

interface PackageSubcommand {
	/** 子命令所在的 token 下标。 */
	index: number;
	/** 位置可靠时为 true（前置旗标都认得，或定位到已知子命令）；否则调用方必须按 write 处理。 */
	certain: boolean;
}

// 包管理器的全局旗标里，这些要吃掉下一个 token 才到子命令。等号形式自己带值，另按单 token 处理。
const PACKAGE_VALUE_FLAGS = new Set(["-C", "--dir", "--prefix", "-F", "--filter", "--registry", "--reporter", "--loglevel"]);
// 这些旗标自己不带值（workspace-root 是布尔旗标；global 是 config 的作用域开关），跳一个就到子命令。
const PACKAGE_NO_ARG_FLAGS = new Set(["--version", "-v", "--help", "-h", "--global", "-g", "--workspace-root"]);

/**
 * 跳过包管理器的全局旗标，定位真正的子命令。没列进来的旗标只跳它自己，并记下位置已不确定：
 * 若其后定位到的是已知子命令（只读表或会写的那张），名字本身就是位置的强证据，照它判；
 * 若定位到的 token 也不认识，就不猜 read，交给调用方按 write 处理。
 */
function packageSubcommandIndex(words: string[]): PackageSubcommand {
	let i = 1;
	let uncertain = false;
	for (;;) {
		const word = words[i];
		if (word === undefined) return { index: i, certain: true };
		if (!word.startsWith("-") || word === "-") {
			// 位置不确定时只有已知子命令的名字能坐实它，否则维持「不可靠」。
			const known = READ_ONLY_PACKAGE_SUBCOMMANDS.has(word) || WRITE_PACKAGE_SUBCOMMANDS.has(word);
			return { index: i, certain: !uncertain || known };
		}
		// `--dir=x`、`--config.foo=bar` 这类值就在同一个 token 里。
		if (word.includes("=")) {
			i += 1;
			continue;
		}
		if (PACKAGE_VALUE_FLAGS.has(word)) {
			i += 2;
			continue;
		}
		if (PACKAGE_NO_ARG_FLAGS.has(word)) {
			i += 1;
			continue;
		}
		// 没见过的旗标：不知道它吃不吃下一个 token，只跳它自己并记下位置不确定。
		i += 1;
		uncertain = true;
	}
}

/** 单个程序的写判定：只认表里的，子命令按子命令表，其余 unknown。 */
function programWriteVerdict(words: string[]): WriteVerdict {
	const program = basename(words[0] as string);
	const args = words.slice(1);
	if (WRITE_PROGRAMS.has(program) || INTERPRETERS.has(program)) return "write";
	if (program === "sed") {
		return args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg.startsWith("--in-place")) ? "write" : "read";
	}
	if (program === "find") {
		return args.some((arg) => WRITE_FIND_ARGS.has(arg)) ? "write" : "read";
	}
	if (program === "git") {
		const located = gitSubcommandIndex(words);
		// 全局旗标认不全就定位不到子命令：按 write 处理，不能顺着错位置静默判 read。
		if (!located.certain) return "write";
		const sub = words[located.index];
		const subArgs = words.slice(located.index + 1);
		// tag 的例外要先于整张写表：列举标签不写任何东西。
		if (sub === "tag") {
			if (subArgs.some((arg) => GIT_TAG_WRITE_FLAGS.has(arg))) return "write";
			const listing = subArgs.some((arg) =>
				GIT_TAG_LISTING_FLAGS.has(arg) || [...GIT_TAG_LISTING_FLAGS].some((flag) => arg.startsWith(`${flag}=`))
			);
			if (listing) return "read";
			// 没有标签名也没有列举旗标（`git tag`）只是列全部。
			return subArgs.some((arg) => !arg.startsWith("-")) ? "write" : "read";
		}
		if (sub && WRITE_GIT_SUBCOMMANDS.has(sub)) return "write";
		if (sub === "branch" && subArgs.some((arg) => WRITE_GIT_BRANCH_FLAGS.has(arg))) return "write";
		if (sub === "remote" && subArgs.some((arg) => WRITE_GIT_REMOTE_ARGS.has(arg))) return "write";
		if (sub && READ_GIT_SUBCOMMANDS.has(sub)) return "read";
		return "unknown";
	}
	if (ACCESS_PACKAGE_MANAGERS.has(program)) {
		// 前置旗标可能吃掉自己的值；位置认不全时按 write，不能猜一个 token 当子命令。
		const located = packageSubcommandIndex(words);
		if (!located.certain) return "write";
		const sub = words[located.index];
		// 只有旗标（`pnpm --version`、`npm --help`）：打印完就退出，不写。
		if (sub === undefined) return "read";
		if (READ_ONLY_PACKAGE_SUBCOMMANDS.has(sub)) return "read";
		// config / store / version 第二 token 才定读写：`npm version patch` 会改包文件。
		const second = words.slice(located.index + 1).find((arg) => !arg.startsWith("-"));
		if (sub === "config") return second !== undefined && READ_ONLY_PACKAGE_CONFIG_ARGS.has(second) ? "read" : "write";
		if (sub === "store") return second !== undefined && READ_ONLY_PACKAGE_STORE_ARGS.has(second) ? "read" : "write";
		if (sub === "version") return second === undefined ? "read" : "write";
		return "write";
	}
	if (READ_PROGRAMS.has(program)) return "read";
	return "unknown";
}

/**
 * 一段命令的写判定。`xargs` 是拿来跑程序的：剥完旗标仍判不出程序时按 write，
 * 不能因为表外就静默按 read 跑（那样它真的会写，而模型什么都不知道）。
 */
function segmentWriteVerdict(segment: string): WriteVerdict {
	const words = shellTokens(leadingAssignments(segment).rest);
	if (words.length === 0) return "unknown";
	const seen = new Set<string>();
	const effective = peelWrappers(words, seen);
	if (!effective || effective.length === 0) return seen.has("xargs") ? "write" : "unknown";
	const verdict = programWriteVerdict(effective);
	if (verdict === "unknown" && seen.has("xargs")) return "write";
	return verdict;
}

export function commandAccess(command: string, writableCeiling: boolean): "read" | "write" {
	if (!writableCeiling) return "read";
	for (const segment of commandSegments(command)) {
		if (segmentWriteVerdict(segment) === "write") return "write";
	}
	return "read";
}

/** 任一段的程序不在任何表里就算 unknown：写越界注解要说清「它按 read 跑是因为判不出来」。 */
export function isUnknownProgram(command: string): boolean {
	const segments = commandSegments(command);
	if (segments.length === 0) return false;
	return segments.some((segment) => segmentWriteVerdict(segment) === "unknown");
}

/**
 * 包管理器与「换包目录」的旗标。
 *
 * 建议里必须用**这家自己的**旗标：给 npm 建议 `--dir`，那条建议自己就跑不起来。
 */
export const PACKAGE_MANAGERS: Record<string, string | undefined> = {
	pnpm: "--dir",
	npm: "--prefix",
	yarn: "--cwd",
	bun: "--cwd",
};
/** 能把包目录改掉的旗标。判定看全部，建议给各家自己的那个。 */
export const PACKAGE_DIR_FLAGS = ["--dir", "--prefix", "-C", "--cwd"];
