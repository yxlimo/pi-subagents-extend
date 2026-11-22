import type { ContextEvent, ContextEventResult, ResourcesDiscoverResult } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { handoffHintFor, withHint } from "../handoff-hint.ts";
import { sweepStaleSpecFiles } from "../sandbox/index.ts";
import type { Wiring } from "./context.ts";
import { textOf } from "./tool-result.ts";

/**
 * 随包发布的用法 skill 目录，经 resources_discover 注册，扩展加载即生效。
 * 三个：范围与 bash 白名单、探针判据与停机语义、上下文隔离（AGENTS.md 标记与主代理专属文件）。
 * 逐字搬自 index.ts；本文件在 wiring/ 下深一层，所以 URL 前缀从 ../skills 改成 ../../skills。
 */
const SKILL_DIRS = ["pi-subagents-extend", "pi-subagents-extend-probes", "pi-subagents-extend-context"].map((name) =>
	fileURLToPath(new URL(`../../skills/${name}`, import.meta.url)),
);

/**
 * resources_discover 的正文：受管（active）的会话不注册用法 skill——它写给父代理看，
 * 子代理会话里只会占上下文。只读 Wiring 上的 policy，不持有会话状态。
 */
export function discoverResources(w: Wiring): ResourcesDiscoverResult {
	return w.policy.active ? {} : { skillPaths: SKILL_DIRS };
}

/**
 * session_shutdown 的正文：释放探针，再兜底清掉 spec 文件。
 * 只读 Wiring 上的 probe，不持有自己的会话状态 —— 状态的唯一一份仍在 createWiring() 里。
 */
export function disposeOnShutdown(w: Wiring): void {
	w.probe?.dispose();
	// 兜底：清掉本次会话（以及之前被中断的会话）遗留的 spec 文件。
	sweepStaleSpecFiles();
}

/**
 * context 的正文：只读入参 event，不碰 Wiring 上的任何字段。
 * 就地补一句交接提示；内容是模型实际看到的，别改动注入的文案。
 */
export function injectHandoffNotes(event: ContextEvent): ContextEventResult | undefined {
	let changed = false;
	const messages = event.messages.map((message) => {
		if (message.role !== "custom" && message.role !== "user") return message;
		const text = textOf(message.content);
		// 便宜的前置筛：没有 handoff 字样就不进正则。
		if (!text.includes("handoff")) return message;
		const hint = handoffHintFor(text);
		if (!hint) return message;
		changed = true;
		const content = Array.isArray(message.content)
			? withHint(message.content, hint)
			: withHint(message.content, hint);
		return { ...message, content };
	});
	return changed ? { messages } : undefined;
}
