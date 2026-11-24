/**
 * 命令词法：直通包装器剥离、git 子命令定位，以及包管理器「换包目录」旗标。
 *
 * 这一层不判读写 —— 会不会写由目录授权与内核决定，不由程序名猜。
 * bash/index.ts 仍是唯一入口，这里的东西由它转出口。
 */

import { ASSIGNMENT_LIKE } from "./env.ts";
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
