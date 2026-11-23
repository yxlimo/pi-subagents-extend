/**
 * 模型**原始**工具参数：按 toolCallId 从会话 transcript 里取回。
 *
 * 为什么需要：pi 的 tool_call 处理器共用同一个可变的 `event.input`，先注册的处理器改了它，
 * 后面的处理器看到的就是改过的值（pi 文档 extensions.md 的 In-place mutation），而处理器顺序
 * 由扩展的加载顺序决定，不在本扩展手里。实测 rtk（把命令改写成 `rtk <cmd>` 省 token）先跑，
 * 于是判定读到 `rtk git status`，与我们记的 bash.allow 里的 `git status` 永远匹配不上 ——
 * 整个会话的 bash 全被拒，而模型根本没那么写过。
 *
 * transcript 里存的是模型实际输出的 arguments，不受处理器链改写影响，所以判定以它为准；
 * 处理器链上的改写仍然保留，作为被沙箱包住的内层命令执行，两边的意图都不丢。
 */
interface ToolCallBlock {
	type?: string;
	id?: string;
	arguments?: unknown;
}

const asArguments = (block: ToolCallBlock): Record<string, unknown> | undefined => {
	const raw = block.arguments;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	// 某些宿主把 arguments 存成 JSON 字符串；解析不出来就当没有，绝不让它变成判定失败。
	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
};

/**
 * 在 transcript 条目里找 toolCallId 对应的工具调用参数。找不到返回 undefined ——
 * 嵌套调用（`<parent>/<n>`）按定义不落在 transcript 里，调用方要退回 `event.input`。
 */
export function originalToolArguments(entries: readonly unknown[], toolCallId: string): Record<string, unknown> | undefined {
	if (!toolCallId) return undefined;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as { message?: { content?: unknown } } | undefined;
		const content = entry?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as ToolCallBlock[]) {
			if (block?.type !== "toolCall" || block.id !== toolCallId) continue;
			const args = asArguments(block);
			if (args) return args;
		}
	}
	return undefined;
}

/**
 * 取原始命令字符串：判定 bash 时的入口。宿主没给 sessionManager（测试替身、旧宿主）、
 * transcript 里没有这一条、或者参数里没有 command 时都返回 undefined，调用方退回 event.input。
 */
export function originalCommand(ctx: unknown, toolCallId: string): string | undefined {
	const sessionManager = (ctx as { sessionManager?: { getBranch?: () => unknown } } | undefined)?.sessionManager;
	const entries = sessionManager?.getBranch?.();
	if (!Array.isArray(entries)) return undefined;
	const args = originalToolArguments(entries, toolCallId);
	const command = args?.command;
	return typeof command === "string" && command.trim() ? command.trim() : undefined;
}
