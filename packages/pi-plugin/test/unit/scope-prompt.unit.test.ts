// Direct-unit coverage for the built-in Confinement summary.
//
// The module is loaded through a computed URL so the suite can be written while
// src/scope-prompt.ts is still absent: typecheck stays green, and running this
// file fails with ERR_MODULE_NOT_FOUND until the implementation lands.
//
// Every case below states what the child prompt must say, not what the helper
// happens to return: a wrong section key or a dropped optional line fails here.

import assert from "node:assert/strict"

interface ScopeBashSummary {
  allow: string[]
  deny: string[]
  network: boolean
  writablePaths: string[]
}

interface ScopeSummary {
  source: string
  read: string[]
  write: string[]
  bash?: ScopeBashSummary
  budgets: { deny: number; write: number }
  deliverable?: { short: string; target: string }
}

const scopeModuleUrl = new URL("../../src/scope-prompt.ts", import.meta.url).href
const { SCOPE_SECTION, scopeText } = (await import(scopeModuleUrl)) as {
  SCOPE_SECTION: string
  scopeText: (summary: ScopeSummary) => string
}

let passed = 0
const ok = (label: string): void => {
  passed += 1
  console.log(`  ok   ${label}`)
}

const header = [
  "## Confinement",
  "",
  "A refusal names what refused it; read it instead of retrying a differently spelled path.",
  "",
]
const full: ScopeSummary = {
  source: "role md /main/.pi/agents/auditor.md",
  read: ["src/**", "docs/**"],
  write: ["dist/**"],
  bash: {
    allow: ["git status", "rg"],
    deny: ["git push", "git reset --hard"],
    network: false,
    writablePaths: ["/cache/pnpm", "/tmp/build"],
  },
  budgets: { deny: 3, write: 2 },
  deliverable: { short: "notes/report.md", target: "/main/notes/report.md" },
}

console.log("pi-subagents-extend scope prompt unit")

// 1. The section key is one stable literal that pi accepts in systemPromptOptions.sections.
{
  assert.equal(SCOPE_SECTION, "pi_subagents_extend_scope")
  ok("the Confinement section is announced under the pi-valid pi_subagents_extend_scope key")
}

// 2. A fully configured child sees every line, in order, with no trailing newline.
{
  assert.equal(
    scopeText(full),
    [
      ...header,
      "- Configuration: role md /main/.pi/agents/auditor.md",
      "- Read: src/**, docs/**",
      "- Write: dist/**",
      "- Bash: 2 allowed commands, network off",
      "- Allowed commands: git status, rg",
      "- Always refused: git push, git reset --hard",
      "- Also writable: /cache/pnpm, /tmp/build",
      "- Budgets: 3 refusals in a row stop the session; 2 for writes",
      "- Deliverable: write it to `notes/report.md`; the parent reads it at `/main/notes/report.md`.",
    ].join("\n"),
    "the summary carries the source, counts, budgets and both deliverable paths",
  )
  ok("a full configuration produces the complete Confinement text")
}

// 3. Empty read means the whole directory; empty write means read-only.
{
  assert.equal(
    scopeText({ ...full, read: [], write: [] }),
    [
      ...header,
      "- Configuration: role md /main/.pi/agents/auditor.md",
      "- Read: the whole working directory",
      "- Write: nothing — this task is read-only",
      "- Bash: 2 allowed commands, network off",
      "- Allowed commands: git status, rg",
      "- Always refused: git push, git reset --hard",
      "- Also writable: /cache/pnpm, /tmp/build",
      "- Budgets: 3 refusals in a row stop the session; 2 for writes",
      "- Deliverable: write it to `notes/report.md`; the parent reads it at `/main/notes/report.md`.",
    ].join("\n"),
    "an omitted scope is described, not silently turned into an empty one",
  )
  ok("empty read and write scopes say 'whole working directory' and 'read-only'")
}

// 4. No bash configuration means no command list at all.
{
  assert.equal(
    scopeText({ ...full, bash: undefined }),
    [
      ...header,
      "- Configuration: role md /main/.pi/agents/auditor.md",
      "- Read: src/**, docs/**",
      "- Write: dist/**",
      "- Bash: not available in this session",
      "- Budgets: 3 refusals in a row stop the session; 2 for writes",
      "- Deliverable: write it to `notes/report.md`; the parent reads it at `/main/notes/report.md`.",
    ].join("\n"),
    "no bash means no Allowed commands / Always refused / Also writable lines",
  )
  ok("a bash-less session is told bash is unavailable, without the three command lines")
}

// 5. network: true is visible in the count line.
{
  assert.match(
    scopeText({ ...full, bash: { allow: ["ls"], deny: [], network: true, writablePaths: [] } }),
    /^- Bash: 1 allowed commands, network on$/m,
    "the child must see that the sandbox has network",
  )
  ok("network on appears on the Bash line")
}

// 6. Empty deny and writablePaths omit their optional lines rather than printing blanks.
{
  const text = scopeText({
    ...full,
    bash: { allow: ["ls"], deny: [], network: false, writablePaths: [] },
  })
  assert.doesNotMatch(text, /^- (Always refused|Also writable):/m, "empty lists produce no line")
  ok("empty deny and writablePaths leave out both optional lines")
}

// 7. No deliverable means no delivery instruction.
{
  const text = scopeText({ ...full, deliverable: undefined })
  assert.doesNotMatch(text, /^- Deliverable:/m, "a read-only task must not be told to write a report")
  ok("a missing deliverable leaves out the Deliverable line")
}

// 8. Lists are printed in the order the parent supplied them, not sorted.
{
  assert.match(
    scopeText({
      ...full,
      read: ["z/**", "a/**", "m/**"],
      write: ["w2", "w1"],
      bash: {
        allow: ["b", "a"],
        deny: ["z", "a"],
        network: false,
        writablePaths: ["/b", "/a"],
      },
    }),
    /- Read: z\/\*\*, a\/\*\*, m\/\*\*\n[\s\S]*- Write: w2, w1\n[\s\S]*- Allowed commands: b, a\n[\s\S]*- Always refused: z, a\n[\s\S]*- Also writable: \/b, \/a\n/,
    "the order in the parent's configuration reaches the child unchanged",
  )
  ok("read, write, allow, deny and writablePaths keep the supplied order")
}

console.log(`  scope-prompt.unit: ${passed} cases passed`)
