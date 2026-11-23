# pi-subagents-extend

A pi extension that confines a subagent to the files its task covers, and keeps main-agent-only
instructions out of a subagent's prompt.

When the parent delegates, it names the files the task covers. Inside the subagent every tool call
outside that scope is refused, so it cannot wander through the repository — and `bash`, the one tool
whose paths cannot be judged from its arguments, either stays disabled or runs under a kernel
sandbox that enforces the same boundary. Separately, a section of `AGENTS.md` fenced by
`<!-- main-agent-only:start -->` and `<!-- main-agent-only:end -->` never reaches a subagent, and
`.pi/main-only.md` is injected into the main session only. Either concern works without the other.

## Requirements

- Linux 6.15 or later for the sandbox (Landlock ABI 7). Below that, `bash` stays disabled rather than
  falling back to weaker rules; scope enforcement and context isolation are unaffected.
- pi-subagents, if you want the extension loaded per agent.

## Install

The package ships on npm with the sandbox helper prebuilt for linux-x64 and linux-arm64, so an
install needs neither Rust nor a network beyond npm:

```bash
pi install npm:pi-subagents-extend
```


From a checkout instead (contributing, or a change you want to try before it ships):

```bash
cd packages/pi-plugin
pnpm install
pnpm run build:helper                # cargo build --release, then into bin/
pi -e "$PWD"                         # this session only, no settings change
```

[How the extension gets loaded](docs/loading.md) covers every channel pi accepts, and which
parent-side features do nothing when only subagents load this package.

If the helper is missing or does not match the platform, a session with `bash` enabled says so when it
starts — it names the path the package carries and the `PI_SUBAGENTS_EXTEND_HELPER_PATH` override,
rather than waiting for the first `bash` call to fail.

A role is declared in the agent's own markdown: `subagentOnlyExtensions` names the md-role loader, and
the `extend` block carries its policy. `.pi/agents/` in this repository has ten working examples —
`coder-bash.md` is the shortest one to copy.

```markdown
---
name: worker
description: Implements a task within the given scope
systemPromptMode: append  # replace drops the <active_agent> tag the loader reads
subagentOnlyExtensions: /path/to/pi-subagents-extend/.pi/agent-profiles/md-role.ts
extend:
  permissions:
    scope: ["src/auth/**"]
    bash:
      allow: ["ls", "rg", "npm test"]
---
```

## Quick start

The parent passes the scope on each dispatch:

```text
subagent(
  agent: "worker",
  task: "Fix the null pointer in login.ts",
  extensionBindings: { "pi-subagents-extend/1": { "permissions": { "scope": ["src/auth/**"], "maxReads": 20 } } }
)
```

The namespace key never holds policy fields directly: a dispatch wraps them in `permissions`. A dispatch's `extensionBindings` and the role md's `extend.permissions` block use the same fields under different spellings: the dispatch spells the write scope `writeScope`, the deny budgets `maxDenies` / `maxWriteDenies`, plus the dispatch-only `maxReads`; the role md spells the write scope `write` and the budgets `budgets.deny` / `budgets.writeDeny`. `worktree` is a sibling of `permissions` in a dispatch, never a field inside it; the role md also keeps `worktree` as a separate block. Those spellings are not interchangeable. `setup` and `output` in a dispatch are ignored with a warning; put `setup.preExec` and `output.deliverable` in the role md.

That is the whole idea: `scope` is what the subagent may read, and everything else — writes, shell,
network — is off until named. A reviewer, for example, reads the repository and writes exactly one
report file:

```json
{ "pi-subagents-extend/1": { "permissions": { "scope": ["."], "readOnly": true, "writeScope": [".pi/review-reports"] } } }
```

That report path reaches the `write` tool but not `bash`: the helper mounts a private tmpfs over
`/tmp`, so a spec that grants a path below it is refused with exit 77 — see
[sandbox](docs/sandbox.md#files).

Recommended shapes for a reviewer, a coder in a worktree, a researcher and a build runner are in
[usage](docs/usage.md#recommended-scenarios), with the full field reference beside them.

## Skills

The extension ships three skills, offered to the agent that loads it:

| Skill | For |
| --- | --- |
| [`pi-subagents-extend`](packages/pi-plugin/skills/pi-subagents-extend/SKILL.md) | the parent agent: how to write a dispatch, what each field buys, and how to read a refusal |
| [`pi-subagents-extend-probes`](packages/pi-plugin/skills/pi-subagents-extend-probes/SKILL.md) | a subagent that was refused or warned: what is counted, what is not, and the way out |
| [`pi-subagents-extend-context`](packages/pi-plugin/skills/pi-subagents-extend-context/SKILL.md) | the context-isolation markers and the two entry points that apply them |

## Documentation

| Document | Contents |
| --- | --- |
| [docs/usage.md](docs/usage.md) | the field reference, recommended scenarios, role defaults, and running without a parent agent |
| [docs/architecture.md](docs/architecture.md) | the three entry points, how the code is divided, configuration sources, context isolation, role defaults |
| [docs/architecture-refusals.md](docs/architecture-refusals.md) | the refusal model, the three write layers, probes, the denial budget, the hard stop |
| [docs/sandbox.md](docs/sandbox.md) | what the helper does: Landlock, the namespaces, capabilities, and why offline means "no route out" |
| [docs/worktrees.md](docs/worktrees.md) | the worktree setup hook, the `node_modules` link, and what a worktree run delivers |
| [docs/testing.md](docs/testing.md) | the offline suites, the mock model, and the four CI legs |

## Development

```bash
cd packages/pi-plugin && pnpm install && pnpm run typecheck && pnpm test
cd ../helper && cargo test
```

`pnpm test` runs a lint pass and four offline suites: 163 scope cases, 10 context cases, 6 sessions
against a real pi process driven by a scripted mock model, and 5 end-to-end cases against the real
`pi-hashline-edit-pro` — no model, no network beyond localhost. See [testing](docs/testing.md).

## Boundaries

The scope is a file-level boundary, not a content-level one: the sandbox prevents out-of-scope
writes and network access, not reads, because running a test suite needs to read the whole tree.

This is not a sandbox against malicious code. A subagent inherits the parent's environment and
credentials, so it guards against a subagent overstepping its task, not against an adversary;
genuinely untrusted input needs container-level isolation. One concrete limit follows from Landlock:
in a **plain checkout** the sandbox is granted `.git` whole, because the index and `HEAD` lock files
live there and a directory cannot be granted without its `hooks/` and `config` — so a subagent
working directly in a checkout can plant a hook the parent would later run. In a linked worktree it
cannot, which is why delegated work runs in one.
