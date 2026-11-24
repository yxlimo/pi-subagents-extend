// bash 命令层的纯函数用例。
//
// src/bash/ 下的六个模块（tokens / env / network / programs / rules / unreachable）
// 今天是纯函数：切词、剥前置赋值、匹配规则，都在一条命令字符串上做。
// 但它们只经 handler 到达，于是每一条断言都要拖起一整个假 pi 会话。
// 这里直接调纯函数：没有假 pi API、没有 bindings JSON、没有沙箱 helper。
//
//   node test/unit/bash.unit.test.ts

import assert from "node:assert/strict"
import {
	commandMatches,
	deniedEnvAssignment,
	deniedEntry,
	firstToken,
	leadingAssignments,
	listedJoin,
	MAX_LISTED,
	parseBashRule,
	pathCandidates,
	requiresNetwork,
	shellTokens,
} from "../../src/bash/index.ts"

// 1. 引号里的空格不是分隔符：切词要按 bash 的引号语义走。
//    `git -c k="a b c" reset --hard` 被朴素切词读成 `reset` 之前的 `b`，
//    于是那条命令被判成读命令 —— 引号感知是这条判定成立的前提。
{
	assert.deepEqual(
		shellTokens('git -c k="a b c" reset --hard'),
		["git", "-c", 'k="a b c"', "reset", "--hard"],
		"a double-quoted value with spaces is one token",
	)
	console.log("  ok   shellTokens keeps a double-quoted value in one token")
}

// 2. 单引号同理：单引号里没有转义，空格照样是普通字符。
{
	assert.deepEqual(
		shellTokens("git -c k='a b c' reset --hard"),
		["git", "-c", "k='a b c'", "reset", "--hard"],
		"a single-quoted value with spaces is one token",
	)
	console.log("  ok   shellTokens keeps a single-quoted value in one token")
}

// 3. 空的一对引号仍是一个词：那是空参数，不是零个参数。
{
	assert.deepEqual(shellTokens('echo ""'), ["echo", '""'], "an empty quoted pair is one word")
	assert.deepEqual(shellTokens("echo ''"), ["echo", "''"], "an empty single-quoted pair is one word")
	console.log("  ok   shellTokens keeps an empty quoted pair as one word")
}

// 4. 前置赋值被剥出来：名字与剩下的命令分开。
{
	assert.deepEqual(
		leadingAssignments("FOO=1 ls"),
		{ names: ["FOO"], rest: "ls" },
		"a leading assignment is reported and the command is left",
	)
	console.log("  ok   leadingAssignments reports a leading assignment and leaves the command")
}

// 5. 多个前置赋值按顺序列出。
{
	assert.deepEqual(
		leadingAssignments("A=1 B=2 ls"),
		{ names: ["A", "B"], rest: "ls" },
		"every leading assignment is reported, in order",
	)
	console.log("  ok   leadingAssignments reports every leading assignment in order")
}

// 6. 引号包住的值里有空格时仍是一个值：按空白切会把命令名切成半截，
//    剩半截 `home"` 当程序名，于是另一条合法命令被误拒。
{
	assert.deepEqual(
		leadingAssignments('HOME="/tmp/my home" ls'),
		{ names: ["HOME"], rest: "ls" },
		"a quoted value with a space stays in one piece",
	)
	console.log("  ok   leadingAssignments keeps a quoted value with a space in one piece")
}

// 7. PATH 按名字拒：换掉要跑的程序就是换掉整条授权。
{
	assert.equal(deniedEnvAssignment("PATH=/tmp ls"), "PATH", "PATH is refused by name")
	console.log("  ok   deniedEnvAssignment refuses PATH by name")
}

// 8. IFS 按名字拒：改变词法就改变了这条命令本身。
{
	assert.equal(deniedEnvAssignment("IFS=, ls"), "IFS", "IFS is refused by name")
	console.log("  ok   deniedEnvAssignment refuses IFS by name")
}

// 9. LD_ 前缀拒：往任意进程里塞共享库。
{
	assert.equal(
		deniedEnvAssignment("LD_PRELOAD=/tmp/x.so ls"),
		"LD_PRELOAD",
		"LD_PRELOAD is refused by prefix",
	)
	console.log("  ok   deniedEnvAssignment refuses LD_PRELOAD by prefix")
}

// 10. 不在前面的赋值不是环境覆盖：那只是命令的参数。
{
	assert.deepEqual(
		leadingAssignments("ls PATH=/tmp"),
		{ names: [], rest: "ls PATH=/tmp" },
		"an assignment that is not leading is not an environment override",
	)
	assert.equal(deniedEnvAssignment("ls PATH=/tmp"), undefined, "and it is not refused")
	console.log("  ok   a non-leading assignment is not an environment override")
}

