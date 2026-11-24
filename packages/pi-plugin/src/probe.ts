/**
 * 探针：检测子代理的无效工作，warn → abort 两级停机。
 *
 * 四条判据（全部可选，零配置不激活）：
 * 1. 只读空转：idleWriteMs 内没有任何「写入活动」→ warn；再过 abortGraceMs → abort。
 *    「写入活动」只算 edit/write 工具调用与命中 bash write 列的命令；read 列的 bash
 *    与 read/grep/find/ls 一律不算，否则拿 bash 只读打转就绕过了这条判据。
 * 2. 原地打转：同一条 bash 命令原文重复 repeatBash 次 → warn；再多一次 → abort。
 * 3. 早可收工：bash 输出命中 successPatterns 后起 successIdleMs 计时，期间无写入活动 → abort。
 * 4. 造杂物：write/edit 目标路径命中 forbidWritePatterns → 直接拒绝。
 *
 * warn 的载体是「拦截下一次 tool_call」：定时器到点自己拦不了正在跑的调用，边界才是
 * 能保证模型看到文案的地方。停机由调用方用 terminate: true 硬停（见 index.ts），
 * 探针只负责把「为什么停」写进 stopReason。
 */

import { createHash } from "node:crypto";

export interface ProbeConfig {
	idleWriteMs: number;
	abortGraceMs: number;
	repeatBash: number;
	successIdleMs: number;
	successPatterns: string[];
	forbidWritePatterns: string[];
}

export const DEFAULT_PROBE: ProbeConfig = {
	idleWriteMs: 6 * 60 * 1000,
	abortGraceMs: 2 * 60 * 1000,
	repeatBash: 3,
	successIdleMs: 5 * 60 * 1000,
	successPatterns: ["fail=0", "0 failed", "0 failing", "all tests passed"],
	forbidWritePatterns: [],
};

/**
 * 停机之后每个调用收到的话。
 *
 * 不能拿停机理由顶：那句话描述的是**触发停机的那一次动作**（「同一条命令重复 3 次：
 * ls -la …/.pnpm」），而后续调用早就换了事，却收到同一句，模型于是把它读成「这条新命令
 * 也犯了那个错」。这个 bug 是真的——一个子代理被判定打转后改去 `ls -la docs`，回来的
 * 仍是那条点名 .pnpm 的旧文案。#stopNotice 与 index.ts 的硬停共用这句。
 */
export const STOP_NOTICE =
	"pi-subagents-extend: this run stops here — it was stopped earlier and nothing further will execute (the stop message above says why). Report to the parent with contact_supervisor.";

export interface ProbeEvent {
	/** 命中判据时给模型看的文案。 */
	reason: string;
	/** warn 之外还要做的事：停掉本轮。 */
	stop: boolean;
}

export interface ProbeHooks {
	warn: (text: string) => void;
}

/**
 * 定时器句柄：Node 返回的 Timeout 对象，或浏览器/假时钟里的数字。探针从不看内容，
 * 只原样交回宿主的 clearTimeout。
 */
export type TimerHandle = object | number;

export interface ProbeHost {
	setTimeout: (fn: () => void, ms: number) => TimerHandle;
	clearTimeout: (handle: TimerHandle) => void;
	now: () => number;
}

/**
 * 一条判据的时窗状态：armed 时，下一个 tool 边界把 warn 抛给模型；到 abortAt 仍没
 * 恢复就停。
 */
interface Window {
	/** 还没在边界上抛给模型。 */
	armed: boolean;
	/** 已经抛过，等宽限到期。 */
	warned: boolean;
	message: string;
	abortAt: number;
}

