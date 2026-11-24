# Testing
`pnpm test` runs every suite under `packages/pi-plugin/test`, all offline: no model, and no network
beyond localhost. The list is not written down anywhere — `scripts/run-tests.mjs` walks the tree — so a
suite that moves between areas still runs, and a new suite runs without anyone editing a script. (The
list it replaced named test/policy.test.ts and friends for weeks after the suites moved, which broke
`pnpm test` while every `mise run test:<area>` stayed green.)

| Suite | What it is |
| --- | --- |
| `test/wiring/extension.test.ts` | the extension's judgement through the handler, against a fake pi API |
| `test/policy/policy.test.ts` | the policy layer's own units: merge semantics, payload parsing, globs |
| `test/paths/paths.test.ts` | path judgement: the working tree versus the declared scope, quoted fragments, anchor ownership |
| `test/role/role-phase3.test.ts` | the role-md layer's units: main-repo anchoring, deliverable links, the worktree/setup/output/policy blocks |
| `test/role/context.test.ts` | the marker stripping and `.pi/main-only.md` injection |
| `test/mock-engine.test.ts` | the mock LLM itself — fixture routing, validation, interpolation — over plain HTTP, no pi process |
| `test/mock-session.test.ts` | a real pi process, driven by a scripted mock model |
| `test/role/dispatch-payload.test.ts` | real pi sessions prove a dispatch payload constrains the child: a wrapped payload is enforced, a flat one is refused |
| `test/hashline-e2e.test.ts` | a real pi process loading the real `pi-hashline-edit-pro` |
| `test/docs/doc-payload.test.ts` | every bindings payload shown in a markdown file is still accepted by the reader |
| `test/docs/version-consistency.test.ts` | the binding version hardcoded in every markdown file matches `role-config.ts` |
| `test/docs/doc-paths.test.ts` | every `test/…test.ts` path a document names still exists |

Case counts are deliberately not tabulated here: each suite prints its own, and the runner relays the
last line of every suite's output, so a suite that suddenly runs zero cases shows up in the log next to
its name instead of in a table nobody re-measures.

Four more real-session suites run standalone (from the package directory) and are not wired
into `pnpm test`, whose runner skips every `e2e-*.test.ts`: `node test/sandbox/e2e-bash.test.ts`,
`test/wiring/e2e-budgets.test.ts`, `test/role/e2e-role.test.ts` and `test/wiring/e2e-guards.test.ts`
(`mise run test:e2e` runs all four). `e2e-bash` walks the bash sandbox's boundaries, where the
verdict is what landed on disk; `e2e-budgets` (4) covers the `allowTools` gate and the two
refusal budgets, one YAML fixture per case; `e2e-role` (3) drives a parent dispatch through the
role-md layer — scope, deliverable, preExec; `e2e-guards` (4) covers the startup report, the
tool-result annotations, the namespace-version warning and the zero-config control.
`test/e2e.test.ts` below is the manual real-model check and is deliberately outside `test` as well.
`cargo test` in `packages/helper` covers the sandbox itself: the ABI check, the ruleset, the
namespace decisions, the capability drop and process supervision.

## One suite whose cases run the helper for real

Several scope cases do not stop at inspecting the rewritten command: they execute it, so the
assertion is about the kernel rather than about the string. Those run only where the kernel can
enforce the sandbox. Below Landlock ABI 7 the suite points `PI_SUBAGENTS_EXTEND_HELPER_PATH` at a stub
that answers `--describe` with ABI 7 and runs nothing, says so in its output, and the live blocks
print `skip` — asserting on the stub's silence would test the stub, not the sandbox.

The helper the suite executes is the cargo build output
(`packages/helper/target/release/pi-subagents-extend-helper`), never the copy in
`packages/pi-plugin/bin/`: that copy is what a loaded extension resolves, so a test run that wrote
to it would replace the binary under a live session. `pretest` therefore only builds; installing
into `bin/` is the separate `pnpm run build:helper`, and `PI_SUBAGENTS_EXTEND_HELPER_PATH` overrides
the path when a specific binary is wanted.

Verified both ways through that override: a fake ABI 3 helper gives three skips and a green suite,
and the real one executes all of them.

The suites are TypeScript and are included in `tsconfig.json`, so `pnpm run typecheck` checks them
too. That is not cosmetic: `await h.call(...)?.block` reads the property off the promise, which the
compiler rejects and JavaScript silently accepts as `undefined` — the shape of a test that passes for
the wrong reason.

