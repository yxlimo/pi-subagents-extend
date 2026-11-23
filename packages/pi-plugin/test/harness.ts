// Shared test harness for the handler-level suites.
//
// The handler-level test files (extension, budgets, notices, session-start,
// sandbox.real, annotations) each activate the extension against a fake pi API
// and drive its tool_call / tool_result / context handlers. The machinery that
// builds that fake API, resolves the sandbox helper, and provides the
// deterministic clock is identical across the files, so it lives here once.
// Each suite imports only the pieces it actually uses.

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { stringify } from "yaml"
import { fileURLToPath } from "node:url"
import { redirectStateDir, stateDir } from "./state-dir.ts"
import type {
  CommandSpec,
  EventHandler,
  ExtensionModule,
  FakeExtensionApi,
  HandlerOptions,
  Harness,
  AnnotatedMessages,
  Outcome,
  PatchedResult,
  SandboxSpec,
  SessionContext,
  PromptOptions,
} from "./types.ts"

// The suites must not inherit the extension's own git-excludes injection. `sandbox/spec.ts` adds
// GIT_CONFIG_COUNT/KEY_0/VALUE_0 unless the host already set GIT_CONFIG_COUNT — so a test process
// started from a sandboxed shell arrives with those three variables already set, the injection is
// suppressed by its own gate, and a case asserting the injected values fails against the very thing
// it is meant to test. Clear them here, once, so a suite behaves the same in CI and in a developer's
// shell; individual suites no longer need their own workaround.
delete process.env.GIT_CONFIG_COUNT
delete process.env.GIT_CONFIG_KEY_0
delete process.env.GIT_CONFIG_VALUE_0
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")

// The suite must not write into the developer's real home. Spec files, `git-excludes` and the
// `xdg-cache` tree live in the extension's state directory, so point that at a throwaway one for
// the run. Not `tmpdir()`: the helper mounts a private tmpfs over `/tmp`, so a grant underneath
// it cannot take effect — the helper refuses such a spec (exit 77) and names the tmpfs as the
// cause. Redirecting `HOME` instead is too blunt: on CI `cargo` is rustup's shim and tries to
// create `$HOME/.rustup`, which the sandbox refuses because the package directory is not a
// write grant. The redirect itself (and the probe-then-fallback for where it lands) lives once
// in ./state-dir.ts; suites that spawn real sessions call it there too.
redirectStateDir("run-", ".test-state-")

// The sandbox helper is a Rust binary. Tests execute the cargo build output and
// never the copy in `bin/`: that copy belongs to a loaded extension, so writing to
// it during a test run would swap the binary out from under a running session —
// `ETXTBSY` at best, a silent behaviour change between calls at worst. An explicit
// override wins, so a stub can be substituted; then the build output; a packaged
// `bin/` copy is the last resort for a checkout with no Rust toolchain.
function resolveHelperBin(): string {
  const candidates = [
    process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH?.trim(),
    join(repo, "..", "helper", "target", "release", "pi-subagents-extend-helper"),
    join(repo, "bin", `pi-subagents-extend-helper-${process.platform}-${process.arch}`),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    "no sandbox helper found; run `cargo build --release --manifest-path packages/helper/Cargo.toml`",
  )
}
const helperBin = resolveHelperBin()

// These cases inspect the command the extension rewrites and the spec it writes;
// none of them executes the helper, so the kernel's Landlock ABI only decides
// whether bash is offered at all. Where the ABI is below the required 7 the real
// helper refuses bash, and the suite would report a failure that says nothing about
// the extension. Point the environment at a stub instead: enforcement is covered by
// the helper's own cargo tests and by running this suite on a 6.15 or later kernel.
interface HelperDescription {
  landlock?: { kernel_abi?: number; supported?: boolean }
  network_namespace?: boolean
}

function helperAbi(bin: string): HelperDescription | undefined {
  const out = spawnSync(bin, ["--describe"], { encoding: "utf8" });
  try {
    return JSON.parse(out.stdout) as HelperDescription;
  } catch {
    return undefined;
  }
}

