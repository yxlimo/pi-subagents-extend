/**
 * POLICY / GLOB：范围匹配的原语（glob 编译、realpath 比对、绝对授权前缀匹配），
 * 以及 `Policy` / `ToolDeclaration` 这两个各主题模块共用的类型。
 * 这一层是纯函数，不持有会话状态；policy.ts 只做桶装再导出。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type BashRule } from "../bash/index.ts";
import { canonical } from "../paths/index.ts";

/**
 * 一个工具的类别声明。
 *
 * `access` 缺省时沿用 `DEFAULT_TOOL_ACCESS` 里按名字给的值；`path` 缺省时从工具自己的
 * 入参 schema 里找（`pathArgFromSchema`），找不到就当 `path`。
 */
export interface ToolDeclaration {
	access?: "read" | "write";
	path?: string | false;
	/** 双文件工具（copy/move）的源文件按读还是按写判；缺省见 `DEFAULT_TRANSFER_SOURCE`。 */
	transferSource?: "read" | "write";
}

export interface Policy {
	globs: string[];
	regexps: RegExp[];
	/** 写范围（edit / write 工具）。没配 writeScope 时等于读范围；readOnly 时为空。 */
	writeGlobs: string[];
	/**
	 * writeScope 里写绝对路径的那几条，已 realpath，按前缀比对。
	 *
	 * 相对授权绑在项目树上（`matches` 里「落在工作树之外一律不认」是软链逃逸的唯一防线），
	 * 但「把报告写到某个文件」本来就是树外的事。绝对路径是父代理明确点名的授权，不是子代理
	 * 能自己构造的逃逸，所以单独放行；相对授权的老规则一点不动。
	 */
	absoluteWrite: string[];
	writeRegexps: RegExp[];
	source: string;
	readOnly: boolean;
	maxReads: number;
	allowTools: string[];
	/**
	 * 父代理对工具类别的显式声明，覆盖 `DEFAULT_TOOL_ACCESS`。
	 *
	 * `path: false` 表示这个工具没有可判的路径入参——写类工具这样声明等于「永远拒绝」，
	 * 因为拿不到目标就没有任何授权能覆盖它。
	 */
	tools: Record<string, ToolDeclaration>;
	bash?: BashRule;
	/** 探针配置；undefined = 关闭。 */
	probe: unknown;
	/** 连续被拒多少次算「撞权限」；0 = 关闭。 */
	maxDenies: number;
	/** 写拒的独立预算：写拒是用法错，换个交付方式就能解决，不该跟读拒共用额度。 */
	maxWriteDenies: number;
	active: boolean;
}

/**
 * glob → 正则，单趟扫描。不能串 replace：`**` 先变成 `.*` 后，后一步的 `*` 规则会
 * 把新生成的 `*` 再改写一遍（"**" 曾变成 ".[^/]*"）。
 */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i += 1) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				// `**/` 吃掉整段目录（含零段），`**` 吃掉任意层任意字符。
				if (glob[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (ch === "?") {
			re += "[^/]";
		} else {
			re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

/**
 * scope 写法归一，`compile` 与沙箱可写面共用一份，免得两处对同一个 glob 的理解
 * 慢慢分叉。两件事：
 * - 尾斜杠只是目录写法，去掉后再展开，否则 "dir/" 会变成 "dir//**"。
 * - "." 和 "./" 表示整棵树。不归一的话会编译成 ^\.$ / ^\./.*$，而 matches 比的是
 *   相对路径 —— 仓库根的相对路径是空串、子文件是 "src/a.ts"，两条都命中不了，
 *   于是 scope: ["."]（文档里的「读全仓」写法）什么也授权不了。开头的 "./" 同理
 *   要去掉："." 归一成 "**"（整棵树），"./src" 归一成 "src"。
 */
export function normalizeGlob(glob: string): string {
	const raw = glob.length > 1 ? glob.replace(/\/+$/, "") || "/" : glob;
	return raw === "." ? "**" : raw.replace(/^\.\//, "");
}

/**
 * 展开目录语义后编译。"dir/**" 额外匹配 "dir" 本身；不含通配符的纯路径额外
 * 匹配 "dir/**"，所以范围写 "src" 就覆盖 src 及其下所有内容。
 */
export function compile(globs: string[]): RegExp[] {
	const expanded = new Set<string>();
	for (const glob of globs) {
		const g = normalizeGlob(glob);
		expanded.add(g);
		if (g.endsWith("/**")) expanded.add(g.slice(0, -3) || "/");
		else if (!/[*?]/.test(g)) expanded.add(`${g}/**`);
	}
	return [...expanded].map(globToRegExp);
}

/** 目标是否落在某个范围里：相对路径与绝对路径都试，scope 写哪种都认。 */
export function matches(regexps: RegExp[], cwd: string, target: string): boolean {
	if (regexps.length === 0) return false;
	const base = canonical(cwd);
	const abs = canonical(resolve(cwd, target));
	const rel = relative(base, abs);
	// 落在工作树之外的一律不认。范围是相对项目写的，项目就是这棵树；软链指到树外时真实路径
	// 会带 ".."，整棵树的范围（"." / "**"）也不该把它放进来。
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
	for (const re of regexps) {
		if (re.test(rel) || re.test(abs)) return true;
	}
	return false;
}

/**
 * 绝对授权（writeScope 里的绝对路径）按前缀比对，允许落在树外。
 *
 * 只给写用：读范围继续绑定在项目树上。绝对路径是父代理点名的，子代理无法自己构造，
 * 所以它不破坏「相对授权不能出树」那条防线。
 */
export function underAny(grants: string[], cwd: string, target: string): boolean {
	if (grants.length === 0) return false;
	const abs = canonical(resolve(cwd, target));
	for (const grant of grants) {
		if (abs === grant) return true;
		if (abs.startsWith(grant.endsWith(sep) ? grant : `${grant}${sep}`)) return true;
	}
	return false;
}
