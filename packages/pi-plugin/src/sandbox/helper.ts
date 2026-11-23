/**
 * SANDBOX 层 · helper 模块：helper 二进制的定位（候选顺序）、能力探测（--describe）、
 * 以及开场拦截文案（缺 helper / 内核 ABI 不足时 fail closed）。pnpm store 的探测与
 * 描述也在这里：它是 /permission 与拒绝文案里「环境描述」的一部分，不参与授权推导。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** helper 的名字：找它、报它、文档里写它都用这一个常量。 */
const HELPER_NAME = "pi-subagents-extend-helper";

/**
 * 找 helper：环境变量优先，其次包装好的 bin/，最后仓内 cargo 产物。
 *
 * 第三个候选是给「源码 checkout + 软链加载」这种用法的：cargo 建好了但没跑
 * `pnpm run build:helper` 把产物拷进 bin/ 时，bash 不该整体失效 —— 这是改名后
 * 真实踩到的坑。npm 安装的副本没有 ../helper，那一条自然落空。
 */
/**
 * helper 候选路径。纯函数，便于直接钉住候选及其顺序：环境变量不是候选，
 * 而是覆盖（设了但不存在就不往下找，否则「指错了」会静默用上另一个）。
 *
 * 第一名是**按平台命名**的二进制：npm 包只能带一份打包时构建的产物，
 * 而 helper 是 Linux 特有的（Landlock + userns），所以发布时按
 * `<name>-<platform>-<arch>` 命名，安装后的副本在自己的平台上找得到、
 * 在别的平台上找不到也说得清。第二名是本地构建的通用名，第三名是源码
 * checkout 里 cargo 的产物 —— npm 安装的副本没有 ../helper，那条自然落空。
 */
export function helperCandidates(
	here: string,
	platform: string = process.platform,
	arch: string = process.arch,
): string[] {
	return [
		resolve(here, "..", "bin", `${HELPER_NAME}-${platform}-${arch}`),
		resolve(here, "..", "bin", HELPER_NAME),
		resolve(here, "..", "..", "helper", "target", "release", HELPER_NAME),
	];
}

export function helperPath(): string | undefined {
	const fromEnv = process.env.PI_SUBAGENTS_EXTEND_HELPER?.trim();
	if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
	// 候选锚在包的 src/ 目录上；本文件在 src/sandbox/ 下，比拆分前深一层，向上补回。
	const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	for (const candidate of helperCandidates(here)) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * bash 到底能不能跑。缺 helper 与内核对不上都是「每条命令都拒」，与其让子代理
 * 撞墙几次再自己推断，不如开场就把它说出来。
 */
export function bashBlocker(helper: string | undefined): string | undefined {
	if (!helper) {
		const platform = `${process.platform}-${process.arch}`;
		return (
			`no sandbox helper found for ${platform}, so every bash command will be refused. ` +
			`The package carries one as bin/${HELPER_NAME}-<platform>-<arch>; if yours is missing, ` +
			"build one with `pnpm run build:helper` in packages/pi-plugin, or set PI_SUBAGENTS_EXTEND_HELPER."
		);
	}
	const caps = describeHelper(helper);
	if (!caps?.landlock.supported) {
		const reason = caps?.landlock.reason ?? "helper --describe returned nothing usable";
		return `this kernel cannot enforce the sandbox (${reason}), so every bash command will be refused`;
	}
	return undefined;
}

/**
 * 探测 pnpm 的 store 路径（只探测，不自动放行）。路径随 cwd 变，必须用子代理的
 * cwd 跑。探测失败不影响其他功能，只是这一行显示不出来。
 */
const pnpmStoreCache = new Map<string, { path?: string; error?: string }>();

export function detectPnpmStore(cwd: string): { path?: string; error?: string } {
	const cached = pnpmStoreCache.get(cwd);
	if (cached) return cached;
	const found = probePnpmStore(cwd);
	pnpmStoreCache.set(cwd, found);
	return found;
}

function probePnpmStore(cwd: string): { path?: string; error?: string } {
	try {
		const out = execFileSync("pnpm", ["store", "path"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const line = out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.pop();
		return line ? { path: line } : { error: "pnpm store path printed nothing" };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** /permission 里显示 pnpm store：探测到的路径 + 一句「未放行」的提示。 */
export function describePnpmStore(cwd: string): string {
	const found = detectPnpmStore(cwd);
	if (found.path) return `${found.path} (not writable; add it to bash.writablePaths if the subagent must install dependencies)`;
	return `detection failed (${found.error ?? "unknown cause"})`;
}

/**
 * helper 的能力探测结果：`--describe` 只读，每个进程查一次。
 */
export type HelperCapabilities = {
	landlock: { kernel_abi: number; required_abi: number; supported: boolean; reason?: string | null };
	network_namespace: boolean;
	resolver_sockets: string[];
};

const helperCache = new Map<string, HelperCapabilities | undefined>();

/** 问 helper 能做到什么程度；拿不到就返回 undefined，调用方按不可用处理。 */
export function describeHelper(helper: string): HelperCapabilities | undefined {
	if (helperCache.has(helper)) return helperCache.get(helper);
	let caps: HelperCapabilities | undefined;
	try {
		// ABI 不够时 --describe 也会输出 JSON，只是退出码非 0；所以按输出解析。
		const out = execFileSync(helper, ["--describe"], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		caps = JSON.parse(out) as HelperCapabilities;
	} catch (error) {
		const stdout = (error as { stdout?: unknown })?.stdout;
		if (typeof stdout === "string" && stdout.trim()) {
			try {
				caps = JSON.parse(stdout) as HelperCapabilities;
			} catch {
				caps = undefined;
			}
		}
	}
	helperCache.set(helper, caps);
	return caps;
}
