/**
 * PATH 层：路径解析与比对的原语（realpath 归一、~ 展开、树内判定、前缀比对、
 * 私有 tmpfs 下的授权剔除）。
 * 这一层是纯函数，不持有会话状态；index.ts 只做接线。
 * 模块拆分第二步：以下声明从 index.ts / policy.ts 原样搬出，行为不变。
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * 真实路径。目标可能还不存在（写新文件），所以取最深的已存在祖先做 realpath，再把剩下的段拼回去。
 *
 * 为什么必须 realpath：词法比较只看路径字符串，软链是唯一能绕过它的向量 —— `src/link` 指到树外时，
 * `write src/link/evil` 在词法上仍是 `src/` 之下。bash 那条路有 Landlock 按 inode 兜底，edit/write
 * 工具在父进程里跑，没有第二层。
 */
export function canonical(path: string): string {
	let head = path;
	const rest: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(head);
			return rest.length === 0 ? real : join(real, ...rest.slice().reverse());
		} catch {
			const parent = dirname(head);
			if (parent === head) return path;
			rest.push(basename(head));
			head = parent;
		}
	}
}

/**
 * 把路径解析到「可比形态」，与 helper 的 `resolve_comparable` 对齐：对最深的**已存在**祖先做
 * realpath，再把不存在的尾巴原样接回去。两边都用 OS 的 realpath（Node 用 `.native`）并原样拼尾巴，
 * 因此对存在的路径与「祖先软链 + 缺失尾巴」两类结果逐字节一致。
 *
 * 整体 realpath 在这里用不了：授权指向的路径可能还不存在（命令本来就要创建它），而挂载之后它更
 * 是不存在。软链必须先解析，否则「经软链指向 /tmp/x 的授权」在插件侧看着不在 /tmp 之下，helper 却
 * 解析成 /tmp/x 把整份 spec 拒掉 —— 那正是这套逻辑要避免的「一条命令都跑不了」。
 */
export function resolveComparable(path: string): string {
	const tail: string[] = [];
	let current = path;
	for (;;) {
		try {
			// `realpathSync.native` 而不是 `realpathSync`：helper 用的是 Rust 的 `fs::canonicalize`，
			// 它落到 OS 的 realpath(3)，而 Node 的 `realpathSync` 是自实现版本，两者在部分输入上结果不同。
			// 尾巴用字面拼接而不是 `resolve`：`resolve` 会把 `..` 归一化，Rust 那边是原样 push 进去的，
			// 归一化会让「授权路径还没创建」这一类判断与 helper 不一致。
			const base = realpathSync.native(current);
			return tail.length === 0 ? base : `${base.replace(/\/+$/, "")}/${tail.join("/")}`;
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

/** 展开 ~ 与相对路径；返回 undefined 表示不是可用路径。 */
export function expandPath(cwd: string, raw: string): string | undefined {
	const value = raw.trim();
	if (!value) return undefined;
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	if (value === "~") return homedir();
	if (value.startsWith("/")) return value;
	return resolve(cwd, value);
}

/**
 * 目标落在 base 树内就返回它的相对路径，否则 undefined。软链按真实路径判：Landlock
 * 只授权目标 inode，收了指到树外的软链等于把树外那个文件也开了。
 */
export function insideTree(base: string, abs: string): string | undefined {
	const rel = relative(base, canonical(abs));
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel;
}

/** `path` 是否在 `root` 之下。按路径边界比，`/etc` 不覆盖 `/etc-other`。 */
export function underRoot(root: string, path: string): boolean {
	if (path === root) return true;
	return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * "." / "./" / 仓库根 / "/"：目标不是某个文件，而是「整棵树」。单独区分出来，
 * 这样拒绝文案能直说「这是仓库根」，而不是让人以为 scope 写法有错。
 */
export function isRootish(raw: string, cwd: string): boolean {
	const abs = resolve(cwd, raw);
	return abs === cwd || abs === "/";
}

/**
 * helper 里的 `PRIVATE_TMP`：spec 不写 `tmp` 时它把私有 tmpfs 挂在这里。
 * 扩展的 XDG_RUNTIME_DIR / MISE_STATE_DIR 也指在它下面，所以这个路径两边必须同一个。
 */
export const CONVENTIONAL_TMP = "/tmp";

/**
 * 会被私有 tmpfs 盖住的目录，与 helper 的 `privatised_dirs` 同一定义：约定 `/tmp` 恒在内，
 * 外加 spec 的 `tmp`（scratch）；但 cwd 落在其中时 helper 不挂（否则会盖掉工作目录）。
 */
export function privatisedDirs(cwd: string, scratch: string): string[] {
	return [...new Set([CONVENTIONAL_TMP, scratch])]
		.map((dir) => dir.replace(/\/+$/, "") || "/")
		.filter((dir) => dir !== "/" && dir !== "." && !(cwd === dir || cwd.startsWith(`${dir}/`)));
}

/**
 * 剔掉「拿到手也用不上」的写授权。
 *
 * helper 在私有化的目录上挂 tmpfs 之后，落在其**下**的授权路径从它的视图里消失，于是它拒掉整份
 * spec（exit 77），bash 全灭。授权那个目录**本身**仍然有效（挂载点还在），所以只剔严格在下的。
 *
 * 两边都按 `resolveComparable` 解析，否则软链会造成两种错判：插件保留而 helper 拒（bash 全灭），
 * 或插件剔掉而 helper 本来会接受（白白丢掉一条能用的授权）。
 *
 * 同时也把剔掉的交回去：静默丢弃会让子代理反复撞「写不进去」而不知道为什么。
 */
export function dropHiddenGrants(
	write: string[],
	cwd: string,
	scratch: string,
): { kept: string[]; dropped: string[] } {
	const dirs = privatisedDirs(cwd, scratch).map(resolveComparable);
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const path of write) {
		const resolved = resolveComparable(path);
		if (dirs.some((dir) => resolved !== dir && resolved.startsWith(`${dir}/`))) dropped.push(path);
		else kept.push(path);
	}
	return { kept, dropped };
}

/**
 * 找 git worktree 的根：从 cwd 往上找第一个「.git 是文件」的目录。
 * worktree 里 .git 是指向主仓 gitdir 的文件；主仓 checkout 里 .git 是目录。
 * 返回 undefined 表示不在 worktree 里。
 */
export function findWorktreeRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (let i = 0; i < 64; i += 1) {
		const dotGit = resolve(dir, ".git");
		if (existsSync(dotGit)) {
			try {
				const st = statSync(dotGit);
				// worktree：.git 是文件
				if (!st.isDirectory()) return dir;
				return undefined;
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}
