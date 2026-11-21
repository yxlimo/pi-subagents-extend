// Offline tests for the main-session skill strip (src/main-skills.ts, wired into the
// !child branch of wireAgentStart). Every case drives the REAL handler — the same
// before_agent_start entry pi calls — with a hand-built event that matches the host's
// measured shape: systemPrompt carries the rendered prompt (for a child, the tag),
// systemPromptOptions.skills is the mutable skill list, and event.prompt is the raw
// user prompt (dist/core/extensions/types.d.ts). A main-session event carries no
// <active_agent> tag; a child event carries the tag the role-config parser reads.

import assert from "node:assert/strict"
import { mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { repo, workdir } from "./harness.ts"

const agentStart = (await import(join(repo, "src", "wiring", "agent-start.ts"))) as unknown as typeof import("../src/wiring/agent-start.ts")
const wiring = (await import(join(repo, "src", "wiring", "context.ts"))) as unknown as typeof import("../src/wiring/context.ts")

let passed = 0
function ok(label: string): void {
  passed += 1
  console.log(`  ok   ${label}`)
}

interface RunOptions {
  cwd: string
  home: string
  systemPrompt: string
  /** The host puts the raw user prompt on messageType: "user" events; the main
   * session's "the prompt names the skill" keep reads it. */
  prompt?: string
  skills: Array<{ name: string; filePath: string }>
  /** Background-children detection: pi-subagents sets this only for those. */
  childEnv?: boolean
}

interface RunResult {
  options: { skills?: Array<{ name: string; filePath: string }> }
  notes: string[]
}

/** One before_agent_start emission through wireAgentStart, with the env a fresh
 * session would see: no bindings payload, HOME pointed at the fixture home, and
 * PI_SUBAGENT_CHILD only when the caller asks for a background child. */
async function runStart(opts: RunOptions): Promise<RunResult> {
  const prev = {
    bindings: process.env.PI_SUBAGENT_EXTENSION_BINDINGS,
    child: process.env.PI_SUBAGENT_CHILD,
    home: process.env.HOME,
  }
  delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  if (opts.childEnv) process.env.PI_SUBAGENT_CHILD = "1"
  else delete process.env.PI_SUBAGENT_CHILD
  process.env.HOME = opts.home
  try {
    const notes: string[] = []
    const w = wiring.createWiring()
    const ctx = { cwd: opts.cwd, ui: { notify: (message: string) => notes.push(message) } } as unknown as ExtensionContext
    // The skills array is passed through as-is so an untouched run provably keeps
    // the same array object (the handler must not hand the host a fresh one).
    const options = { skills: opts.skills }
    const event = {
      type: "before_agent_start",
      messageType: "user",
      systemPrompt: opts.systemPrompt,
      prompt: opts.prompt,
      systemPromptOptions: options,
    } as unknown as BeforeAgentStartEvent
    await agentStart.wireAgentStart(w, event, ctx)
    return { options, notes }
  } finally {
    if (prev.bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = prev.bindings
    if (prev.child === undefined) delete process.env.PI_SUBAGENT_CHILD
    else process.env.PI_SUBAGENT_CHILD = prev.child
    if (prev.home === undefined) delete process.env.HOME
    else process.env.HOME = prev.home
  }
}

/** A skill fixture: frontmatter with the given flag line ("" for none). */
function writeSkill(dir: string, name: string, flag: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.md`)
  writeFileSync(file, `---\nname: ${name}\ndescription: the ${name} skill\n${flag}---\n# ${name}\n`)
  return file
}

function fixture(name: string): { proj: string; home: string; skillsDir: string } {
  const proj = join(workdir, `skills-proj-${name}`)
  const home = join(workdir, `skills-home-${name}`)
  mkdirSync(proj, { recursive: true })
  mkdirSync(home, { recursive: true })
  return { proj, home, skillsDir: join(proj, "skills") }
}

const MAIN_PROMPT = "ORDINARY MAIN SESSION PROMPT with no active_agent tag and no role body marker"

console.log("pi-subagents-extend main-skills")

// 1. A main session loses the flagged skill and keeps the others.
{
  const { proj, home, skillsDir } = fixture("1")
  const plain = writeSkill(skillsDir, "plain_skill_1", "")
  const flagged = writeSkill(skillsDir, "arch_reference_1", "subagent-only: true\n")
  const result = await runStart({
    cwd: proj,
    home,
    systemPrompt: `${MAIN_PROMPT} 1`,
    skills: [
      { name: "plain_skill_1", filePath: plain },
      { name: "arch_reference_1", filePath: flagged },
    ],
  })
  assert.deepEqual(
    result.options.skills?.map((skill) => skill.name),
    ["plain_skill_1"],
    "the flagged skill is dropped and the unflagged one stays",
  )
  ok("a main session loses the subagent-only skill and keeps the others")
}

// 2. A child keeps the flagged skill — and the same fixture dropped in a main-shaped
// run proves the keep is not vacuous (the flag is actually read and the strip branch
// is reachable for exactly this fixture).
{
  const { proj, home, skillsDir } = fixture("2")
  const plain = writeSkill(skillsDir, "plain_skill_2", "")
  const flagged = writeSkill(skillsDir, "arch_reference_2", "subagent-only: true\n")
  const skills = () => [
    { name: "plain_skill_2", filePath: plain },
    { name: "arch_reference_2", filePath: flagged },
  ]
  // Foreground child: the tag in systemPrompt is the identity, no env var needed.
  const child = await runStart({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="coder"/>\nCHILD TASK TWO',
    skills: skills(),
  })
  assert.deepEqual(
    child.options.skills?.map((skill) => skill.name),
    ["plain_skill_2", "arch_reference_2"],
    "a child session keeps every skill it was given, flagged one included",
  )
  // Background child: the env var alone identifies the child even with a tagless prompt.
  const background = await runStart({
    cwd: proj,
    home,
    systemPrompt: "CHILD TASK TWO without any tag",
    childEnv: true,
    skills: skills(),
  })
  assert.deepEqual(
    background.options.skills?.map((skill) => skill.name),
    ["plain_skill_2", "arch_reference_2"],
    "a background child keeps its skills too — a child must never lose one",
  )
  // The counterfactual: the identical fixture through the main branch drops it.
  const main = await runStart({
    cwd: proj,
    home,
    systemPrompt: `${MAIN_PROMPT} 2`,
    skills: skills(),
  })
  assert.deepEqual(
    main.options.skills?.map((skill) => skill.name),
    ["plain_skill_2"],
    "the same flagged file IS dropped when the session is a main one",
  )
  ok("a child keeps the flagged skill the main branch provably drops")
}

// 3. A skill with no subagent-only key (and one with an explicit false) is untouched:
// same names AND the same array object — no needless fresh array for the host.
{
  const { proj, home, skillsDir } = fixture("3")
  const plain = writeSkill(skillsDir, "plain_skill_3", "")
  const explicitFalse = writeSkill(skillsDir, "explicit_false_3", "subagent-only: false\n")
  const skills = [
    { name: "plain_skill_3", filePath: plain },
    { name: "explicit_false_3", filePath: explicitFalse },
  ]
  const result = await runStart({ cwd: proj, home, systemPrompt: `${MAIN_PROMPT} 3`, skills })
  assert.strictEqual(result.options.skills, skills, "nothing to drop: the host keeps the same array")
  assert.deepEqual(
    result.options.skills.map((skill) => skill.name),
    ["plain_skill_3", "explicit_false_3"],
  )
  ok("skills without the flag are untouched, array identity included")
}

// 4. Malformed frontmatter never throws and never hides a skill. Three shapes: an
// unclosed frontmatter, a garbage-but-closed one whose flag the scan still honours
// (a YAML parse would throw here — the scan is what keeps this non-fatal), and a
// filePath that does not exist.
{
  const { proj, home, skillsDir } = fixture("4")
  mkdirSync(skillsDir, { recursive: true })
  const unclosed = join(skillsDir, "unclosed_4.md")
  writeFileSync(unclosed, "---\nname: unclosed_4\ndescription: no closing fence\n")
  const garbage = writeSkill(skillsDir, "garbage_4", ": :\n%%%\nsubagent-only: true\n")
  const result = await runStart({
    cwd: proj,
    home,
    systemPrompt: `${MAIN_PROMPT} 4`,
    skills: [
      { name: "unclosed_4", filePath: unclosed },
      { name: "garbage_4", filePath: garbage },
      { name: "ghost_4", filePath: join(skillsDir, "missing_4.md") },
    ],
  })
  assert.deepEqual(
    result.options.skills?.map((skill) => skill.name),
    ["unclosed_4", "ghost_4"],
    "broken files and unreadable paths stay visible; the flag inside garbage YAML is still honoured",
  )
  assert.deepEqual(result.notes, [], "and none of it disturbs the session")
  ok("malformed frontmatter does not throw, and garbage YAML with the flag is still dropped")
}

// 5. The per-path mtime cache is real behaviour, not an implementation detail:
// with the mtime pinned, the strip decision survives a content flip (the cache is
// being consulted — a fresh read would have kept the skill), and once the mtime
// moves the fresh content wins again.
{
  const { proj, home, skillsDir } = fixture("5")
  const flagged = writeSkill(skillsDir, "cached_skill_5", "subagent-only: true\n")
  const stamp = new Date(Date.UTC(2020, 0, 1))
  utimesSync(flagged, stamp, stamp)
  const skills = () => [{ name: "cached_skill_5", filePath: flagged }]
  const first = await runStart({ cwd: proj, home, systemPrompt: `${MAIN_PROMPT} 5`, skills: skills() })
  assert.deepEqual(first.options.skills, [], "flagged at the pinned mtime: dropped")
  // Same mtime, different content: the cache answers from the old read.
  writeFileSync(flagged, "---\nname: cached_skill_5\nsubagent-only: false\n---\n# cached_skill_5\n")
  utimesSync(flagged, stamp, stamp)
  const second = await runStart({ cwd: proj, home, systemPrompt: `${MAIN_PROMPT} 5`, skills: skills() })
  assert.deepEqual(second.options.skills, [], "same mtime: the cached decision survives the content flip")
  // A fresh mtime invalidates the entry and the fresh read wins.
  writeFileSync(flagged, "---\nname: cached_skill_5\nsubagent-only: false\n---\n# cached_skill_5\n")
  const third = await runStart({ cwd: proj, home, systemPrompt: `${MAIN_PROMPT} 5`, skills: skills() })
  assert.deepEqual(third.options.skills?.map((skill) => skill.name), ["cached_skill_5"], "new mtime: re-read and kept")
  ok("the mtime cache answers same-mtime reads and re-reads after an mtime change")
}

// 6. The explicit-request keep: a main session whose prompt NAMES the flagged skill
// keeps it. The control run without the name drops it, so it is the name that kept
// it — not a broken strip. The name is read from event.prompt: the rendered
// systemPrompt carries the <available_skills> advertisement, which names every
// skill and would keep everything.
{
  const { proj, home, skillsDir } = fixture("6")
  const flagged = writeSkill(skillsDir, "arch_reference_6", "subagent-only: true\n")
  const skills = () => [{ name: "arch_reference_6", filePath: flagged }]
  const named = await runStart({
    cwd: proj,
    home,
    systemPrompt: `${MAIN_PROMPT} 6`,
    prompt: "please load the arch_reference_6 skill and follow it for this task",
    skills: skills(),
  })
  assert.deepEqual(named.options.skills?.map((skill) => skill.name), ["arch_reference_6"], "an explicit request keeps the skill")
  const unnamed = await runStart({
    cwd: proj,
    home,
    systemPrompt: `${MAIN_PROMPT} 6`,
    prompt: "something that does not mention any skill",
    skills: skills(),
  })
  assert.deepEqual(unnamed.options.skills, [], "without the name the same skill is dropped")
  ok("a prompt that names the flagged skill keeps it; the channel is event.prompt")
}

console.log(`\npi-subagents-extend main-skills 测试通过（${passed} 项）`)
