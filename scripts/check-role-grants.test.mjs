#!/usr/bin/env node
// Tests for the role md checker. Each case pins a failure that was reported wrongly or not at all:
// an interior comment used to truncate every list, and a loader path pointing at a deleted file was
// reported by nothing at all.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	allowEntries,
	checkRoleDirs,
	createdPaths,
	denyEntries,
	loaderEntries,
	listBlock,
	REQUIRED_DENY,
	writeEntries,
} from "./check-role-grants.mjs";

const FLOOR = REQUIRED_DENY.map((entry) => `        - ${entry}`).join("\n");

/** Write one role md into a temp dir and return the dir. */
function withRoleDirs(files) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "role-check-"));
	for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
	return dir;
}

function md({ write, deny = FLOOR, loader, gate, allow }) {
	return [
		"---",
		"name: coder",
		"extend:",
		"  permissions:",
		...(write ? [`    write: ${write}`] : []),
		...(loader ? [`subagentOnlyExtensions: ${loader}`] : []),
		"    bash:",
		...(allow ? ["      allow:", ...allow.map((entry) => `        - ${entry}`)] : []),
		...(deny ? ["      deny:", deny] : []),
		"---",
		"",
		...(gate ? ["```bash", gate, "```"] : []),
		"",
	].join("\n");
}

// ---- 列表解析：注释行不能截断 ---------------------------------------------------
test("列表里的注释与空行不会截断解析", () => {
	const text = ["deny:", "  # 九条地板，一字不改", "", "  - git commit", "  # 中间又一行注释", "  - rm -rf", "next: x"].join("\n");
	assert.deepEqual(denyEntries(text), ["git commit", "rm -rf"]);
});

test("块式与流式 write 都能读出来", () => {
	assert.deepEqual(writeEntries("write:\n  # 注释\n  - .pi/reports\n  - src\n"), [".pi/reports", "src"]);
	assert.deepEqual(writeEntries('write: ["."]\n'), ["."]);
	assert.deepEqual(writeEntries("write: []\n"), []);
	// 键不存在时返回 null（与「存在但为空」区分），调用方据此决定要不要检查
	assert.equal(listBlock("scope: x\n", "write"), null);
});

test("allow 列表读出 re: 模式原样保留", () => {
	assert.deepEqual(allowEntries("allow:\n  - git status\n  - re:^pnpm (run )?test\n"), [
		"git status",
		"re:^pnpm (run )?test",
	]);
});

test("subagentOnlyExtensions 按逗号拆分", () => {
	assert.deepEqual(loaderEntries("subagentOnlyExtensions: /a/one.ts, /b/two.ts\n"), ["/a/one.ts", "/b/two.ts"]);
	assert.deepEqual(loaderEntries("name: coder\n"), []);
});

