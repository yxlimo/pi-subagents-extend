// 同一会话激活两次只注册一次；不同会话各注册各的。
//
// 两件事必须同时成立，缺一条就是事故：
//   1. 同一个会话里两份扩展（包装好的 ambient 一份 + 声明路径一份）不能注册两遍 —— 第一份把命令
//      包装成沙箱调用，第二份把包装后的字符串当用户命令比对白名单，整个子会话的 bash 全被拒。
//   2. 进程内的前台子代理要照常注册自己那一份 —— 它不加载 ambient，只加载声明的路径；把它一起去
//      掉就等于前台子代理完全没有策略（fail open）。
//
//   node test/unit/activation.unit.test.ts

import assert from "node:assert/strict";
import { activate } from "../../src/index.ts";

let passed = 0;
function ok(label: string): void {
	passed += 1;
	console.log(`  ok   ${label}`);
}

/** 一个够 activate 用的假 api：只记注册次数，不实现任何行为。 */
function fakeApi(): { api: unknown; counts: Map<string, number> } {
	const counts = new Map<string, number>();
	const api = {
		on(event: string) {
			counts.set(event, (counts.get(event) ?? 0) + 1);
		},
		registerCommand() {},
		getAllTools: () => [],
		getActiveTools: () => [],
	};
	return { api, counts };
}

const total = (counts: Map<string, number>): number =>
	[...counts.values()].reduce((sum, n) => sum + n, 0);

{
	const { api, counts } = fakeApi();
	activate(api as never);
	const first = total(counts);
	assert.ok(first > 0, "第一次激活必须真的注册 handler");
	activate(api as never);
	assert.equal(total(counts), first, "同一个 api 第二次激活不能再注册一份");
	ok("同一会话激活两次只注册一次");
}

{
	const a = fakeApi();
	const b = fakeApi();
	activate(a.api as never);
	activate(b.api as never);
	assert.ok(total(a.counts) > 0 && total(b.counts) > 0, "两个会话各自都要注册");
	assert.equal(total(a.counts), total(b.counts), "两份会话的注册数量一致");
	ok("不同会话（进程内前台子代理）各自注册，互不顶掉");
}

{
	// 宿主给只读 api 时不因为闸门失败而整个扩展不激活。
	const { api, counts } = fakeApi();
	Object.freeze(api);
	assert.doesNotThrow(() => activate(api as never));
	assert.ok(total(counts) > 0, "冻结的 api 上仍要注册 handler（退化成没有去重）");
	ok("只读 api 退化成没有去重，但照样激活");
}

console.log(`\npi-subagents-extend activation unit tests passed (${passed} cases)`);
