// 「模型原始工具参数」这一层直接调纯函数：不建假 pi API、不读 bindings、不落 spec 文件。
//
// 为什么单独测：判定 bash 时命令有两个来源 —— transcript 里模型原本的那条，和 event.input
// 上可能已被同伴扩展改写过的那条。挑错来源的后果是整会话 bash 全被拒，或者反过来把被禁命令
// 洗白，所以来源选择本身要钉。
//
//   node test/unit/original-args.unit.test.ts

import assert from "node:assert/strict";
import { originalCommand, originalToolArguments } from "../../src/wiring/tool-call/original-args.ts";

let passed = 0;
function ok(label: string): void {
	passed += 1;
	console.log(`  ok   ${label}`);
}

const assistantEntry = (blocks: unknown[]): unknown => ({
	type: "message",
	id: "entry-1",
	message: { role: "assistant", content: blocks },
});

const call = (id: string, command: string): unknown => ({
	type: "toolCall",
	id,
	name: "bash",
	arguments: { command },
});

{
	const entries = [assistantEntry([call("c1", "git status --short")])];
	assert.deepEqual(originalToolArguments(entries, "c1"), { command: "git status --short" });
	ok("按 toolCallId 取回模型原始参数");
}

{
	const entries = [assistantEntry([call("c1", "ls")])];
	assert.equal(originalToolArguments(entries, "c2"), undefined);
	ok("id 对不上时取不到（调用方退回 event.input）");
}

{
	const entries = [assistantEntry([call("c1", "first")]), assistantEntry([call("c1", "second")])];
	assert.deepEqual(originalToolArguments(entries, "c1"), { command: "second" });
	ok("重复 id 取最后一条：后面那条才是本次要判的");
}

{
	const entries = [assistantEntry([{ type: "toolCall", id: "c1", arguments: '{"command":"rg foo"}' }])];
	assert.deepEqual(originalToolArguments(entries, "c1"), { command: "rg foo" });
	ok("arguments 是 JSON 字符串时照样解析");
}

{
	const entries = [assistantEntry([{ type: "toolCall", id: "c1", arguments: "{not json" }])];
	assert.equal(originalToolArguments(entries, "c1"), undefined);
	ok("参数解析失败当作没有，不抛也不误判");
}

{
	const entries = [{ type: "message", message: { role: "user", content: "plain string" } }, { type: "session" }];
	assert.equal(originalToolArguments(entries, "c1"), undefined);
	ok("非 assistant / 非数组 content 的条目直接跳过");
}

{
	const entries = [assistantEntry([call("c1", "one"), call("c2", "two")])];
	assert.equal(originalCommand({ sessionManager: { getBranch: () => entries } }, "c2"), "two");
	assert.equal(originalCommand({ sessionManager: { getBranch: () => entries } }, "c1"), "one");
	ok("同消息多条调用各取各的");
}

{
	assert.equal(originalCommand({}, "c1"), undefined);
	assert.equal(originalCommand(undefined, "c1"), undefined);
	assert.equal(originalCommand({ sessionManager: {} }, "c1"), undefined);
	ok("宿主没有 sessionManager（测试替身、旧宿主）时返回 undefined，不抛");
}

{
	const entries = [assistantEntry([call("c1", "   ")])];
	assert.equal(originalCommand({ sessionManager: { getBranch: () => entries } }, "c1"), undefined);
	ok("空白命令当作取不到：调用方会退回 event.input");
}

{
	const entries = [assistantEntry([{ type: "toolCall", id: "c1", arguments: { pattern: "x" } }])];
	assert.equal(originalCommand({ sessionManager: { getBranch: () => entries } }, "c1"), undefined);
	ok("参数里没有 command 字段时取不到");
}

console.log(`\npi-subagents-extend original-args unit tests passed (${passed} cases)`);