`scripts` in `package.json` run them through node's type stripping, so there is no build step
between editing a test and running it.

## How the tool-judging layer is covered

The layer decides whether a tool call may touch a path, so most cases assert one of three things:
allowed, refused by the read scope, or refused by the write scope.

Tool *classification* is declared, not inferred: `DEFAULT_TOOL_ACCESS` maps a name to `read` or
`write`, `bindings.tools` overrides it, and the path *argument* name is read from the tool's own
`parameters` schema (`path`, else `file_path`). Cases 87-92 pin the declared classification: `replace`
and `undo_last_change` are judged by the write scope, `allowTools` cannot widen a path tool, a missing
target names the argument without charging the budget, a custom tool is judged by its declaration,
`path: false` means always refused, a malformed `tools` entry refuses everything, the schema-derived
argument name is honoured, and a tool named `constructor` or `__proto__` cannot reach a declaration
through the prototype chain.

Case 96 covers `replace_match` separately, because it was the one tool whose anchors the list did not
know: its two ends are called `replace_from` / `replace_to` (the host's own schema), not the
`remove_from` / `remove_to` that `replace` uses. Missing that pair meant every anchor-only
`replace_match` — its normal shape on a host with `requirePath` off, i.e. the host this layer targets —
was refused with "pass the path explicitly", advice the model cannot follow.

Case 97 covers anchors that do not agree on one file. Two shapes reach or could be imagined here, and
only the first is reachable:

- `remove_from` in one file and `remove_to` in another. This arrives at this layer untouched, and the
  rule refuses it rather than judging whichever anchor happened to resolve first. The host's own
  `resolveEditTarget` refuses it too (`paths.size > 1`), so the point is that this layer's decision does
  not *depend* on the host getting there first: a target that is not unique has no answer, and picking
  one is how a judgement silently covers the wrong file.
- both spellings at once, pointing at different files. This one cannot reach the layer: the host
  normalizes aliases in `prepareArguments` before schema validation, and pi's `tool_call` hook receives
  the post-normalization arguments (`agent-loop`: `prepareToolCallArguments` → `validateToolArguments` →
  `beforeToolCall({args})`). The case pins it anyway as the same rule, and says so.

Mutation-verified on the reachable shape: restoring first-match-wins makes the case *allow* the split
payload. The test asserts refusal and the note the model gets, not a claim about the escape.

The two failure modes are reported differently, because their exits differ. An anchor that cannot be
resolved at all means "re-read the file, the anchors may have expired"; anchors that disagree mean the
payload itself is invalid, so the note names both files and says to split the call — re-reading would
hand back the same refusal. `anchorTargetPath` therefore returns `{path}` / `{miss: "unknown"}` /
`{miss: "disagree", files}`, and case 97 pins the disagree wording.

Case 98 covers the explicit `path` that `copy` / `move` accept. The anchors' owning file comes from the
registry as an absolute path (`toCwd`), and the host compares the *resolved* form of `providedPath`
against it (`resolveInCwd` → `toCwd`). This layer must compare the same way: comparing the raw input
string rejected every relative spelling — `docs/b.md`, `./docs/b.md` — which is the form the model
usually gives and the form the host's own `read` output displays, so legitimate transfers were refused
with advice ("pass the path") the model had already followed. Mutation-verified: restoring the raw
comparison turns the relative-source assertion red.

Cases 93-94 cover recovering a write target from anchor ownership, which the host records in
`sessions/<sha256(sessionFile)[0:24]>.registry.jsonl` as `allocate` / `free` / `clear` events. A
resolver miss must refuse, never allow. Case 94 deliberately uses `scope: ["."]`: with a narrower
scope the fallback target `.` would be refused for the wrong reason and the case would stop
discriminating.

Case 95 covers the two-file tools. `copy` and `move` name a source and a destination in one
call, and the two must be judged separately: resolving them into one list returns whichever anchor
comes first, and that is the source, so the destination went unchecked — a copy out of the write
scope was allowed. The case pins both directions (copy's source may be read-only, move's may not),
the escape (destination outside the write scope is refused, naming the destination), the positive
controls (both sides writable is allowed, so "refuse everything" cannot pass), the
`transferSource` override, and an unresolved destination.

Every case here was mutation-verified — the implementation was reverted and the suite went red —
because a case that cannot fail proves nothing.
## End-to-end against the real host extension

`test/hashline-e2e.test.ts` is the only suite that loads a **third-party** extension.
`pi-hashline-edit-pro` is a pinned devDependency, and the suite drives it in a real pi process:
scripted model, real tool schemas, real anchor sidecar.

The unit cases above test this layer against a fake pi and a fake sidecar — that is, against *my
model* of the host. Two things this layer depends on belong to the host, not to me: the shape of its
tool arguments, and the anchor registry it writes (a JSONL sidecar next to a sqlite hash store).
Either can change in a release and leave every unit case green while a real subagent either cannot
edit a file at all or writes outside its scope. So the verdict here is not a message: it is whether
the file on disk changed.

Anchors cannot be written into a script — the host derives them from file content — so the second
scripted step is a **function** of the incoming messages: it reads the anchor out of the previous
`read` result and calls the tool with it. That is why `mock-llm.ts` accepts function steps.

The five cases: an anchor-only edit inside the write scope lands on disk (proves the sidecar
resolution works against the real format); an anchor owned by an out-of-scope file is refused and
that file is untouched; a cross-file `copy` whose destination is outside the write scope is refused
and the destination is untouched; the reverse control — a `copy` whose source is read-only and
whose destination is writable — succeeds, so the three refusals cannot be satisfied by refusing
everything; and a `copy` that passes the destination as a relative `path` — the spelling the model
usually gives — also lands, because the host resolves the argument against cwd before comparing and
this layer must compare the same resolved form. Only a real host can prove it accepts that
spelling.

The host's config directory is redirected with `PI_HASHLINE_DIR`, which the host honours itself, so
its sidecar and hash store land in a temporary directory and the user's real configuration is never
touched. If the package is missing the suite fails rather than skipping: a suite that skips when the
host is absent is a suite that never runs.


## A real dispatch in this repo loads the published package, not your checkout

The e2e suites above put the extension into the child explicitly: the fixture role md carries
`subagentOnlyExtensions: <checkout>/src/index.ts` (`EXT` in `test/role/e2e-role.test.ts`), and the
session runs with an isolated `PI_CODING_AGENT_DIR`, so nothing else can load. That is why they test
the working tree.

An ordinary dispatch you start by hand does not work that way. The child loads whatever is installed
globally — `pi install npm:pi-subagents-extend` in `~/.pi/agent/settings.json` — so after editing
`src/` a real subagent still runs the **published** version, and both the refusal texts and the
behaviour you observe belong to that version. Verifying a checkout change therefore means one of:

- run the e2e suite for the area (fixtures declare the checkout), or
- temporarily point a role md's `subagentOnlyExtensions` at the checkout and dispatch, then put it
  back, or
- `pi install` the local package and accept that the checkout is what the machine runs.

Reading a green refusal as proof of an unshipped change is the mistake this section exists to
prevent.

## The mock model

`test/mock-llm.ts` is a dependency-free OpenAI-compatible server: `/v1/models`, and
`/v1/chat/completions` streaming `chat.completion.chunk` with text steps and tool-call steps. It has
two modes. `startMockLlm({steps})` is a single queue consumed in order, so a boundary is exact
rather than left to chance — whether a run continued is simply whether the next step was requested,
and `mock.requests.length` is the signal: after a hard stop it stops growing. A step may also be a
**function** of the incoming messages, which is how the hashline suite feeds an anchor read one turn
earlier into the next call; anchors cannot be written into a script, only read out of a previous
tool result. When the queue is exhausted the server answers 500, so "pi asked one more round than
expected" is an explicit failure, not a silent pass.

Sessions run through the officially exported `RpcClient` (`--mode rpc`), a long-lived child whose
lifetime the test controls. `pi -p` is unsuitable because it exits as soon as the parent agent goes
idle, which loses the process while a background subagent is still running.

The session is isolated with `PI_CODING_AGENT_DIR` pointing at a temporary agent directory whose
`models.json` declares the mock as an OpenAI-completions provider, so the user's own configuration is
not touched. Fake `contact_supervisor` and `structured_output` tools are registered by a fixture
(`-e` loads both it and the extension), because in a real session those come from other extensions;
their executions are recorded as marker files, which is how "the rescue channel really ran" is
asserted. `contact_supervisor` and `structured_output` need no `allowTools` entry: they are in the
safe set and are always allowed. The handoff cases additionally need `allowTools: ["subagent"]`,
because the fake `subagent` tool is not in that safe set.

The six cases: a hard stop after two out-of-scope reads with no closing turn; a mixed batch where
`contact_supervisor` runs while the same batch is refused (the case a real model cannot be relied on
to produce); an in-scope control; the regression where a call after a stop reports the stop reason
instead of a fresh verdict; and the two channels that carry the worktree handoff annotation.

## Scenario fixtures

A queue written in TypeScript is tied to the one driver that runs it. A scenario is data — YAML
under `test/fixtures/mock/` — that any host driver can replay, which is what the host-agnostic
contract below is for. `startMockLlmFromFixture` runs the same HTTP server, keyed by conversation
instead of a global cursor, and `loadMockFixture` (`test/mock-fixture.ts`) loads a YAML file;
inline objects go through the same `validateMockFixture`, so a file and an object fail with the
same messages, each carrying the source plus the offending path (`sessions[1].turns[0].reply`).

Schema:

```yaml
name: role-scope          # optional; labels error messages
model: mock-1             # optional; what /v1/models advertises (startMockLlmFromFixture's options.model overrides)
sessions:
  - name: child           # required, non-empty; error messages name it
    when:                 # required object; both keys optional, both present must both hold
      systemPromptContains: "role-scope"   # substring of all system-message contents joined with \n
      messagesContain: "..."               # substring of the JSON-serialized request body
    turns:
      - reply:
          text: "{{toolResults}}"          # finish_reason: stop
      - reply:
          calls:                           # finish_reason: tool_calls
            - name: read                   # non-empty
              args: { path: in-scope.txt } # optional, must be an object when present
```

- A conversation is identified by the SHA-256 of its first system message's content (first 16 hex
  characters). On its first request the server scans `sessions` **in order** and assigns the first
  session whose `when` holds; the assignment never changes afterwards. A predicate that also
  matches the parent must therefore be placed after the child's.