const described = helperAbi(helperBin);
// Cases that execute the helper for real need a kernel that can enforce the
// sandbox. With the stub there is nothing to enforce, so those parts are skipped
// instead of asserting on the stub's silence.
const liveSandbox = described?.landlock?.supported === true;
if (described?.landlock?.supported) {
  process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = helperBin
} else {
  const stubDir = mkdtempSync(join(tmpdir(), "pi-subagents-extend-stub-"))
  const stub = join(stubDir, "pi-subagents-extend-helper")
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' '{"landlock":{"kernel_abi":7,"required_abi":7,"supported":true,"reason":null},"network_namespace":true,"resolver_sockets":[]}'\n`,
  )
  chmodSync(stub, 0o755)
  process.env.PI_SUBAGENTS_EXTEND_HELPER_PATH = stub
  console.log(
    `  note  kernel Landlock ABI ${described?.landlock?.kernel_abi ?? "unknown"} is below the required 7;` +
      " the suite runs against a stub helper that reports ABI 7",
  )
}

/** The sandbox spec the extension wrote for a rewritten bash command. */
/** The spec file the extension wrote for a rewritten bash command (path, not content). */
function specPathOf(command: string): string {
  const match = /'--spec' '([^']+)'/.exec(command)
  assert.ok(match, `no --spec in: ${command}`)
  return match[1]
}
function specOf(command: string): SandboxSpec {
  return JSON.parse(readFileSync(specPathOf(command), "utf8")) as SandboxSpec
}

const ext = (await import(join(repo, "src", "index.ts"))) as unknown as ExtensionModule

/**
 * The documented dispatch payload nests policy under `permissions`. Most cases in this suite
 * predate that contract and pass the policy fields flat, so the harness lifts them into the
 * documented shape; cases that pin the contract itself pass `rawBindings` to opt out.
 */
const wrapDispatchBindings = (raw: string | undefined): string | undefined => {
  if (!raw) return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw
  const table = parsed as Record<string, unknown>
  let changed = false
  for (const [key, value] of Object.entries(table)) {
    if (!key.startsWith("pi-subagents-extend/")) continue
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const ns = value as Record<string, unknown>
    if (Object.hasOwn(ns, "permissions")) continue
    // 块级键（worktree/setup/output）在派单里与 permissions 平级，其余是策略字段。
    const blockLevel = ["worktree", "setup", "output"]
    const permissions: Record<string, unknown> = {}
    const rest: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(ns)) {
      if (blockLevel.includes(name)) rest[name] = field
      else permissions[name] = field
    }
    table[key] = { ...rest, permissions }
    changed = true
  }
  return changed ? JSON.stringify(table) : raw
}

type HandlerArgs = HandlerOptions & { rawBindings?: boolean }

/**
/**
 * Activate the extension with the given bindings env and return its tool_call handler.
 */
