#!/usr/bin/env node
// Verify a published install the way a user gets it: `pi install npm:pi-subagents-extend@<version>` into
// an empty agent dir, then check what actually landed there.
//
// Why this exists: every bug this guards against was invisible from the checkout. The tarball once
// shipped a helper under a name the resolver no longer looked for, the src someone imported was not the
// src in the tarball, and the tests always ran against the working tree. Verification has to happen on
// the installed copy, pinned by exact version, so "it works here" means "it works from npm".
//
// Usage: node scripts/verify-install.mjs [--version <x.y.z>] [--keep]
// Needs network (npm registry) and the `pi` binary on PATH. Not a CI gate: CI cannot trust its own
// registry view immediately after a publish, and that is what the publish workflow's registry-check is for.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..", "packages", "pi-plugin");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const NAME = manifest.name;

const args = process.argv.slice(2);
const flag = (name) => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const version = flag("--version") ?? manifest.version;
const keep = args.includes("--keep");

const failures = [];
const fail = (message) => {
	failures.push(message);
	console.log(`  ✗ ${message}`);
};
const pass = (message) => console.log(`  ✓ ${message}`);

const note = (message) => console.log(`  · ${message}`);

/**
 * Whether this checkout sits exactly on the tag it is verifying. The shipped-src comparison only means
 * something there: an ordinary working tree is ahead of the last release by definition, and calling that
 * drift a failure would make the check red every day until release day.
 */
function onTag(version) {
	const git = (...argv) => execFileSync("git", argv, { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		// `v<version>` is an annotated tag, so it has to be dereferenced: plain rev-parse returns the tag
		// object, which never equals a commit and would silently disable the comparison everywhere.
		return git("rev-parse", `v${version}^{commit}`) === git("rev-parse", "HEAD");
	} catch {
		return false;
	}
}
/** Every file under `dir` as a sorted { relativePath: sha256 } map — the cheapest way to compare trees. */
function hashTree(dir) {
	const out = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === "node_modules" || entry.name === "bin") continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			out.push(`${relative(dir, full)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
		}
	};
	walk(dir);
	return out.sort().join("\n");
}

const agentDir = mkdtempSync(join(os.tmpdir(), "verify-install-"));
console.log(`${NAME}@${version} → isolated agent dir ${agentDir}`);

try {
	execFileSync("pi", ["install", `npm:${NAME}@${version}`], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	pass(`pi install npm:${NAME}@${version}`);

	const installed = join(agentDir, "npm", "node_modules", NAME);
	if (!existsSync(installed)) {
		fail(`nothing installed at ${installed}`);
		throw new Error("install missing");
	}

	// 1. the version a user asked for is the version they got (a tag can move; the pin must not)
	const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
	if (installedManifest.version === version) pass(`installed version is ${version}`);
	else fail(`installed ${installedManifest.version}, asked for ${version}`);

	// 2. the settings entry names the exact package, so a later plain `pi update` cannot silently move it
	const settings = readFileSync(join(agentDir, "settings.json"), "utf8");
	if (settings.includes(`npm:${NAME}@${version}`)) pass("settings pins the exact version");
	else fail(`settings does not list npm:${NAME}@${version}`);

	// 3. what is imported is what was tested: the shipped src must equal this checkout's src
	const shipped = join(installed, "src");
	const local = join(packageDir, "src");
	const sameSrc = hashTree(shipped) === hashTree(local);
	if (!onTag(version)) {
		// A working tree ahead of the release: comparing it to the published tarball would report drift
		// every day. Say what was actually checked so nobody reads this line as approval.
		note(`checkout is not at v${version}; shipped src not compared${sameSrc ? "" : " (they do differ)"}`);
	} else if (sameSrc) {
		pass("shipped src matches this checkout byte for byte");
	} else {
		fail("shipped src differs from the tag — the release does not carry the code that was tested");
	}

	// 4. the sandbox helper ships for both platforms under the names the resolver looks for
	const binDir = join(installed, "bin");
	const expected = ["linux-x64", "linux-arm64"].map((pair) => `pi-subagents-extend-helper-${pair}`);
	if (!existsSync(binDir)) {
		fail("no bin/ directory in the tarball — every bash command would be refused");
	} else {
		const present = readdirSync(binDir);
		const missing = expected.filter((name) => !present.includes(name));
		if (missing.length === 0) pass(`helper binaries present: ${expected.join(", ")}`);
		else fail(`helper binaries missing: ${missing.join(", ")} (found ${present.join(", ") || "none"})`);

		// 5. the native one actually runs here: a binary built for another arch looks present and fails at use
		const native = `pi-subagents-extend-helper-${process.platform}-${process.arch}`;
		if (present.includes(native)) {
			try {
				const described = JSON.parse(execFileSync(join(binDir, native), ["--describe"], { encoding: "utf8" }));
				if (described.landlock?.supported === true && described.landlock?.kernel_abi >= described.landlock?.required_abi) {
					pass(`native helper runs: landlock ABI ${described.landlock.kernel_abi} ≥ ${described.landlock.required_abi}`);
				} else {
					fail(`native helper cannot enforce: ${JSON.stringify(described.landlock)}`);
				}
			} catch (error) {
				fail(`native helper ${native} did not run: ${error.message}`);
			}
		} else {
			fail(`no helper for this platform (${process.platform}-${process.arch}); found ${present.join(", ")}`);
		}
	}

	// 6. test material must not ship: a tarball that carries its own tests is bigger than it needs to be
	if (existsSync(join(installed, "test"))) fail("the tarball ships test/");
	else pass("no test/ in the tarball");
} catch (error) {
	fail(`install failed: ${error.message}`);
} finally {
	if (keep) console.log(`  kept ${agentDir}`);
	else rmSync(agentDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed for ${NAME}@${version}`);
	process.exit(1);
}
console.log(`\n${NAME}@${version}: installs, pins, ships the tested src and a working helper`);
