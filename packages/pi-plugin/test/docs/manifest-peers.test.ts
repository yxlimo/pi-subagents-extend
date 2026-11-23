// 宿主提供的包必须声明成 peerDependencies（范围 "*"），不能进 dependencies。
//
// pi 的原文（docs/packages.md「Declare dependencies」）：宿主把这些包直接供给扩展；放进
// dependencies 会装出第二份物理副本，绕过扩展的模块映射，产生重复的类、注册表和重复初始化。
// typebox 这种 schema 库更隐蔽：扩展里的 `Type.Object(...)` 与宿主校验用的不是同一个模块实例，
// schema 身份判断（instanceof / 内部 Symbol）失效，表现是「参数校验莫名其妙不生效」。
// pi 检测到这种 manifest 会打一条警告，警告很容易被忽略 —— 所以这里把它变成红。
//
// 这不是假设：@yxlimo/pi-wake 就把 typebox 写进了 dependencies，0.1.1 被 pi 报过这条警告。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const pkgRoot = join(repoRoot, "packages", "pi-plugin");

/** pi 列出的宿主提供包；新增一项要跟着 pi 的文档改。 */
const HOST_PROVIDED = new Set([
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
]);

const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

let cases = 0;

// 一、dependencies 里出现宿主包就是缺陷本身，不看源码也要红。
const inDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) => HOST_PROVIDED.has(name));
assert.deepEqual(
	inDependencies,
	[],
	`host-provided packages belong in peerDependencies("*"), not dependencies: ${inDependencies.join(", ")}`,
);
cases += 1;

// 二、源码真正 import 的宿主包，必须声明成 peer 且范围是 "*"。
const imported = new Set<string>();
const walk = (dir: string): void => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const absolute = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			walk(absolute);
			continue;
		}
		if (!entry.name.endsWith(".ts")) continue;
		const text = readFileSync(absolute, "utf8");
		for (const match of text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
			const specifier = match[1] as string;
			// 只认裸包名：`./x.ts` 是本地模块，`node:fs` 是内置的。
			if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
			imported.add(specifier);
		}
	}
};
walk(join(pkgRoot, "src"));

const referenced = [...imported].filter((name) => HOST_PROVIDED.has(name)).sort();
// 正对照：一条都没扫到说明扫描本身坏了，否则下面两条会在空集上永远绿。
assert.ok(
	referenced.length > 0,
	`no host-provided package found in ${imported.size} imported specifiers — the scan broke`,
);
cases += 1;

for (const name of referenced) {
	assert.equal(
		manifest.peerDependencies?.[name],
		"*",
		`${name} is imported by src/ and must be a peerDependency with range "*"`,
	);
}
cases += 1;

// 三、本地 typecheck 与测试用的还是真实的那份，所以 devDependencies 里要留一份。
for (const name of referenced) {
	assert.ok(
		manifest.devDependencies?.[name],
		`${name} needs a devDependency too, or a fresh checkout cannot type check`,
	);
}
cases += 1;

// 四、反向对照：非宿主依赖照旧可以放在 dependencies（本包的 `yaml` 就是这种）。
assert.ok(
	Object.keys(manifest.dependencies ?? {}).length > 0,
	"this package is expected to keep at least one real dependency; if that changed, tighten this case",
);
assert.ok(
	Object.keys(manifest.dependencies ?? {}).every((name) => !HOST_PROVIDED.has(name)),
	"dependencies may only hold packages pi does not supply",
);
cases += 1;

console.log(`manifest-peers: ${cases} cases passed (peers checked: ${referenced.join(", ")})`);
