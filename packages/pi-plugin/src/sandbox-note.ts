/**
 * 沙箱失败提示：让子代理分清「主代理没授权」和「这台机器坏了」。
 *
 * 两种失败要分开处理，因为证据强度不同：
 *
 * - **网络**：离线时任何 `ENETUNREACH` / `EAI_AGAIN` 都只可能是断网造成的，判定确定。
 *   断网有两种实现：能建网络命名空间时是结构上的“没有路由”（`ENETUNREACH`），
 *   建不出来时（部分 CI runner）由 Landlock 端口规则兜底，报的是连接 `EACCES`。
 *   两种都要认，否则在回落的机器上这句提示就消失了。
 * - **写越界**：`EACCES` / `Permission denied` 太常见，读到 `/etc/shadow` 被拒也是这句话。
 *   所以这里不按文案猜，而是拿事实比对：从失败行里取路径，与这次命令的**可写清单**
 *   （spec.write，父代理授权出来的那份）比较。路径不在清单里、而宿主侧**读得到**它
 *   （沙箱不限制读，所以读得到的文件只可能是被拒了写），才判定为「授权问题」。
 *   `*.lock` 例外：那是 git 自己的锁文件习惯，命令往往照样成功，不当授权问题上报。
 *
 * 文本面向模型、英文、一句话：它嵌在失败结果后面。
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, resolve, sep } from "node:path"

/** 已补过提示的标记，兼作幂等判据。 */
const MARK = "[sandbox]"

/**
 * 网络失败的特征串。只收「解析/路由根本不通」这一类：
 * `ECONNREFUSED` / `socket hang up` 刻意不收 —— 本地 loopback 是通的，
 * 那两个在沙箱内是正常的测试结果，补提示会造成误报。
 */
const NETWORK_FAILURES: RegExp[] = [
	/\bENETUNREACH\b/,
	/\bENETDOWN\b/,
	/\bEHOSTUNREACH\b/,
	/\bEAI_AGAIN\b/,
	/\bENOTFOUND\b/,
	/network is unreachable/i,
	// Landlock 兜底时连接失败是 EACCES，文案里一定带 connect。
	/connect[^\n]{0,80}\bEACCES\b/i,
	/\bEACCES\b[^\n]{0,80}\bconnect\b/i,
	/could not resolve host/i,
	/temporary failure in name resolution/i,
	/getaddrinfo[^\n]*failed/i,
]

/** 权限被拒的行。只在这一行里找路径。 */
const REFUSAL = /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i

