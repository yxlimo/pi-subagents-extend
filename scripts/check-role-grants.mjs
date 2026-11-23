#!/usr/bin/env node
// Role md config checker. Every rule here exists because the failure it catches was silent:
//
//   write grants     A `extend.permissions.write` entry is matched against the session cwd, so a typo
//                    produces a role that refuses all writes while looking exactly like a working
//                    boundary. That happened three times: a missing `packages/pi-plugin/` prefix,
//                    `SKILL.md` at a path that does not exist, and a scratch directory one level short.
//   deny floor       The bindings file that used to supply `git commit`, `git push` and the rest to
//                    every role is gone, so a role md that omits the deny list simply has none. A
//                    subagent that can commit and push is the exact failure the floor prevented.
//   gate commands    A role md that tells the subagent to run a gate it may not run is worse than no
//                    gate: the child spends calls on the refusal and the contradiction reads like a
//                    sandbox bug.
//   loader paths     `subagentOnlyExtensions` naming a file that no longer exists loads nothing, so the
//                    role runs with no confinement at all — and the dispatch still succeeds.
//
// Parsing: these files are hand-written YAML and the shape is fixed, so this reads them by indentation
// instead of taking a dependency on a parser. Every list reader tolerates `# comments` and blank lines
// between entries; matching "the first run of `- ` lines" stops at the first comment, which reported
// working configs as broken three separate times.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The floor every role md with bash must carry: history rewrites and recursive deletes. */
export const REQUIRED_DENY = [
	"git commit",
	"git push",
	"git rebase",
	"git merge",
	"git reset",
	"git clean",
	"git checkout",
	"git restore",
	"rm -rf",
];

const stripQuotes = (value) => value.replace(/^["']|["']$/g, "");

/**
 * Read one `key:` list out of the frontmatter, by indentation.
 *
 * Returns `null` when the key is absent, `[]` when it is present but empty. Comment lines inside the
 * block are skipped rather than treated as the end of the list.
 */
export function listBlock(text, key) {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => new RegExp(`^[ \\t]*${key}:[ \\t]*$`).test(line));
	if (start === -1) return null;
	const indent = lines[start].search(/\S/);
	const entries = [];
	for (const line of lines.slice(start + 1)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) continue;
		if (!trimmed) continue;
		if (line.search(/\S/) <= indent) break;
		const item = line.match(/^[ \t]*-[ \t]+(.*)$/);
		if (item) entries.push(stripQuotes(item[1].trim()));
	}
	return entries;
}

/** Read a flow list (`key: [a, b]`) from one line. Returns null when the shape is not a flow list. */
export function flowList(text, key) {
	const match = text.match(new RegExp(`^[ \\t]*${key}:[ \\t]*\\[(.*)\\]`, "m"));
	if (!match) return null;
	return match[1]
		.split(",")
		.map((entry) => stripQuotes(entry.trim()))
		.filter(Boolean);
}

/** `write` accepts both shapes; the block form wins when both somehow appear. */
export function writeEntries(text) {
	return listBlock(text, "write") ?? flowList(text, "write") ?? [];
}

export function denyEntries(text) {
	return listBlock(text, "deny") ?? [];
}

export function allowEntries(text) {
	return listBlock(text, "allow");
}

export function scopeEntries(text) {
	return listBlock(text, "scope") ?? flowList(text, "scope") ?? [];
}

/** `subagentOnlyExtensions` is a comma-separated list on one line. */
export function loaderEntries(text) {
	const match = text.match(/^[ \t]*subagentOnlyExtensions:[ \t]*(.+)$/m);
	if (!match) return [];
	return match[1]
		.split(",")
		.map((entry) => stripQuotes(entry.trim()))
		.filter(Boolean);
}

