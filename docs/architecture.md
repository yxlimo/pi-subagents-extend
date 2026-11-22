# Architecture

## Three entry points

The package exposes three modules. Which audience a module serves is decided by **how it is
loaded**, never by inspecting the session at run time.

| Entry point | Loaded by | Behaviour |
| --- | --- | --- |
| `src/index.ts` | the agent's `subagentOnlyExtensions`, plus ambient loading | scope and bash |
| `src/main-context.ts` | ambient loading only (`.pi/extensions/` symlink or a global install) | injects `.pi/main-only.md` into the main session; in a background subagent it strips the markers instead |
| `src/child-context.ts` | declared by an agent's `subagentOnlyExtensions` only | strips the markers, never injects |

Two context modules exist because a foreground subagent and the main session **cannot be told
apart from inside the process**: a foreground subagent runs in the same process and has no
`PI_SUBAGENT_CHILD`, so its environment is identical to the main session's, while a background
subagent is a separate process carrying that variable. The `PI_SUBAGENT_CHILD === "1"` check in
`main-context.ts` exists to stop background subagents, which load it ambiently too.

pi's frontmatter has two fields that matter here: `subagentOnlyExtensions` (this agent's
subagents) and `extensions` (same, plus the session itself). Foreground subagents load only what
is declared there; background subagents additionally load ambient extensions.

## How the code is divided

`src/index.ts` is the assembly layer: it reads the bindings once, creates the session
state, and registers seven event handlers as one-line delegations. It holds no
judgement of its own. Everything below depends only on `node:*` and the modules
before it — no module imports `index.ts`, which is what keeps the layers one-way.

| Module | What it owns |
| --- | --- |
| `wiring/context.ts` | the session state and the three functions that mutate it (`stop`, `armProbe`, `applyRoleBaseline` — which merges the role md with the dispatch payload) |
| `bash/index.ts` | the barrel every caller imports: allow-list rules, merge semantics, the single command matcher |
| `bash/tokens.ts` | quote-aware tokenizing, command segments, path candidates |
| `bash/env.ts` | leading environment assignments; refuses a `PATH`/`IFS`/`LD_PRELOAD` redefinition |
| `bash/programs.ts` | the read/write program tables, wrapper peeling, package-manager subcommand rules |
| `bash/network.ts` | which commands need a round trip, with the local-query carve-out |
| `bash/rules.ts` | rule parsing and merge, `classifyCommand`, the entry listing |
| `bash/unreachable.ts` | the manifest walk that reports an entry no invocation can reach |
| `policy.ts` | payload parsing, the merge semantics of role md and dispatch, globs |
| `paths.ts` | real paths, working-tree versus scope comparison, hidden-grant reporting |
| `dependencies.ts` | lockfile discovery, the dependency gate, scratch-directory probing |
| `budgets.ts` | the two refusal counters and their defaults |
| `notices.ts` | what the extension says about a grant: unreachable entries, legacy columns, the compat layer |
| `sandbox.ts` | the helper process, the granted path set, the spec written per call, command wrapping |
| `probe.ts` | gateway probing and the classification of a failure body |
| `role-config.ts` | role-md resolution, the `extend` block, identity from the prompt |
| `deliverable.ts` | the main-checkout anchor and the deliverable link |
| `context-scope.ts` | marker stripping and `.pi/main-only.md` injection |
| `wiring/session-start.ts` | the startup warnings, probe arming |
| `wiring/agent-start.ts` | the child's prompt sections, the role md read, deliverable wiring, `preExec`, the worktree decision |
| `wiring/tool-call/paths.ts` | whether a path argument may be touched |
| `wiring/tool-call/anchor.ts` | which file an anchor belongs to, from the sidecar |
| `wiring/tool-call/judge.ts` | the tool_call gate chain, in order |
| `wiring/tool-result.ts` | the annotations appended to a tool result |
| `wiring/misc.ts` | resource discovery, shutdown, handoff notes |

The order in `wiring/tool-call/judge.ts` is the semantics, not an implementation
detail: safe tools pass before a stopped session blocks anything, configuration errors
precede scope checks, and a refusal is charged to a budget only when more permission
could have fixed it. A passing work call resets both counters; the three safe tools do
not, so a child cannot stay in the warning tier by asking for help between probes.
## Configuration sources

Two, and either can stand alone:

- **Bindings**, passed by the parent on each dispatch as
  `extensionBindings: { "pi-subagents-extend/1": { "permissions": { … } } }`. pi-subagents encodes them into
  `PI_SUBAGENT_EXTENSION_BINDINGS`; the extension reads that variable once at activation, because
  it exists only until a foreground subagent's session starts and is then restored.
