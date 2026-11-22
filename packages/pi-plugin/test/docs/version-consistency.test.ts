// 文档里写死的 binding 版本必须和 role-config.ts 的 BINDING_VERSION 一致。
// 扫描仓库根的 .md；跳过依赖、构建产物和嵌套 worktree，避免旧副本把结果带偏。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../..", import.meta.url));

const { BINDING_VERSION } = (await import(
  pathToFileURL(join(here, "..", "..", "src", "role-config.ts")).href
)) as typeof import("../../src/role-config.ts");

// 跳过的是相对仓库根的路径段：worktree 自身的绝对路径里就有 pi-worktree。
const SKIP_DIRS = new Set(["node_modules", ".git", ".build", "target"]);
const skipped = (rel: string): boolean =>
  rel.split(sep).some((part) => SKIP_DIRS.has(part) || part.includes("pi-worktree"));

const markdownFiles: string[] = [];
const walk = (absolute: string, rel: string): void => {
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (skipped(childRel)) continue;
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) walk(child, childRel);
    else if (entry.isFile() && entry.name.endsWith(".md")) markdownFiles.push(child);
  }
};
walk(root, "");

const VERSION_PATTERN = /pi-subagents-extend\/(\d+)/g;
const expected = String(BINDING_VERSION);
let occurrences = 0;

for (const file of markdownFiles) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(VERSION_PATTERN)) {
      occurrences += 1;
      const found = match[1];
      if (found !== expected) {
        assert.fail(
          `${relative(root, file)}:${index + 1}: documented binding version ${found} does not match BINDING_VERSION ${expected}`,
        );
      }
    }
  }
}

// 扫不到任何一处就说明 walk 没走到文档：必须修扫描，而不是放宽检查。
assert.ok(
  occurrences > 0,
  "found 0 pi-subagents-extend/<N> occurrences: the markdown scan is not reaching the docs; fix the walk rather than relaxing this check",
);

console.log(`pi-subagents-extend binding version consistency: scanned ${markdownFiles.length} markdown files, found ${occurrences} occurrences`);
console.log("pi-subagents-extend binding version consistency tests passed");
