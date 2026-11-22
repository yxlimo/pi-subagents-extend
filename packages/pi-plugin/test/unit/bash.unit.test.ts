// bash 命令层的纯函数用例。
//
// src/bash/ 下的六个模块（tokens / env / network / programs / rules / unreachable）
// 今天是纯函数：切词、剥前置赋值、判读写、匹配规则，都在一条命令字符串上做。
// 但它们只经 handler 到达，于是每一条断言都要拖起一整个假 pi 会话。
// 这里直接调纯函数：没有假 pi API、没有 bindings JSON、没有沙箱 helper。
//
//   node test/unit/bash.unit.test.ts

import assert from "node:assert/strict"
import {
	classifyCommand,
	commandAccess,
	commandMatches,
	deniedEnvAssignment,
	deniedEntry,
	firstToken,
	isUnknownProgram,
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

// 18. 表里的写程序就是写。
{
	for (const cmd of ["rm x", "cp a b", "mkdir d", "touch f"]) {
		assert.equal(commandAccess(cmd, true), "write", `writer must be write: ${cmd}`)
	}
	console.log("  ok   commandAccess puts every writer in the write class")
}

// 19. 表里的读程序就是读。
{
	for (const cmd of ["cat x", "ls", "rg foo", "find . -name x"]) {
		assert.equal(commandAccess(cmd, true), "read", `reader must be read: ${cmd}`)
	}
	console.log("  ok   commandAccess puts every reader in the read class")
}

// 20. 两张表里都没有的程序：判不出来就按读跑，并且被标成 unknown ——
//     注解要能说清「它按 read 跑是因为判不出来」，而不是假装它是读程序。
{
	assert.equal(commandAccess("frobnicate x", true), "read", "an unlisted program runs as read")
	assert.equal(isUnknownProgram("frobnicate x"), true, "and it is reported as unknown")
	assert.equal(isUnknownProgram("cat x"), false, "a listed reader is not unknown")
	console.log("  ok   a program outside both tables is read and is flagged unknown")
}

// 21. xargs 是拿来跑程序的：剥完旗标仍判不出程序时按写 ——
//     判不出来的 payload 真的会写，而模型什么都不知道。
{
	assert.equal(commandAccess("xargs frobnicate", true), "write", "an unknown payload program is still write")
	console.log("  ok   xargs with an unrecognisable payload program is write")
}

// 22. git 的全局旗标认不全时子命令位置不可靠：按写处理，
//     不能顺着错位置把它静默判成读。
{
	assert.equal(
		commandAccess("git --namespace foo reset --hard", true),
		"write",
		"a git subcommand that cannot be located is write",
	)
	console.log("  ok   a git subcommand that cannot be located is write")
}

// 23. 包管理器的前置旗标认不全时同理：不猜一个 token 当子命令。
{
	assert.equal(
		commandAccess("pnpm --mystery-flag dir list", true),
		"write",
		"a package-manager subcommand that cannot be located is write",
	)
	console.log("  ok   a package-manager subcommand that cannot be located is write")
}

// 24. 包管理器的写子命令：它们执行任意代码或改文件。
{
	for (const cmd of ["pnpm run build", "npm exec cowsay", "pnpm test", "npm install"]) {
		assert.equal(commandAccess(cmd, true), "write", `package-manager writer must be write: ${cmd}`)
	}
	console.log("  ok   commandAccess puts the package-manager writers in the write class")
}

// 25. 包管理器的只读子命令：查询。
{
	for (const cmd of ["pnpm list", "npm ls", "pnpm why x", "npm view x", "npm info x", "pnpm show", "pnpm outdated"]) {
		assert.equal(commandAccess(cmd, true), "read", `package-manager query must be read: ${cmd}`)
	}
	console.log("  ok   commandAccess puts the package-manager queries in the read class")
}

// 26. 带值的全局旗标吃掉自己的值之后才是子命令：`pnpm -C dir list` 的
//     子命令是 list，不是 dir。
{
	assert.equal(commandAccess("pnpm -C dir list", true), "read", "a value-taking flag is not the subcommand")
	console.log("  ok   pnpm -C dir list is read")
}

// 27. 不认识的旗标只跳它自己：子命令的名字本身就是位置的强证据，
//     不该被一个未知旗标挤出去。
{
	assert.equal(commandAccess("pnpm --silent list", true), "read", "an unknown flag does not push the subcommand out")
	console.log("  ok   pnpm --silent list is read")
}

// 28. 引号包住的 git 全局值不藏住动词：切词错了就会把 reset 读成 b，
//     那条命令于是被判成读命令。
{
	assert.equal(
		commandAccess('git -c k="a b c" reset --hard', true),
		"write",
		"a quoted global value does not hide the verb",
	)
	assert.equal(
		commandAccess('git -c k="a b c" log', true),
		"read",
		"and the verb still decides the other way",
	)
	console.log("  ok   a quoted git global value does not hide the verb")
}

// 29. 三列各自独立，开关按字面值读。
{
	const rule = parseBashRule({
		read: ["cat f"],
		write: ["rm f"],
		allow: ["git status"],
		network: true,
		writable: true,
		deny: ["rm -rf /"],
	})
	assert.ok(rule, "a rule with entries parses")
	assert.deepEqual(rule.read, ["cat f"], "read is read as read")
	assert.deepEqual(rule.write, ["rm f"], "write is read as write")
	assert.deepEqual(rule.allow, ["git status"], "allow is its own column")
	assert.deepEqual(rule.deny, ["rm -rf /"], "deny is read as deny")
	assert.equal(rule.network, true, "network is read as network")
	assert.equal(rule.writable, true, "writable is read as writable")
	console.log("  ok   parseBashRule reads the three columns and the switches")
}

// 30. 三列都没有条目就是没有 bash：开关自己不算授权。
{
	assert.equal(parseBashRule({}), undefined, "no column means no bash")
	assert.equal(parseBashRule({ read: [] }), undefined, "an explicitly empty column means no bash")
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

// 36. classifyCommand 说出命中的是哪一条：条目原文与列名都给出。
{
	const rule = parseBashRule({ read: ["cat f"], write: ["rm f"], allow: ["git status"], writable: true })
	assert.ok(rule, "the rule parses")
	assert.deepEqual(
		classifyCommand(rule, "git status --short"),
		{ access: "read", column: "allow", entry: "git status" },
		"the matching entry is named",
	)
	console.log("  ok   classifyCommand names the entry that matched")
}

// 37. allow 列的读写由命令本身推出来，不是由列名。
{
	const rule = parseBashRule({ allow: ["rm f", "cat f"], writable: true })
	assert.ok(rule, "the rule parses")
	assert.deepEqual(
		classifyCommand(rule, "rm f"),
		{ access: "write", column: "allow", entry: "rm f" },
		"an allow entry whose command writes is a write",
	)
	assert.deepEqual(
		classifyCommand(rule, "cat f"),
		{ access: "read", column: "allow", entry: "cat f" },
		"an allow entry whose command reads is a read",
	)
	console.log("  ok   the allow column takes its access from the command")
}

// 38. 兼容列仍按原义判，并且排在 allow 列前面：同一条命令只有一个答案。
{
	const rule = parseBashRule({ write: ["rm f"], read: ["cat f"], allow: ["rm f"], writable: true })
	assert.ok(rule, "the rule parses")
	assert.deepEqual(
		classifyCommand(rule, "rm f"),
		{ access: "write", column: "write", entry: "rm f" },
		"the legacy write column keeps its meaning",
	)
	assert.deepEqual(
		classifyCommand(rule, "cat f"),
		{ access: "read", column: "read", entry: "cat f" },
		"the legacy read column keeps its meaning",
	)
	console.log("  ok   the legacy columns keep their own meaning")
}

// 39. allow 不能取消 deny：两条都命中时，deny 仍然先说。
{
	const rule = parseBashRule({ allow: ["git push"], deny: ["git push"] })
	assert.ok(rule, "the rule parses")
	assert.equal(deniedEntry(rule, "git push origin main"), "git push", "the deny entry is named")
	assert.equal(
		classifyCommand(rule, "git push origin main")?.column,
		"allow",
		"the allow column still matches it: the deny is not cancelled, it is checked first",
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
