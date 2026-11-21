// headEntriesHint 的纯函数用例：拒绝文案里的「同首 token 条目」提示。
//
// src/notices.ts 的 headEntriesHint 是纯函数：一条 BashRule、一条命令、一个 cwd，
// 返回一段文案。但它今天是只经 handler 到达的 —— 每条断言都要拖起一个假 pi 会话。
// 这里直接调纯函数：没有假 pi、没有 bindings JSON。
//
// 背景事故：这层提示曾把 re: 正则条目静默丢掉 —— 拒绝文案列出的字面条都对不上，
// 于是读者以为这个程序没被允许，却看不见真正放行它的那条正则，照着字面条改参数
// 再撞一次。现在正则条目「只数不列」，文案要明说。
//
// 用例都用 git 头：unreachableEntries 对工具链里到处都有的程序名一律不判，
// 所以断言不依赖 cwd 里有没有 manifest，测试不碰文件系统的偶然状态。
//
//   node test/unit/notices.unit.test.ts

import assert from "node:assert/strict"
import { parseBashRule } from "../../src/bash-match.ts"
import { headEntriesHint } from "../../src/notices.ts"

const cwd = process.cwd()

// 1. 没有正则条目时，文案不提正则 —— 一个字都不能有：凭空的「另有正则条目」
//    也是假话，读者会去找一条不存在的条目。
{
	const rule = parseBashRule({ allow: ["git status", "git log"] })!
	const hint = headEntriesHint(rule, "git push", cwd)
	assert.match(hint, /entries for `git`/, "the hint names the program the entries belong to")
	assert.ok(!hint.includes("regex"), `a hint with no regex entries does not mention them, got: ${hint}`)
	console.log("  ok   a hint with no regex entries never mentions them")
}

// 2. 一条正则条目要说出来，单数 —— 这句话就是事故补丁的本体：字面条照列，
//    但读者还得被告知「另有一条可能匹配任何东西的正则，这里不评估它」。
{
	const rule = parseBashRule({ read: ["git log", "re:^git push --force$"] })!
	const hint = headEntriesHint(rule, "git push", cwd)
	assert.match(hint, /git log/, "the literal same-program entry is still listed")
	assert.match(hint, /plus 1 regex entry/, "the hint says a regex entry may also match")
	assert.ok(!hint.includes("regex entries"), `one regex entry is singular, got: ${hint}`)
	console.log("  ok   one regex entry is reported in the singular")
}

// 3. 计数照实：两条正则就是 2，复数形式。数错了读者又会低估还有多少条没看见。
{
	const rule = parseBashRule({ read: ["re:^git push --force$", "re:^git push --tags$"] })!
	const hint = headEntriesHint(rule, "git push", cwd)
	assert.match(hint, /plus 2 regex entries/, "two regex entries are counted and pluralized")
	console.log("  ok   two regex entries are counted in the plural")
}

// 4. 列出的字面条就是白名单里同首 token 的那些，按原顺序 —— 不同头的条目
//    （rg files）与这条被拒的命令无关，混进来会让读者把两件事看成一件。
{
	const rule = parseBashRule({ allow: ["git status", "git log", "rg files"] })!
	const hint = headEntriesHint(rule, "git push", cwd)
	assert.ok(hint.includes("`git`: git status, git log"), `the same-head entries are listed in allowlist order, got: ${hint}`)
	assert.ok(!hint.includes("rg files"), `a different-head entry is not listed, got: ${hint}`)
	console.log("  ok   listed literals are the same-head allowlist entries, in order")
}

// 5. 没话可说就返回空串：空命令没有首 token；首 token 在白名单里没有同头
//    字面条、也没有正则条目时，硬挤一段「没有条目」的文案只会添噪。
{
	const rule = parseBashRule({ allow: ["git status"] })!
	assert.equal(headEntriesHint(rule, "", cwd), "", "an empty command yields an empty hint")
	assert.equal(headEntriesHint(rule, "rg files", cwd), "", "a head with no entries and no regex yields an empty hint")
	console.log("  ok   no same-head entries and no regex entries means an empty hint")
}

// 6. 前置赋值先剥掉再算首 token：匹配时剥得掉，提示就得同样剥 —— 否则
//    `FOO=1 git push` 的头会被算成 FOO=1，明明有 git 条目却提示「没有」。
{
	const rule = parseBashRule({ allow: ["git status"] })!
	const hint = headEntriesHint(rule, "FOO=1 git push", cwd)
	assert.match(hint, /entries for `git`/, "the head is computed after stripping leading assignments")
	assert.match(hint, /git status/, "the same-head entry is found behind the assignment")
	console.log("  ok   leading assignments are stripped before the head is matched")
}

console.log("\nnotices unit tests passed")