- `reply` must set exactly one of `text` or `calls`; validation refuses both and neither.
- Two placeholders are interpolated into `reply.text`: `{{lastToolResult}}` is the text of the most
  recent `tool` message in the request (empty string when there is none), `{{toolResults}}` is
  every tool message's text joined with `\n` in order. Any other `{{...}}` stays literal, so a
  typo shows up in the transcript instead of silently interpolating empty.
- A session consuming more turns than configured, and a conversation matching no session, both
  answer 500: the first names the session and its configured turn count, the second lists every
  configured session with its `when`. `mock.sessions` records `turnsConsumed` per conversation key.

## When to use which mode

A single session with a scripted queue is enough for tool-gating behaviour — mock-session's hard
stop and budget cases need nothing else. A scenario with two sessions is for anything where a
parent dispatches a child: the parent's turns script the dispatch, the child's script the work,
and each consumes its own cursor, so interleaved requests cannot move each other's position.

## Host drivers

`test/hosts/types.ts` keeps a scenario test host-agnostic:

```ts
export interface HostRun {
	toolResults: { tool?: string; text: string }[];
	assistantText: string;
	transcript: unknown[];
	stderr: string;
	stop(): Promise<void>;
}

export interface HostDriver {
	readonly name: string;
	run(input: {
		project: string;   // the temporary project the session runs in
		mockUrl: string;   // where the fixture-backed mock listens
		agentDir: string;  // the isolated PI_CODING_AGENT_DIR
		prompt: string;
		timeoutMs: number;
	}): Promise<HostRun>;
}
```

