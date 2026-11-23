// 文档里不写死本包的版本号：安装命令写成 `pi install npm:pi-subagents-extend` 即可。
// 写死会随每次发布腐坏，而且没有信号 —— 这类句子没人会回头改。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const pkgRoot = join(repoRoot, "packages", "pi-plugin");
const SKIP_DIRS = new Set(["node_modules", ".git", ".build", "target", ".test-state", "review-reports"]);
// prepack 会把仓库根的 README/LICENSE 复制进包目录，那是构建产物，不是文档源。
const GENERATED = new Set(["packages/pi-plugin/README.md", "packages/pi-plugin/LICENSE"]);

const packageName = (JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { name: string }).name;
const escaped = packageName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const LITERAL_VERSION = new RegExp(`${escaped}@\\d`);

const markdownFiles: string[] = [];
const walk = (absolute: string, rel: string): void => {
	for (const entry of readdirSync(absolute, { withFileTypes: true })) {
		const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(join(absolute, entry.name), childRel);
			continue;
		}
		if (!entry.name.endsWith(".md") || GENERATED.has(childRel)) continue;
		markdownFiles.push(childRel);
	}
};
walk(repoRoot, "");

const offenders = markdownFiles.flatMap((file) =>
	readFileSync(join(repoRoot, file), "utf8")
		.split("\n")
		.map((line, index) => ({ line: index + 1, text: line.trim(), file }))
		.filter(({ text }) => LITERAL_VERSION.test(text))
		.map(({ file, line, text }) => `${file}:${line}  ${text}`),
);

assert.ok(markdownFiles.length > 0, "no markdown found — the walk broke");
assert.deepEqual(offenders, [], `去掉安装命令里的版本号：${packageName} 发新版本后这些句子就错了`);

console.log(`pinned-version: ${markdownFiles.length} markdown files carry no literal ${packageName} version`);
