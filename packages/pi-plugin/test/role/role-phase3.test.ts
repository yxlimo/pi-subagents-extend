// Phase 3a deliverable module tests: main-repo anchoring and deliverable links.
// Git cases construct their own repositories under os.tmpdir(); nothing is written to the checkout.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url);
const src = (name: string): string => pathToFileURL(join(here.pathname, "..", "..", "src", name)).href;

const { mainRepoRoot, ensureDeliverableLink, deliverableTarget } =
  (await import(src("deliverable.ts"))) as typeof import("../../src/deliverable.ts");

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

console.log("pi-subagents-extend role phase 3a deliverable module");

// 1. Tier 1: a linked worktree's .git file points through commondir at the main repo.
{
  const dir = temp("anchor-common");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const anchor = mainRepoRoot(worktree);
    if (anchor.root === null) assert.fail("a linked worktree must have an anchor");
    assert.equal(anchor.via, "common-dir");
    assert.equal(anchor.root, resolve(main));
    ok("tier 1: real git worktree anchors through commondir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Tier 3: from a subdirectory of a linked worktree there is no .git file, so git lists the main worktree.
{
  const dir = temp("anchor-list");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const nested = join(worktree, "nested", "deep");
    mkdirSync(nested, { recursive: true });
    const anchor = mainRepoRoot(nested);
    if (anchor.root === null) assert.fail("a worktree subdirectory must still find the main repo");
    assert.equal(anchor.via, "worktree-list");
    assert.equal(anchor.root, resolve(main));
    ok("tier 3: a worktree subdirectory anchors via git worktree list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. Tier 2: a plain gitfile with gitdir: and no commondir points straight at the .git directory.
{
  const dir = temp("anchor-gitfile");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(join(main, ".git"), { recursive: true });
    writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, ".git"), "gitdir: ../main/.git\n");
    const anchor = mainRepoRoot(child);
    if (anchor.root === null) assert.fail("a gitfile must have an anchor");
    assert.equal(anchor.via, "gitfile");
    assert.equal(anchor.root, resolve(main));
    ok("tier 2: a gitfile anchors on its standalone gitdir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4. Tier 4: a plain directory with no git evidence is its own main root, not a failure.
{
  const dir = temp("anchor-cwd");
  try {
    mkdirSync(dir, { recursive: true });
    const anchor = mainRepoRoot(dir);
    if (anchor.root === null) assert.fail("a plain directory must fall back to cwd");
    assert.equal(anchor.via, "cwd");
    assert.equal(anchor.root, resolve(dir));
    ok("tier 4: a plain directory falls back to cwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5. A cwd that does not exist reports failure and says what was tried.
{
  const dir = temp("anchor-missing");
  const anchor = mainRepoRoot(join(dir, "absent"));
  assert.equal(anchor.root, null);
  if (anchor.root !== null) assert.fail("expected a failed anchor");
  assert.ok(anchor.tried.length > 0);
  ok("an unusable cwd reports null with the attempted paths");
}

// 6. No worktree means no link at all.
{
  const dir = temp("link-same");
  try {
    mkdirSync(dir, { recursive: true });
    const result = ensureDeliverableLink(dir, dir, "notes/out.md");
    assert.equal(result.action, "none");
    if (result.action !== "none") assert.fail("expected none");
    assert.equal(result.reason, "same-directory");
    assert.throws(() => statSync(join(dir, "notes", "out.md")), /ENOENT/);
    ok("same directory: no link is created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 7. A fresh child gets a symlink whose resolution is the main-side file.
{
  const dir = temp("link-created");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(main, { recursive: true });
    mkdirSync(child, { recursive: true });
    const target = deliverableTarget(main, "notes/out.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "main content\n");
    const result = ensureDeliverableLink(child, main, "notes/out.md");
    if (result.action !== "created") assert.fail("expected created");
    assert.equal(result.targetPath, target);
    assert.equal(readlinkSync(result.linkPath), target);
    assert.equal(realpathSync(result.linkPath), target);
    assert.equal(readFileSync(result.linkPath, "utf8"), "main content\n");
    ok("fresh child: created link resolves to the main-side file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 8. Calling it again reuses the existing link instead of replacing it.
{
  const dir = temp("link-reused");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(main, { recursive: true });
    mkdirSync(child, { recursive: true });
    const first = ensureDeliverableLink(child, main, "notes/out.md");
    assert.equal(first.action, "created");
    assert.ok(statSync(dirname(deliverableTarget(main, "notes/out.md"))).isDirectory(), "main-side parent created");
    const second = ensureDeliverableLink(child, main, "notes/out.md");
    assert.equal(second.action, "reused");
    assert.equal(second.linkPath, first.linkPath);
    assert.equal(readlinkSync(second.linkPath), deliverableTarget(main, "notes/out.md"));
    ok("second call: reused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 9. A link to a different target is not overwritten; a .new link is written beside it.
{
  const dir = temp("link-retarget");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(main, { recursive: true });
    mkdirSync(child, { recursive: true });
    const other = join(dir, "other.md");
    writeFileSync(other, "other\n");
    const linkPath = join(child, "out.md");
    symlinkSync(other, linkPath);
    const result = ensureDeliverableLink(child, main, "out.md");
    if (result.action !== "retargeted") assert.fail("expected retargeted");
    assert.equal(result.linkPath, `${linkPath}.new`);
    assert.equal(result.targetPath, deliverableTarget(main, "out.md"));
    assert.equal(readlinkSync(result.linkPath), deliverableTarget(main, "out.md"));
    assert.equal(readlinkSync(linkPath), other, "the original link is untouched");
    assert.match(result.warning, /left it untouched/);
    ok("link to another target: retargeted to <name>.new with a warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 10. A real file at the link path is never overwritten; the caller falls back to the main path.
{
  const dir = temp("link-real");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(main, { recursive: true });
    mkdirSync(child, { recursive: true });
    const linkPath = join(child, "out.md");
    writeFileSync(linkPath, "do not touch\n");
    const result = ensureDeliverableLink(child, main, "out.md");
    if (result.action !== "skipped") assert.fail("expected skipped");
    assert.equal(result.reason, "real-file");
    assert.ok(result.warning);
    assert.equal(readFileSync(linkPath, "utf8"), "do not touch\n");
    assert.equal(result.targetPath, deliverableTarget(main, "out.md"));
    ok("real file at the link path: skipped with a warning and left untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 11. A deliverable that escapes the child directory is a config error, not a link to create.
{
  const dir = temp("link-escape");
  try {
    mkdirSync(join(dir, "main"), { recursive: true });
    mkdirSync(join(dir, "child"), { recursive: true });
    assert.throws(() => ensureDeliverableLink(join(dir, "child"), join(dir, "main"), "../escape.md"), /relative path/);
    assert.throws(() => ensureDeliverableLink(join(dir, "child"), join(dir, "main"), "/tmp/absolute.md"), /relative path/);
    assert.throws(() => deliverableTarget(join(dir, "main"), "../escape.md"), /relative path/);
    ok("escaping and absolute deliverables are refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 26. Tier 3 skips a linked worktree listed first and anchors on the main checkout (P2-1).
{
  const dir = temp("anchor-list-order");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const nested = join(worktree, "nested");
    mkdirSync(nested, { recursive: true });
    // git normally prints the main worktree first; stand in for a listing that doesn't.
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const fakeGit = join(bin, "git");
    writeFileSync(fakeGit, `#!/bin/sh\nprintf 'worktree ${worktree}\\nHEAD 000\\nbranch refs/heads/phase3\\n\\nworktree ${main}\\nHEAD 111\\nbranch refs/heads/main\\n'\n`);
    chmodSync(fakeGit, 0o755);
    const oldPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}${sep}${oldPath}`;
    try {
      const anchor = mainRepoRoot(nested);
      if (anchor.root === null) assert.fail("a main checkout must still be found");
      assert.equal(anchor.root, resolve(main));
      assert.equal(anchor.via, "worktree-list");
    } finally {
      process.env.PATH = oldPath;
    }
    ok("tier 3: a linked worktree listed first is skipped for the main checkout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\npi-subagents-extend role phase 3a deliverable tests passed (${passed} cases)`);
