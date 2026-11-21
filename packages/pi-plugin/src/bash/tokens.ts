/**
 * bash 命令的切词与路径候选抽取。
 *
 * 从 bash-match.ts 拆出来的纯函数层：只做文本处理，不做授权判断。
 * bash-match.ts 仍是唯一入口，这里的东西由它转出口。
 */

export const RE_PREFIX = "re:";

export function tokens(text: string): string[] {
	return text.trim().split(/\s+/);
}

/**
 * 把命令切成参数，按 bash 的引号语义。
 *
 * 与 index.ts 的 `hasUnquotedShellControl` 是同一套扫描规则，但**保留引号字符本身**：
 * 下游把「含引号」当作「这段是代码或字面量，不是路径」的直接信号，剥掉反而要多猜一次。
 * 空白只在引号之外切词，所以 `-e 'require("x")'` 是两个 token，不是一个。
 */
export function shellTokens(command: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i] as string;
		if (quote === "'") {
			current += ch;
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			current += ch;
			// 双引号内反斜杠仍会转义，跳过后一个字符（与 hasUnquotedShellControl 一致）
			if (ch === "\\" && i + 1 < command.length) {
				current += command[i + 1] as string;
				i += 1;
				continue;
			}
			if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				out.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	// 引号没闭合时前半句照常返回：那种命令会被元字符检查先拒掉，这里不必再判一次。
	if (current) out.push(current);
	return out;
}

/**
 * 「像路径」的字符集：只由这些字符构成（斜杠另判，见 `pathCandidates`）。
 *
 * 斜杠是「路径」与「包名 / 裸词」在文本上唯一稳定的分界 —— `foo`、`--flag`、`HEAD` 都不含斜杠。
 * 反过来只认以 `/` 或 `./` 开头的写法会漏掉一个真实形态：cwd 下有 `escape-link -> /home/other`
 * 时，`rg foo escape-link/x` 照样读到树外，而它看起来完全不像「绝对路径」。
 *
 * 放宽这一条不会新增误拒：相对候选按 cwd 解析后落在 cwd 之下，而 cwd 本来就在允许集内。
 */
const PATH_TOKEN = /^[-A-Za-z0-9._/@+%~]+$/;

/**
 * 开头是这两种字符的不是路径：`-` 是 flag（`--file=x/y`），`@` 是 npm 包名（`@scope/pkg`）。
 * 只挡开头，`src/@types/x.ts` 这类中间出现的照样算。
 */
const PATH_TOKEN_SKIP_HEADS = ["-", "@"];

/**
 * 出现这些字符的 token 一律不当路径：动态拼接（`$DIR`、反引号）、代码片段（括号、引号）、
 * URL（冒号）、glob（`*` `?` `{}`）、以及 shell 语法残留。
 *
 * 其中大部分字符本来就进不了 `PATH_TOKEN` 的字符类，这条表因此是「判据以后放宽了也别把它们
 * 当路径」的显式记录；先跳过再判正则，也让意图只有一处。
 */
const PATH_TOKEN_SKIP = ["$", "`", "*", "?", "(", ")", "{", "}", ",", "'", '"', ";", "|", "<", ">", ":"];

/** 最多看这么多条：一条命令里的路径参数不会更多，扫描也不该无上限。 */
const MAX_PATH_CANDIDATES = 32;

/** 超长 token 直接跳过：那多半不是路径，白做一次 realpath。 */
const MAX_PATH_TOKEN_LENGTH = 200;

/**
 * 从一条命令里抽出「看起来像路径」的参数候选；纯抽取，不做授权判断。宁可漏放，不许误拒。
 *
 * 第一个 token 是程序位，它本身是路径形态时**不算**参数候选：可执行文件由 bash 通过 PATH 解析，
 * 根本不进参数表；只有把程序写成绝对路径（`/nix/store/…/bin/foo args`）时它才出现在命令开头，
 * 而那是「正在执行的工具」，不是在工具链目录里翻东西。路径形态的四种写法（绝对路径、`~/`、`./`、
 * `../`）都带斜杠，一条斜杠判据就覆盖了全部。
 */
export function pathCandidates(command: string): string[] {
	const out: string[] = [];
	const words = shellTokens(command);
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i] as string;
		// 粘值写法（`--file=/a/b`）要判的是 `=` 后面的路径，不是整段旗标：
		// 整段以 `-` 开头会被 SKIP_HEADS 丢掉，路径就永远进不了判定。
		// 不认旗标名，只按第一个 `=` 切；斜杠、字符集、跳过表这些判据自己能分辨值是不是路径。
		const token = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
		// 程序位是路径形态时跳过：它是要执行的工具，不是这条命令的参数。
		if (i === 0 && token.includes("/")) continue;
		if (out.length >= MAX_PATH_CANDIDATES) break;
		if (token.length > MAX_PATH_TOKEN_LENGTH) continue;
		if (PATH_TOKEN_SKIP.some((ch) => token.includes(ch))) continue;
		if (PATH_TOKEN_SKIP_HEADS.some((ch) => token.startsWith(ch))) continue;
		// 没有斜杠的一律不是路径：`foo`、`--flag`、`HEAD` 都是裸词。
		if (!token.includes("/")) continue;
		if (!PATH_TOKEN.test(token)) continue;
		out.push(token);
	}
	return out;
}

/**
 * 按 shell 控制符切段；引号内与反斜杠转义的字符不当分隔符。
 */
export function commandSegments(command: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i] as string;
		if (quote === "'") {
			current += ch;
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			current += ch;
			if (ch === "\\" && i + 1 < command.length) {
				current += command[i + 1] as string;
				i += 1;
				continue;
			}
			if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + (command[i + 1] as string);
			i += 1;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
			out.push(current);
			current = "";
			if (ch === "&" && command[i + 1] === "&") i += 1;
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map((segment) => segment.trim()).filter((segment) => segment !== "");
}
