import { DenyCounter } from "../budgets.ts";
import { bindingKey, type RolePolicy } from "../role-config.ts";
import { BINDINGS_ENV, asObject, denyAll, extractCallConfig, parsePolicyObject, type Policy } from "../policy/index.ts";
import { stringList } from "../bash/index.ts";
import { Probe, parseProbeConfig } from "../probe.ts";

/** activate() 的接线选项。profile 层已移除，目前没有字段；新选项按需加在这里。 */
export interface ActivateOptions {}

/** 未配置时的策略：全拒、只读、不计数。与 denyAll 的「坏了」不同，这是「没配」。 */
const INACTIVE: Policy = {
	globs: [],
	regexps: [],
	writeGlobs: [],
	absoluteWrite: [],
	writeRegexps: [],
	source: "not configured",
	readOnly: true,
	maxReads: 0,
	allowTools: [],
	tools: {},
	probe: undefined,
	maxDenies: 0,
	maxWriteDenies: 0,
	active: false,
};

/**
 * activate() 的全部可变会话状态。七个事件处理器原本直接读 activate 闭包里的
 * 这批变量；收进一个对象，是为了让处理器可以逐个搬出 index.ts 而不带走闭包。
 * 字段初始化就是 activate() 原来的声明序（见 createWiring）。
 */
export interface WiringState {
	/**
	 * bindings 在激活时定格：前台子代理的 bindings 环境变量只在会话启动前存在，
	 * tool_call 里读不到，必须在这里取。角色 md（含派单的 worktree 默认值）按会话 cwd
	 * 读，在各自的事件处理器里解析。
	 */
	call: ReturnType<typeof extractCallConfig>;
	policy: Policy;
	/** 角色 md 的基线：before_agent_start 里按子代理身份填入，只补 bindings 没给的字段。 */
	roleBaseline: RolePolicy | undefined;
	roleSource: string | undefined;
	roleResolved: boolean;
	/**
	 * before_agent_start 可能在 preExec 等待期间再次触发；同一个键的发射者 await 在飞的接线，
	 * 不同键（另一个子会话）各走各的。失败时 finally 删键，下一轮可重试，不缓存 rejected promise。
	 */
	roleWirings: Map<string, Promise<void>>;
	baseConfig: Record<string, unknown> | undefined;
	baseSource: string;
	baseRequireScope: boolean;
	baseBroken: boolean;
	/** toolCallId → 这次 bash 的 spec 摘要（写清单、cwd、是否离线）。 */
	sandboxSpecs: Map<
		string,
		{ write: string[]; cwd: string; offline: boolean; command: string; specFile?: string }
	>;
	/**
	 * helper 的「网络已隔离」提示每会话只播报一次：第一条离线命令照常播报，之后的
	 * 离线命令由 wrapInSandbox 加 quiet 前缀。住在会话状态上而不是模块级变量上 ——
	 * 模块级的记牌会跨会话泄漏，第二个会话的第一条命令就被静音了。
	 */
	sandboxNetworkNoticeAnnounced: boolean;
	denyCounter: DenyCounter;
	/** 写拒单独计数：写拒的正解是换交付方式（回报告），跟「授权写错」不是一类信号。 */
	writeDenyCounter: DenyCounter;
	allowedReads: number;
	/**
	 * 停机是硬停：每个被拦的结果都带 terminate，pi 在整批结果都 terminating 时结束本轮
	 * （docs/extensions.md："terminate only applies to a blocked call; the agent stops early
	 * only when every finalized result in the batch is terminating"）。停止后整批都会被拦，
	 * 所以不留「一切都拒绝、模型还在反复试」的软状态。
	 */
	stopped: boolean;
	currentCtx: { cwd?: string; actions?: unknown; ui?: unknown } | undefined;
	probe: Probe | undefined;
	/**
	 * UI 提示通道：这条告警是给父代理看的配置问题，不该写进模型上下文，所以只走 UI
	 * （ctx.ui.notify）。session_start / judgeToolCall / before_agent_start 每次拿到
	 * 自己的 ctx 时覆盖写入，最近一次写入的生效——告警跟着最新的事件上下文走。
	 */
	uiWarning?: (message: string) => void;
}

/** 状态加上三个改状态的方法：处理器读字段、调方法，不再碰闭包。 */
export interface Wiring extends WiringState {
	stop(reason: string): { block: true; reason: string; terminate: true };
	/** 按当前 policy 建探针。角色基线重算策略后会重新上探针，所以这里可重跑。 */
	armProbe(): void;
	/**
	 * bindings 已经有值的键优先，md 基线只填缺失的那几个
	 * （scope、writeScope、readOnly、allowTools、maxDenies、maxWriteDenies）。
	 */
	applyRoleBaseline(): void;
}

/**
 * 逐字搬自 activate() 的声明段：先取 call、按坏/好分支定 policy、
 * 再建两个计数器，最后 armProbe()。顺序与条件都保持原样。
 */