- **The role md**, the per-role default declared in the role's own agent definition
  (`.pi/agents/<role>.md`, `extend:` block) and loaded through the md-role loader. See [Role defaults](#role-defaults).

A dispatch's `extensionBindings` and the role md's `extend.permissions` block use the same fields under different spellings: the dispatch nests them under `permissions` and spells the write scope `writeScope`, the deny budgets `maxDenies` / `maxWriteDenies`, plus the dispatch-only `maxReads`; the role md spells the write scope `write` and the budgets `budgets.deny` / `budgets.writeDeny`. `worktree` is a sibling of `permissions` in a dispatch, never a field inside it; the role md also keeps `worktree` as a separate block. Those spellings are not interchangeable. `setup` and `output` in a dispatch are ignored with a warning; put `setup.preExec` and `output.deliverable` in the role md.
Without either, the extension does nothing: no scope, no refusals, no side effects.

Wildcards: `**` matches any number of directory levels, `*` any characters within one level, `?`
one character. A pure path glob also matches the directory itself and everything beneath it, so
`src` and `src/**` both cover the whole directory. Malformed bindings, or an invalid `scope`, fail
closed: the session keeps running, every file access is refused, and the refusal states why.

## Refusals, budgets and probes

What each tool call is judged against once a scope is active, the three write layers of the
sandbox, the probe criteria, the denial budget and the annotations a `bash` result can carry are
the runtime half of this file and live in [architecture-refusals.md](architecture-refusals.md).

## Context isolation

Three places for content, chosen by whom it belongs to:

| Content | Where | Visible to a subagent |
| --- | --- | --- |
| rules a subagent must follow too | an ordinary `AGENTS.md` section | yes |
| content that reads better beside the repository rules but is the main agent's | fenced by `<!-- main-agent-only:start -->` … `<!-- main-agent-only:end -->` | no |
| content that is wholly the main agent's | `.pi/main-only.md` | no |

The whole span between a pair of markers, comments and trailing blank line included, is removed
from a subagent's prompt; the main agent reads it unchanged. When a marker is left unterminated the
section is **kept** and the session records a warning: letting a subagent read one extra passage is
better than deleting half a file on a guess about where the boundary lies.

`.pi/main-only.md` is resolved against the project root and injected through pi's `sections` rather
than by rewriting the system prompt, because pi diffs sections and appends a single system message,
so the earlier prompt cache still hits.

A subagent started with `context: "fork"` receives the parent's prompt whole, isolation included;
isolation therefore requires avoiding fork context. This does not overlap pi-subagents'
`inheritProjectContext: false`, which is all-or-nothing and does not read the file at all — right
for a repository whose rules are irrelevant to subagents, wrong for one whose rules a subagent must
follow.

## Role defaults

Bindings have a practical gap: they can only be written by the parent **on each dispatch**, and an
agent definition has nowhere else to declare a default. Omitting them does not remove three
prohibitions — it returns at the top of `tool_call`, so every restriction disappears.

A role md keeps the default with the role. The policy is declared in the role's own agent
definition, `.pi/agents/<role>.md`, under an `extend:` block:

```markdown
---
name: writer
subagentOnlyExtensions: /path/to/pi-subagents-extend/.pi/agent-profiles/md-role.ts
extend:
  permissions:
    scope: ["."]
    bash:
      allow: ["git status", "git diff", "pnpm test"]
      writable: true
      deny: ["git stash", "git checkout", "git reset"]
---
```

The extension is loaded by `.pi/agent-profiles/md-role.ts` (`export default activate`), which
passes no profile name; the reader recomputes the policy from the md's merged fields, so a md that
supplies `scope` produces an active policy with no other configuration at all.

Merging runs over two layers, and the direction is one way: role md → dispatch.

| Layer | Source | Relation to the layer below |
| --- | --- | --- |
| role md | the role's `extend` block in `.pi/agents/<role>.md` | the role's default |
| dispatch | `extensionBindings` of one call | the dispatch's values for the fields it names; the fields it omits keep the role's default |

Rules per field — a field the dispatch names wins, a field it omits is filled from the md:

- **replaced** — `allowTools`, `bash.read`, `bash.write`, `bash.allow`, `bash.writablePaths`. A
  field the dispatch names replaces the role md's list; a field it omits is filled from the md.
  These are grants, so a caller narrowing them is legitimate — a dispatch is made tighter than its
  role simply by writing a shorter list. For these columns an **explicitly empty array in the
  dispatch** is a different instruction: it empties that column rather than adding nothing.
  Reading `"allow": []` as "add zero entries" left the role md's whole allowlist in place, so a
  dispatch that meant to close bash kept the grant. `bash.write` and `bash.allow` are separate
  columns: `write` grants write, `allow` leaves the read/write judgement to the extension.
- **union, hard floor** — `bash.deny`: **no caller can relax it**. That is what makes a project's
  structural prohibition different from an ordinary allowlist.
- **replaced** — `scope`, `writeScope`. A task range has to be able to be *narrower* than the role
  default; a union would widen file access on every dispatch and would make "narrower than the role"
  inexpressible.
- **the call wins** — the remaining scalars and switches (`readOnly`, `maxReads`, `maxDenies`,
  `maxWriteDenies`, `tools`, `probe`, `bash.writable`, `bash.network`, `bash.dependencyGate`,
  `bash.cpuStallSeconds`, `bash.scratchPaths`); `bash.env` merges per variable name.
- **`readOnly: true` with no `writeScope` in the same layer** empties the merged `writeScope`. Without
  that, a role md's `writeScope` (the `review` role's report directory is the shape) cancelled a
  dispatch's read-only intent, because the merged config then had an "explicit" write scope and
  explicit scope wins. Naming a `writeScope` in the same layer still expresses "read-only plus this
  one directory".