// ---- 拒接地板 -------------------------------------------------------------------
test("deny 里有注释时不再误报缺条目（回归：曾把两份正确配置判死）", () => {
	const dir = withRoleDirs({ "coder.md": md({ write: "[.]", deny: FLOOR.replace("        - git commit", "        # 地板\n        - git commit") }) });
	try {
		const { problems } = checkRoleDirs(dir);
		assert.deepEqual(problems.filter((p) => p.includes("deny list is missing")), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("真的少一条时仍然报错，并点名缺的那条", () => {
	const dir = withRoleDirs({ "coder.md": md({ write: "[.]", deny: "        - git commit\n        - rm -rf" }) });
	try {
		const { problems } = checkRoleDirs(dir);
		const denyProblem = problems.find((p) => p.includes("deny list is missing"));
		assert.ok(denyProblem, "缺少地板条目必须报错");
		assert.match(denyProblem, /git push/);
		assert.doesNotMatch(denyProblem, /git commit/, "已经存在的那条不该出现在缺失清单里");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- loader 路径 ---------------------------------------------------------------
test("subagentOnlyExtensions 指向仓库内已删除的文件 → 报错（fail-open 的根源）", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "role-check-loader-"));
	mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	mkdirSync(path.join(root, ".pi", "agent-profiles"));
	const loader = path.join(root, ".pi", "agent-profiles", "md-role.ts");
	writeFileSync(
		path.join(root, ".pi", "agents", "coder.md"),
		md({ write: "[.]", loader }),
	);
	try {
		const { problems } = checkRoleDirs(path.join(root, ".pi", "agents"));
		assert.equal(problems.length, 1);
		assert.match(problems[0], /subagentOnlyExtensions names .*md-role\.ts/);
		assert.match(problems[0], /no confinement at all/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("仓库外且本机不存在的 loader 记为不可验证，不算错误（CI 里跑不动另一次检出）", () => {
	// 另一台机器/另一次检出的绝对路径：这里判不了，只能跳过，否则 CI 上每条都是「缺失」。
	const dir = withRoleDirs({
		"coder.md": md({ loader: "/nonexistent-checkout/loader.ts" }),
	});
	try {
		const { problems, report } = checkRoleDirs(dir);
		assert.deepEqual(problems, []);
		assert.deepEqual(report, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loader 文件存在时不报错", () => {
	const dir = withRoleDirs({ "coder.md": md({ write: "[.]", loader: "/etc/hostname" }) });
	try {
		assert.deepEqual(checkRoleDirs(dir).problems, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("装好的 loader 指向本包不存在的 src 文件 → 报错（本机有没有那份安装都要报）", () => {
	// 机器绝对路径在 CI 上判不了存在性，但「尾部是 src/<file> 而本包没有这个文件」任何机器都能判：
	// 改名或手误就靠这条抓住。
	const dir = withRoleDirs({
		"coder.md": md({ loader: "/opt/nowhere/node_modules/pi-subagents-extend/src/gone.ts" }),
	});
	try {
		const { problems } = checkRoleDirs(dir);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /src\/gone\.ts is not a file this package ships/);

test("指向本包但不在 src/ 下的 loader → 报错（回归：删掉 .pi/agent-profiles/md-role.ts 后仍被四个角色 md 引用）", () => {
	const dir = withRoleDirs({
		"coder.md": md({
			loader: "/home/x/extensions/pi-subagents-extend/.pi/agent-profiles/md-role.ts",
		}),
	});
	try {
		const { problems } = checkRoleDirs(dir);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /not inside this package's shipped src\//);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("装好的 loader 指向本包真的发布的文件 → 不算错，但存在性仍记为不可验证", () => {
	const dir = withRoleDirs({
		"coder.md": md({ loader: "/opt/nowhere/node_modules/pi-subagents-extend/src/index.ts" }),
	});
	try {
		const { problems, unverifiable } = checkRoleDirs(dir);
		assert.deepEqual(problems, []);
		// 悄悄当作通过是不行的：这一条这一台机器确实没验证。
		assert.equal(unverifiable.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("别的扩展的 loader 不拿本包的文件表去判", () => {
	const dir = withRoleDirs({ "coder.md": md({ loader: "/opt/other-ext/src/thing.ts" }) });
	try {
		assert.deepEqual(checkRoleDirs(dir).problems, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- 写授权 --------------------------------------------------------------------
test("preExec 用 mkdir -p 创建的目标算可达，别的一律算死授权", () => {
	const dir = withRoleDirs({
		"review.md": [
			"---",
			"name: review",
			"extend:",
			"  setup:",
			"    preExec: mkdir -p .pi/review-reports",
			"  permissions:",
			'    write: [".pi/review-reports"]',
			"    bash:",
			"      deny:",
			FLOOR,
			"---",
			"",
		].join("\n"),
	});
	try {
		assert.deepEqual(checkRoleDirs(dir).problems, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("既不存在又没人创建 → 报成死授权", () => {
	const dir = withRoleDirs({ "coder.md": md({ write: '[".pi/not-there"]' }) });
	try {
		const { problems } = checkRoleDirs(dir);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /\.pi\/not-there/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createdPaths 只认真正创建目标的形状，且锚在被检查仓库的根上", () => {
	const root = "/repo";
	assert.deepEqual(createdPaths("mkdir -p a/b", root), ["/repo/a/b"]);
	assert.deepEqual(createdPaths("mkdir -p a && cp x a/", root), ["/repo/a", "/repo/a", "/repo/a/x"]);
	assert.deepEqual(createdPaths("mkdir -p /abs/dir", root), ["/abs/dir"]);
	// 只是提到某个路径不算创建
	assert.deepEqual(createdPaths("echo .pi/reports", root), []);
	assert.deepEqual(createdPaths("", root), []);
});

test("相对写授权按被检查仓库的根解析，而不是按运行检查器的 cwd", () => {
	// docs/ 只存在于被检查仓库里；cwd 是别的目录，所以只有 root 参与解析才判得对。
	const root = mkdtempSync(path.join(os.tmpdir(), "role-check-root-"));
	mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	mkdirSync(path.join(root, "docs"));
	writeFileSync(
		path.join(root, ".pi", "agents", "coder.md"),
		md({ write: "[docs]", allow: ["git status"] }),
	);
	try {
		assert.deepEqual(checkRoleDirs(path.join(root, ".pi", "agents")).problems, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---- 门禁命令 ------------------------------------------------------------------
test("门禁里写了 allow 没有的命令 → 报错，角色会拒绝自己的验收命令", () => {
	const dir = withRoleDirs({
		"coder.md": md({ write: "[.]", allow: ["git status"], gate: "mise run test:role" }),
	});
	try {
		const { problems } = checkRoleDirs(dir, { miseToml: '[tasks."test:role"]\nrun = "x"\n' });
		assert.equal(problems.length, 1);
		assert.match(problems[0], /mise run test:role/);
		assert.match(problems[0], /refuse its own acceptance command/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("allow 用 re: 模式覆盖门禁时不算被拒", () => {
	const dir = withRoleDirs({
		"coder.md": md({ write: "[.]", allow: ["re:^mise run test:"], gate: "mise run test:role" }),
	});
	try {
		assert.deepEqual(checkRoleDirs(dir, { miseToml: '[tasks."test:role"]\nrun = "x"\n' }).problems, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("门禁点名不存在的 mise 任务 → 报错", () => {
	const dir = withRoleDirs({
		"coder.md": md({ write: "[.]", allow: ["mise run test:gone"], gate: "mise run test:gone" }),
	});
	try {
		const { problems } = checkRoleDirs(dir, { miseToml: '[tasks."test:role"]\nrun = "x"\n' });
		assert.equal(problems.length, 1);
		assert.match(problems[0], /unknown mise task\(s\) test:gone/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("没有 mise.toml 时只跳过任务存在性，不跳过 allowlist 检查", () => {
	const dir = withRoleDirs({
		"coder.md": md({ write: "[.]", allow: ["git status"], gate: "mise run test:role" }),
	});
	try {
		const { problems } = checkRoleDirs(dir);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /but bash.allow does not/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