// The evaluator treats an entry beginning `re:` as a pattern, so a literal comparison would report
// every command covered by a pattern as refused.
export function allows(entries, command) {
	return entries.some((entry) => {
		if (entry === command) return true;
		const pattern = entry.match(/^re:(.*)$/);
		if (!pattern) return false;
		try {
			return new RegExp(pattern[1]).test(command);
		} catch {
			return false;
		}
	});
}

// Approximate the creation shapes role mds actually use: `mkdir -p <dir>` creates that directory,
// and a copy/move into a directory creates one file named after its source there. Redirections,
// loops and globs are deliberately not modelled — reporting a reachable grant as unreachable is
// safer than hiding a dead one.
export function createdPaths(preExec, root = process.cwd()) {
	const created = [];
	const isDirectory = (path) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	};

	// Every path this returns is absolute, resolved against the repo the md belongs to: `preExec` runs
	// with that repo as its cwd, while this checker may be started from anywhere.
	const absolute = (path) => (isAbsolute(path) ? path : resolve(root, path));
	for (const command of preExec.split(/\s*(?:&&|;)\s*/)) {
		const tokens =
			command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => stripQuotes(token)) ?? [];
		const [program, ...args] = tokens;
		// Flags are not paths; `--` is filtered too because it also starts with `-`.
		const operands = args.filter((arg) => !arg.startsWith("-"));
		if (program === "mkdir" && args.includes("-p")) {
			created.push(...operands.map(absolute));
			continue;
		}
		if (!["cp", "install", "mv"].includes(program) || operands.length < 2) continue;
		const destination = operands[operands.length - 1];
		const source = operands[operands.length - 2];
		// A trailing slash marks "this is a directory", not part of the path: keep the entry
		// comparable with the grant it is excusing.
		const target = absolute(destination.replace(/\/+$/, "") || "/");
		created.push(target);
		if (destination.endsWith("/") || isDirectory(absolute(destination))) {
			created.push(join(target, basename(source)));
		}
	}
	return created;
}

const exists = (path) => {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
};