function nonNegativeInt(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function patternList(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	return (value as unknown[])
		.filter((v): v is string => typeof v === "string" && v.trim() !== "")
		.map((v) => v.trim());
}

/**
 * 解析 bindings 的 probe 字段。
 *
 * 打转与撞权限是纯错误信号，默认开启；时间基判据（只读空转、早可收工）会误伤
 * 慢任务，必须由父代理显式配置。没有 probe 字段时，时间判据的阈值取 0 = 关闭。
 */
export function parseProbeConfig(raw: unknown): ProbeConfig | undefined {
	if (raw === false) return undefined;
	if (raw === undefined) return { ...DEFAULT_PROBE, idleWriteMs: 0, abortGraceMs: 0, successIdleMs: 0 };
	if (raw === true) return DEFAULT_PROBE;
	if (typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_PROBE;
	const cfg = raw as Record<string, unknown>;
	// `{}` = 全部默认值；只写部分字段时，没写的那些保持关闭（0）。
	const blank = Object.keys(cfg).length === 0;
	const pick = (value: unknown, fallback: number) => {
		if (blank) return fallback;
		if (value === undefined) return 0;
		return nonNegativeInt(value, fallback);
	};
	return {
		idleWriteMs: pick(cfg.idleWriteMs, DEFAULT_PROBE.idleWriteMs),
		abortGraceMs: pick(cfg.abortGraceMs, DEFAULT_PROBE.abortGraceMs),
		repeatBash: Math.max(2, nonNegativeInt(cfg.repeatBash, DEFAULT_PROBE.repeatBash)),
		successIdleMs: pick(cfg.successIdleMs, DEFAULT_PROBE.successIdleMs),
		successPatterns: patternList(cfg.successPatterns, DEFAULT_PROBE.successPatterns),
		forbidWritePatterns: patternList(cfg.forbidWritePatterns, []),
	};
}

function compilePatterns(patterns: string[]): { source: string; re: RegExp }[] {
	const out: { source: string; re: RegExp }[] = [];
	for (const p of patterns) {
		try {
			out.push({ source: p, re: new RegExp(p) });
		} catch {
			// 写坏的模式跳过（不因此误伤所有写入）。
		}
	}
	return out;
}

function matchesAny(patterns: string[], text: string): string | undefined {
	for (const p of patterns) {
		try {
			if (new RegExp(p).test(text)) return p;
		} catch {
			// 忽略坏模式
		}
	}
	return undefined;
}

export interface ProbeDeps {
	config: ProbeConfig;
	/** 只读任务（pi-subagents-extend 的 readOnly）：跳过判据 1 与 3。 */
	readOnly: boolean;
	hooks: ProbeHooks;
	host?: ProbeHost;
	/** 写入活动间隔超过这个值就 warn/abort（缺省 clamp 到一个合理下限，便于测试缩短）。 */
}

const MIN_IDLE_MS = 1000;
const BASH_TEXT_LIMIT = 24_000;

/**
 * 探针实例。调用方在 tool_call / tool_result / session_shutdown 上转发事件。
 */
export class Probe {
	#cfg: ProbeConfig;
	#readOnly: boolean;
	#hooks: ProbeHooks;
	#host: ProbeHost;
	#timers = new Set<TimerHandle>();
	#idleTimer?: TimerHandle;
	#successTimer?: TimerHandle;
	#idle: Window = { armed: false, warned: false, message: "", abortAt: 0 };
	#repeat: Window = { armed: false, warned: false, message: "", abortAt: 0 };
	#bashCounts = new Map<string, number>();
	/**
	 * 进行中的命令：`toolCallId → 命令原文`。
	 *
	 * 不能用单个槽位：pi 默认让一条助手消息里的多个工具调用并行执行，两个 bash 调用会先后
	 * 进入、结果以任意顺序回来。单槽会把先到的结果记到后一条命令名下，再丢掉另一条 —— 输出
	 * 比对于是张冠李戴，而这条判据的全部代价就是「记错就误杀」。
	 */
	#pending = new Map<string, string>();
	/** 每条命令上一次输出的摘要，条数封顶。 */
	#lastOutputs = new Map<string, string>();
	#forbidPatterns: { source: string; re: RegExp }[];
	#stopped = false;
	#stopReason = "";
	/** 停机原因是不是真的交给了模型（只有交给过才可以说「上面的消息」）。 */
	#causeSent = false;
	#successArmed = false;

	constructor(deps: ProbeDeps) {
		this.#cfg = deps.config;
		this.#readOnly = deps.readOnly;
		this.#hooks = deps.hooks;
		this.#host = deps.host ?? defaultHost();
		this.#forbidPatterns = compilePatterns(deps.config.forbidWritePatterns);
		this.#startIdleTimer();
	}

	get config(): ProbeConfig {
		return this.#cfg;
	}

	/** 有写入活动：重置空转计时器，清掉已武装的 warn，并把打转计数清零。 */
	noteWriteActivity(): void {
		if (this.#stopped) return;
		this.#idle = { armed: false, warned: false, message: "", abortAt: 0 };
		// 判据 2 的语义是「同一件事没有进展地重复」，写活动就是进展：计数清零。
		// 已经发出的 spin warn 也要撤掉——否则子代理改完文件再跑同一条测试，仍会被
		// 宽限计时器判死。dogfooding 实测过：一个 coder 子代理第 3 次跑同一条测试收到
		// warn，中途改了代码，宽限到期照样被停。代价是写类命令自身不再受这条判据约束，
		// 读类命令（真正的原地打转）不受影响。
		this.#bashCounts.clear();
		this.#lastOutputs.clear();
		this.#repeat = { armed: false, warned: false, message: "", abortAt: 0 };
		this.#disarmSuccess();
		this.#startIdleTimer();
	}

	/** bash 命令进入：判据 2 计数。写活动由 helper 侧的内核观察决定，不在这里猜。 */
	noteBashStart(command: string, callId?: string): ProbeEvent | undefined {
		if (this.#stopped) return undefined;
		const key = command.trim();
		if (!key) return undefined;
		this.#pending.set(callId ?? "", key);
		if (this.#pending.size > 64) {
			const stalest = this.#pending.keys().next().value as string | undefined;
			if (stalest !== undefined) this.#pending.delete(stalest);
		}
		const count = (this.#bashCounts.get(key) ?? 0) + 1;
		this.#bashCounts.set(key, count);
		if (count === this.#cfg.repeatBash) {
			const message =
				`Same bash command repeated ${count} times (criterion: spinning): ${key.slice(0, 160)}. ` +
				`One more stops the run — change approach or report to the parent.`;
			this.#repeat = {
				armed: true,
				warned: true,
				message,
				abortAt: this.#host.now() + this.#cfg.abortGraceMs,
			};
			// 第 N 次直接拦下这次调用并给 warn：放行到下一次就没机会说了。
			this.#hooks.warn(message);
			return { reason: message, stop: false };
		}
		if (count > this.#cfg.repeatBash) {
			return {
				reason:
					`Same bash command repeated ${count} times (criterion: spinning): ${key.slice(0, 160)}. ` +
					"The run stops here: state what you kept retrying and what the parent must supply.",
				stop: true,
			};
		}
		return undefined;
	}

	/** bash 输出：判据 3 的成功标记；并判定这一次重复是不是带回了新信息。 */
	noteBashResult(output: string, callId?: string): void {
		// 输出判定与 readOnly 无关：那条开关只关「早可收工」，不关打转。
		this.#noteOutput(output, callId);
		if (this.#readOnly || this.#stopped) return;
		const text = output.length > BASH_TEXT_LIMIT ? output.slice(-BASH_TEXT_LIMIT) : output;
		const hit = matchesAny(this.#cfg.successPatterns, text);
		if (!hit) return;
		this.#startSuccessTimer(hit);
	}

	/**
	 * 一条命令的输出回来了：和上一次不同，就说明这次重复拿到了新信息，不算原地打转。
	 *
	 * 判据原来的口径是「同一条命令出现 N 次」，不看结果。dogfooding 里一个在量目录布局的
	 * 子代理因此被杀：它三次 `ls` 同一个目录、每次输出都不一样，可那正是测量任务在做的事。
	 * 现在计数归零、并撤掉已武装的 warn —— 拿到新输出就是进展，跟写了文件是一回事。
	 * 真正卡住的孩子输出一字不差，仍然会被数到阈值上。
	 */
	#noteOutput(output: string, callId?: string): void {
		const slot = callId ?? "";
		const key = this.#pending.get(slot);
		this.#pending.delete(slot);
		if (!key) return;
		const digest = digestOf(output);
		const previous = this.#lastOutputs.get(key);
		if (this.#lastOutputs.size >= 64 && !this.#lastOutputs.has(key)) {
			const oldest = this.#lastOutputs.keys().next().value as string | undefined;
			if (oldest !== undefined) {
				this.#lastOutputs.delete(oldest);
				// 被淘汰的命令失去基线，计数也一并丢掉：下一次从 1 重新开始。
				// 保留计数就会在“没基线”的情况下继续累加，那是往误杀的方向偏。
				this.#bashCounts.delete(oldest);
			}
		}
		// 先删后插：Map 保留首次插入的位置，不删就成了按首次出现排序的 FIFO，
		// 而重复最多的那条命令正好坐在队头，会成为第一个被淘汰的对象。
		this.#lastOutputs.delete(key);
		this.#lastOutputs.set(key, digest);
		if (previous === undefined || previous === digest) return;
		this.#bashCounts.delete(key);
		this.#repeat = { armed: false, warned: false, message: "", abortAt: 0 };
	}

	/** write/edit 目标路径：判据 4。命中返回拒绝事件。 */
	checkWriteTarget(path: string): ProbeEvent | undefined {
		if (this.#stopped) return undefined;
		for (const p of this.#forbidPatterns) {
			if (p.re.test(path)) {
				return {
					reason:
						`pi-subagents-extend: refusing to write "${path}" into the repo (criterion: junk files, matched "` +
						`${p.source}"); put debug and temp files under /tmp.`,
					stop: false,
				};
			}
		}
		return undefined;
	}

	/** tool 边界：把已武装的 warn 抛给模型；宽限走完就停。 */
	atToolBoundary(): ProbeEvent | undefined {
		// 停过之后每个边界都要拒绝：没有这条，停机只停在内部状态里，子代理照跑。
		// 给的是「已停」的状态说明，不是那条触发停机的旧描述（见 #stopNotice）。
		if (this.#stopped && this.#stopReason) {
			// 计时器触发的停机（只读空转、早可收工）从没把原因交给过模型：`#hooks.warn` 是 UI
			// 提示，不进上下文。那种情形的第一次边界必须把原因说完，否则模型收到的是
			// 「原因见上面的消息」，而上面根本没有那条消息。
			if (!this.#causeSent) {
				this.#causeSent = true;
				return { reason: this.#stopReason, stop: true };
			}
			return { reason: STOP_NOTICE, stop: true };
		}
		if (this.#stopped) return undefined;
		const now = this.#host.now();
		const expired = [this.#idle, this.#repeat].find((w) => w.warned && now >= w.abortAt);
		if (expired) {
			// 这一次的原因就由这次调用返回，所以标记为「已交给模型」。
			this.#stopWith(`${expired.message}\nGrace expired; the run stops here. Summarize what changed and what blocks you.`, true);
			return { reason: this.#stopReason, stop: true };
		}
		const armed = [this.#repeat, this.#idle].find((w) => w.armed);
		if (armed) {
			armed.armed = false;
			armed.warned = true;
			this.#hooks.warn(armed.message);
			return { reason: armed.message, stop: false };
		}
		return undefined;
	}

	/** 定时器到点：空转的 warn 与 abort 都不依赖 tool 边界。 */
	#fireIdle(): void {
		if (this.#stopped) return;
		if (!this.#idle.armed) {
			this.#idle = {
				armed: true,
				warned: false,
				message:
					`Nothing written for ${ms(this.#cfg.idleWriteMs)} and no write-capable bash ran (criterion: idle). ` +
					"Start the change, or report what blocks you to the parent.",
				abortAt: this.#host.now() + this.#cfg.abortGraceMs,
			};
			this.#idleTimer = this.#schedule(() => this.#fireIdleAbort(), this.#cfg.abortGraceMs);
			return;
		}
		this.#fireIdleAbort();
	}

	/**
	 * 停机。三处（grace 到期、空转、早可收工）都走这里，因为 `#causeSent` 的正确值取决于调用点：
	 * 由这次调用把原因返回出去的，标 true；由计时器触发、只能等下一个边界补发的，标 false。
	 * 原先三处各写三行，新加一处忘了写就不会补发 —— 那正是这次要修的 bug 的形状。
	 */
	#stopWith(reason: string, causeSent: boolean): void {
		this.#stopped = true;
		this.#clearTimers();
		this.#stopReason = reason;
		this.#causeSent = causeSent;
	}

	#fireIdleAbort(): void {
		if (this.#stopped) return;
		// 计时器停机没有工具调用可以带回原因，`#hooks.warn` 只是 UI 提示，所以留给下一个边界补发。
		this.#stopWith(
			`Criterion: idle — nothing written for over ${ms(this.#cfg.idleWriteMs + this.#cfg.abortGraceMs)} ` +
				"and no write-capable bash ran. The run stops here: state what you confirmed and why nothing changed.",
			false,
		);
		this.#hooks.warn(this.#stopReason);
	}

	#startIdleTimer(): void {
		if (this.#readOnly || this.#cfg.idleWriteMs < MIN_IDLE_MS) return;
		this.#clearIdleTimer();
		this.#idleTimer = this.#schedule(() => this.#fireIdle(), this.#cfg.idleWriteMs);
	}

	#startSuccessTimer(marker: string): void {
		if (this.#cfg.successIdleMs < MIN_IDLE_MS) return;
		this.#disarmSuccess();
		this.#successArmed = true;
		this.#successTimer = this.#schedule(() => {
			if (this.#stopped) return;
			this.#stopWith(
				`Criterion: work is done — success marker "${marker}" matched and nothing changed for ${ms(this.#cfg.successIdleMs)}. ` +
					"The run stops here; report the result.",
				false,
			);
			this.#hooks.warn(this.#stopReason);
		}, this.#cfg.successIdleMs);
	}

	#disarmSuccess(): void {
		if (this.#successTimer !== undefined) {
			this.#host.clearTimeout(this.#successTimer);
			this.#successTimer = undefined;
		}
		this.#successArmed = false;
	}

	#schedule(fn: () => void, ms: number): TimerHandle {
		const handle = this.#host.setTimeout(() => {
			this.#timers.delete(handle);
			fn();
		}, ms);
		this.#timers.add(handle);
		return handle;
	}

	#clearIdleTimer(): void {
		if (this.#idleTimer !== undefined) {
			this.#host.clearTimeout(this.#idleTimer);
			this.#timers.delete(this.#idleTimer);
			this.#idleTimer = undefined;
		}
	}

	#clearTimers(): void {
		for (const handle of this.#timers) this.#host.clearTimeout(handle);
		this.#timers.clear();
		this.#idleTimer = undefined;
		this.#successTimer = undefined;
	}

	/** 会话结束：清定时器，避免残留。 */
	dispose(): void {
		this.#stopped = true;
		this.#clearTimers();
	}

	/** 诊断用：当前状态。 */
	status(): string[] {
		// 空闲阈值：只读任务不适用；关闭时写「关闭」。
		let idleLimit = "off";
		if (this.#readOnly) idleLimit = "n/a (read-only task)";
		else if (this.#cfg.idleWriteMs > 0) {
			idleLimit = `${ms(this.#cfg.idleWriteMs)} + grace ${ms(this.#cfg.abortGraceMs)}`;
		}
		const lines = [
			`Idle: ${idleLimit}`,
			`Spin: same command warns at ${this.#cfg.repeatBash}, stops at ${this.#cfg.repeatBash + 1} (${this.#bashCounts.size} commands recorded)`,
			`Done-early: ${this.#readOnly ? "n/a (read-only task)" : `stops after ${ms(this.#cfg.successIdleMs)} with no new change`}`,
			`Junk files: ${this.#forbidPatterns.length} forbidden path patterns`,
			`State: ${this.#stopped ? "stopped" : "running"}${this.#successArmed ? " (success marker matched)" : ""}`,
		];
		return lines;
	}
}

/**
 * 判断两条输出是不是一字不差，只需要一个摘要：存原文会让 64 条命令各自攒着几十 KB
 * （bash 结果的设计上限就是 24 KB），只为了回答一个相等问题。
 */
function digestOf(output: string): string {
	return createHash("sha1").update(output).digest("hex");
}

function ms(value: number): string {
	if (value >= 60_000) {		const m = value / 60_000;
		return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
	}
	return `${Math.round(value / 1000)} s`;
}

function defaultHost(): ProbeHost {
	return {
		setTimeout: (fn, delay) => {
			const h = setTimeout(fn, delay);
			// 定时器不该把进程留住。
			if (typeof (h as { unref?: () => void }).unref === "function") (h as { unref: () => void }).unref();
			return h;
		},
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		now: () => Date.now(),
	};
}