export function createWiring(): Wiring {
	const call = extractCallConfig(process.env[BINDINGS_ENV]);
	let policy: Policy = INACTIVE;
	if (call.error) {
		policy = denyAll(call.error);
	} else if (call.config) {
		policy = parsePolicyObject(call.config, `extensionBindings ${bindingKey()}`, { requireScope: true });
	}
	const wiring: Wiring = {
		call,
		policy,
		roleBaseline: undefined,
		roleSource: undefined,
		roleResolved: false,
		roleWirings: new Map<string, Promise<void>>(),
		baseConfig: call.config,
		baseSource: `extensionBindings ${bindingKey()}`,
		baseRequireScope: Boolean(call.config),
		baseBroken: Boolean(call.error),
		sandboxSpecs: new Map<
			string,
			{ write: string[]; cwd: string; offline: boolean; command: string; specFile?: string }
		>(),
		sandboxNetworkNoticeAnnounced: false,
		denyCounter: new DenyCounter(policy.maxDenies),
		writeDenyCounter: new DenyCounter(policy.maxWriteDenies, "write"),
		allowedReads: 0,
		stopped: false,
		currentCtx: undefined,
		probe: undefined,
		stop(reason: string) {
			this.stopped = true;
			// 详细理由只回给触发停机的那一次；后续调用拿 stopNotice，见 activate 里的 stopNotice 注释。
			return { block: true, reason, terminate: true } as const;
		},
		armProbe(): void {
			const probeCfg = parseProbeConfig(this.policy.probe);
			this.probe =
				this.policy.active && probeCfg
					? new Probe({
						config: probeCfg,
						readOnly: this.policy.readOnly,
						hooks: {
							warn: (text) => {
								const ui = this.currentCtx?.ui as { notify?: (m: string, t?: string) => void } | undefined;
								ui?.notify?.(`pi-subagents-extend: ${text}`, "warning");
							},
						},
					})
					: undefined;
		},
		applyRoleBaseline(): void {
			if (this.baseBroken || !this.roleBaseline || Object.keys(this.roleBaseline).length === 0) return;
			// 上层自己写了 readOnly 且没写 writeScope：写范围就是空的（与 mergeConfig 同语义），
			// md 不能把写授权重新放出来。
			const readOnlyWithoutWrite = Object.hasOwn(this.baseConfig ?? {}, "readOnly") && this.baseConfig?.readOnly === true && !Object.hasOwn(this.baseConfig ?? {}, "writeScope");
			const fields: Record<string, unknown> = { ...(this.baseConfig ?? {}) };
			let mdContributed = false;
			for (const [key, value] of Object.entries(this.roleBaseline)) {
				if (key === "writeScope" && readOnlyWithoutWrite) continue;
				// bash.deny 是硬底线（与 mergeConfig 同语义）：派单整块声明了 bash 也不拆 md 的禁令。
				// 效果 = payload 的 bash 原样 + deny 与 md 的并集；其余字段仍是 payload 优先，
				// payload 没声明 bash（或写坏了）时 md 的整块照旧按下面的缺失补齐走。
				// 并集确实补进了新条目才算 md 有贡献——没有新条目就不重算，source 也不多一层。
				if (key === "bash" && Object.hasOwn(fields, "bash")) {
					const payloadBash = asObject(fields.bash);
					const mdBash = asObject(value);
					if (payloadBash && mdBash) {
						const payloadDeny = stringList(payloadBash.deny);
						const deny = [...new Set([...payloadDeny, ...stringList(mdBash.deny)])];
						if (deny.length > payloadDeny.length) {
							fields.bash = { ...payloadBash, deny };
							mdContributed = true;
						}
					}
					continue;
				}
				if (!Object.hasOwn(fields, key)) {
					fields[key] = value;
					mdContributed = true;
				}
			}
			// md 一个字段都没补进来就不重算策略：来源也不能凭空多出一层。
			if (!mdContributed) return;
			// 拒绝文案里的 source 是父代理判断「该改哪个文件」的唯一线索，只列真正贡献过的层。
			// baseSource 是激活时定格的 bindings 来源（createWiring），排在 md 之前。
			// 「补了字段」不等于「改了结果」：md 写的若本来就是默认值（bash.writable: false，
			// 或没有任何写范围时的 readOnly: true），有效策略与只有载荷时完全相同，source 再
			// 多出 md 这层就是误导——父代理会去改一个改不动的 md。所以按两次解析的结果判
			// 贡献，而不是按补没补字段。
			const mdLabel = this.roleSource ?? "role md";
			let source = this.baseConfig ? `${this.baseSource} + ${mdLabel}` : mdLabel;
			try {
				const withMd = parsePolicyObject(fields, "", { requireScope: this.baseRequireScope });
				const payloadOnly = parsePolicyObject({ ...(this.baseConfig ?? {}) }, "", {
					requireScope: this.baseRequireScope,
				});
				// 两份策略同出 parsePolicyObject 一条构造路径，键序固定，JSON 直比即稳定。
				// source 正是我们在此要决定的，先归一再比；编译出的 RegExp 两边都序列化成
				// {}，内容差异已由 globs / writeGlobs 本身承载。
				if (JSON.stringify({ ...withMd, source: "" }) === JSON.stringify({ ...payloadOnly, source: "" })) {
					source = this.baseSource;
				}
			} catch {
				// 载荷单独解析抛错：按 md 有贡献处理（与今天一致），不让异常悄悄改策略。
			}
			this.policy = parsePolicyObject(fields, source, { requireScope: this.baseRequireScope });
			this.denyCounter = new DenyCounter(this.policy.maxDenies);
			this.writeDenyCounter = new DenyCounter(this.policy.maxWriteDenies, "write");
			this.armProbe();
		},
	};
	wiring.armProbe();
	return wiring;
}
