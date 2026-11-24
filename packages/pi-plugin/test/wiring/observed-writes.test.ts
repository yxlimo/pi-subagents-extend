// 内核观察到的写入要真的算作「进展」。
//
// 分工是：helper 在写范围上挂 inotify，把结果写到 `<spec>.observe`；plugin 在 tool_result 里读这份
// 结果，`wrote:true` 就通知探针「有写活动」。两半各自有测试——Rust 侧 cargo test（含真二进制的
// tests/observe.rs），探针侧 probe 自己的用例——但中间这条接线（judge 记下 observeFile → tool_result
// 读它 → noteWriteActivity）只有这几条用例在钉。少任何一段，机制都是静默失效：helper 照样报，
// plugin 照样不读，探针照样把真正在编译的子代理杀掉。
//
// 断言落在**探针的行为**上（下一条同命令是否被判打转），不是「noteWriteActivity 被调用了」：
// 后者用假对象就能骗过，前者要求真的把状态清干净。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_PROBE, Probe } from "../../src/probe.ts";
import type { SandboxSpecEntry, Wiring } from "../../src/wiring/context.ts";
import { annotateToolResult } from "../../src/wiring/tool-result.ts";

/** 探针：重复 3 次判打转；定时器换成什么都不做的假时钟，用例不靠等待。 */
function makeProbe(): Probe {
	return new Probe({
		config: { ...DEFAULT_PROBE, repeatBash: 3 },
		readOnly: false,
		hooks: { warn: () => {} },
		host: { setTimeout: () => 0, clearTimeout: () => {}, now: () => 0 },
	});
}

/** 只带判定所需字段的 Wiring：这几条用例走成功结果，注解分支一个都不触发。 */
function wiringWith(probe: Probe, observeFile?: string): Wiring {
	const specs = new Map<string, SandboxSpecEntry>();
	if (observeFile !== undefined) {
		specs.set("c3", {
			write: [],
			cwd: process.cwd(),
			offline: false,
			command: "cargo build",
			observeFile,
		});
	}
	return { probe, policy: { bash: { allow: [] } }, sandboxSpecs: specs } as unknown as Wiring;
}

/** 跑两条同样的命令（输出也一样，所以不清零），留下计数 = 2。 */
function twoIdenticalCommands(probe: Probe): void {
	for (const id of ["c1", "c2"]) {
		probe.noteBashStart("git status", id);
		probe.noteBashResult("same output", id);
	}
}

/** 第三条命令是 bash，结果回来时 plugin 去看观察文件。 */
function thirdCommand(probe: Probe, wiring: Wiring): void {
	probe.noteBashStart("cargo build", "c3");
	annotateToolResult(wiring, {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "c3",
		input: { command: "cargo build" },
		content: [{ type: "text", text: "ok" }],
		details: undefined,
		isError: false,
	});
	probe.noteBashResult("ok", "c3");
}

test("内核看到写入时算进展：重复计数归零，同一条命令不再被判打转", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "observe-"));
	try {
		const observeFile = path.join(dir, "spec.json.observe");
		writeFileSync(observeFile, JSON.stringify({ wrote: true, watched: 3 }));
		const probe = makeProbe();
		twoIdenticalCommands(probe);
		thirdCommand(probe, wiringWith(probe, observeFile));

		// 没有这条观察的话，这一次就是第 3 次同命令 → 会 warn。
		const next = probe.noteBashStart("git status", "c4");
		assert.equal(next, undefined, "内核观察到写入之后，这条命令不该再被算作打转");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("内核看到的是「没写」时不算进展：第 3 次同命令照旧打转", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "observe-"));
	try {
		const observeFile = path.join(dir, "spec.json.observe");
		writeFileSync(observeFile, JSON.stringify({ wrote: false, watched: 3 }));
		const probe = makeProbe();
		twoIdenticalCommands(probe);
		thirdCommand(probe, wiringWith(probe, observeFile));

		const next = probe.noteBashStart("git status", "c4");
		assert.ok(next, "只读命令不该被当成进展");
		assert.equal(next.stop, false, `第 3 次是 warn，不是停：${next.reason}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("没有观察结果时不当成「没写过」，也不当成进展", () => {
	// 旧版 helper 不写这份文件，被信号杀掉的命令也来不及写完。两种都不该被解读成事实。
	const dir = mkdtempSync(path.join(os.tmpdir(), "observe-"));
	try {
		const probe = makeProbe();
		twoIdenticalCommands(probe);
		thirdCommand(probe, wiringWith(probe, path.join(dir, "absent.observe")));

		const next = probe.noteBashStart("git status", "c4");
		assert.ok(next, "没有证据时保持原来的判定，不因为缺文件就清零");
		assert.equal(next.stop, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
