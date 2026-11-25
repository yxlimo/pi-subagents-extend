// Phase 3a wiring tests: how the deliverable, worktree and preExec modules connect to a session.
// Cases construct their own repositories under os.tmpdir(); nothing is written to the checkout.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PromptOptions } from "../types.ts";
import { childRun } from "../harness.ts";

const here = new URL(".", import.meta.url);
const src = (name: string): string => pathToFileURL(join(here.pathname, "..", "..", "src", name)).href;

const { deliverableTarget } =
  (await import(src("deliverable.ts"))) as typeof import("../../src/deliverable.ts");
const { wireDeliverable, sandboxWritableDirs, wireWorktree, wirePreExec, nodeModulesWriteHint } =
  (await import(src("index.ts"))) as typeof import("../../src/index.ts");

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ok   ${label}`);
}

function temp(label: string): string {
  return join(tmpdir(), `pi-subagents-extend-p3-${label}-${process.pid}-${(Math.random() * 1e6) | 0}`);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repoWithWorktree(dir: string): { main: string; worktree: string } {
  const main = join(dir, "main");
  const worktree = join(dir, "child");
  mkdirSync(main, { recursive: true });
  git(["init", "-q"], main);
  writeFileSync(join(main, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], main);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"], main);
  git(["worktree", "add", "-q", "-b", "phase3", worktree], main);
  return { main, worktree };
}

console.log("pi-subagents-extend role phase 3a wiring");

// 16. deliverable in the main checkout still gets the file grant even though no link is needed.
{
  const dir = temp("wire-same");
  try {
    mkdirSync(dir, { recursive: true });
    const policy = { absoluteWrite: [] as string[] };
    const warnings: string[] = [];
    const result = wireDeliverable(dir, { output: { deliverable: "notes/out.md" } }, policy, (m) => warnings.push(m));
    const target = deliverableTarget(dir, "notes/out.md");
    assert.equal(result.link?.action, "none");
    assert.equal(result.target, target);
    assert.ok(policy.absoluteWrite.includes(target), "the real file is granted even with no link");
    assert.deepEqual(warnings, []);
    assert.equal(result.deliverable, "notes/out.md", "the short path comes back for the scope section");
    ok("phase 3 wiring: same-directory deliverable is granted and the short path is returned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 17. A linked worktree gets a symlink to the main file; only the file, never its parent, is writable.
{
  const dir = temp("wire-worktree");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const policy = { absoluteWrite: [] as string[] };
    const result = wireDeliverable(worktree, { output: { deliverable: "notes/out.md" } }, policy, () => {});
    const target = deliverableTarget(main, "notes/out.md");
    assert.equal(result.link?.action, "created");
    assert.equal(result.link?.linkPath, join(worktree, "notes", "out.md"));
    assert.equal(readlinkSync(result.link!.linkPath), target);
    assert.ok(policy.absoluteWrite.includes(target));
    assert.ok(!policy.absoluteWrite.includes(dirname(target)), "the parent directory is not a write grant");
    const writable = sandboxWritableDirs(
      { writeGlobs: [] } as never,
      worktree,
      { scratchPaths: [], writablePaths: [] } as never,
    );
    assert.ok(writable.includes(target), "bash can write the deliverable file");
    assert.ok(!writable.includes(dirname(target)), "bash cannot write the parent directory");
    assert.equal(result.deliverable, "notes/out.md", "the short path comes back for the scope section");
    ok("phase 3 wiring: worktree symlink points at the main file; only the file is granted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 18. readOnly never suppresses the single deliverable grant.
{
  const dir = temp("wire-readonly");
  try {
    mkdirSync(dir, { recursive: true });
    const policy = { readOnly: true, absoluteWrite: [] as string[] };
    wireDeliverable(dir, { output: { deliverable: "report.md" } }, policy, () => {});
    assert.deepEqual(policy.absoluteWrite, [deliverableTarget(dir, "report.md")]);
    ok("phase 3 wiring: readOnly still grants exactly the deliverable file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 19. A file cannot anchor a main repo: no link, no grant, and the warning names what was tried.
{
  const dir = temp("wire-no-anchor");
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "not-a-directory.txt");
    writeFileSync(file, "seed\n");
    const policy = { absoluteWrite: [] as string[] };
    const warnings: string[] = [];
    const result = wireDeliverable(file, { output: { deliverable: "out.md" } }, policy, (m) => warnings.push(m));
    assert.equal(result.link, undefined);
    assert.deepEqual(policy.absoluteWrite, []);
    assert.ok(warnings.some((m) => m.includes(file) && m.includes("not a directory")), warnings.join("\n"));
    ok("phase 3 wiring: a file cwd reports the tried anchor and grants nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// 20. setup.preExec runs the configured command in the child cwd and reports its result.
{
  const dir = temp("preexec-ok");
  try {
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, "marker.txt");
    const result = await wirePreExec(dir, { setup: { preExec: `printf "ran\\n" >> ${marker}` } }, () => {});
    assert.equal(result.ran, true);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(marker, "utf8"), "ran\n");
    ok("phase 3 wiring: preExec runs its command in the child cwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 21. A failing preExec reports the exit code and a bounded tail, without throwing.
{
  const dir = temp("preexec-fail");
  const warnings: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    const result = await wirePreExec(dir, { setup: { preExec: "seq 1 1000 >&2; printf 'boom\\n' >&2; exit 7" } }, (m) => warnings.push(m));
    assert.equal(result.ran, true, "the child still proceeds");
    assert.equal(result.status, 7);
    const text = warnings.join("\n");
    assert.match(text, /setup\.preExec exited with code 7/);
    assert.match(text, /boom/, "the tail is included");
    assert.ok(!text.includes("1\n2\n3\n"), "only the tail is reported");
    assert.ok(text.length < 2600, `the report is bounded, got ${text.length}`);
    ok("phase 3 wiring: a failing preExec reports the code and a bounded tail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 22. worktree.nodeModules: remove unlinks only the link; the target survives.
{
  const dir = temp("worktree-remove");
  const warnings: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "deps", "shared");
    mkdirSync(target, { recursive: true });
    const link = join(dir, "node_modules");
    symlinkSync(target, link, "dir");
    assert.equal(wireWorktree(dir, { worktree: { nodeModules: "remove" } }, (m) => warnings.push(m)).action, "removed");
    assert.equal(existsSync(link), false, "the link is gone");
    assert.equal(statSync(target).isDirectory(), true, "the target is untouched");
    assert.ok(warnings.some((m) => m.includes(target)), warnings.join("\n"));
    ok("phase 3 wiring: nodeModules remove unlinks the link and keeps the target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 23. A real directory and a link outside the main checkout are both left alone, with a warning.
{
  const dir = temp("worktree-keep");
  const warnings: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    const real = join(dir, "node_modules");
    mkdirSync(real, { recursive: true });
    assert.equal(wireWorktree(dir, { worktree: { nodeModules: "remove" } }, (m) => warnings.push(m)).action, "skipped");
    assert.equal(statSync(real).isDirectory(), true);
    assert.ok(warnings.some((m) => m.includes("real directory")), warnings.join("\n"));

    rmSync(real, { recursive: true, force: true });
    const elsewhere = temp("worktree-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    try {
      symlinkSync(elsewhere, real, "dir");
      assert.equal(wireWorktree(dir, { worktree: { nodeModules: "remove" } }, (m) => warnings.push(m)).action, "skipped");
      assert.equal(readlinkSync(real), elsewhere, "an out-of-checkout link stays");
      assert.ok(warnings.some((m) => m.includes("outside the main checkout")), warnings.join("\n"));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }

    rmSync(real, { recursive: true, force: true });
    const target = join(dir, "deps", "shared");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, real, "dir");
    wireWorktree(dir, { worktree: { nodeModules: "keep" } }, () => {});
    const inLink = nodeModulesWriteHint(dir, join(real, "pkg", "x.js"));
    assert.match(inLink, /worktree\.nodeModules: remove/, "keep hints at the fix");
    assert.equal(nodeModulesWriteHint(dir, join(dir, "src", "x.js")), "", "unrelated paths get no hint");
    wireWorktree(dir, { worktree: { nodeModules: "remove" } }, () => {});
    assert.equal(nodeModulesWriteHint(dir, join(real, "pkg", "x.js")), "", "no false hint after removal");
    ok("phase 3 wiring: unsafe targets are kept and the hint only appears for keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// 24. A directory at the deliverable path must never become a write grant (P0-a).
{
  const dir = temp("wire-directory");
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    const target = deliverableTarget(dir, "dist");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "keep\n");
    const policy = { writeGlobs: ["src"], absoluteWrite: [] as string[] };
    const warnings: string[] = [];
    const result = wireDeliverable(dir, { output: { deliverable: "dist" } }, policy, (m) => warnings.push(m));
    assert.deepEqual(policy.absoluteWrite, [], "a directory gets no write grant");
    assert.equal(result.deliverable, undefined, "a refused deliverable is not announced to the child");
    const writable = sandboxWritableDirs(
      policy as never,
      dir,
      { scratchPaths: [], writablePaths: [] } as never,
    );
    assert.ok(!writable.includes(target), "no sandbox entry for the directory");
    assert.ok(writable.includes(join(dir, "src")), "the task still has a write grant elsewhere");
    assert.ok(warnings.some((m) => m.includes(target) && m.includes("not a regular file")), warnings.join("\n"));
    assert.equal(result.target, target);
    ok("phase 3 wiring: a directory deliverable is refused with no grant or sandbox entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 25. A symlink at the deliverable path must not redirect the grant outside the checkout (P0-b).
{
  const dir = temp("wire-symlink");
  const outside = temp("wire-outside");
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const dangling = deliverableTarget(dir, "leak.txt");
    const outsideFile = join(outside, "secret.txt");
    symlinkSync(outsideFile, dangling, "file");
    const policy = { absoluteWrite: [] as string[] };
    const warnings: string[] = [];
    wireDeliverable(dir, { output: { deliverable: "leak.txt" } }, policy, (m) => warnings.push(m));
    assert.deepEqual(policy.absoluteWrite, [], "a link gets no write grant");
    assert.equal(existsSync(outsideFile), false, "the outside file was not created");
    assert.equal(lstatSync(dangling).isSymbolicLink(), true, "the link is left untouched");
    assert.ok(warnings.some((m) => m.includes(dangling) && m.includes("not a regular file")), warnings.join("\n"));

    // An existing outside file must also keep its bytes.
    const present = deliverableTarget(dir, "leak2.txt");
    const existing = join(outside, "existing.txt");
    writeFileSync(existing, "original\n");
    symlinkSync(existing, present, "file");
    const policy2 = { absoluteWrite: [] as string[] };
    wireDeliverable(dir, { output: { deliverable: "leak2.txt" } }, policy2, () => {});
    assert.deepEqual(policy2.absoluteWrite, [], "a link to an existing file gets no grant");
    assert.equal(readFileSync(existing, "utf8"), "original\n", "the outside file was not modified");
    ok("phase 3 wiring: a linked deliverable is refused and the outside file is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// 27 (case A / P0). A symlinked parent inside the main checkout must not move the grant — or the file — outside it.
{
  const dir = temp("wire-parent-symlink");
  const outside = temp("wire-parent-outside");
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(dir, ".pi"), "dir");
    const deliverable = ".pi/reports/review.md";
    const requested = deliverableTarget(dir, deliverable);
    const resolved = join(realpathSync(outside), "reports", "review.md");
    const policy = { absoluteWrite: [] as string[] };
    const warnings: string[] = [];
    const result = wireDeliverable(dir, { output: { deliverable } }, policy, (m) => warnings.push(m));
    assert.deepEqual(policy.absoluteWrite, [], "a parent symlink must not grant an outside file");
    assert.equal(result.deliverable, undefined, "a refused deliverable is not announced to the child");
    assert.equal(existsSync(resolved), false, "the outside file was never created");
    assert.equal(result.target, requested);
    assert.ok(warnings.some((m) => m.includes(deliverable) && m.includes(resolved)), warnings.join("\n"));
    ok("phase 3 wiring: a symlinked parent is refused before creating the outside file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// 28 (case B). A legitimate deliverable inside the main checkout keeps its grant even when cwd is a worktree.
{
  const dir = temp("wire-boundary-main");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const deliverable = "reports/review.md";
    const target = deliverableTarget(main, deliverable);
    const policy = { absoluteWrite: [] as string[] };
    const warnings: string[] = [];
    const result = wireDeliverable(worktree, { output: { deliverable } }, policy, (m) => warnings.push(m));
    assert.deepEqual(policy.absoluteWrite, [target], "the main-checkout file keeps its grant");
    assert.equal(result.target, target);
    assert.ok(existsSync(target), "the deliverable file was created in the main checkout");
    assert.ok(!warnings.some((m) => m.includes("outside the main checkout")), warnings.join("\n"));
    ok("phase 3 wiring: a legitimate main-checkout deliverable is not refused by the boundary check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// 29 (P2-1). The preExec timeout must not hold the event loop open: a ref'd 600s timer
// would keep a session alive for ten minutes if it ended while preExec still ran.
{
  const dir = temp("wire-timer-unref");
  try {
    const original = globalThis.setTimeout;
    const captured: ReturnType<typeof setTimeout>[] = [];
    globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
      const handle = original(handler, timeout);
      if (timeout === 600_000) captured.push(handle);
      return handle;
    }) as typeof globalThis.setTimeout;
    try {
      await wirePreExec(dir, { setup: { preExec: `printf "ran\\n" >> ${join(dir, "marker.txt")}` } }, () => {});
    } finally {
      globalThis.setTimeout = original;
    }
    assert.equal(captured.length, 1, "the 600s timeout was installed");
    assert.equal(captured[0].hasRef?.(), false, "the timeout is unref'd so it cannot keep the session alive");
    ok("phase 3 wiring: the preExec timeout is unref'd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 34. The scope section must use a pi-valid name and still carry both paths.
{
  const dir = temp("wire-section-name");
  try {
    const proj = join(dir, "main");
    const home = join(dir, "home");
    mkdirSync(join(proj, ".pi", "agents"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(proj, ".pi", "agents", "section-name.md"),
      '---\nextend:\n  permissions:\n    scope: ["."]\n  output:\n    deliverable: notes/out.md\n---\n# section-name\n',
    );
    const options: PromptOptions = {};
    const run = await childRun({
      cwd: proj,
      home,
      systemPrompt: '<active_agent name="section-name"/>\nhello',
      systemPromptOptions: options,
    });
    try {
      const keys = Object.keys(options.sections ?? {});
      assert.deepEqual(keys, ["pi_subagents_extend_scope"], "the scope section is stored under one pi-valid name");
      for (const key of keys) {
        assert.match(key, /^[A-Za-z][A-Za-z0-9_]*$/, "pi rejects section names containing ':' or '-'");
      }
      const section = (options.sections as unknown as Record<string, string> | undefined)?.pi_subagents_extend_scope ?? "";
      assert.ok(section.includes("`notes/out.md`"), "the short deliverable path is named");
      const target = deliverableTarget(proj, "notes/out.md");
      assert.ok(section.includes(`the parent reads it at \`${target}\`.`), "the absolute target is named");
      ok("phase 3 wiring: scope section has a pi-valid name and names both the short path and absolute target");
    } finally {
      run.restore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\npi-subagents-extend role phase 3a wiring tests passed (${passed} cases)`);