async function handler({ bindings, rawBindings, cwd = workdir, piTools, transcript }: HandlerArgs = {}): Promise<Harness> {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  if (bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = rawBindings ? bindings : wrapDispatchBindings(bindings)

  const handlers: Record<string, EventHandler> = {}
  const commands: Record<string, CommandSpec> = {}
  const ui: string[] = []
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand(name, spec) {
      commands[name] = spec
    },
  }
  if (piTools) api.getAllTools = () => piTools
  ext.activate(api)

  const aborts: string[] = []
  const ctx: SessionContext = { cwd, ui: { notify: (message: string) => ui.push(message) }, actions: { abort: () => aborts.push("abort") } }
  // 判定读的是 transcript 里模型原本那条命令（event.input 会被处理器链改写）。只有用例显式给了
  // transcript 才挂 sessionManager：旧宿主没有这条通道，判定要照常退回 event.input。
  if (transcript) (ctx as SessionContext & { sessionManager: unknown }).sessionManager = { getBranch: () => transcript }
  if (handlers.session_start) {
    // session_start is async but only reports; flush it before returning.
    await handlers.session_start({ type: "session_start" }, ctx)
  }

  // pi 给每次工具调用一个新 id，所以默认 id 也按调用递增：写死 "t1" 会让「两次调用
  // 各自带 spec」的用例看起来像是靠泄漏才成立。result 不带 id 时配对**最近一次** call，
  // 这样「call 完紧跟 result」的老写法照旧成立。
  let callSeq = 0
  let lastCallId = "t0"
  const call = async (
    toolName: string,
    input?: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<Outcome> => {
    const id = toolCallId ?? `t${++callSeq}`
    lastCallId = id
    return (await handlers.tool_call({ type: "tool_call", toolCallId: id, toolName, input }, ctx)) as Outcome
  }
  const result = async (
    toolName: string,
    content: unknown,
    isError = false,
    toolCallId?: string,
  ): Promise<PatchedResult | undefined> =>
    (await handlers.tool_result?.(
      {
        type: "tool_result",
        toolCallId: toolCallId ?? lastCallId,
        toolName,
        input: {},
        content,
        isError,
      },
      ctx,
    )) as PatchedResult | undefined
  const context = async (messages: unknown[]): Promise<AnnotatedMessages | undefined> =>
    (await handlers.context?.({ type: "context", messages }, ctx)) as AnnotatedMessages | undefined
  /** Fire session_shutdown, which is where the extension sweeps stale spec files. */
  const shutdown = async (): Promise<void> => {
    await handlers.session_shutdown?.({ type: "session_shutdown" }, ctx)
  }

  return {
    call,
    result,
    context,
    shutdown,
    aborts,
    ui,
    commands,
    restore: () => {
      if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
    },
  }
}

/**
 * Write a role md into a test project the way production finds one: `.pi/agents/<role>.md`
 * under `cwd`, frontmatter with `name` and `systemPromptMode: append`, a non-empty body,
 * and the given `extend` block as YAML. The extension does all parsing — this only writes
 * the file. Returns the path written.
 */
function writeAgentMd({
  cwd,
  role,
  extend,
  body = `Role policy for ${role}: stay inside the granted scope and report instead of writing outside it.`,
}: {
  cwd: string
  role: string
  extend: Record<string, unknown>
  body?: string
}): string {
  const dir = join(cwd, ".pi", "agents")
  mkdirSync(dir, { recursive: true })
  // `stringify` is the same serializer family the reader (`parse` in role-config.ts) uses,
  // so what a test passes is what the extension reads back, without hand-rolled YAML.
  const frontmatter = stringify({ name: role, systemPromptMode: "append", extend }, { lineWidth: 0 })
  const file = join(dir, `${role}.md`)
  writeFileSync(file, `---\n${frontmatter}---\n\n${body}\n`)
  return file
}

/**
 * The child system prompt as production assembles it under `systemPromptMode: append`:
 * the base prompt arrives wrapped in `<addendum>`, so the `<active_agent>` tag does not
 * sit on line one, and the md body follows the tag. `parseRoleName` only demands that
 * the tag be a whole line by itself; the harness composes text, it does not parse it.
 */
function childSystemPrompt(role: string, body: string, base = "You are a delegated subagent."): string {
  const attribute = role
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
  return [
    "<addendum>",
    base,
    "</addendum>",
    "",
    `<active_agent name="${attribute}"/>`,
    "",
    body,
  ].join("\n")
}

/** Deterministic clock: setTimeout is driven manually via advance(). */
interface TimerHost {
  now(): number
  setTimeout(fn: () => void, delay: number): number
  clearTimeout(id: number): void
}

function fakeClock(): { host: TimerHost; advance(ms: number): void } {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const host: TimerHost = {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = ++seq
      timers.set(id, { at: now + delay, fn })
      return id
    },
    clearTimeout: (id) => void timers.delete(id),
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)
      if (due.length === 0) break
      const [id, t] = due[0]
      timers.delete(id)
      now = t.at
      t.fn()
    }
    now = target
  }
  return { host, advance }
}

const defaultProbe = () => ({
  idleWriteMs: 6 * 60 * 1000,
  abortGraceMs: 2 * 60 * 1000,
  repeatBash: 3,
  successIdleMs: 5 * 60 * 1000,
  successPatterns: ["fail=0"],
  forbidWritePatterns: [],
})

