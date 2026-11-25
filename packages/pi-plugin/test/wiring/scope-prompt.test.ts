// End-to-end wiring for the built-in Confinement summary.
//
// These cases drive the real activate() → before_agent_start path through the
// shared harness, so they assert what the child actually receives in
// systemPromptOptions.sections. The section key is spelled out here: if wiring
// uses a different key than the exported SCOPE_SECTION, the key assertion fails
// even when both sides agree with each other.

import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { childRun, workdir, writeAgentMd } from "../harness.ts"
import type { PromptOptions } from "../types.ts"
import { deliverableTarget } from "../../src/deliverable.ts"

const SCOPE_SECTION = "pi_subagents_extend_scope"
const sectionsOf = (options: PromptOptions): Record<string, string> =>
  (options.sections ?? {}) as unknown as Record<string, string>

console.log("pi-subagents-extend scope prompt wiring")

// 1. A role-md child gets the scope section with its real read/write scopes and bash rules.
{
  const home = join(workdir, "scope-prompt-home-child")
  const proj = join(workdir, "scope-prompt-proj-child")
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(join(proj, "docs"), { recursive: true })
  writeAgentMd({
    cwd: proj,
    role: "scope-confined",
    extend: {
      permissions: {
        scope: ["src/**"],
        write: ["docs/**"],
        bash: { allow: ["git status", "rg"], deny: ["git push"] },
      },
      output: { deliverable: "report.md" },
    },
  })
  const options: PromptOptions = {}
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="scope-confined"/>\nhello',
    systemPromptOptions: options,
  })
  try {
    assert.deepEqual(
      Object.keys(sectionsOf(options)),
      [SCOPE_SECTION],
      "before_agent_start adds exactly the Confinement section to a child prompt",
    )
    const text = sectionsOf(options)[SCOPE_SECTION] ?? ""
    assert.match(text, /^- Read: src\/\*\*$/m, "the child sees the md's read scope")
    // 写范围 = md 的 write globs + 绝对写授权（这里就是交付物那个真实文件），所以只断言前缀。
    assert.match(text, /^- Write: docs\/\*\*, /m, "the child sees the md's write scope")
    assert.match(text, /^- Bash: 2 allowed commands, network off$/m, "the child sees the bash allow count")
    assert.match(text, /^- Allowed commands: git status, rg$/m, "the child sees the allow list")
    assert.match(text, /^- Always refused: git push$/m, "the child sees the hard deny list")
    assert.ok(
      text.includes(
        `Deliverable: write it to \`report.md\`; the parent reads it at \`${deliverableTarget(proj, "report.md")}\`.`,
      ),
      "the delivery instruction lives in the Confinement section",
    )
    console.log("  ok   a role-md child receives the Confinement section with its scopes and bash rules")
  } finally {
    run.restore()
  }
}

// 2. The main session is not a child: it gets no Confinement section at all.
{
  const home = join(workdir, "scope-prompt-home-main")
  const proj = join(workdir, "scope-prompt-proj-main")
  mkdirSync(proj, { recursive: true })
  writeAgentMd({ cwd: proj, role: "scope-confined", extend: { permissions: { scope: ["src/**"] } } })
  const options: PromptOptions = {}
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: "ORDINARY MAIN SESSION PROMPT no active_agent tag and no md body marker",
    foreground: true,
    systemPromptOptions: options,
  })
  try {
    assert.deepEqual(
      Object.keys(sectionsOf(options)),
      [],
      "the parent's own prompt is left without a child Confinement section",
    )
    console.log("  ok   a main session gets no Confinement section")
  } finally {
    run.restore()
  }
}

// 3. A child with neither a role md nor a bindings payload has no active policy or role source,
//    so no summary is invented for it.
{
  const home = join(workdir, "scope-prompt-home-empty")
  const proj = join(workdir, "scope-prompt-proj-empty")
  mkdirSync(home, { recursive: true })
  mkdirSync(proj, { recursive: true })
  const options: PromptOptions = {}
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="no-config-child"/>\nhello',
    systemPromptOptions: options,
  })
  try {
    assert.deepEqual(
      Object.keys(sectionsOf(options)),
      [],
      "an unconfigured child must not be told it has a confinement it does not have",
    )
    console.log("  ok   a child with no md and no payload gets no Confinement section")
  } finally {
    run.restore()
  }
}

console.log("pi-subagents-extend scope prompt wiring: 3 cases passed")
