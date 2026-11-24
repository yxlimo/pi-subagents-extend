import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { reportUnreachableEntries, reportedUntrackedWorktreeProfiles } from "../notices.ts";
import { bashBlocker, detectPnpmStore, helperPath, reportedHiddenGrants } from "../sandbox/index.ts";
import type { ActivateOptions, Wiring } from "./context.ts";

/**
 * session_start 的正文（逐字搬自 index.ts 的处理器）：接上本会话的 UI 提示通道、清空
 * 「只说一次」的告警护栏，最后向父代理汇报生效范围。角色 md 的基线在
 * before_agent_start 的接线里解析，这里不再读任何配置文件。
 */


/**
 * session_start 的正文（逐字搬自 index.ts 的处理器）：策略只来自激活时定格的 bindings，
 * 这里接上 UI 提示通道、清空告警护栏并汇报生效范围；options 与 event 都用不到，
 * 保持处理器的调用形状。
 */
export async function wireSessionStart(w: Wiring, _options: ActivateOptions, _event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
	w.currentCtx = ctx;
	// 提示状态按会话重置：一个进程可能服务多个会话，模块级的 set 留到下一个会话就会把
	// 本该发出的告警吞掉（那是「lost, not duplicated」的一种，且完全没有痕迹）。
	reportedHiddenGrants.clear();
	reportedUntrackedWorktreeProfiles.clear();
	// UI 提示通道在这里接上会话的 ctx：`judgeToolCall` 只在工具调用时绑定，session_start
	// 里的告警要发得出去，就不能等第一次工具调用。
	w.uiWarning = (message) => {
		const ui = ctx.ui as { notify?: (m: string, t?: string) => void } | undefined;
		ui?.notify?.(message, "warning");
	};
	const cwd = ctx.cwd ?? process.cwd();
	if (!w.policy.active) return;
	const budget = w.policy.maxReads > 0 ? `, read budget ${w.policy.maxReads}` : "";
	const bash = w.policy.bash
		/** 报「配置里到底有什么」，不是「哪一列有值」：只数 allow。 */
		? (() => {
			const parts: string[] = [];
			if (w.policy.bash.allow.length > 0) parts.push(`${w.policy.bash.allow.length} allowed`);
			return `, bash ${parts.join(" / ") || "no entries"}`;
		})()
		: ", bash off";
	const probeLine = w.probe ? ", probe on" : "";
	const storeLine = w.policy.bash ? `, pnpm store ${detectPnpmStore(cwd).path ?? "detection failed"}` : "";
	const writeGrants = [...w.policy.writeGlobs, ...w.policy.absoluteWrite];
	let mode = "read-write";
	if (w.policy.readOnly) mode = writeGrants.length > 0 ? "read-only, except the granted writes" : "read-only";
	const sameWrite = w.policy.writeGlobs.join("\n") === w.policy.globs.join("\n");
	const writeNote = sameWrite ? "" : `, write scope ${w.policy.writeGlobs.length} entries`;
	const msg = w.policy.globs.length
		? `scope active (${w.policy.source}, ${w.policy.globs.length} entries${writeNote}, ${mode}${budget}${bash}${probeLine}${storeLine})`
		: `scope is empty: every file access is refused${budget}${bash}${probeLine}${storeLine}`;
	ctx.ui.notify(`pi-subagents-extend: ${msg}`, "info");
	// 只在该会话真的会跑 bash 时才喊：父会话没 bindings 时 bash 不受管，不必打扰。
	if (w.policy.bash) {
		const blocker = bashBlocker(helperPath());
		if (blocker) ctx.ui.notify(`pi-subagents-extend: ${blocker}`, "warning");
		// 授权写了却永远命中不了：告诉父代理一次（走 UI，不进模型上下文）。
		reportUnreachableEntries(w.policy.bash, cwd, w.uiWarning);
	}
}
