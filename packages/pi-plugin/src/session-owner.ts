/**
 * 进程级的会话归属：同一个会话里只让一份扩展副本干活。
 *
 * 为什么需要这一层：同一个 pi 进程里，扩展可能被加载两份 —— 项目级副本
 * （<proj>/.pi/extensions/x）与安装版（~/.pi/agent/npm/node_modules/x）。pi 的去重比的是
 * 路径字符串，两条不同的路径都会被加载，于是同一个会话里注册了两套 handler：第一份把 bash
 * 命令包成沙箱调用，第二份看到的是包装后的字符串，比对不上 bash.allow，整个子会话的 bash
 * 全被拒。靠 api 对象上的去重标记挡不住：每个扩展实例各拿一个自己的 api 对象。
 *
 * 归属表（进程级）：
 *   Symbol.for("pi-subagents-extend.sessions") → Map<sessionId, owner>
 * owner 是副本自己的模块 realpath。表里没有 → 抢占并继续；是自己 → 继续；是别人 → 本会话
 * 整个惰性（handler 直接返回，不抛错），并且只报一次冲突。
 *
 * 优先级：owner 路径不含 /node_modules/ 的赢（项目级压过安装版）。表里的 owner 在
 * node_modules 里而自己不在 → 改抢表项并报冲突。其余情况先到先得。
 *
 * 会话身份只能从事件 ctx 上取（ctx.sessionManager.getSessionId()）：扩展入口拿不到它，
 * api 上只有 getSessionName()（显示名，可能没有）。同一个会话里的两份副本共用同一个
 * runner → 同一个 id；前台子代理是同进程的另一个 SessionManager → 另一个 id，所以两张表
 * 互不干扰。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 归属表：sessionId → owner（副本的模块 realpath）。Symbol.for 让不同文件认同同一个键。 */
const SESSIONS = Symbol.for("pi-subagents-extend.sessions");

/**
 * 归属表的伴生状态：这份归属由哪一次激活抢到（token），以及已经报过的冲突。
 *
 * 放在另一个键上，是为了让归属表的值保持「就是 owner 路径」这一个形状 —— 表是契约，伴生
 * 状态是实现细节：同一份代码被激活两次时（同一模块、两个 api 对象），路径分不出谁是谁，
 * token 才分得出来。
 */
const STATE = Symbol.for("pi-subagents-extend.session-state");

/** 安装版路径的标记：路径里有它就说明这份副本来自 npm 安装目录。 */
const INSTALLED = "/node_modules/";

interface SessionState {
	/** sessionId → 抢到归属的激活 token。 */
	claims: Map<string, string>;
	/** sessionId → 已经报过的冲突（每对路径一次）。 */
	reported: Map<string, Set<string>>;
}

/** 进程级的一张表：符号键下的全局对象，两份副本认同同一个键。 */
function globalState<T>(key: symbol, make: () => T): T {
	// SAFETY: `globalThis` 是宿主给的全局对象；这里只按 Symbol 键读写本模块自己放进去的值。
	// 键是 Symbol.for 出来的唯一符号，不与宿主或别的扩展的属性相撞；同一个键只有本模块会写，
	// 所以读到的值形状由下面第一次创建时的构造器保证。
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const existing = globals[key] as T | undefined;
	if (existing !== undefined) return existing;
	const created = make();
	globals[key] = created;
	return created;
}

/** 归属表本身。导出是为了让测试能直接看这张表（也是契约里写明的那张）。 */
export function ownerTable(): Map<string, string> {
	return globalState<Map<string, string>>(SESSIONS, () => new Map());
}

function sessionState(): SessionState {
	return globalState<SessionState>(STATE, () => ({ claims: new Map(), reported: new Map() }));
}

/**
 * 本副本的模块路径（realpath）：冲突消息点名它，优先级也看它。
 *
 * realpath 而不是加载时的原始路径：软链副本与它指向的那份是同一个文件，路径不同但代码
 * 相同，按文件认归属才不会把同一份代码当成两份互相顶掉。
 */
export function ownerPathOf(moduleUrl: string): string {
	const here = fileURLToPath(moduleUrl);
	try {
		return realpathSync(here);
	} catch {
		// 判不了就按原路径：路径只是身份，不是判据，判错了也不会放宽任何东西。
		return here;
	}
}

function modulePath(): string {
	return ownerPathOf(import.meta.url);
}

/** 本模块的 owner 路径。 */
export const OWNER = modulePath();

/**
 * 事件 ctx 上的会话身份。
 *
 * 没有 ctx（老宿主、测试替身）或宿主不提供 sessionManager 时没有身份：这种事件不参与归属
 * 判定，照常执行 —— 判不出归属就不该拦下东西。
 */
function sessionIdOf(ctx: unknown): string | undefined {
	try {
		const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager;
		if (!manager || typeof manager.getSessionId !== "function") return undefined;
		const id = manager.getSessionId();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		// ctx 的 getter 在 runner 失效后会抛：那时候没有事件要处理，当作没有身份。
		return undefined;
	}
}

/** 这份副本是不是安装版（路径在 node_modules 里）。 */
function isInstalled(owner: string): boolean {
	return owner.includes(INSTALLED) || owner.includes("\\node_modules\\");
}

