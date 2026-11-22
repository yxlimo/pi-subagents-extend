import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { EventHandler, SessionContext, Outcome, FakeExtensionApi } from "../types.ts"
import { workdir, ext } from "../harness.ts"
import "../support.ts"

// 角色身份是怎么被认出来的，以及认出之后什么时候闩住。
//
// 这一组从 session-start-wiring.test.ts 搬出来：那个文件已到 500 行，而身份闩锁是
// 独立的一条行为（「这次发射算不算认出了角色」），不是一般接线。用例编号保持原样。

// 267. A first prompt with no role identity must not latch the session as "no role":
// a later prompt carrying the <active_agent> tag still applies the role md, and
// preExec runs exactly once (it never ran for the identity-less emission).
{
  const home = join(workdir, "role-home-267")
  const md = join(home, ".agents", "late-tag-267.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(
    md,
    '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n  setup:\n    preExec: printf \'ran\\n\' >> count.txt\n---\n# late-tag-267\n',
  )
  const proj = join(workdir, "role-proj-267")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })

  // childRun emits the same prompt on every emission, so the tagless-then-tagged
  // sequence is driven against one activation directly, strictly in order. The
  // third emission (tagged again) pins the latch: once the role has been resolved
  // a re-emission must not re-run the wiring or the preExec.
  const previous = { child: process.env.PI_SUBAGENT_CHILD, home: process.env.HOME }
  process.env.PI_SUBAGENT_CHILD = "1"
  process.env.HOME = home
  const handlers: Record<string, EventHandler> = {}
  const ui: string[] = []
  const api: FakeExtensionApi = {
    on: (event, fn) => {
      handlers[event] = fn
    },
    registerCommand: () => {},
  }
  ext.activate(api as never)
  const ctx: SessionContext = { cwd: proj, ui: { notify: (message: string) => ui.push(message) } }
  try {
    await handlers.session_start?.({ type: "session_start" }, ctx)
    const tagged = '<active_agent name="late-tag-267"/>\nhello'
    await handlers.before_agent_start?.(
      { type: "before_agent_start", systemPrompt: "ORPHAN PROMPT 267 with no active_agent tag and no role body marker" },
      ctx,
    )
    assert.ok(
      ui.some((message) => message.includes("no active_agent role was found")),
      `the identity-less emission still warns, got: ${ui.join(" | ")}`,
    )
    await handlers.before_agent_start?.({ type: "before_agent_start", systemPrompt: tagged }, ctx)
    await handlers.before_agent_start?.({ type: "before_agent_start", systemPrompt: tagged }, ctx)

    const inside = (await handlers.tool_call?.(
      { type: "tool_call", toolName: "read", input: { path: join(proj, "allowed", "x.ts") }, toolCallId: "r1" },
      ctx,
    )) as Outcome
    assert.equal(inside, undefined, "the md scope from the late tag is applied")
    const outside = (await handlers.tool_call?.(
      { type: "tool_call", toolName: "write", input: { path: join(proj, "outside", "x.ts"), content: "x" }, toolCallId: "r2" },
      ctx,
    )) as Outcome
    assert.ok(outside && outside.block, "a write outside the md scope is refused after the late tag")
    assert.ok(
      outside.reason.includes(`role md ${md}`),
      `the refusal must name the md, got: ${outside.reason}`,
    )
    assert.equal(readFileSync(join(proj, "count.txt"), "utf8"), "ran\n", "preExec ran exactly once across the three emissions")
  } finally {
    if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD
    else process.env.PI_SUBAGENT_CHILD = previous.child
    if (previous.home === undefined) delete process.env.HOME
    else process.env.HOME = previous.home
  }
  console.log("  ok   a late <active_agent> tag still applies the role md and preExec runs once")
}
