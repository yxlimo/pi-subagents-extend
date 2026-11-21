// DenyCounter 的纯函数用例：连续拒绝的计数、警告与硬停的节拍、归零语义、缺省预算。
//
// src/budgets.ts 是纯模块：计数器自己不知道 pi、工具调用或 bindings 的存在，
// 它只暴露 record() / reset() / count / status()。但今天是只经 handler 到达的：
// 每条断言都要拖起一整个假 pi 会话。这里直接调纯函数 —— 没有假 pi、没有临时目录。
//
// 不在这里钉的事（它们是接线事实，不在本模块里，钉不了就是钉不了）：
// - 用法错误（缺 path、shell 元字符、空命令）不计数 —— record() 只被
//   wiring/tool-call/paths.ts 的两个范围拒绝点调用，用法错误根本到不了计数器；
// - 硬规则（powershell、codemod、profile deny）不计数 —— 同上，判定在 judge.ts；
// - contact_supervisor / structured_output / intercom 不触发归零 —— 归零的
//   工具名单判断内联在 index.ts 的 tool_call 接线里（!SAFE_TOOLS.includes）。
//   这三条要假 pi 才能钉；handler 侧的用例在 test/budgets.test.ts (33)。
//
//   node test/unit/budgets.unit.test.ts

import assert from "node:assert/strict"
import { DEFAULT_MAX_DENIES, DEFAULT_MAX_WRITE_DENIES, type DenyCountResult, DenyCounter } from "../../src/budgets.ts"

// 1. 缺省预算就是决策：授权类 5 次、写范围类 2 次。这两个数字是 handler 侧
//    「第 5 次警告、第 6 次硬停」用例（test/budgets.test.ts 35）的前提，
//    改了任何一个，那条节拍就变了。
{
	assert.equal(DEFAULT_MAX_DENIES, 5, "the default grant budget is five counted refusals")
	assert.equal(DEFAULT_MAX_WRITE_DENIES, 2, "the default write budget is two counted refusals")
	console.log("  ok   defaults: grant 5, write 2")
}

// 2. 一次会计数的拒绝：授权类计数器（单参构造，kind 缺省即 grant）前 4 次静默，
//    第 5 次给警告 —— 文案指去 contact_supervisor，因为授权不够的出路是求援。
{
	const counter = new DenyCounter(DEFAULT_MAX_DENIES)
	for (let i = 1; i < DEFAULT_MAX_DENIES; i += 1) {
		const r = counter.record()
		assert.equal(r.yes, false, `counted refusal ${i} is still silent`)
		assert.equal(r.stop, false, `counted refusal ${i} does not stop the run`)
		assert.equal(r.note, undefined, `counted refusal ${i} carries no note`)
	}
	assert.equal(counter.count, DEFAULT_MAX_DENIES - 1, "four refusals leave the count at four")
	const warn = counter.record()
	assert.equal(warn.yes, true, "the refusal at the limit is refused")
	assert.equal(warn.stop, false, "the refusal at the limit only warns")
	assert.match(warn.note ?? "", /in a row/, "the warning says how many in a row")
	assert.match(warn.note ?? "", /contact_supervisor/, "the grant wording names the escalation channel")
	assert.equal(counter.count, DEFAULT_MAX_DENIES, "the warning refusal is counted")
	console.log("  ok   a counted grant refusal: silent x4, warn with contact_supervisor at the 5th")
}

// 3. 警告之后再来一次就是硬停：停机文案写给父代理看（模型没有下一轮），
//    所以说的是诊断（放宽授权重派），不再叮嘱子代理。
{
	const counter = new DenyCounter(DEFAULT_MAX_DENIES)
	for (let i = 0; i < DEFAULT_MAX_DENIES; i += 1) counter.record()
	const stop = counter.record()
	assert.equal(stop.yes, true, "the refusal past the limit is refused")
	assert.equal(stop.stop, true, "the refusal past the limit stops the run")
	assert.match(stop.note ?? "", /denial budget/, "the stop note names the criterion")
	assert.match(stop.note ?? "", /re-dispatch with a wider grant/, "the stop note tells the parent the fix")
	console.log("  ok   warn then stop: the refusal past the limit ends the run")
}

// 4. 写范围类的文案是另一份：出路是改回报告，不是求援 —— 把「这里写不了」
//    当成「授权配错了」，子代理会换个路径继续试（模块头注释写明的失败模式）。
{
	const counter = new DenyCounter(DEFAULT_MAX_WRITE_DENIES, "write")
	const first = counter.record()
	assert.equal(first.yes, false, "the first write refusal is silent (1 < 2)")
	const warn = counter.record()
	assert.equal(warn.yes, true, "the second write refusal is refused")
	assert.equal(warn.stop, false, "the second write refusal only warns")
	assert.match(warn.note ?? "", /Write refusal 2 in a row/, "the write warning counts writes")
	assert.match(warn.note ?? "", /Deliver the finding as a report/, "the write wording sends a report")
	assert.equal(warn.note?.includes("contact_supervisor"), false, "the write wording does not borrow the grant wording")
	const stop = counter.record()
	assert.equal(stop.stop, true, "the third write refusal stops the run")
	assert.match(stop.note ?? "", /write budget/, "the write stop note names its own criterion")
	assert.match(stop.note ?? "", /writeScope/, "the write stop note tells the parent to widen writeScope")
	console.log("  ok   write-kind wording is its own: report instead of escalate")
}

// 5. 一次放行把两个状态都清零：count 与 warned。只清 count 不清 warned 的话，
//    清零后的第一次拒绝会被吃掉（直接跳进警告档）——「连续 N 次」就名存实亡。
//    handler 侧「放行的调用归零」靠的就是这个 reset()；哪些调用算放行是接线的事，
//    这里钉计数器这一侧的合同。
{
	const counter = new DenyCounter(3)
	for (let i = 0; i < 3; i += 1) counter.record()
	assert.equal(counter.count, 3, "three refusals reach the limit")
	counter.reset()
	assert.equal(counter.count, 0, "reset zeroes the count")
	const after = counter.record()
	assert.equal(after.yes, false, "the first refusal after a reset is silent again — warned was cleared too")
	const again: DenyCountResult[] = []
	for (let i = 0; i < 2; i += 1) again.push(counter.record())
	assert.equal(again[1]?.yes, true, "the counter reaches its warning again after a reset")
	assert.match(again[1]?.note ?? "", /in a row/, "the second warning is a fresh count of three, not a carried-over one")
	console.log("  ok   reset zeroes count and warned: the count restarts from silence")
}

// 6. 预算写 0 是关掉这条判据：record() 直接放行、计数停在 0，status 报 off；
//    开着的计数器报「已计/上限」。
{
	const off = new DenyCounter(0)
	const r = off.record()
	assert.deepEqual(r, { yes: false, stop: false }, "with limit 0 the refusal is not counted")
	assert.equal(off.count, 0, "with limit 0 the count stays at zero")
	assert.equal(off.status(), "off", "status reports off for a disabled counter")
	const live = new DenyCounter(5)
	live.record()
	live.record()
	assert.equal(live.status(), "2/5", "status reports count/limit for a live counter")
	console.log("  ok   limit 0 disables the counter; live status is count/limit")
}

console.log("\nbudgets unit tests passed")