const workdir = mkdtempSync(join(tmpdir(), "pi-subagents-extend-test-"))
mkdirSync(join(workdir, "src/auth"), { recursive: true })


// A child run: activate, fire session_start, then before_agent_start with a role tag.
const childRun = async (opts: { cwd: string; home: string; systemPrompt: string; bindings?: string; order?: "normal" | "hostile"; beforeStartEmissions?: number; beforeStartDelayMs?: number; beforeStartCwds?: string[]; foreground?: boolean; rawBindings?: boolean; systemPromptOptions?: PromptOptions }) => {
  const prev = {
    bindings: process.env.PI_SUBAGENT_EXTENSION_BINDINGS,
    child: process.env.PI_SUBAGENT_CHILD,
    home: process.env.HOME,
  }
  if (opts.bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = opts.rawBindings ? opts.bindings : wrapDispatchBindings(opts.bindings)
  if (opts.foreground) delete process.env.PI_SUBAGENT_CHILD
  else process.env.PI_SUBAGENT_CHILD = "1"
  process.env.HOME = opts.home
  const handlers: Record<string, EventHandler> = {}
  const ui: string[] = []
  const api: FakeExtensionApi = {
    on(event, fn) { handlers[event] = fn },
    registerCommand() {},
  }
  ext.activate(api)
  const ctx: SessionContext = { cwd: opts.cwd, ui: { notify: (message) => ui.push(message) } }
  if (opts.order === "hostile") {
    // A hostile host could emit session_start after the role wiring; the grant must survive it.
    await handlers.before_agent_start?.({ type: "before_agent_start", systemPrompt: opts.systemPrompt, systemPromptOptions: opts.systemPromptOptions }, ctx)
    await handlers.session_start?.({ type: "session_start" }, ctx)
  } else {
    await handlers.session_start?.({ type: "session_start" }, ctx)
    const emitBeforeStart = (cwd?: string) => handlers.before_agent_start?.({ type: "before_agent_start", systemPrompt: opts.systemPrompt, systemPromptOptions: opts.systemPromptOptions }, cwd ? { ...ctx, cwd } : ctx)
    if (opts.beforeStartEmissions && opts.beforeStartEmissions > 1) {
      await Promise.all(
        Array.from({ length: opts.beforeStartEmissions }, async (_, i) => {
          if (i > 0 && opts.beforeStartDelayMs) await new Promise((r) => setTimeout(r, opts.beforeStartDelayMs))
          return emitBeforeStart(opts.beforeStartCwds?.[i])
        }),
      )
    } else {
      await emitBeforeStart()
    }
  }
  return {
    call: async (tool: string, input?: Record<string, unknown>): Promise<Outcome> =>
      (await handlers.tool_call({ type: "tool_call", toolName: tool, input, toolCallId: "r1" }, ctx)) as Outcome,
    ui,
    restore: () => {
      if (prev.bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = prev.bindings
      if (prev.child === undefined) delete process.env.PI_SUBAGENT_CHILD
      else process.env.PI_SUBAGENT_CHILD = prev.child
      if (prev.home === undefined) delete process.env.HOME
      else process.env.HOME = prev.home
    },
  }
}

// The internal read/write judgment is not exported from the extension entry, so suites reach the
// module directly. Shared: three of the five split session-start files classify commands.
const bashApi = (await import(join(repo, "src", "bash/index.ts"))) as unknown as typeof import("../src/bash/index.ts")

// The role-md parser, reached the same way: the split session-start files assert on
// policyFromBlock / bindingKey directly, so the import lives here once instead of once per file.
const rc = (await import(join(repo, "src", "role-config.ts"))) as unknown as typeof import("../src/role-config.ts")
export { handler, writeAgentMd, childSystemPrompt, specOf, specPathOf, liveSandbox, fakeClock, defaultProbe, workdir, repo, ext, wrapDispatchBindings, childRun, bashApi, rc, stateDir }