`run()` starts the host against the temporary project, sends the prompt, and returns what a
scenario test asserts on — the tool results with their tool names, the assistant text, the raw
transcript and stderr; `stop()` ends the session. `test/hosts/pi.ts` implements it over the
officially exported `RpcClient` (see above for why `pi -p` is unusable); opencode or dsh can
implement the same interface and replay the same YAML files unchanged.

Two traps are measured, both in the pi driver:

1. The spawned session must not inherit the caller's `PI_*` environment: `PI_SUBAGENT_CHILD` alone
   makes pi-subagents skip registering its tools, and `PI_SESSION_*` would attach this "parent" to
   somebody else's session. A filter that merely omits the keys does not survive — `RpcClient`
   builds the child's environment as `{...process.env, ...options.env}`, so the spread adds every
   omitted key back. The driver sets each `PI_*` / `HERDR_*` key to `undefined` explicitly (spawn
   drops undefined-valued keys) and only then overrides `PI_CODING_AGENT_DIR`.
2. `RpcClient`'s `provider` / `model` resolve against the isolated `PI_CODING_AGENT_DIR`: the
   `models.json` written into that directory is what declares the mock as an OpenAI-completions
   provider with its `baseUrl` at `mockUrl`. Nothing in the caller's own configuration participates.

The pi driver also writes `{ toolActivation: "eager" }` into the extension's config, because a
scripted parent has no turn to call `subagents_enable`, and it deliberately does **not** register
the fake-tools fixture — the subagent call under test must reach the real pi-subagents tool, not a
stub that shadows it.

