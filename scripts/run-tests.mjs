#!/usr/bin/env node
// Run every extension suite under `packages/pi-plugin/test`.
//
// This exists because the list it replaces went stale silently: `pnpm test` kept naming
// `node test/policy.test.ts` and friends for weeks after the suites moved into per-area
// directories, so the package's own test command failed on the first missing path while
// every `mise run test:<area>` stayed green. A hand-maintained list will rot again; walking
// the tree cannot.
//
// Excluded, deliberately:
//   `e2e-*.test.ts`   long real-session suites (they spawn pi and need the helper binary).
//                     `mise run test:e2e` owns them, and CI runs them nowhere.
//   `e2e.test.ts`     the real-model suite: needs a provider credential, stays manual.
//
// Both exclusions are by *name pattern*, not by path list, so moving a suite between areas
// never changes what runs here.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TEST_DIR = join(ROOT, "packages", "pi-plugin", "test");

function collect(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			// `fixtures` holds data, not suites; a fixture directory with a `.test.ts` in it would be a
			// surprise, but walking it costs nothing and keeps the rule simple.
			files.push(...collect(path));
			continue;
		}
		if (!entry.name.endsWith(".test.ts")) continue;
		if (entry.name === "e2e.test.ts") continue;
		if (entry.name.startsWith("e2e-")) continue;
		files.push(path);
	}
	return files;
}

const suites = collect(TEST_DIR).sort();
if (suites.length === 0) {
	console.error(`no suites found under ${TEST_DIR}`);
	process.exit(1);
}

const failures = [];
const started = Date.now();
for (const file of suites) {
	const name = relative(ROOT, file);
	const result = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8" });
	const ok = result.status === 0;
	// The suites print their own case counts; relay the last line so the log stays readable and a
	// suite that suddenly runs zero cases is visible next to it.
	const last = `${result.stdout ?? ""}`.trim().split("\n").filter(Boolean).at(-1) ?? "";
	console.log(`${ok ? "ok  " : "FAIL"} ${name} — ${last}`);
	if (!ok) {
		failures.push({ name, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
	}
}

for (const failure of failures) {
	console.error(`\n===== ${failure.name} failed\n`);
	if (failure.stdout) console.error(failure.stdout);
	if (failure.stderr) console.error(failure.stderr);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length > 0) {
	console.error(`\n${failures.length} of ${suites.length} suites failed (${seconds}s)`);
	process.exit(1);
}
console.log(`\nall ${suites.length} suites passed (${seconds}s)`);
