import { resolve } from "node:path";
import { nodeModulesWriteHint } from "../agent-start.ts";
import type { Wiring } from "../context.ts";
import { matches, underAny } from "../../policy/index.ts";
import { isRootish } from "../../paths/index.ts";
import { anchorTargetPath, ANCHOR_ARGS, TRANSFER_DEST_ARGS, TRANSFER_SOURCE_ARGS } from "./anchor.ts";

/**
 * 路径类工具的判定（pathToolVerdict）与三类拒绝 helper，从 index.ts 的 activate()
 * 闭包整体移入。判定函数不持有会话状态：全部状态都在 Wiring 上，由调用方传入；
 * allowedReads 也照旧通过 `w.allowedReads += 1` 记回 Wiring（见 verdict 尾部）。
 */

/** 路径类工具里的读工具：read 预算只对它计数。 */
const READ_TOOL = "read";

/**
 * 双文件工具的源文件按什么判。`copy` 只读源（源可以只读），`move` 从源里删（源必须可写）。
 * 没在这张表里的双文件工具按 `write` 判 —— 拿不准就往严里判，这是本层的既有取向。
 */
const DEFAULT_TRANSFER_SOURCE: Record<string, "read" | "write"> = {
	copy: "read",
	move: "write",
};

/** 把 glob 列表压进拒绝文案：最多 12 条，空列表直说。 */
export function preview(globs: string[]): string {
	if (globs.length === 0) return "(empty)";
	const shown = globs.slice(0, 12).join(", ");
	return globs.length > 12 ? `${shown} …` : shown;
}

/** 用法/配置错误：只拒，不计入撞权限预算。 */
export const deny = (reason: string) => ({ block: true, reason } as const);

/** 授权与任务不匹配：计入撞权限预算，预算用尽即停机。 */
export const bail = (w: Wiring, reason: string) => {
	const counted = w.denyCounter.record();
	if (!counted.yes) return deny(reason);
	const composed = counted.note ? `${reason}\n\n${counted.note}` : reason;
	return counted.stop ? w.stop(composed) : deny(composed);
};

// 写拒自己的预算：文案必须给出「改用回报告」这条出路，否则子代理只会换个路径再试。
export const writeBail = (w: Wiring, reason: string) => {
	const counted = w.writeDenyCounter.record();
	if (!counted.yes) return deny(reason);
	const composed = counted.note ? `${reason}\n\n${counted.note}` : reason;
	return counted.stop ? w.stop(composed) : deny(composed);
};