## Real-model runs

For final debugging only, never part of `pnpm test`:

```bash
pnpm run test:llm                      # pi's default model
PI_E2E_MODEL=<provider>/<model> pnpm run test:llm
PI_E2E_KEEP=1 pnpm run test:llm        # keep the temporary project and read the transcripts
```

It creates a disposable project holding an `AGENTS.md` with markers, a `.pi/main-only.md`, a
`.pi/extensions/` symlink and two agent definitions, then runs four sessions: the main session, a
foreground subagent, a background subagent (`async: true`) and a control without the extension. The
verdict rests on codes that exist only inside the isolated content: the main session and the control
must produce them, both subagents must answer `NONE`. The background subagent writes its answer to a
file itself, so collecting that evidence does not depend on the parent turn being woken.

A boundary a real-model run reveals comes back as a scripted case in the mock suite, so the suite
stays deterministic.

## Continuous integration

Four legs, all running the full suite. The images are pinned by version, because what these legs
assert is a property of the kernel, and `ubuntu-latest` moved from 24.04 to 26.04 underneath: a
floating label would change the subject of the test without changing the test. Each leg prints its
image and running kernel.

| Leg | Measured kernel | Landlock ABI | Namespaces | Asserts |
| --- | --- | --- | --- | --- |
| `26.04-namespaces` | 7.0.0-1019-azure | 8 | allowed after a sysctl | `network isolated` |
| `24.04-namespaces` | 7.0.0-1014-aws | 8 | allowed after a sysctl | `network isolated` |
| `26.04-fallback` | 7.0.0-1019-azure | 8 | refused by AppArmor | `cannot enter the namespaces` |
| `22.04-abi4` | 6.8.0-1070-azure | 4 | allowed | `ABI 7 is required`, exit 76 |

Ubuntu's default (`apparmor_restrict_unprivileged_userns=1`) lets the user namespace be created and
then refuses `setgroups`, mount, network and PID; the leg that needs them lifts the restriction with
a `sudo sysctl` on a throwaway VM. The fallback leg deliberately leaves it alone.

Each leg's self-check runs the helper directly and fails the build unless it reports the shape that
leg is supposed to see, so a run that quietly took the wrong path fails instead of passing. One
such check already paid for itself: the helper used to print its "network isolated" line only when
there were resolver sockets to shadow, which made "real namespaces" and "silently fell back" look
identical in the log.

24.04 turned out to run a 7.0 kernel as well, so the two namespace legs differ in image, kernel build
and flavour (aws against azure) rather than in kernel generation. 6.8 is the only older kernel on
offer, and at ABI 4 it cannot run the sandbox at all — that leg tests the refusal.

## Checking a published install

CI builds and publishes from the working tree, so nothing there can tell you what a user gets after
`pi install`. `mise run verify:install` (needs network) installs the current version into an empty
`PI_CODING_AGENT_DIR` and checks the copy that landed: the version it asked for is the version it
got, the settings entry pins it, both helper binaries are present under the names the resolver
looks for, the native one answers `--describe` with a usable Landlock ABI, no `test/` shipped, and
the shipped `src/` equals this checkout byte for byte.

That last comparison only runs when the checkout sits exactly on `v<version>`; on an ordinary working
tree — which is ahead of the last release by definition — the line degrades to a note saying the
comparison did not happen. The difference matters: "matches" is a claim, "not compared" is not.

Run it from the tagged commit when verifying a release: only there does the comparison above say
anything, and only there is a red line about the tarball a statement about what users install.
