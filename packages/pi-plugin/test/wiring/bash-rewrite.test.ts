// 同伴扩展改写 bash 命令时的判定来源。
//
// pi 的 tool_call 处理器共用可变的 event.input：先注册的处理器改了它，后面的处理器看到的是
// 改过的值。实测 rtk（把命令改写成 `rtk <cmd>` 省 token）就这么先跑，于是本扩展拿
// `rtk git status` 去比对 bash.allow 里的 `git status` —— 匹配不上，整个子会话的 bash 全被拒。
//
// 这里钉两件事：判定用 transcript 里模型原本那条命令；执行用当前值，把同伴的改写留在沙箱内层
// 照常生效。同时钉住反方向：改写不能把被禁命令洗白。
//
//   node test/wiring/bash-rewrite.test.ts

import assert from "node:assert/strict";
import { handler, workdir } from "../harness.ts";

const assistantEntry = (id: string, command: string): unknown => ({
	type: "message",
	id: `entry-${id}`,
	message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
});

const allowGitStatus = JSON.stringify({
	"pi-subagents-extend/1": { scope: [workdir], bash: { allow: ["git status"] } },
});

// deny 是硬底线：带一条 deny 的 bindings，用来钉「改写不能洗白被禁命令」。
const denyCommit = JSON.stringify({
	"pi-subagents-extend/1": { scope: [workdir], bash: { allow: ["git status"], deny: ["git commit"] } },
});

let passed = 0;
function ok(label: string): void {
	passed += 1;
	console.log(`  ok   ${label}`);
}

// 1) 前一个处理器把命令改写成 `rtk git status --short`，transcript 里模型写的是 `git status --short`：
//    判定按原始命令匹配白名单，放行；包装用当前值，rtk 的改写留在沙箱内层。
{
	const h = await handler({
		cwd: workdir,
		bindings: allowGitStatus,
		transcript: [assistantEntry("c1", "git status --short")],
	});
	const input: { command?: string } = { command: "rtk git status --short" };
	const outcome = await h.call("bash", input, "c1");
	h.restore();
	assert.equal(outcome, undefined, "原始命令在白名单里，就该放行，而不是判改写后的字符串");
	assert.ok(input.command, "放行的命令要被改写成 helper 调用");
	assert.ok(
		input.command.includes("'rtk git status --short'"),
		`同伴的改写留在沙箱内层执行，实际得到：${input.command}`,
	);
	ok("被同伴改写的命令按原始命令判定并放行，改写保留在沙箱内层");
}

// 2) 没有 transcript（旧宿主 / 测试替身）时退回 event.input：这时改写后的字符串匹配不上，
//    必须拒绝 —— 这一条保证上一条不是「怎么都放行」。
{
	const h = await handler({ cwd: workdir, bindings: allowGitStatus });
	const outcome = await h.call("bash", { command: "rtk git status --short" }, "c2");
	h.restore();
	assert.ok(outcome && "block" in outcome && outcome.block, "没有原始命令可依据时该拒，不能默认放行");
	assert.match(String(outcome.reason), /not in the allowlist/);
	ok("拿不到原始命令时拒绝改写后的字符串，不放行");
}

// 3) 改写不能洗白被禁命令：模型原文是 git commit（deny 硬底线），同伴把它改写成无辜的样子。
//    判定看原始命令 → 仍然被 deny 挡下。
{
	const h = await handler({
		cwd: workdir,
		bindings: denyCommit,
		transcript: [assistantEntry("c3", "git commit -m x")],
	});
	const outcome = await h.call("bash", { command: "git status --short" }, "c3");
	h.restore();
	assert.ok(outcome && "block" in outcome && outcome.block, "被禁命令不能因为被改写就通过");
	assert.match(String(outcome.reason), /blocked by a deny entry/, `实际文案：${outcome.reason}`);
	ok("被禁命令不会被同伴改写洗白");
}

// 4) transcript 里没有这一条（嵌套调用不落 transcript）时同样退回 event.input。
{
	const h = await handler({
		cwd: workdir,
		bindings: allowGitStatus,
		transcript: [assistantEntry("other", "git status --short")],
	});
	const outcome = await h.call("bash", { command: "rtk git status --short" }, "c4");
	h.restore();
	assert.ok(outcome && "block" in outcome && outcome.block, "id 对不上时按 event.input 判定");
	ok("transcript 里没有本次调用时退回 event.input");
}

console.log(`\npi-subagents-extend bash rewrite tests passed (${passed} cases)`);