const pathToolVerdict = (
	w: Wiring,
	event: { toolName: string; input?: unknown },
	cwd: string,
	kind: { access: "read" | "write"; pathArg: string | false; transferSource?: "read" | "write" },
	sessionFile: string | undefined,
): { block: true; reason: string; terminate?: boolean } | undefined => {
	const isWrite = kind.access === "write";
	// 声明成写工具却没有可判的路径入参：目标拿不到，就没有任何授权能覆盖它。永远拒绝，
	// 而且这是用法/配置问题，不计入撞权限预算。
	if (isWrite && kind.pathArg === false) {
		return deny(
			`pi-subagents-extend: ${event.toolName} is declared as a write tool with no path argument, so its target cannot be checked (source: ${w.policy.source}). Declare tools.${event.toolName}.path in the bindings, or let the parent perform this write.`,
		);
	}
	const input = (event as { input?: Record<string, unknown> }).input;
	const pathValue = kind.pathArg === false ? undefined : input?.[kind.pathArg];
	let raw = typeof pathValue === "string" ? pathValue.trim() : "";
	// 写类工具没带路径时，先按「锚点归属」把目标找回来：锚点编辑工具的目标就是锚点所属的
	// 文件，归属记在宿主扩展的会话 sidecar 里。解析不出来就保持空 → 下面拒绝。
	const anchorTextOf = (keys: string[]): string[] =>
		keys
			.map((key) => input?.[key])
			.filter((value): value is string => typeof value === "string")
			.map((value) => value.trim())
			.filter((value) => value !== "");

	let anchorsTried: string[] = [];
	// 解析失败要分清是哪一种：模型看到的文案不同，出路也不同（重读一次 vs 拆成两次调用）。
	let anchorMiss: { miss: "unknown" } | { miss: "disagree"; files: string[] } | undefined;
	if (isWrite && !raw) {
		anchorsTried = anchorTextOf(ANCHOR_ARGS);
		const resolved = anchorTargetPath(sessionFile, anchorsTried);
		if ("path" in resolved) raw = resolved.path;
		else anchorMiss = resolved;
	}

	const readable = (path: string): boolean => matches(w.policy.regexps, cwd, path);
	const writable = (path: string): boolean =>
		matches(w.policy.writeRegexps, cwd, path) || underAny(w.policy.absoluteWrite, cwd, path);

	// 锚点分属两个文件：这不是「读不到」，重读一百次还是同一个入参 —— 只能拆成两次调用。
	const disagreeText = (files: string[]): string =>
		`pi-subagents-extend: ${event.toolName} was given anchors that belong to different files (${files.join(", ")}), so there is no single file whose access could be checked (source: ${w.policy.source}). One call edits one file — split this into one call per file.\nWrite scope: ${preview(w.policy.writeGlobs)}`;
	const transferUnknownText = (side: string): string =>
		`pi-subagents-extend: ${event.toolName} moves content between two files, and the ${side} anchors are not in this session's anchor registry, so that file is unknown. Both sides have to be known before either can be checked (source: ${w.policy.source}). Re-read the file (anchors expire), enable the host's force-path option (pi-hashline-edit-pro: requirePath), or pass the path explicitly.\nWrite scope: ${preview(w.policy.writeGlobs)}`;

	// 双文件工具（copy / move）：`source_*` 属于源文件，`anchor`（与 `remove_*`）属于目标
	// 文件，两份文件必须分别判定。合成一组去查只会拿到先命中的那一侧，另一侧完全没判 ——
	// 源在写范围内、目标在范围外时会被放行，而这类工具在子进程里直接落盘，没有 Landlock
	// 兜底，放行就是一次真正的写越界。
	const sourceAnchors = isWrite ? anchorTextOf(TRANSFER_SOURCE_ARGS) : [];
	const destAnchors = isWrite ? anchorTextOf(TRANSFER_DEST_ARGS) : [];
	if (isWrite && sourceAnchors.length > 0 && destAnchors.length > 0) {
		const sourceRes = anchorTargetPath(sessionFile, sourceAnchors);
		const destRes = anchorTargetPath(sessionFile, destAnchors);
		if (!("path" in sourceRes)) {
			return deny(sourceRes.miss === "disagree" ? disagreeText(sourceRes.files) : transferUnknownText("source"));
		}
		if (!("path" in destRes)) {
			return deny(destRes.miss === "disagree" ? disagreeText(destRes.files) : transferUnknownText("destination"));
		}
		const sourcePath = sourceRes.path;
		const destPath = destRes.path;
		// 宿主开了 requirePath 时显式 path 指向其中一侧；对不上就说明声明与锚点不一致。
		// 必须按**解析后**的绝对路径比：注册表里存的是 toCwd 之后的绝对路径，宿主自己也是把
		// providedPath resolve 到 cwd 再与锚点归属比对（fs-write.ts 的 resolveInCwd → toCwd，
		// paths.ts 里非绝对路径就 resolve(cwd, p)）。早先拿原始字符串直接比，任何相对写法
		// （`docs/b.md`、`./docs/b.md`）都永远对不上，于是把宿主本来会执行的调用一律拒掉 ——
		// 而相对写法正是模型最常给的形式，也是宿主 read 输出里的显示形式。
		const rawAbs = raw ? resolve(cwd, raw) : "";
		if (rawAbs && rawAbs !== sourcePath && rawAbs !== destPath) {
			return deny(
				`pi-subagents-extend: ${event.toolName} was given path "${raw}", which matches neither file its anchors belong to ("${sourcePath}" and "${destPath}") (source: ${w.policy.source}). Pass the path of the file the anchors came from, or omit it.`,
			);
		}
		// 表按 Object.hasOwn 读：工具名是外部输入，`__proto__` / `constructor` 这类名字
		// 走普通下标会取到原型链上的对象。表里现在只有 copy / move，撞不到，但这是本文件里
		// 最后一处没设防的表读取，别留着。
		const defaultSource = Object.hasOwn(DEFAULT_TRANSFER_SOURCE, event.toolName)
			? DEFAULT_TRANSFER_SOURCE[event.toolName]
			: undefined;
		const sourceAccess = kind.transferSource ?? defaultSource ?? "write";
		if (sourceAccess === "read") {
			if (!readable(sourcePath)) {
				return bail(
					w,
					`pi-subagents-extend: ${event.toolName} reads "${sourcePath}", which is outside the read scope — copying content out of it would carry that content past this layer (source: ${w.policy.source}). Say what you need from it instead.\nRead scope: ${preview(w.policy.globs)}`,
				);
			}
		} else if (!writable(sourcePath)) {
			return writeBail(
				w,
				`pi-subagents-extend: ${event.toolName} changes the source file "${sourcePath}" (a move deletes the lines it takes), and that file is readable but not writable — the write scope is ${preview(w.policy.writeGlobs)} (source: ${w.policy.source}). Copy instead of moving if the source may only be read.${nodeModulesWriteHint(cwd, sourcePath)}`,
			);
		}
		if (!writable(destPath)) {
			return writeBail(
				w,
				`pi-subagents-extend: "${destPath}" is readable but not writable, so ${event.toolName} cannot place the block there — the write scope is ${preview(w.policy.writeGlobs)} (source: ${w.policy.source}). Deliver a report instead of writing a file; use contact_supervisor if it really has to be written.${nodeModulesWriteHint(cwd, destPath)}`,
			);
		}
		const junk = w.probe?.checkWriteTarget(destPath);
		if (junk) return { block: true, reason: junk.reason, terminate: false };
		w.probe?.noteWriteActivity();
		// 两侧都过了：不要落回下面的单路径判定（它会把源当成写目标再判一次）。
		return undefined;
	}

	const target = raw || ".";
	const writeHint = isWrite ? nodeModulesWriteHint(cwd, target) : "";
	if (event.toolName === READ_TOOL && w.policy.maxReads > 0 && w.allowedReads >= w.policy.maxReads) {
		return bail(w, `pi-subagents-extend: read budget exhausted (${w.policy.maxReads} reads).`);
	}
	const canWrite = w.policy.writeGlobs.length > 0 || w.policy.absoluteWrite.length > 0;
	// 只对 readOnly 早退：`writeScope: []`（不是 readOnly）走下面那条「readable but not
	// writable」，它说清了「读还是能读」，比一句「没有写授权」有用。
	if (isWrite && w.policy.readOnly && !canWrite) {
		// 一条写授权都没有（readOnly 且没写 writeScope，或 writeScope: []）与「写不进去」是同一种
		// 处境：放宽读范围解决不了，所以走写预算。出路是改成交报告，而不是去求援——记到授权
		// 预算上会让子代理连撞 5 次、还被指去 contact_supervisor，而它求不到任何东西。
		return writeBail(
			w,
			`pi-subagents-extend: this session has no write grant; ${event.toolName} is refused (source: ${w.policy.source}). Deliver the finding as a report instead of writing a file; use contact_supervisor if it really has to be written.${writeHint}`,
		);
	}
	// 写操作没有 path 就无法判断目标：直接说清，不要报成「路径不在范围内」。
	// 这是用法错误不是权限错误，不计入撞权限计数。
	if (isWrite && !raw) {
		// 锚点分属两个文件是入参自相矛盾，不是「读不到」：文案要指出去拆调用，别让模型去重读。
		if (anchorMiss?.miss === "disagree") return deny(disagreeText(anchorMiss.files));
		return deny(
			anchorsTried.length > 0
				? `pi-subagents-extend: ${event.toolName} has no target path — no "${kind.pathArg}" was passed, and the anchor it points at is not in this session's anchor registry, so the owning file is unknown. Without a target nothing can be checked, so no scope can allow it (source: ${w.policy.source}). Re-read the file (anchors expire), enable the host's force-path option (pi-hashline-edit-pro: requirePath), or pass the path explicitly.\nWrite scope: ${preview(w.policy.writeGlobs)}`
				: `pi-subagents-extend: ${event.toolName} has no "${kind.pathArg}" — without a target nothing can be checked, so no scope can allow it (source: ${w.policy.source}). Pass it explicitly.\nWrite scope: ${preview(w.policy.writeGlobs)}`,
		);
	}
	const readOk = matches(w.policy.regexps, cwd, target);
	if (isWrite) {
		if (!matches(w.policy.writeRegexps, cwd, target) && !underAny(w.policy.absoluteWrite, cwd, target)) {
			// 读得到、写不到：这是最常见也最容易误导的拒绝，文案要直说撞的是写范围，
			// 并给出正解——回报告——而不是「换个路径再试」。
			if (readOk) {
				return writeBail(
					w,
					`pi-subagents-extend: "${target}" is readable but not writable — the write scope is ${preview(w.policy.writeGlobs)} (source: ${w.policy.source}). Deliver a report instead of writing a file; use contact_supervisor if it really has to be written.${writeHint}`,
				);
			}
			return bail(
				w,
				`pi-subagents-extend: "${target}" is outside the scope — neither readable nor writable (source: ${w.policy.source}). Do not retry outside paths; if you need this one, say what and why.\nRead scope: ${preview(w.policy.globs)}\nWrite scope: ${preview(w.policy.writeGlobs)}${writeHint}`,
			);
		}
	} else if (!readOk) {
		// 缺 path 时目标其实是 cwd，说清这一点，免得被当成「子代理走错目录」。
		if (!raw) {
			// 缺 path：用法错误，不计入撞权限计数。
			return deny(
				`pi-subagents-extend: no path was given; the working directory (${cwd}) was assumed and is outside the read scope (source: ${w.policy.source}). Pass a path inside the scope.\nRead scope: ${preview(w.policy.globs)}`,
			);
		}
		// cwd / 仓库根：读起来像 scope 写错，其实多半是「想要全仓搜索」。计数（这是
		// 授权问题），但要说清这不是某个文件路径写错。
		if (isRootish(raw, cwd)) {
			return bail(
				w,
				`pi-subagents-extend: "${raw}" is the repository root, not a file in the read scope (source: ${w.policy.source}). Pass the concrete path; if repo-wide access is really needed, say so and the parent can widen the scope.\nRead scope: ${preview(w.policy.globs)}`,
			);
		}
		return bail(
			w,
			`pi-subagents-extend: "${target}" is outside the read scope (source: ${w.policy.source}). Do not retry outside paths; if you need this one, say what and why.\nRead scope: ${preview(w.policy.globs)}`,
		);
	}
	if (isWrite) {
		const junk = w.probe?.checkWriteTarget(target);
		if (junk) return { block: true, reason: junk.reason, terminate: false };
		w.probe?.noteWriteActivity();
	}
	if (event.toolName === READ_TOOL) w.allowedReads += 1;
	return undefined;
};

export { pathToolVerdict };
