/**
 * POLICY / PAYLOAD：读派单载荷（extractCallConfig）并把它落成 `Policy`
 * （parsePolicyObject）——键白名单、fail closed 的解析。角色 md 是基线层，
 * 其 extend.permissions 由 wiring/context.ts 的 applyRoleBaseline 逐字段补进
 * 载荷缺失的字段，bash.deny 与载荷的并集在那里是硬底线。本层是纯函数，
 * 不持有会话状态；policy.ts 只做桶装再导出。
 */
import { isAbsolute } from "node:path";
import { parseBashRule } from "../bash/index.ts";
import { DEFAULT_MAX_DENIES, DEFAULT_MAX_WRITE_DENIES } from "../budgets.ts";
import { BINDING_NAMESPACE, bindingKey } from "../role-config.ts";
import { canonical } from "../paths/index.ts";
import { compile, type Policy, type ToolDeclaration } from "./glob.ts";

export const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";

/**
 * 解析 bindings.tools：名字 → 类别覆盖。
 *
 * 写坏就整份绑定作废（fail closed），与 scope / writeScope 的处理一致：一个说不清工具
 * 类别的会话没办法安全地放行任何工具。
 */
export function parseToolDeclarations(value: unknown): {
	declarations: Record<string, ToolDeclaration>;
	error?: string;
} {
	// 工具名来自外部输入：用无原型对象，避免 "__proto__" 这类键改写原型链。
	const declarations: Record<string, ToolDeclaration> = Object.create(null);
	if (value === undefined) return { declarations };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { declarations, error: "tools must be an object of { toolName: { access, path } }" };
	}
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { declarations, error: `tools.${name} must be an object` };
		}
		const entry = raw as { access?: unknown; path?: unknown; transferSource?: unknown };
		if (entry.access !== undefined && entry.access !== "read" && entry.access !== "write") {
			return { declarations, error: `tools.${name}.access must be "read" or "write"` };
		}
		if (
			entry.path !== undefined &&
			entry.path !== false &&
			(typeof entry.path !== "string" || entry.path.trim() === "")
		) {
			return { declarations, error: `tools.${name}.path must be a non-empty string or false` };
		}
		if (
			entry.transferSource !== undefined &&
			entry.transferSource !== "read" &&
			entry.transferSource !== "write"
		) {
			return { declarations, error: `tools.${name}.transferSource must be "read" or "write"` };
		}
		const declaration: ToolDeclaration = {};
		if (entry.access !== undefined) declaration.access = entry.access;
		if (entry.path !== undefined) {
			declaration.path = entry.path === false ? false : (entry.path as string).trim();
		}
		if (entry.transferSource !== undefined) declaration.transferSource = entry.transferSource;
		declarations[name] = declaration;
	}
	return { declarations };
}

/**
 * bindings 存在但无法使用时的策略：会话保持活跃，但什么都拿不到。
 *
 * 预算用缺省值而不是 0：0 表示「永不计数」，那会让一次写坏的绑定变成无限重试的会话 ——
 * 每个调用都被拒、却永远不会停，正是这条判据要避免的状态。拒几次就硬停，父代理能从拒绝
 * 文案里看到真实原因（哪一份绑定、哪里写错）。
 */
export function denyAll(source: string): Policy {
	return {
		globs: [],
		regexps: [],
		absoluteRead: [],
		writeGlobs: [],
		absoluteWrite: [],
		writeRegexps: [],
		source,
		readOnly: true,
		maxReads: 0,
		allowTools: [],
		tools: {},
		probe: undefined,
		maxDenies: DEFAULT_MAX_DENIES,
		maxWriteDenies: DEFAULT_MAX_WRITE_DENIES,
		active: true,
	};
}

