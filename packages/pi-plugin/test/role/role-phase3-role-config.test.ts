// Phase 3a role-config module tests: the four extend blocks and role identity resolution.
// Cases build temporary role md files under os.tmpdir(); nothing is written to the checkout.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url);
const src = (name: string): string => pathToFileURL(join(here.pathname, "..", "..", "src", name)).href;

const { worktreeFromBlock, setupFromBlock, outputFromBlock, policyFromBlock, resolveRoleFromPrompt } =
  (await import(src("role-config.ts"))) as typeof import("../../src/role-config.ts");

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ok   ${label}`);
}

function temp(label: string): string {
  return join(tmpdir(), `pi-subagents-extend-p3-${label}-${process.pid}-${(Math.random() * 1e6) | 0}`);
}


console.log("pi-subagents-extend role phase 3a role-config module");

// 12. All three blocks convert, with nodeModules defaulting to keep inside an existing block.
{
  const out = worktreeFromBlock({ worktree: { enabled: true } });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.worktree, { enabled: true, nodeModules: "keep" });
  assert.deepEqual(setupFromBlock({ setup: { preExec: "echo hi" } }).setup, { preExec: "echo hi" });
  assert.deepEqual(outputFromBlock({ output: { deliverable: "notes/out.md" } }).output, { deliverable: "notes/out.md" });
  const explicit = worktreeFromBlock({ worktree: { enabled: false, nodeModules: "remove" } });
  assert.deepEqual(explicit.worktree, { enabled: false, nodeModules: "remove" });
  ok("worktree, setup and output blocks convert with the nodeModules default");
}

// 13. Unknown keys and bad values are reported by block and omitted.
{
  const worktree = worktreeFromBlock({ worktree: { enabled: "yes", nodeModules: "delete", mystery: 1 } });
  assert.ok(worktree.problems.some((p) => p.includes("worktree.enabled")));
  assert.ok(worktree.problems.some((p) => p.includes("worktree.nodeModules")));
  assert.ok(worktree.problems.some((p) => p.includes("worktree.mystery")));
  assert.equal(worktree.worktree?.enabled, undefined);
  assert.equal(worktree.worktree?.nodeModules, "keep");
  const setup = setupFromBlock({ setup: { preExec: 7, extra: true } });
  assert.ok(setup.problems.some((p) => p.includes("setup.preExec")));
  assert.ok(setup.problems.some((p) => p.includes("setup.extra")));
  assert.equal(setup.setup?.preExec, undefined);
  const output = outputFromBlock({ output: { deliverable: "../escape.md", extra: true } });
  assert.ok(output.problems.some((p) => p.includes("output.deliverable")));
  assert.ok(output.problems.some((p) => p.includes("output.extra")));
  assert.equal(output.output?.deliverable, undefined);
  ok("bad keys are reported with their block name and omitted");
}

// 14. An absent block means do not intervene; a present empty block is still a block.
{
  const absent = {
    worktree: worktreeFromBlock({}),
    setup: setupFromBlock({}),
    output: outputFromBlock({}),
  };
  assert.deepEqual(absent.worktree.worktree, undefined);
  assert.deepEqual(absent.setup.setup, undefined);
  assert.deepEqual(absent.output.output, undefined);
  assert.deepEqual([absent.worktree.problems, absent.setup.problems, absent.output.problems], [[], [], []]);
  const empty = {
    worktree: worktreeFromBlock({ worktree: {} }),
    setup: setupFromBlock({ setup: {} }),
    output: outputFromBlock({ output: {} }),
  };
  assert.deepEqual(empty.worktree.worktree, { nodeModules: "keep" });
  assert.deepEqual(empty.setup.setup, {});
  assert.deepEqual(empty.output.output, {});
  ok("absent blocks stay absent; present empty blocks parse to empty configs");
}

// 15. A malformed or unknown top-level block is reported, and wired blocks are silent.
{
  assert.ok(worktreeFromBlock({ worktree: true }).problems.some((p) => p.includes("worktree must be an object")));
  assert.ok(setupFromBlock({ setup: [] }).problems.some((p) => p.includes("setup must be an object")));
  assert.ok(outputFromBlock({ output: "x" }).problems.some((p) => p.includes("output must be an object")));
  const wired = policyFromBlock({ spooky: {}, worktree: {}, setup: {}, output: {} });
  assert.deepEqual(wired.problems, ["spooky: unknown block"]);
  ok("unknown block names are reported and the three wired blocks are silent");
}

// 30. A <active_agent> tag wins even when another md's body is also in the prompt.
{
  const dir = temp("resolve-tag");
  try {
    const home = join(dir, "home");
    const agentDir = join(home, ".agents");
    mkdirSync(agentDir, { recursive: true });
    const alphaBody = "ALPHA UNIQUE BODY MARKER for role identity tests with enough text to fill a probe beyond one hundred and twenty characters of distinctive content";
    const betaBody = "BETA DISTINCT BODY MARKER that also appears in the prompt but must not win over the tag for role identity resolution";
    writeFileSync(join(agentDir, "alpha.md"), `---\nextend:\n  permissions:\n    scope: ["a/**"]\n---\n${alphaBody}\n`);
    writeFileSync(join(agentDir, "beta.md"), `---\nextend:\n  permissions:\n    scope: ["b/**"]\n---\n${betaBody}\n`);
    const prompt = `rewritten prompt\n${betaBody}\n<active_agent name="alpha"/>\n`;
    const result = resolveRoleFromPrompt(prompt, dir, home);
    assert.equal(result.role, "alpha", "the tag wins over a body match");
    assert.deepEqual(result.warnings, []);
    ok("resolver: a tag wins even when another md's body is in the prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 31. No tag + one body match resolves that role; whitespace differences are normalised away.
{
  const dir = temp("resolve-one");
  try {
    const home = join(dir, "home");
    const agentDir = join(home, ".agents");
    mkdirSync(agentDir, { recursive: true });
    const body = "SOLO DISTINCT BODY MARKER followed by enough unique prose that the probe stays stable across whitespace changes in both the prompt and the md file itself";
    writeFileSync(join(agentDir, "solo.md"), `---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n${body}\n`);
    const prompt = `rewritten prompt\n\n${body.replace(/ /g, "   ")}\n\ntail`;
    const result = resolveRoleFromPrompt(prompt, dir, home);
    assert.equal(result.role, "solo");
    assert.deepEqual(result.warnings, []);
    ok("resolver: one body match resolves the role across whitespace differences");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 32. Two md files with the same body are ambiguous: null plus a warning naming both.
{
  const dir = temp("resolve-ambiguous");
  try {
    const home = join(dir, "home");
    const agentDir = join(home, ".agents");
    mkdirSync(agentDir, { recursive: true });
    const body = "IDENTICAL SHARED BODY MARKER used by two role files so a body match cannot tell them apart and must report ambiguity instead of guessing";
    writeFileSync(join(agentDir, "alpha.md"), `---\nextend:\n  permissions:\n    scope: ["a/**"]\n---\n${body}\n`);
    writeFileSync(join(agentDir, "beta.md"), `---\nextend:\n  permissions:\n    scope: ["b/**"]\n---\n${body}\n`);
    const result = resolveRoleFromPrompt(`prompt\n${body}\n`, dir, home);
    assert.equal(result.role, null, "ambiguity must not pick a role");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /more than one role md/i);
    assert.match(result.warnings[0], /alpha \(/);
    assert.match(result.warnings[0], /beta \(/);
    ok("resolver: two identical bodies are ambiguous and name both candidates");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 33. No tag and no body match: null, no ambiguity warning, but extendMdSeen is reported.
{
  const dir = temp("resolve-nomatch");
  try {
    const home = join(dir, "home");
    const agentDir = join(home, ".agents");
    mkdirSync(agentDir, { recursive: true });
    const body = "UNRELATED ROLE BODY that is not present in the child prompt at all and must not be matched";
    writeFileSync(join(agentDir, "decoy.md"), `---\nextend:\n  permissions:\n    scope: ["x/**"]\n---\n${body}\n`);
    const result = resolveRoleFromPrompt("a completely unrelated rewritten prompt with no role body", dir, home);
    assert.equal(result.role, null);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.extendMdSeen, true, "the md declares extend, so the caller can explain the missing tag");
    ok("resolver: no tag and no body match yields no role but reports the extend md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


console.log(`\npi-subagents-extend role phase 3a role-config tests passed (${passed} cases)`);
