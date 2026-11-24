import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { readFileSync, rmSync } from "node:fs";
import { handoffHintFor, withHint } from "../handoff-hint.ts";
import { unreachableCommandNote } from "../notices.ts";
import { cpuStallNote, networkFailureNote, writeRefusalNote } from "../sandbox-note.ts";
import type { Wiring } from "./context.ts";

/** 从 tool_result 的 content/result 里抽纯文本。 */
export function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
				return "";
			})
			.join("\n");
	}
	if (value && typeof value === "object" && "text" in value) return String((value as { text: unknown }).text ?? "");
	return "";
}

/**
 * tool_result 处理器的正文，只读 Wiring 上的字段（probe / policy / sandboxSpecs），
 * 不持有自己的会话状态 —— 状态的唯一一份仍在 createWiring() 里。
 */
export function annotateToolResult(w: Wiring, event: ToolResultEvent): ToolResultEventResult | undefined {
	const text = textOf(event.content);
	const isBash = event.toolName === "bash";
	if (w.probe && isBash) w.probe.noteBashResult(text, event.toolCallId);
	// bash 没开时命令根本没跑，别去解释它的结果。
	const offline = w.policy.bash !== undefined && w.policy.bash.network !== true;
	const ran = w.sandboxSpecs.get(event.toolCallId);
	if (ran) {
		// 内核有没有看到写：探针的「写活动」只有这一个来源（bash 命令不再自带读写身份）。
		// 读不到就是没证据——旧版 helper 不写这份文件，被信号杀掉的命令也来不及写完。
		// `watched: 0` 同样是没证据（写范围还不存在），不能当成「没写过」。
		if (ran.observeFile && w.probe) {
			try {
				const observation = JSON.parse(readFileSync(ran.observeFile, "utf8")) as { wrote?: boolean | null };
				if (observation.wrote === true) w.probe.noteWriteActivity();
			} catch {
				// 没有结果文件 = 没有证据，不猜。
			}
		}
		w.sandboxSpecs.delete(event.toolCallId);
		// helper 早已读过它；留着只会堆垃圾文件（每个 bash 调用一份）。
		if (ran.specFile) {
			try {
				rmSync(ran.specFile, { force: true });
			} catch {
				// 删不掉不影响判定，忽略。
			}
		}
	}
	const hints = [
		handoffHintFor(text),
		// 两道注解都以「这条命令真的失败了」为前提。不看 isError 时，成功命令的**输出内容**里
		// 出现 EACCES / ENETUNREACH 字样也会命中：实测一个子代理跑 `git diff`，diff 正文里
		// 含这些字符串，于是它自己的一份正确改动被追加了「这在授权之外，去要 writablePaths」。
		// 判断事实而不猜文案：工具结果自带 isError。
		isBash && event.isError ? networkFailureNote(text, offline) : undefined,
		isBash && event.isError ? cpuStallNote(text) : undefined,
		isBash && ran && event.isError ? writeRefusalNote(text, ran.write, ran.cwd) : undefined,
		isBash && ran && event.isError && w.policy.bash
			? unreachableCommandNote(text, ran.command, w.policy.bash, ran.cwd)
			: undefined,
	].filter((hint): hint is string => Boolean(hint));
	if (!hints.length) return undefined;
	return { content: withHint(event.content, hints.join("\n\n")) };
}