- A `bash` written as anything but an object is not ignored: the merged `bash` is empty, so bash is
  refused. Field-by-field merging made a broken layer fall through to the role md's whole
  allowlist — a typo kept every grant, the opposite of what a broken grant should do.
- The merged policy reports both layers in `source:` (the role md plus `extensionBindings`); a
  refusal is the one place the model reads that string, and the entry that answered may live in
  either.
- A role md may omit `scope`, since a role does not know a task's paths. File access is then
  refused entirely while the bash allowlist still applies, so a forgotten binding fails loudly on
  the first read instead of silently permitting everything.
- A role md that exists but cannot be parsed, or whose `extend` block is invalid, results in
  deny-all rather than no restriction. A role with **no md at all** is different, and deliberately
  so: it leaves the policy unchanged — the builtin agents (`worker`, `scout`, `delegate`) have no
  role md, so a missing md cannot be treated as an error.

The main session never loads the role md, so project defaults cannot lock it down by accident.

## Skills

The extension publishes three skills and registers them through `resources_discover`, so they
reach the system prompt of whichever session loads the extension and nothing has to be copied into
`AGENTS.md`:

| Skill | Contents |
| --- | --- |
| `pi-subagents-extend` | file scope, the bash columns and `re:` patterns, the sandbox, worktree setup, role defaults, a call template |
| `pi-subagents-extend-probes` | the probe criteria, the denial budget, warn and stop semantics, how to read a report after a stop |
| `pi-subagents-extend-context` | the markers, `.pi/main-only.md`, the three entry points |

pi advertises only a skill's name and description, so each description names the situations it
covers — the routing decision rests on that line alone. A session that is already scoped does not
register them.

## Boundaries

- The scope is a file-level boundary, not a content-level one: including `docs/**` permits reading
  the whole directory.
- The tool layer judges the **real** path, not the textual one. A symlink inside the scope that
  points outside it is refused, and so is any target whose real path leaves the working tree, even
  under a whole-tree scope (`"."` or `"**"`): a scope is written relative to the project, and the
  project is that tree. This matters because `edit`/`write` run in the parent process with no
  Landlock underneath — the sandbox judges inodes, they do not. Measured before the fix: `write
  src/link/evil` where `src/link -> /elsewhere` was allowed and landed outside.
- Reads are not confined inside the sandbox: a test suite must read the tree, its `node_modules` and
  its configuration, and the toolchain lives in `/nix/store`. Read confinement stays with `read`,
  `grep` and `find`, which are judged by `scope`. One nudge runs on top of the sandbox, for read-class
  commands only: a path argument that contains a slash and nothing but path characters is resolved
  (symlinks by their real target) and refused when it lands outside the **working tree** — the directory
  the command runs in, not the read scope — naming the path and saying what the way out is — see
  [usage](usage.md#what-bash-may-read). The toolchain directories are not exempt: the program being run
  is, because that is the tool rather than a file of the task's. It is a nudge, so it is loose by
  construction: quoted arguments, `$VAR`, globs, URLs and bare words are skipped, and the sandbox still
  reads anything the command asks for.
- The extension intercepts at `tool_call`. A subagent inherits the parent's environment and
  credentials, so this guards against overstepping, not against malice.
- Nested subagents do not inherit bindings: an unscoped nested subagent runs without this
  extension. Either disable `allowNestedSubagents` for a scoped session or pass bindings on the
  nested call.
