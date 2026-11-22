#!/usr/bin/env node
// Every `extend.permissions.write` entry in a role md is matched against the session cwd, so a
// typo does not fail loudly — it produces a role that refuses all writes while looking exactly
// like a working boundary. That happened three times here: a missing `packages/pi-plugin/` prefix,
// `SKILL.md` at a path that does not exist, and a scratch directory one level short.
//
// So: an entry that does not exist is only legitimate if the role's `setup.preExec` creates it.
// Anything else is a dead grant, and a role whose only grants are dead cannot write at all.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const dir = process.argv[2] ?? ".pi/agents";
const exists = (p) => {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
};
const isDirectory = (path) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

// Pull a block scalar or flow list out of the YAML frontmatter without a parser: these files are
// hand-written, the shape is fixed, and a dependency would have to be installed to run a check
// that guards a config typo.
function writeEntries(text) {
	const block = text.match(/^[ \t]*write:[ \t]*\n((?:[ \t]+-[ \t]+.*\n)+)/m);
	if (block) {
		return block[1]
			.split("\n")
			.map((line) => line.replace(/^[ \t]*-[ \t]*/, "").trim())
			.filter(Boolean)
			.map((entry) => entry.replace(/^["']|["']$/g, ""));
	}
	const flow = text.match(/^[ \t]*write:[ \t]*\[(.*)\]/m);
	if (!flow) return [];
	return flow[1]
		.split(",")
		.map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

// Approximate the creation shapes role mds actually use: `mkdir -p <dir>` creates that directory,
// and a copy/move into a directory creates one file named after its source there. Redirections,
// loops and globs are deliberately not modelled — reporting a reachable grant as unreachable is
// safer than hiding a dead one.
function createdPaths(preExec) {
	const created = [];
	for (const command of preExec.split(/\s*(?:&&|;)\s*/)) {
		const tokens =
			command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) ?? [];
		const [program, ...args] = tokens;
		// Flags are not paths; `--` is filtered too because it also starts with `-`.
		const operands = args.filter((arg) => !arg.startsWith("-"));
		if (program === "mkdir" && args.includes("-p")) {
			created.push(...operands);
			continue;
		}
		if (!["cp", "install", "mv"].includes(program) || operands.length < 2) continue;
		const destination = operands[operands.length - 1];
		const source = operands[operands.length - 2];
		created.push(destination);
		if (destination.endsWith("/") || isDirectory(destination)) {
			created.push(join(destination, basename(source)));
		}
	}
	return created;
}

const problems = [];
const report = [];
for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
	const path = join(dir, file);
	const text = readFileSync(path, "utf8");
	const entries = writeEntries(text);
	if (entries.length === 0) continue;
	// `preExec` runs unsandboxed at session start, which is the only way a role can create a path
	// the sandbox would otherwise have to grant first. Excuse only the exact paths the command
	// creates: a path merely mentioned in it (or sitting under a directory it creates) can still
	// be dead, which is exactly what this check exists to catch.
	const preExec = (text.match(/^\s+preExec:[ \t]*(.+)$/m) ?? [])[1] ?? "";
	const missing = entries.filter((entry) => !exists(entry));
	const created = createdPaths(preExec);
	const orphaned = missing.filter((entry) => !created.includes(entry));
	if (orphaned.length > 0) {
		problems.push(`${path}: ${orphaned.join(", ")}`);
	}
	report.push(
		`${path}: ${entries.length} entries, ${missing.length} created at session start` +
			(preExec ? " (preExec present)" : ""),
	);
}
// There is no project-wide floor any more: the bindings file that used to supply `git commit`,
// `git push` and the rest to every role is gone, so a role md that omits the deny list simply has
// none. A subagent that can commit and push is the exact failure the floor used to prevent, and
// nothing else would notice — so the omission is an error here.
const REQUIRED_DENY = [
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

for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
	const path = join(dir, file);
	const text = readFileSync(path, "utf8");
	if (!/^\s+bash:/m.test(text)) continue;
	const block = text.match(/^[ \t]*deny:[ \t]*\n((?:[ \t]+-[ \t]+.*\n)+)/m);
	const denied = block
		? block[1]
				.split("\n")
				.map((value) => value.replace(/^[ \t]*-[ \t]*/, "").trim())
				.filter(Boolean)
		: [];
	const absent = REQUIRED_DENY.filter((entry) => !denied.includes(entry));
	if (absent.length > 0) {
		problems.push(`${path}: deny list is missing ${absent.join(", ")}`);
	}
}

// A role md that tells the subagent to run a gate it is not allowed to run is worse than no gate
// at all: the child spends calls on the refusal and the contradiction reads like a sandbox bug.
// Both halves live in the same file, so the file can be checked against itself. Only the fenced
// blocks count — those are the gates — because prose legitimately names commands the role is not
// supposed to run (a neighbour md says which task covers a suite that runs elsewhere).
const MISE_TOML = "mise.toml";
let knownTasks = null;
try {
	const toml = readFileSync(MISE_TOML, "utf8");
	const names = [...toml.matchAll(/^\[tasks\.(?:"([^"]+)"|([A-Za-z0-9:_-]+))\]/gm)].map(
		(match) => match[1] ?? match[2],
	);
	const aliases = [...toml.matchAll(/^alias\s*=\s*\[(.*)\]/gm)].flatMap((match) =>
		[...match[1].matchAll(/"([^"]+)"/g)].map((alias) => alias[1]),
	);
	knownTasks = new Set([...names, ...aliases]);
} catch {
	// No task table in this checkout: the allowlist half still runs, the existence half is skipped.
}

// The allow list is hand-written YAML with comments between entries. Matching "the first run of
// `- ` lines" stops at the first comment and drops everything after it — when this check was first
// written that reported two working gates as refused. Read by indentation to the end of the block.
function allowEntries(text) {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^[ \t]*allow:[ \t]*$/.test(line));
	if (start === -1) return null;
	const indent = lines[start].search(/\S/);
	const entries = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.trim()) continue;
		if (line.search(/\S/) <= indent) break;
		const item = line.match(/^[ \t]*-[ \t]+(.*)$/);
		if (item) entries.push(item[1].trim());
	}
	return entries;
}

// The evaluator treats an entry beginning `re:` as a pattern, so a literal comparison here would
// report every command covered by a pattern as refused.
function allows(entries, command) {
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

for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
	const path = join(dir, file);
	const text = readFileSync(path, "utf8");
	const entries = allowEntries(text);
	if (!entries) continue;
	const gates = [...text.matchAll(/```[\s\S]*?```/g)].flatMap((fence) =>
		[...fence[0].matchAll(/mise run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]),
	);
	const unique = [...new Set(gates)];
	const refused = unique.filter((task) => !allows(entries, `mise run ${task}`));
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


for (const line of report) console.log(line);

if (problems.length > 0) {
	console.error(
		`\n${problems.length} role md problem(s) — a dead write grant refuses every write, and a missing deny entry lets the role commit or push:\n${problems.join("\n")}`,
	);
	process.exit(1);
}
console.log("\nrole config: every write grant is reachable, every deny list complete");
