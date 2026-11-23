// 文档里点名的测试文件必须存在。
//
// 这条用例来自一次真实漂移：套件按区域移进 `test/<area>/` 之后，`docs/testing.md` 的表格和
// `package.json` 的 test 脚本都还写着 `test/policy.test.ts` 这些旧路径。package.json 那份已经
// 用「遍历目录」的方式消掉了，文档这份没有 —— 文档没法自己发现自己点名了一个不存在的文件。
//
// 只判 `test/…test.ts` 形状的路径：那是本文档体系里唯一稳定的坐标（相对包目录或相对仓库根），
// 其他路径形状（工作树里的文件、别的仓库的套件）不在本仓库里，判了只会误报。
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";


const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const pkgRoot = join(repoRoot, "packages", "pi-plugin");
const SKIP_DIRS = new Set(["node_modules", ".git", ".build", "target", ".test-state", "review-reports"]);

const markdownFiles: string[] = [];
const walk = (absolute: string, rel: string): void => {
	for (const entry of readdirSync(absolute, { withFileTypes: true })) {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (childRel.split(sep).some((part) => SKIP_DIRS.has(part))) continue;
		const child = join(absolute, entry.name);
		if (entry.isDirectory()) walk(child, childRel);
		else if (entry.isFile() && entry.name.endsWith(".md")) markdownFiles.push(child);
	}
};
walk(repoRoot, "");

interface Referenced {
	file: string;
	line: number;
	spec: string;
	resolved: string;
}

const referenced: Referenced[] = [];
for (const file of markdownFiles) {
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((text, index) => {
		for (const match of text.matchAll(/`([^`\n]+)`/g)) {
			const spec = match[1].trim();
			if (!spec.endsWith(".test.ts")) continue;
			// Accepted spellings: relative to the package directory (`test/policy/policy.test.ts`) or
			// relative to the repo root (`packages/pi-plugin/test/...`). Both land in the same place.
			if (!spec.startsWith("test/") && !spec.startsWith("packages/pi-plugin/test/")) continue;
			const resolved = join(
				pkgRoot,
				spec.startsWith("packages/pi-plugin/") ? spec.slice("packages/pi-plugin/".length) : spec,
			);
			referenced.push({ file: relative(repoRoot, file), line: index + 1, spec, resolved });
		}
	});
}

let cases = 0;
const missing = referenced.filter((entry) => !existsSync(entry.resolved));
cases += 1;
assert.deepEqual(
	missing.map((entry) => `${entry.file}:${entry.line} names ${entry.spec}, which does not exist`),
	[],
	"every test path a document names must exist",
);

// 正对照：文档确实被读到了，否则上面那条在没有引用时会因为「什么都没检查」而永远绿。
cases += 1;
assert.ok(
	referenced.length > 0,
	`no test paths found in ${markdownFiles.length} markdown files — the walk or the pattern broke`,
);

console.log(`doc-paths: ${cases} cases passed (${referenced.length} references across ${markdownFiles.length} files)`);