export function positiveInt(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** `extensionBindings` 里的这两个键属于角色 md，不该影响本次派单的策略。 */
export const PAYLOAD_IGNORED_KEYS = ["setup", "output"] as const;

/** 命名空间层站在 permissions 旁边的块级键；不进策略，交给 worktree 决策。 */
export const NAMESPACE_BLOCK_KEYS = ["worktree"] as const;
/** 命名空间层能识别的全部键；其余键一律拒绝，免得拼写错误被静默忽略。 */
export const NAMESPACE_KEYS = ["permissions", ...NAMESPACE_BLOCK_KEYS, ...PAYLOAD_IGNORED_KEYS] as const;
/** 从 PI_SUBAGENT_EXTENSION_BINDINGS 里取本扩展的 namespace 配置对象；版本不匹配一律拒绝。 */
interface CallConfigResult {
	config?: Record<string, unknown>;
	/** 命名空间层的块级键（如 worktree），不属于 permissions 策略。 */
	blocks?: Record<string, unknown>;
	error?: string;
	/** 命名空间层或 permissions 层出现的、必须只告警一次的键。 */
	ignored?: string[];
}

/**
 * 派单载荷 permissions 里出现 parsePolicyObject 不认识的键时的拒绝文案。
 * `write` / `budgets` 是角色 md 的拼法，这里点名正确的派单拼法，避免用户照 md 抄过来被静默丢弃。
 */
export function unknownPayloadKeysError(keys: readonly string[], prefix: string): string {
	const hints: Record<string, string> = {
		write: 'the dispatch spelling is "writeScope"',
		budgets: 'the dispatch spelling is "maxReads" / "maxDenies"',
	};
	const listed = keys
		.map((key) => (hints[key] ? `"${key}" (${hints[key]})` : `"${key}"`))
		.join(", ");
	return `${prefix}.permissions: unknown key(s) ${listed}; everything is refused`;
}

export function unknownNamespaceKeysError(keys: readonly string[], prefix: string): string {
	const listed = keys.map((key) => `"${key}"`).join(", ");
	const accepted = NAMESPACE_KEYS.map((key) => `"${key}"`).join(", ");
	return `${prefix}: unknown namespace key(s) ${listed}; accepted namespace keys are ${accepted}; everything is refused`;
}

export function extractCallConfig(raw: string | undefined): CallConfigResult {
	if (!raw?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			error: `${BINDINGS_ENV} is not valid JSON (${error instanceof Error ? error.message : String(error)}); everything is refused`,
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: `${BINDINGS_ENV} is not a JSON object; everything is refused` };
	}
	const record = parsed as Record<string, unknown>;
	const prefix = `${BINDING_NAMESPACE}/`;
	const keys = Object.keys(record).filter((key) => key.startsWith(prefix));
	// 绑定是给别的扩展的，本扩展不参与。
	if (keys.length === 0) return {};
	if (keys.length > 1) {
		return { error: `ambiguous: more than one ${BINDING_NAMESPACE}/* namespace; everything is refused` };
	}
	const key = keys[0];
	if (key !== bindingKey()) {
		return { error: `this build supports ${bindingKey()}, got ${key}; everything is refused` };
	}
	const cfg = record[key];
	if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
		return { error: `extensionBindings ${key}: the configuration is not an object; everything is refused` };
	}
	const namespace = cfg as Record<string, unknown>;
	const expected = `{"extensionBindings":{"${key}":{"permissions":{"scope":["src/**"]}}}}`;
	// 派单载荷和角色 md 的 extend.permissions 是同一个对象；扁平写法不是「少一层语法糖」，
	// 而是另一份契约。放过它会在用户照文档写对时反而拒绝，所以这里只认一层 permissions。
	if (!Object.hasOwn(namespace, "permissions")) {
		return {
			error: `extensionBindings ${key}: missing "permissions" object; the namespace key must contain a permissions object; expected ${expected}; everything is refused`,
		};
	}
	const perms = asObject(namespace.permissions);
	if (!perms) {
		return {
			error: `extensionBindings ${key}.permissions must be an object; expected ${expected}; everything is refused`,
		};
	}
	// 命名空间层只认 permissions / 块级键 / 忽略对；多出来的键直接拒绝，不让拼写错误藏在这里。
	const unknownNamespace = Object.keys(namespace).filter(
		(name) => !(NAMESPACE_KEYS as readonly string[]).includes(name),
	);
	if (unknownNamespace.length > 0) {
		return { error: unknownNamespaceKeysError(unknownNamespace, `extensionBindings ${key}`) };
	}
	const config: Record<string, unknown> = Object.create(null);
	const unknown: string[] = [];
	for (const [name, value] of Object.entries(perms)) {
		// setup / output 是给别的扩展的，本扩展不参与，只告警一次。
		if ((PAYLOAD_IGNORED_KEYS as readonly string[]).includes(name)) continue;
		// 原型键不是声明：Object.create(null) 让它成为普通键，这里直接跳过，不进 config 也不报错。
		if (name === "__proto__") continue;
		if ((POLICY_CONFIG_KEYS as readonly string[]).includes(name)) {
			config[name] = value;
		} else {
			unknown.push(name);
		}
	}
	if (unknown.length > 0) {
		return { error: unknownPayloadKeysError(unknown, `extensionBindings ${key}`) };
	}
	const blocks: Record<string, unknown> = Object.create(null);
	for (const name of NAMESPACE_BLOCK_KEYS) {
		if (Object.hasOwn(namespace, name)) blocks[name] = namespace[name];
	}
	const ignored = PAYLOAD_IGNORED_KEYS.filter(
		(name) => Object.hasOwn(namespace, name) || Object.hasOwn(perms, name),
	);
	return { config, blocks, ignored: [...ignored] };
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/**
 * 配置对象 → 策略。
 *
 * `requireScope` 为 true 时（本次调用的 bindings）scope 必须写成字符串数组，写错
 * 就全拒；为 false 时（agent profile 的默认值）允许不写 scope：角色的默认值不知道
 * 本次任务管哪些路径，此时文件访问全拒但 bash 白名单照常可用——漏传 bindings 是
 * 「响的」失败，不是「什么限制都没有」。
 */