// 11. 会出网的程序名：判的是程序本身。
{
	assert.equal(requiresNetwork("curl https://example.com"), "curl", "curl is network")
	assert.equal(requiresNetwork("wget https://example.com"), "wget", "wget is network")
	assert.equal(requiresNetwork("ssh host"), "ssh", "ssh is network")
	assert.equal(requiresNetwork("gh pr list"), "gh", "gh is network")
	console.log("  ok   requiresNetwork names curl, wget, ssh and gh")
}

// 12. git 的出网子命令：连子命令名一起报，读者才知道该问什么。
{
	assert.equal(requiresNetwork("git push"), "git push", "git push is network")
	assert.equal(requiresNetwork("git clone x"), "git clone", "git clone is network")
	assert.equal(requiresNetwork("git fetch"), "git fetch", "git fetch is network")
	assert.equal(requiresNetwork("git pull"), "git pull", "git pull is network")
	assert.equal(requiresNetwork("git ls-remote"), "git ls-remote", "git ls-remote is network")
	console.log("  ok   requiresNetwork names the git network subcommands")
}

// 13. 发布要出网：npm publish 与 pnpm publish 同理。
{
	assert.equal(requiresNetwork("npm publish"), "npm publish", "npm publish is network")
	assert.equal(requiresNetwork("pnpm publish"), "pnpm publish", "pnpm publish is network")
	console.log("  ok   requiresNetwork names npm publish")
}

// 14. curl 的本地查询旗标不是网络：打印完本机信息就退出，
//     把它按「会挂住」拒掉就是误拒。
{
	for (const flag of ["--version", "-V", "--help", "-h"]) {
		assert.equal(requiresNetwork(`curl ${flag}`), null, `curl ${flag} is a local query`)
	}
	console.log("  ok   requiresNetwork lets curl's local query flags through")
}

// 15. git status 看的是本地仓库：不是网络。
{
	assert.equal(requiresNetwork("git status"), null, "git status is local")
	console.log("  ok   requiresNetwork lets git status through")
}

// 16. 直通包装器被剥开后仍看得到真正要跑的程序：`env FOO=1 curl …` 里的
//     赋值不藏住 curl。
{
	assert.equal(requiresNetwork("env FOO=1 curl https://example.com"), "curl", "env does not hide curl")
	console.log("  ok   requiresNetwork sees through an env wrapper")
}

// 17. `timeout 5 curl …` 同理：duration 是 timeout 自己的参数。
{
	assert.equal(requiresNetwork("timeout 5 curl https://example.com"), "curl", "timeout does not hide curl")
	console.log("  ok   requiresNetwork sees through a timeout wrapper")
}


// 29. allow / deny / network 各自按字面值读。
{
	const rule = parseBashRule({
		allow: ["git status"],
		network: true,
		deny: ["rm -rf /"],
	})
	assert.ok(rule, "a rule with entries parses")
	assert.deepEqual(rule.allow, ["git status"], "allow is its own column")
	assert.deepEqual(rule.deny, ["rm -rf /"], "deny is read as deny")
	assert.equal(rule.network, true, "network is read as network")
	console.log("  ok   parseBashRule reads the allow, deny and network columns")
}

// 30. 三列都没有条目就是没有 bash：开关自己不算授权。
{
	assert.equal(parseBashRule({}), undefined, "no column means no bash")
	assert.equal(parseBashRule({ allow: [] }), undefined, "an explicitly empty allowlist means no bash")
	assert.equal(parseBashRule({ network: true }), undefined, "a switch alone is not an allowlist")
	assert.equal(parseBashRule("nonsense"), undefined, "a non-object is not a rule")
	console.log("  ok   parseBashRule returns undefined when no column carries an entry")
}


// 34. 字面量条目按词前缀匹配：它是前缀，不是子串，也不是全等。
{
	assert.equal(commandMatches("pnpm test", "pnpm test -t foo"), true, "a literal entry matches extra arguments")
	assert.equal(commandMatches("pnpm test", "pnpm publish"), false, "a literal entry does not match another subcommand")
	assert.equal(commandMatches("git", "git status"), true, "a bare program matches its arguments")
	assert.equal(commandMatches("git", "gitk"), false, "a prefix stops at the word boundary")
	assert.equal(commandMatches("pnpm test", ""), false, "an empty command never matches")
	assert.equal(commandMatches("", "ls"), false, "an empty entry never matches")
	console.log("  ok   a literal entry matches by word prefix")
}

