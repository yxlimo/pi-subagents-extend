/**
 * 离线沙箱里「一跑就挂」的网络命令判定。
 *
 * 从 bash/index.ts 拆出来的网络层：裸 netns 是丢包而不是拒连，这一类命令要在 spawn
 * 之前拒掉。判据看剥掉前置赋值、包装器与路径前缀后的第一个 token。
 * bash/index.ts 仍是唯一入口，requiresNetwork 由它转出口。
 */

import { basename } from "node:path";
import { leadingAssignments } from "./env.ts";
import { gitSubcommandIndex, peelWrappers } from "./programs.ts";
import { shellTokens } from "./tokens.ts";

const NETWORK_PROGRAMS = new Set([
	"curl", "wget", "nc", "ncat", "netcat", "telnet", "ssh", "scp", "sftp",
	"ping", "dig", "host", "nslookup", "traceroute", "gh",
]);
const NETWORK_SUBCOMMANDS: Record<string, string[]> = {
	docker: ["pull", "push", "login"],
	npm: ["publish"],
	pnpm: ["publish"],
	yarn: ["publish"],
};
const GIT_NETWORK_SUBCOMMANDS = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);

/**
 * curl 的 URL 参数是否全是 file: 协议：读了也不出网，裸 netns 里照常工作。
 * 带任何其他 scheme（http/https/ftp/…）就仍按网络判；不含 scheme 的裸 host 不在这里放行。
 */
function curlOnlyReadsFiles(args: string[]): boolean {
	let sawFileUrl = false;
	for (const arg of args) {
		if (/^file:/i.test(arg)) {
			sawFileUrl = true;
			continue;
		}
		if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(arg)) return false; // 别的 scheme 要出网
	}
	return sawFileUrl;
}

// curl 的查询旗标打印完本地信息就退出；放在任何 URL 之前都成立，不能当成要出网而误拒。
const CURL_LOCAL_QUERY_FLAGS = new Set(["--version", "-V", "--help", "-h"]);

/**
 * 离线沙箱里「一跑就挂」的网络命令判定。
 *
 * 裸 netns 是丢包而不是拒连：`curl` 没有输出也没有错误，事后注解（networkFailureNote）
 * 等不到触发文本，所以要在 spawn 之前拒掉这一类。判据放在共用层，不按角色各写一份。
 *
 * 宁可少拒，不许误拒：只认确定的程序名与子命令；`git status`、`pnpm install`、
 * `cargo fetch`、`npm run …`、`pnpm --dir … run …` 都能从缓存或本地工作，一律放行；
 * 拿不准的也放行。名单看剥掉前置赋值、包装器与路径前缀后的第一个 token，动态拼出来的
 * 程序名（`$TOOL`、`$(…)`）不判 —— 这一层是引导，不是防黑客，而且 shell 元字符本来就会被先拒掉。
 * 引号里的东西刻意不解析：`bash -c "curl …"` 不判；直通包装器（env/sudo/…）则剥开看它真正跑谁。
 *
 * @returns 需要网络的程序名（有子命令时一并给出，如 `git fetch`），否则 null。
 */
export function requiresNetwork(command: string): string | null {
	const words = shellTokens(leadingAssignments(command).rest);
	const effective = peelWrappers(words);
	if (!effective || effective.length === 0) return null;
	// 绝对路径也要认：`/usr/bin/curl` 与 `curl` 是同一个程序。
	const program = basename(effective[0] as string);
	// `gh --version` / `version` / `help` / `config get` 只读本地配置，不外出。
	if (program === "gh") {
		const sub = effective[1];
		if (sub === "--version" || sub === "version" || sub === "help") return null;
		if (sub === "config" && effective[2] === "get") return null;
		return "gh";
	}
	if (NETWORK_PROGRAMS.has(program)) {
		if (program === "curl" && CURL_LOCAL_QUERY_FLAGS.has(effective[1] ?? "")) return null;
		// `curl file:///…` 是本地文件读取，裸 netns 下也能成。
		if (program === "curl" && curlOnlyReadsFiles(effective.slice(1))) return null;
		return program;
	}
	if (program === "git") {
		const located = gitSubcommandIndex(effective);
		// 子命令位置认不全时网络也认不出：沿用本层「拿不准就放行」的口径，不误拒本地命令。
		if (!located.certain) return null;
		const sub = effective[located.index];
		if (sub && GIT_NETWORK_SUBCOMMANDS.has(sub)) return `git ${sub}`;
		const next = effective[located.index + 1];
		// `git remote -v` / `git submodule update` 只看本地；带上 update 才去网络上取。
		if (sub === "remote" && next === "update") return "git remote update";
		if (sub === "submodule" && next === "update" && effective.slice(located.index + 2).includes("--remote")) {
			return "git submodule update --remote";
		}
		return null;
	}
	// 原型链上的键（toString 之类）不是程序名：用 hasOwn 而不是直接索引。
	if (!Object.hasOwn(NETWORK_SUBCOMMANDS, program)) return null;
	const sub = effective[1];
	const list = NETWORK_SUBCOMMANDS[program] as string[];
	return sub && list.includes(sub) ? `${program} ${sub}` : null;
}
