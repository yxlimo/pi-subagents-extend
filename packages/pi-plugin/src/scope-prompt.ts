/**
 * 子会话 confinement 摘要：把当前生效的范围拼成一段纯文本提示。
 *
 * 一段只用一个 section key，模型读到拒绝时先看这里，而不是换个拼写重试。
 */

export const SCOPE_SECTION = "pi_subagents_extend_scope";

export interface ScopeSummary {
	/** 生效的配置来源，如 `role md /abs/path/coder.md` 或 policy.source。 */
	source: string;
	/** 读范围（policy.globs 里的原始 glob 字符串）；空数组表示整个工作树。 */
	read: string[];
	/** 绝对读授权（policy.absoluteRead）：父代理点名的树外读前缀；缺省或空表示没有。 */
	absoluteRead?: string[];
	/** 写范围：policy.writeGlobs 与 policy.absoluteWrite 合并；空数组表示没有写授权。 */
	write: string[];
	bash?: { allow: string[]; deny: string[]; network: boolean; writablePaths: string[] };
	budgets: { deny: number; write: number };
	deliverable?: { short: string; target: string };
}

/** 按传入顺序拼提示；空列表只在模板允许的地方改写成兜底文案。 */
export function scopeText(summary: ScopeSummary): string {
	const lines = [
		"## Confinement",
		"",
		"A refusal names what refused it; read it instead of retrying a differently spelled path.",
		"",
		`- Configuration: ${summary.source}`,
		`- Read: ${summary.read.length > 0 ? summary.read.join(", ") : "the whole working directory"}`,
	];
	// 绝对读前缀单独一行：它们落在工作树之外，混进 Read 行会让模型以为那是树内 glob。
	if (summary.absoluteRead && summary.absoluteRead.length > 0) {
		lines.push(`- Absolute read: ${summary.absoluteRead.join(", ")}`);
	}
	lines.push(`- Write: ${summary.write.length > 0 ? summary.write.join(", ") : "nothing — this task is read-only"}`);

	if (summary.bash) {
		lines.push(
			`- Bash: ${summary.bash.allow.length} allowed commands, network ${summary.bash.network ? "on" : "off"}`,
			`- Allowed commands: ${summary.bash.allow.join(", ")}`,
		);
		if (summary.bash.deny.length > 0) {
			lines.push(`- Always refused: ${summary.bash.deny.join(", ")}`);
		}
		if (summary.bash.writablePaths.length > 0) {
			lines.push(`- Also writable: ${summary.bash.writablePaths.join(", ")}`);
		}
	} else {
		lines.push("- Bash: not available in this session");
	}

	lines.push(`- Budgets: ${summary.budgets.deny} refusals in a row stop the session; ${summary.budgets.write} for writes`);
	if (summary.deliverable) {
		lines.push(`- Deliverable: write it to \`${summary.deliverable.short}\`; the parent reads it at \`${summary.deliverable.target}\`.`);
	}

	return lines.join("\n");
}