/** 行内的绝对路径（带引号或不带；结尾的引号与标点去掉）。 */
const PATH_IN_LINE = /(?:'|"|`)?(\/[^\s'"`:;,)]*)/g

/**
 * git 的锁文件：`index.lock`、`packed-refs.lock` 这类「先写锁、再改名」的临时文件。
 *
 * 沙箱里的 git 会去建它用不到的锁：linked worktree 的 common dir 只授权了
 * objects/refs/logs，于是每次提交都打一行 `error: Unable to create
 * '<common>/packed-refs.lock': Permission denied`（退出码 0，commit 照旧落地 —— ref 写成
 * 松散 ref，packed-refs 留旧值，下次 gc 自会收拾）。那行不是子代理写错了地方，把它当成
 * 「授权不够，去要 writablePaths」上报比漏提示更有害：父代理会去放宽一份本来正确的授权。
 * 所以锁文件一律不注解。
 */
function isLockFile(path: string): boolean {
	return path.endsWith(".lock")
}

/**
 * 补在网络失败结果后面的提示；不该补时返回 undefined。
 *
 * @param text bash 工具结果的纯文本
 * @param offline 这条命令是否在无网沙箱里跑的（`bash.network !== true`）
 */
export function networkFailureNote(text: string, offline: boolean): string | undefined {
	if (!offline || !text || text.includes(MARK)) return undefined
	if (!NETWORK_FAILURES.some((pattern) => pattern.test(text))) return undefined
	return `${MARK} the network is off per the parent's bindings — a permission, not a broken machine. Retrying will fail the same way; use contact_supervisor to ask for "network": true.`
}

/**
 * 补在「命令树不再消耗 CPU 而被杀」后面的提示；不该补时返回 undefined。
 *
 * 这是 `bash.cpuStallSeconds` 打开时 helper 的动作：它按子树累计 CPU 判定，秒数是它量的。
 * 提示的重点不是「失败了」，而是「重试没用」—— 卡在锁、socket、或被孤儿进程挂住的命令，
 * 再跑一遍会以同样的方式卡住，而模型很容易把它当成一次偶发失败。
 */
export function cpuStallNote(text: string): string | undefined {
	if (!text || text.includes(MARK)) return undefined
	const matched = /cpu stall: the command tree used no CPU for (\d+) s/.exec(text)
	if (!matched) return undefined
	return `${MARK} no CPU for ${matched[1]} s, so the parent's stall watchdog killed it — a hung command, not a failing test. Retrying stalls the same way; report what you were running with contact_supervisor.`
}

/**
 * 补在「写到授权范围之外」后面的提示；不该补时返回 undefined。
 *
 * @param text bash 工具结果的纯文本
 * @param granted 这条命令的可写清单（`spec.write`，宿主侧的绝对路径）
 * @param cwd 命令的 cwd，用来解析相对路径
 */
export function writeRefusalNote(text: string, granted: string[], cwd: string): string | undefined {
	if (!text || text.includes(MARK) || !granted.length) return undefined
	const roots = granted.map((dir) => realOrSelf(dir))
	const refused = firstRefusedOutside(text, roots, cwd)
	if (!refused) return undefined
	const shown = roots.length > 3 ? `${roots.slice(0, 3).join(", ")} …` : roots.join(", ")
	return `${MARK} ${refused} is outside the writes the parent granted (${shown}) — a permission, not a filesystem fault. Writing elsewhere will not help; use contact_supervisor to ask for writablePaths or a wider write scope.`
}

/** 第一条「路径在授权外、而宿主读得到」的拒绝目标；没有就 undefined。 */
function firstRefusedOutside(text: string, roots: string[], cwd: string): string | undefined {
	const seen = new Set<string>()
	for (const line of text.split("\n")) {
		if (!REFUSAL.test(line)) continue
		for (const raw of pathsIn(line)) {
			if (isLockFile(raw)) continue
			const target = candidate(raw, cwd)
			if (!target || seen.has(target)) continue
			seen.add(target)
			if (!isUnder(target, roots) && readable(target)) return target
		}
	}
	return undefined
}

/** 行内可作为写目标的路径：去掉设备、URL 与单斜杠。 */
function pathsIn(line: string): string[] {
	const found: string[] = []
	PATH_IN_LINE.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = PATH_IN_LINE.exec(line)) !== null) {
		const raw = match[1]
		if (!raw || raw === "/" || raw.includes("://") || raw.startsWith("/dev/")) continue
		found.push(raw)
	}
	return found
}

/** 相对路径按 cwd 解析，再做一次 realpath（目标可能还不存在）。 */
function candidate(raw: string, cwd: string): string {
	return realOrSelf(isAbsolute(raw) ? raw : resolve(cwd, raw))
}

/** `realpathSync`，失败就退回原路径（目标可能还不存在）。 */
function realOrSelf(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return path
	}
}

/** `path` 是否等于 `roots` 里某个目录或在其之下。 */
function isUnder(path: string, roots: string[]): boolean {
	return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))
}

/**
 * 宿主侧能不能读：读得到目标，或读得到它所在的目录（那是「新建文件」的情形）。
 *
 * 这一条把「宿主权限不够」的 `EACCES` 排除在外，例如 `cat /etc/shadow` 被拒 —— 那种
 * 情况我们自己也读不到，不能归因为沙箱授权。
 */
function readable(path: string): boolean {
	try {
		statSync(path)
	} catch {
		// 目标不存在：看它落在哪个现存目录里，目录可读即可。
		let dir = dirname(path)
		for (let depth = 0; depth < 32; depth += 1) {
			try {
				if (statSync(dir).isDirectory()) return readableDir(dir)
			} catch {
				const parent = dirname(dir)
				if (parent === dir) return false
				dir = parent
			}
		}
		return false
	}
	return readableDir(path)
}

function readableDir(path: string): boolean {
	try {
		accessSync(path, constants.R_OK)
		return true
	} catch {
		return false
	}
}