/** Parse the mise task names/aliases so a gate can be checked against a real task. */
export function knownMiseTasks(toml) {
	const names = [...toml.matchAll(/^\[tasks\.(?:"([^"]+)"|([A-Za-z0-9:_-]+))\]/gm)].map(
		(match) => match[1] ?? match[2],
	);
	const aliases = [...toml.matchAll(/^alias\s*=\s*\[(.*)\]/gm)].flatMap((match) =>
		[...match[1].matchAll(/"([^"]+)"/g)].map((alias) => alias[1]),
	);
	return new Set([...names, ...aliases]);
}

/**
 * Check every role md in `dir`.
 *
 * `miseToml` is optional: when it is absent the gate half still runs (allowlist), only the
 * "task exists" half is skipped.
 */
export function checkRoleDirs(dir, { miseToml, root = resolve(dir, "..", "..") } = {}) {
	const problems = [];
	const report = [];
	// Paths this machine cannot verify (another checkout's extension): reported, never fatal.
	const unverifiable = [];
	const knownTasks = miseToml ? knownMiseTasks(miseToml) : null;
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort();

	for (const file of files) {
		const path = join(dir, file);
		const text = readFileSync(path, "utf8");

		// --- loader paths: a missing one means the child runs unconfined while the dispatch succeeds
		//
		// A role md may legitimately point outside its own repo (pi-wake lists this repo's loader), so an
		// absolute path is not portable and cannot be verified in a fresh checkout. Verify what the machine
		// running the check can verify: anything inside this repo must exist, anything outside is checked
		// only when its directory exists here — otherwise the CI answer would be "every path is missing".
		for (const entry of loaderEntries(text)) {
			const resolved = isAbsolute(entry) ? entry : resolve(root, entry);
			const inside = resolved === root || resolved.startsWith(root + sep);
			if (!inside && !exists(dirname(resolved))) {
				unverifiable.push(`${path}: ${entry}`);
				continue;
			}
			if (!exists(resolved)) {
				problems.push(
					`${path}: subagentOnlyExtensions names ${entry}, which does not exist — the role would load no confinement at all`,
				);
			}
		}

		// --- write grants
		// Grants are matched against the *session* cwd, which is the repo this md belongs to — not the
		// cwd of whoever runs this checker. Everything below resolves against `root` for that reason.
		const entries = writeEntries(text);
		if (entries.length > 0) {
			// `preExec` runs unsandboxed at session start, which is the only way a role can create a path
			// the sandbox would otherwise have to grant first. Excuse only the exact paths the command
			// creates: a path merely mentioned in it (or sitting under a directory it creates) can still
			// be dead, which is exactly what this check exists to catch.
			const preExec = (text.match(/^\s+preExec:[ \t]*(.+)$/m) ?? [])[1] ?? "";
			const absolute = entries.map((entry) => (isAbsolute(entry) ? entry : resolve(root, entry)));
			const created = createdPaths(preExec, root);
			const orphaned = entries.filter((_, index) => {
				if (exists(absolute[index])) return false;
				return !created.includes(absolute[index]);
			});
			if (orphaned.length > 0) problems.push(`${path}: ${orphaned.join(", ")}`);
			report.push(
				`${path}: ${entries.length} entries, ${orphaned.length} dead` +
					(preExec ? " (preExec present)" : ""),
			);
		}

		// --- deny floor
		if (/^\s+bash:/m.test(text)) {
			const denied = denyEntries(text);
			const absent = REQUIRED_DENY.filter((entry) => !denied.includes(entry));
			if (absent.length > 0) problems.push(`${path}: deny list is missing ${absent.join(", ")}`);
		}

		// --- gate commands named in fenced blocks must be runnable by the same file's allow list
		// Only the fenced blocks count — those are the gates — because prose legitimately names
		// commands the role is not supposed to run (a neighbour md says which task covers a suite that
		// runs elsewhere).
		const allow = allowEntries(text);
		if (!allow) continue;
		const gates = [...text.matchAll(/```[\s\S]*?```/g)].flatMap((fence) =>
			[...fence[0].matchAll(/mise run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]),
		);
		const unique = [...new Set(gates)];
		const refused = unique.filter((task) => !allows(allow, `mise run ${task}`));
		const unknown = knownTasks ? unique.filter((task) => !knownTasks.has(task)) : [];
		if (refused.length > 0) {
			problems.push(
				`${path}: the gate names ${refused.map((task) => `mise run ${task}`).join(", ")} but bash.allow does not — the role would refuse its own acceptance command`,
			);
		}
		if (unknown.length > 0) {
			problems.push(`${path}: the gate names unknown mise task(s) ${unknown.join(", ")}`);
		}
	}

	return { report, problems, unverifiable };
}

function main() {
	const dir = process.argv[2] ?? ".pi/agents";
	// Everything resolves against the repo the role mds belong to, so `mise run check:grants` can point
	// at another checkout and still read that checkout's task table.
	const root = resolve(dir, "..", "..");
	let miseToml;
	try {
		miseToml = readFileSync(join(root, "mise.toml"), "utf8");
	} catch {
		// No task table in this checkout: the allowlist half still runs, the existence half is skipped.
		miseToml = undefined;
	}

	const { report, problems, unverifiable } = checkRoleDirs(dir, { miseToml });
	for (const line of report) console.log(line);
	// Silent skipping is how a check rots: say which paths this checkout could not verify.
	if (unverifiable.length > 0) {
		console.log(
			`\n${unverifiable.length} loader path(s) outside this checkout, not verified here:\n${unverifiable.join("\n")}`,
		);
	}

	if (problems.length > 0) {
		console.error(
			`\n${problems.length} role md problem(s) — a dead write grant refuses every write, a missing deny entry lets the role commit or push:\n${problems.join("\n")}`,
		);
		process.exit(1);
	}
	console.log("\nrole config: every write grant is reachable, every deny list complete");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