/**
 * 写范围（edit / write 工具），与 bash.writablePaths（进程层）分开：
 *   不写 writeScope → 等于读范围，现有派单行为不变；
 *   readOnly → 默认等价于空写范围；但**同一层写的 writeScope 优先**，这样「只读会话 + 一个
 *              报告文件」是能表达的，而不是非黑即白。派单只写 readOnly 时不写 writeScope，
 *              applyRoleBaseline（wiring/context.ts）会跳过 md 基线的 writeScope，那份压不过它；
 *   写了 → 只认这一份，写超出即拒，读不受影响。
 */
export function parseWriteScope(
	config: Record<string, unknown>,
	globs: string[],
	readOnly: boolean,
	source: string,
): { writeGlobs?: string[]; error?: string } {
	if (readOnly && config.writeScope === undefined) return { writeGlobs: [] };
	if (config.writeScope === undefined) return { writeGlobs: globs };
	const ws = config.writeScope;
	if (!Array.isArray(ws) || ws.some((g) => typeof g !== "string" || !g.trim())) {
		return { error: `${source}.writeScope must be an array of strings; everything is refused` };
	}
	return { writeGlobs: (ws as string[]).map((g) => g.trim()).filter(Boolean) };
}

/**
 * parsePolicyObject 认识的配置键。派单载荷的 permissions 对象只认这些键，
 * 其余键由 extractCallConfig 在入口拒绝（见 unknownPayloadKeysError），避免
 * 「拼错的收窄字段被静默丢弃」——丢弃一个写范围收窄会把写授权放大到整个读范围。
 */
export const POLICY_CONFIG_KEYS = [
	"scope",
	"writeScope",
	"readOnly",
	"tools",
	"allowTools",
	"bash",
	"probe",
	"maxReads",
	"maxDenies",
	"maxWriteDenies",
] as const;

export function parsePolicyObject(
	config: Record<string, unknown>,
	source: string,
	options: { requireScope: boolean },
): Policy {
	const scope = config.scope;
	const scopeGiven = scope !== undefined;
	if (scopeGiven && (!Array.isArray(scope) || scope.some((g) => typeof g !== "string" || !g.trim()))) {
		return denyAll(`${source}.scope must be an array of strings; everything is refused`);
	}
	if (!scopeGiven && options.requireScope) {
		return denyAll(`${source}.scope is missing; everything is refused`);
	}
	const globs = scopeGiven ? (scope as string[]).map((g) => g.trim()).filter(Boolean) : [];

	// 绝对条目是父代理点名的树外读授权，与 writeScope 的绝对条目同构：相对条目进 globs 由
	// matches() 按真实路径绑在树上，绝对条目单独收进 absoluteRead 由 underAny() 按前缀比对。
	// 两者并存取并集（判定里 matches(...) || underAny(...)），没有绝对条目时与旧行为逐字节相同。
	const absoluteRead = globs.filter((g) => isAbsolute(g)).map((g) => canonical(g));
	const readGlobs = globs.filter((g) => !isAbsolute(g));
	const readOnly = config.readOnly === true;
	const write = parseWriteScope(config, globs, readOnly, source);
	if (write.error) return denyAll(write.error);
	const toolDeclarations = parseToolDeclarations(config.tools);
	if (toolDeclarations.error)
		return denyAll(`${source}.${toolDeclarations.error}; everything is refused`);
	const allWrite = write.writeGlobs as string[];
	const absoluteWrite = allWrite.filter((g) => isAbsolute(g)).map((g) => canonical(g));
	const writeGlobs = allWrite.filter((g) => !isAbsolute(g));
	const allowTools = Array.isArray(config.allowTools)
		? (config.allowTools as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
		: [];
	return {
		globs: readGlobs,
		regexps: compile(readGlobs),
		absoluteRead,
		writeGlobs,
		absoluteWrite,
		writeRegexps: compile(writeGlobs),
		source,
		readOnly,
		maxReads: positiveInt(config.maxReads),
		allowTools,
		tools: toolDeclarations.declarations,
		bash: parseBashRule(config.bash),
		probe: config.probe,
		// 撞权限是纯错误信号：不配也开，父代理可以显式写 0 关掉。
		// 缺省 5：停机是硬停，判早一次就丢掉整轮任务，而多给几次只浪费几个调用。
		maxDenies: config.maxDenies === 0 ? 0 : positiveInt(config.maxDenies) || DEFAULT_MAX_DENIES,
		// 缺省 2：写拒是用法错（该回报告而不是落盘），给两次机会换做法就够。
		maxWriteDenies: config.maxWriteDenies === 0 ? 0 : positiveInt(config.maxWriteDenies) || DEFAULT_MAX_WRITE_DENIES,
		active: true,
	};
}
