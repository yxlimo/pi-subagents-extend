/**
 * bash 前置赋值（`FOO=1 cmd`）的处理。
 *
 * 从 bash/index.ts 拆出来的安全控制层：剥出命令前连续的赋值，
 * 并拦下能注入代码或换掉要跑的程序的黑名单名字。
 */

const ASSIGNMENT_HEAD = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

// 与 ASSIGNMENT_HEAD 同判：剥直通包装器时用来跳过 `env FOO=1 cmd` 里的赋值。
export const ASSIGNMENT_LIKE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * 前缀赋值里那些能改变「跑哪个程序」或者「往进程里塞代码」的名字。
 *
 * 这一层不是严格沙箱，是让子代理走在既定轨道上的辅助（定位如此：放行多了可以事后补，卡太死
 * 反而妨碍干活），所以这里是**黑名单**而不是白名单：挡住已知的注入入口，其余名字照常放行。
 * 漏一个就是一次放宽 —— 这是刻意接受的代价，每一条都对应一个可验证的注入方式：
 *
 *   LD_* / DYLD_*              往任意进程加载共享库
 *   NODE_* / npm_config_*      node 预加载模块；实测 `NODE_OPTIONS=--require=/tmp/x.js node -e ""`
 *                              直接执行了 /tmp/x.js
 *   PYTHON* / PERL* / RUBY*    解释器预加载
 *   GIT_* / PAGER / LESSOPEN   被允许的 git 子命令、分页器里跑任意程序
 *   BASH_ENV / ENV / BASH_FUNC_*  shell 启动时执行
 *   PATH / IFS                 换掉要跑的程序 / 改变词法
 *
 * 刻意**不含** HOME：它是最常见的痛点写法（`HOME=/tmp/pi-home node x.mjs`），而借它注入要
 * 额外满足若干条件（例如宿主的 pager 只在 tty 下才起）。这条边界是取舍，不是疏漏。
 */
const DENIED_ENV_NAMES = new Set(["PATH", "IFS", "ENV", "PAGER", "LESSOPEN", "LESSCLOSE", "MANPAGER", "BASH_ENV", "SHELLOPTS"]);
const DENIED_ENV_PREFIXES = [
	"LD_",
	"DYLD_",
	"NODE_",
	"npm_config_",
	"NPM_CONFIG_",
	"PYTHON",
	"PERL",
	"RUBY",
	"GIT_",
	"BASH_FUNC_",
	"JAVA_TOOL_",
	"_JAVA_",
	"MALLOC_",
];

export function isDeniedEnvName(name: string): boolean {
	if (DENIED_ENV_NAMES.has(name)) return true;
	return DENIED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 前置赋值的名字，以及剥掉前缀之后剩下的命令。 */
export interface LeadingAssignments {
	names: string[];
	rest: string;
}

/**
 * 扫出最前面连续的 `NAME=value` 赋值，返回名字与剩下的命令。
 *
 * 逐字符扫而不是按空白切词：值可以被引号包住（`HOME="/tmp/my home"`），按空白切会把它切成两半，
 * 剩下半截 `home"` 当程序名，于是另一条合法命令被误拒 —— 那正是这个补丁要修的那类失败。
 * 名字允许在 `=` 前带一个 `+`（`A+=1` 是追加赋值，bash 同样当赋值看）。
 * 引号没闭合时值一直吃到末尾，剩下的命令为空，空命令永不匹配（fail closed）。
 */
export function leadingAssignments(command: string): LeadingAssignments {
	const text = command.trim();
	const names: string[] = [];
	let i = 0;
	for (;;) {
		while (i < text.length && /\s/.test(text[i] as string)) i += 1;
		const head = ASSIGNMENT_HEAD.exec(text.slice(i));
		if (!head) break;
		names.push(head[0].replace(/\+?=$/, ""));
		let j = i + head[0].length;
		let quote: string | undefined;
		while (j < text.length) {
			const ch = text[j] as string;
			if (quote) {
				if (ch === "\\" && quote === '"') {
					j += 2;
					continue;
				}
				if (ch === quote) quote = undefined;
				j += 1;
				continue;
			}
			if (ch === "'" || ch === '"') {
				quote = ch;
				j += 1;
				continue;
			}
			if (/\s/.test(ch)) break;
			j += 1;
		}
		i = j;
	}
	return { names, rest: i === 0 ? text : text.slice(i).trim() };
}

/**
 * 前置赋值里命中黑名单的名字，供拒绝文案点名。命中即拒：带上它，「被允许的命令」就变成了
 * 「跑我自己的代码」，白名单等于没写。
 */
export function deniedEnvAssignment(command: string): string | undefined {
	return leadingAssignments(command).names.find((name) => isDeniedEnvName(name));
}
