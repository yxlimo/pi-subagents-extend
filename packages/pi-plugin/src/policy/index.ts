/**
 * POLICY / PARSE 层：把派单载荷与角色 md 基线解析成 `Policy`。两层的合并不在这里：
 * wiring/context.ts 的 applyRoleBaseline 逐字段把基线补进载荷缺失的字段，
 * bash.deny 取并集作硬底线。实现按主题住在 `policy/` 下的两个模块里，本文件只做
 * 桶装再导出，调用方的 `from "./index.ts"` 全部原样可用，行为不变。
 * - `policy/payload.ts`：读派单载荷交给我们的配置对象（键白名单、fail closed）。
 * - `policy/glob.ts`：glob 编译与范围比对原语，以及共享类型 `Policy` / `ToolDeclaration`。
 */

export {
	BINDINGS_ENV,
	PAYLOAD_IGNORED_KEYS,
	NAMESPACE_BLOCK_KEYS,
	NAMESPACE_KEYS,
	POLICY_CONFIG_KEYS,
	asObject,
	denyAll,
	extractCallConfig,
	parsePolicyObject,
	parseToolDeclarations,
	parseWriteScope,
	positiveInt,
	unknownNamespaceKeysError,
	unknownPayloadKeysError,
} from "./payload.ts";


export {
	compile,
	globToRegExp,
	matches,
	normalizeGlob,
	underAny,
} from "./glob.ts";

export type { Policy, ToolDeclaration } from "./glob.ts";