/** 冲突消息：两份路径都要点名，并说清哪一份在管事。 */
function conflictMessage(active: string, inactive: string): string {
	if (active === inactive) {
		return `pi-subagents-extend: this extension is loaded twice in this session (the same file: ${active}); only one of the two registrations takes effect. Keep one copy.`;
	}
	return `pi-subagents-extend: two copies of this extension are loaded in this session; only one of them takes effect. Active: ${active}. Inactive: ${inactive}. Keep one copy — a project-local copy under .pi/extensions and an installed package under node_modules are the usual pair.`;
}

/** 本副本在某个会话里的归属。 */
export interface Ownership {
	/** 本副本的 owner：模块 realpath。 */
	readonly owner: string;
	/**
	 * 这次事件归不归本副本管。false = 本会话整个让给 owner，调用方直接返回，不抛错。
	 *
	 * 每次事件都问一次，不是只问第一次：归属会在运行中易主（项目级副本改抢安装版的位子），
	 * 只问一次的那一份会继续判下去，两份一起判就是本模块要治的那个故障。
	 */
	owns(ctx: unknown, warn?: (ctx: unknown, message: string) => void): boolean;
	/**
	 * 会话结束时把归属交回去。
	 *
	 * 不交回去的后果具体：pi 的 /reload 会先发 session_shutdown 再重新加载扩展，新实例拿到的
	 * 是一张还写着旧主人的表，于是谁都不再管这个会话 —— 扩展看起来还加载着，实际什么也不判。
	 */
	release(ctx: unknown): void;
}

/**
 * 一次激活一份归属。
 *
 * owner 默认是本模块的 realpath；传 owner 是为了让测试能造出「另一份副本」（真实的第二份
 * 副本在另一个文件里，测试没法复制一份出来）。
 */
export function createOwnership(options: { owner?: string } = {}): Ownership {
	const owner = options.owner ?? OWNER;
	// token 区分「同一份代码的两次激活」：模块路径一样，但只有一次激活该管这个会话。
	const token = randomUUID();

	function report(
		sessionId: string,
		active: string,
		inactive: string,
		ctx: unknown,
		warn?: (ctx: unknown, message: string) => void,
	): void {
		const state = sessionState();
		let reported = state.reported.get(sessionId);
		if (!reported) {
			reported = new Set<string>();
			state.reported.set(sessionId, reported);
		}
		// 一对路径在一个会话里只报一次：抢占的那一方与被抢的那一方报的是同一件事。
		const key = [active, inactive].sort().join(" | ");
		if (reported.has(key)) return;
		reported.add(key);
		warn?.(ctx, conflictMessage(active, inactive));
	}

	return {
		owner,
		owns(ctx: unknown, warn?: (ctx: unknown, message: string) => void): boolean {
			const sessionId = sessionIdOf(ctx);
			// 没有会话身份就不参与归属判定：照常执行。
			if (sessionId === undefined) return true;
			const table = ownerTable();
			const claims = sessionState().claims;
			const current = table.get(sessionId);
			if (current === undefined) {
				table.set(sessionId, owner);
				claims.set(sessionId, token);
				return true;
			}
			if (current === owner) {
				const holder = claims.get(sessionId);
				// 归属写的是本副本的路径，但没有别的 token 认领（表被别人写过）也算自己的：
				// 表是唯一的归属凭据，token 只用来分辨同一份代码的两次激活。
				if (holder === undefined || holder === token) {
					claims.set(sessionId, token);
					return true;
				}
				// 同一份代码被激活了两次：先到先得，后来的一份整个会话让出去。
				report(sessionId, owner, owner, ctx, warn);
				return false;
			}
			// 别人是 owner：项目级副本压过安装版 —— 改抢表项，从这一刻起由本副本管事。
			if (isInstalled(current) && !isInstalled(owner)) {
				table.set(sessionId, owner);
				claims.set(sessionId, token);
				report(sessionId, owner, current, ctx, warn);
				return true;
			}
			report(sessionId, current, owner, ctx, warn);
			return false;
		},
		release(ctx: unknown): void {
			const sessionId = sessionIdOf(ctx);
			if (sessionId === undefined) return;
			const table = ownerTable();
			const state = sessionState();
			// 只有当前主人能交出这份归属：被别人抢走的位子不归我删。
			if (table.get(sessionId) !== owner) return;
			if (state.claims.get(sessionId) !== token) return;
			table.delete(sessionId);
			state.claims.delete(sessionId);
			state.reported.delete(sessionId);
		},
	};
}

/**
 * 事件处理器的包装：事件进来先问归属，不是本副本管的会话整个让出去。
 *
 * 冲突告警走既有的 UI 提示通道（ctx.ui.notify，与 wiring 里的 w.uiWarning 是同一个通道）：
 * 这条告警是给父代理看的配置问题，不该进模型上下文。
 */
export function createOwnHandler(ownership: Ownership) {
	const warn = (ctx: unknown, message: string): void => {
		try {
			const ui = (ctx as ExtensionContext).ui as { notify?: (m: string, t?: string) => void } | undefined;
			ui?.notify?.(message, "warning");
		} catch {
			// runner 失效后 ctx.ui 的 getter 会抛：没有 UI 可报，归属本身已经判完了。
		}
	};
	return async <R>(ctx: ExtensionContext, body: () => Promise<R> | R): Promise<R | undefined> => {
		if (!ownership.owns(ctx, warn)) return undefined;
		return await body();
	};
}
