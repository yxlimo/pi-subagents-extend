/**
 * DEPENDENCY-ENVIRONMENT 层：工具链产物目录探测（scratch dirs）—— 读 manifest 推出
 * build/test 会往哪些目录写，作为沙箱写授权集合的输入。
 * 除 `scratchDirsCache`（探测结果按 cwd 的 memo，语义上仍是纯函数）外不持有会话状态；
 * index.ts 只做接线。
 * 模块拆分第三步：以下声明从 index.ts 原样搬出，行为不变。
 */
import { readdirSync, type Dirent } from "node:fs";
import { resolve } from "node:path";
/**
 * 工具链 → 项目里会出现的产物目录。判据是仓库根（及其一层子目录，覆盖 monorepo 的
 * packages/*）里的清单文件：有 Cargo.toml 就是 Rust 项目，有 package.json 就是 Node 项目。
 * 只读文件，不 spawn 进程，也不猜「这个目录现在存不存在」。
 *
 * dirs 里的目录：存在就放行，不存在就不管（空目录没有意义，凭空造一堆更吵）。
 * primary 里的目录：属于该工具链的主产物，缺了就创建 —— `cargo test` 一定会写 target/，
 * 不放行也不创建的话，命令第一次跑就是 Permission denied。
 */
const TOOLCHAINS: { markers: string[]; dirs: string[]; primary: string[] }[] = [
	{
		markers: ["package.json"],
		dirs: ["coverage", "dist", "build", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".vite", ".parcel-cache", ".cache", ".angular"],
		primary: [],
	},
	{ markers: ["Cargo.toml"], dirs: ["target"], primary: ["target"] },
	{
		markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
		dirs: ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".venv"],
		primary: ["__pycache__"],
	},
	{ markers: ["go.mod"], dirs: ["bin"], primary: [] },
	{ markers: ["pom.xml"], dirs: ["target"], primary: ["target"] },
	{ markers: ["build.gradle", "build.gradle.kts"], dirs: ["build", ".gradle"], primary: ["build"] },
	{ markers: ["mix.exs"], dirs: ["_build", "deps"], primary: ["_build"] },
	{ markers: ["pubspec.yaml"], dirs: [".dart_tool", "build"], primary: [".dart_tool"] },
	{ markers: ["Gemfile"], dirs: ["tmp", "log", ".bundle"], primary: [] },
	{ markers: ["Package.swift"], dirs: [".build"], primary: [".build"] },
	{ markers: ["build.zig"], dirs: ["zig-out", "zig-cache", ".zig-cache"], primary: ["zig-out", "zig-cache"] },
	{ markers: ["stack.yaml", "cabal.project"], dirs: ["dist-newstyle", ".stack-work"], primary: ["dist-newstyle"] },
	{ markers: ["CMakeLists.txt"], dirs: ["build"], primary: ["build"] },
	{ markers: ["*.csproj", "*.sln"], dirs: ["obj", "bin"], primary: [] },
];

/**
 * 清单也往子目录里找两层（`packages/web/package.json` 这种 monorepo 布局），
 * 但不开销太大：跳过明显的产物/依赖目录，并给总量封顶。
 */
export const DETECT_SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "vendor", "__pycache__", "bin", "obj"]);
const DETECT_MAX_ROOTS = 200;

const scratchDirsCache = new Map<string, { dir: string; primary: boolean }[]>();

/** 探测结果按 cwd 缓存：bash 白名单命令会反复拼 spec。 */
/**
 * 按名字排序（纯函数，供 `sortedEntries` 与测试使用）。用字典序而不是 localeCompare：
 * 后者的结果依赖运行时的 locale，那正好是排序要消除的那类不确定性。
 */
export function sortByName<T extends { name: string }>(entries: T[]): T[] {
	return entries.sort((a, b) => {
		if (a.name === b.name) return 0;
		return a.name < b.name ? -1 : 1;
	});
}

/**
 * 目录项按名字排序后返回；读不了就当作空目录。
 *
 * readdir 的顺序由文件系统决定：这台机器上 tmpfs 给的是排序结果，而 ext4 的 dir_index、
 * XFS、NFS 给的是哈希序。扫描有 DETECT_MAX_ROOTS 的名额上限，顺序不定就意味着
 * 「哪些目录被检查、被授权」随机器而变 —— 闸门可能在一台机器上放行、在另一台上拒绝。
 * 排序把这个不确定性按死。
 */
export function sortedEntries(dir: string): Dirent[] {
	try {
		return sortByName(readdirSync(dir, { withFileTypes: true }));
	} catch {
		return [];
	}
}

export function detectScratchDirs(cwd: string): { dir: string; primary: boolean }[] {
	const key = resolve(cwd);
	const cached = scratchDirsCache.get(key);
	if (cached) return cached;

	const found: { dir: string; primary: boolean }[] = [];
	const roots = [key];
	// 广度优先往下两层，遇到产物/依赖目录不再深入。
	let frontier = [key];
	for (let depth = 0; depth < 2 && roots.length < DETECT_MAX_ROOTS; depth += 1) {
		const next: string[] = [];
		for (const dir of frontier) {
			for (const entry of sortedEntries(dir)) {
				if (!entry.isDirectory() || DETECT_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
				const child = resolve(dir, entry.name);
				roots.push(child);
				next.push(child);
				if (roots.length >= DETECT_MAX_ROOTS) break;
			}
			if (roots.length >= DETECT_MAX_ROOTS) break;
		}
		frontier = next;
	}

	for (const root of roots) {
		let entries: string[] = [];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const toolchain of TOOLCHAINS) {
			const matched = toolchain.markers.some((marker) =>
				marker.startsWith("*.")
					? entries.some((name) => name.endsWith(marker.slice(1)))
					: entries.includes(marker),
			);
			if (!matched) continue;
			for (const name of toolchain.dirs) {
				found.push({ dir: resolve(root, name), primary: toolchain.primary.includes(name) });
			}
		}
	}

	scratchDirsCache.set(key, found);
	return found;
}