// 35. `re:` 条目整串锚定：写不 ^$ 也整串，写坏的正则不匹配任何命令。
{
	assert.equal(commandMatches("re:^pnpm (test|build)$", "pnpm build"), true, "the regex matches")
	assert.equal(commandMatches("re:^pnpm (test|build)$", "pnpm build --watch"), false, "the regex is anchored to the whole command")
	assert.equal(commandMatches("re:pnpm .*", "pnpm publish"), true, "an unanchored source is still whole-string")
	assert.equal(commandMatches("re:[", "anything"), false, "a broken regex matches nothing")
	console.log("  ok   a re: entry is anchored to the whole command")
}



// 39. allow 不能取消 deny：两条都命中时，deny 仍然先说。
{
	const rule = parseBashRule({ allow: ["git push"], deny: ["git push"] })
	assert.ok(rule, "the rule parses")
	assert.equal(deniedEntry(rule, "git push origin main"), "git push", "the deny entry is named")
	assert.equal(
		rule.allow.find((entry) => commandMatches(entry, "git push origin main")),
		"git push",
		"the allow entry still matches it: the deny is not cancelled, it is checked first",
	)
	console.log("  ok   an allow entry does not cancel a deny")
}

// 40. 首个词：条目与命令的程序位。
{
	assert.equal(firstToken("pnpm run typecheck"), "pnpm", "the first word")
	assert.equal(firstToken("  git   status "), "git", "extra whitespace is not a word")
	assert.equal(firstToken(""), "", "an empty text has no first word")
	console.log("  ok   firstToken returns the first word")
}

// 41. 截断提示只出现在超过上限时：刚好到上限不加提示。
{
	assert.equal(MAX_LISTED, 8, "the cap is eight")
	const eight = ["a", "b", "c", "d", "e", "f", "g", "h"]
	assert.equal(listedJoin(eight), "a, b, c, d, e, f, g, h", "the list at the cap is joined as it is")
	assert.ok(!listedJoin(eight).includes("more"), "no truncation note at the cap")
	console.log("  ok   listedJoin adds no truncation note at the cap")
}

// 42. 超过上限才截断，并说清还剩几条。
{
	const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"]
	assert.equal(listedJoin(nine), "a, b, c, d, e, f, g, h, … and 1 more", "the note counts the rest")
	console.log("  ok   listedJoin adds the truncation note above the cap")
}

// 43. 粘值旗标的候选是 `=` 后面的路径本身，不是整段 `--flag=...`：
//     交给路径判定的必须是命令真正会打开的那个字符串。
{
	assert.deepEqual(
		pathCandidates("rg --file=/home/other/patterns.txt"),
		["/home/other/patterns.txt"],
		"the glued value is the candidate, not the whole flag",
	)
	assert.deepEqual(pathCandidates("rg --output=/tmp/x"), ["/tmp/x"], "an in-scope glued value is a candidate too")
	console.log("  ok   pathCandidates yields the bare path from a glued = value")
}

// 44. 值不是路径的粘值旗标不产候选：没有斜杠的被斜杠判据挡掉，
//     glob 与动态值被跳过表挡掉 —— 不认旗标名，判据自己就能分辨。
{
	assert.deepEqual(pathCandidates("rg --color=always"), [], "a bare value has no slash")
	assert.deepEqual(pathCandidates("rg --max-count=2"), [], "a numeric value has no slash")
	assert.deepEqual(pathCandidates("rg --glob=*.ts"), [], "a glob value is in the skip set")
	assert.deepEqual(pathCandidates("rg --file=$DIR/patterns"), [], "a dynamic value is in the skip set")
	assert.deepEqual(pathCandidates("rg --file=@scope/pkg"), [], "a package-spec value keeps the head skip")
	console.log("  ok   pathCandidates drops glued values that are not paths")
}

// 45. 粘值写法与分开写法给出同一批候选：这是这条修复真正要守的不变量 ——
//     同一个路径换个拼写，判定不该一边拦一边放。
{
	for (const [flag, value] of [
		["--file", "/home/other/patterns.txt"],
		["--output", "/tmp/x"],
		["--include", "src/index.ts"],
	] as const) {
		assert.deepEqual(
			pathCandidates(`rg ${flag}=${value}`),
			pathCandidates(`rg ${flag} ${value}`),
			`${flag} yields the same candidates glued or split`,
		)
	}
	console.log("  ok   pathCandidates judges a glued flag the same as its split form")
}
console.log("\nbash unit tests passed")
