---
name: pi-subagents-extend
description: Use when a delegated pi-subagents subagent must stay inside a file and command scope, or when each code area needs its own role. Write the role once in its agent definition (`.pi/agents/<role>.md`, an `extend:` block) and dispatch with `agent`, `model`, `task` only. This skill answers the questions that decide whether that role actually bites - which file has to load the extension, which frontmatter fields to keep or delete, what `bash.allow` matches, what the sandbox stops on its own, and how to prove the role is in force. Every out-of-scope tool call is refused and the refusal names the file that decided it.
---

# pi-subagents-extend: keep a subagent inside its task

Two ways to use it:

- **One dispatch at a time.** Pass `extensionBindings` with a `scope`. Good for a single job, fails as a habit: it cannot ride along inside a `tasks` fan-out, and a dispatch that forgets it is unconstrained.
- **A role per code area.** Write the policy once in the role's own agent definition. Every dispatch to that role inherits it and passes only `agent`, `model`, `task`.

Everything below is the second way, because the first is one JSON block and the second is where people get stuck. The dispatch block itself is at [the end](#parent-side-dispatch-template).

## Step 1: confirm the extension is in the child at all

Nothing else in this skill works if the extension is not loaded in the child session. Which channel loads it depends on how you dispatch — and this is the part that silently fails:

| Dispatch | Child runs | How the extension gets in | What you must write |
| --- | --- | --- | --- |
| background (`async: true`) | its own `pi` process | ambient: the discovery directory (`~/.pi/agent/extensions/<name>/`) **or** an npm entry in the settings `packages` list | nothing |
| foreground (`async: false`) | inside the parent process | **ambient is not loaded at all** — only the agent's own `subagentOnlyExtensions` | that field, pointing at the installed entry |

`pi install npm:pi-subagents-extend` writes an entry in `~/.pi/agent/settings.json` under `packages`. That **is** the global install — there is no separate directory required, and both channels count as ambient.

So:

- You only ever dispatch background children → stop here, the extension is already in the child.
- You dispatch foreground children too → put `subagentOnlyExtensions: /home/<you>/.pi/agent/npm/node_modules/pi-subagents-extend/src/index.ts` (your real absolute path — no `~`, no glob) in the role md. It names the **installed** copy, the same file ambient loads for background children. A path into a development checkout is a different file: two copies, one of them stale.

Verify it before writing policy — a child that answers "command not allowed" is loaded; a child that just runs it is not:

```text
subagent(agent: "<role>", model: "<model>", task: "Run `git commit --allow-empty -m x` and report the exact error text you get.")
```

Expect a refusal that names the role md path. If the commit goes through, the extension is not in that child, and no `extend:` block you write will do anything.

## Step 2: write the role md

One file per role: `.pi/agents/<role>.md`. Copy this, then change the marked lines:

```markdown
---
name: coder-routing
description: One line: what this role owns, and which paths that is.
inheritProjectContext: true
# tools: — do not write it, see below
thinking: medium
systemPromptMode: append
# subagentOnlyExtensions: — only if you dispatch async: false, see below
extend:
  permissions:
    scope: ["lib/router/**", "lib/session-id.ts"]
    write: ["lib/router/**"]
    allowTools: ["read", "grep", "find", "ls", "bash", "write"]
    budgets:
      deny: 5
      writeDeny: 2
    bash:
      allow: ["git status", "git diff", "mise run typecheck", "mise run test:router:session-balance"]
      deny:
        - git commit
        - git push
        - git rebase
        - git merge
        - git reset
        - git clean
        - git checkout
        - git restore
        - rm -rf
  worktree:
    enabled: true
---

<the role's body: what it owns, its boundaries, the gates it runs, what it must deliver>
```

### The three frontmatter fields that decide whether this works

**`tools:` — delete the line.** It is a strict allowlist over *registered* names, checked when the child starts:

- `edit` is not registered on a host running `pi-hashline-edit-pro` (that extension removes it), so declaring it stops the child before its first request;
- the anchored family (`replace`, `replace_match`, `insert`, `copy`, `move`, `undo_last_change`) is not registered on a host without it;
- declaring both is fatal either way, since a declared tool that never registered is a run error.

Leave `tools:` out and this extension bounds the child instead: path tools are judged by `scope`, every other tool is refused unless it is in `allowTools`, a safe tool, or a runtime tool. The anchored family counts as path tools that write — they need a `write` grant, not an `allowTools` entry. A role that really wants a hard tool ceiling may keep a list, but only of names every host has: `read`, `grep`, `find`, `ls`, `bash`, `write`.

**`systemPromptMode:` — use `append`.** pi-subagents prepends `<active_agent name="…"/>` to the child prompt in *both* modes, so role identity resolves either way; the difference is what else is in there. `append` keeps the harness system prompt and adds the role body. `replace` makes the role body the entire system prompt: the child loses the standard instructions it needs to use tools well.

**`subagentOnlyExtensions:` — only for foreground dispatches.** Value is the absolute path of the loaded entry, e.g. `~/.pi/agent/npm/node_modules/pi-subagents-extend/src/index.ts` written out in full (no `~`). It names the *installed* copy on purpose: the same file ambient already loads for background children. When both copies do end up in one session, this extension registers once per session, so the second copy is inert rather than a second judge.

## Step 3: the permission block, field by field

Everything lives under `extend.permissions`, except `worktree` which is a sibling of `permissions` inside `extend`.

| Field | What it does | Default | The trap |
| --- | --- | --- | --- |
| `scope` | what may be read: `read`, `grep`, `find`, `ls` | absent = nothing readable while bash still works | relative to the session cwd, which is the worktree root |
| `write` | what the `write` / anchored family may write | absent = same as `scope`; `[]` or `readOnly: true` = no writes | needs the `packages/…` prefix if the session cwd is the repo root |
| `readOnly` | refuse every write | `false` | `readOnly: true` plus a `write` list in the *same* layer still means "read-only except that list" |
| `allowTools` | extra tools beyond the path family and the safe ones | empty | not needed for the anchored family or for `todo` / `contact_supervisor` |
| `budgets.deny` | how many widen-the-grant refusals before the session is stopped | `5` (5th warns, 6th stops) | only counts refusals a wider grant could fix — a wrong argument does not count |
| `budgets.writeDeny` | same for write refusals | `2` | keep it low: a role that keeps trying to write outside its area is not going to succeed |
| `bash.allow` | the commands it may run | empty = bash refused | matching rules are in [Step 4](#step-4-bash-what-matches-and-what-the-sandbox-stops-anyway) |
| `bash.deny` | commands refused no matter what | empty | a union floor: no dispatch can lift an entry, and it has no cross-file reuse |
| `bash.network` | outbound network for commands | `false` | the sandbox cuts packets; a command that dials out hangs rather than failing fast |
| `worktree` | the dispatch default for `worktree` | not set = the dispatch decides | fills a missing value only; an explicit `false` in the dispatch wins |

`scope` may be omitted for a role that does not know a task's paths: file access is then refused entirely and the bash allowlist still applies, so a forgotten binding fails loudly on the first read rather than silently permitting everything.

A role md that exists but cannot be parsed, or whose `extend` block is invalid, fails **closed**: every tool call is refused and the refusal names the file and the problem. A role with no md at all is different — the builtin agents have none, so a missing md leaves the policy alone.

## Step 4: bash: what matches, and what the sandbox stops anyway

**`bash.allow` matches tokens, not string prefixes.** An entry matches when its tokens equal the command's leading tokens, one for one. So:

- `"mise run check"` does **not** match `mise run check:admin` — different token, no match, no accidental widening;
- `"mise run test:policy"` matches only that task;
- `"git status"` matches `git status --short` and `git status`;
- a leading `VAR=value` is stripped before the comparison, so an allowed program cannot be hidden behind an assignment;
- `re:<pattern>` is a full-match regular expression when the entry starts with `re:` — that is how one entry covers a family: `re:mise run test:(policy|paths|bash)`.

**`bash.allow` decides whether a command may run, not what it may write.** There is no command read/write classification: `mise`, `make`, `just`, project scripts and package managers all run under the same Landlock rules. A task with a write grant gets the write scope, git's own directories, `node_modules`, the detected artefact directories and `bash.writablePaths` writable. With no write configuration the sandbox gets no writable path at all. A write outside that set is refused by the kernel while the command runs, and the failed result says `[sandbox] <path> is outside the writes the parent granted (<granted paths>) — a permission, not a filesystem fault`, pointing at `writablePaths` or a wider write scope.
- it must still be in `bash.allow`, or it is refused;
- mise's own state directory is pointed inside the sandbox (when the worktree has a `mise.toml`), so a task that writes state does not write it to the host — and the tool install directory is not granted either, so `mise` may run the tasks but cannot install a tool. Install tools from the parent session.

**Network is cut structurally.** Only listed network tools are refused up front (a refusal is friendlier than a hang); anything else that dials out — including a `mise` task — has its packets dropped inside the namespace, so it hangs or times out rather than telling you it was the network.

**The deny floor is copied into every md.** Nine entries, identical in each role that has bash: history rewrites (`commit`, `push`, `rebase`, `merge`, `reset`, `clean`, `checkout`, `restore`) and `rm -rf`. There is no `include`, no `extends`, no project-level floor file: the role md is the only place a default can live, and `deny` is the one field a dispatch cannot lift. `node scripts/check-role-grants.mjs` fails when a role md with bash is missing an entry, so drift is caught rather than discovered.

## Step 5: prove the role is in force

Policy that is loaded but not applied looks exactly like policy that works, until the first escape. Three checks, and do them for the dispatch shape you actually use:

1. **Out of scope is refused.** `read` a path outside `scope`; the refusal must name this role's md path.
2. **In scope is allowed.** `read` a path inside `scope` and report one line of it — otherwise check 1 also passes when *everything* is refused.
3. **The gates run.** `mise run <task>` (or whatever `bash.allow` names) returns real output. Dependencies are prepared at dispatch: `setup.preExec` runs `~/.pi/extensions/.pi/scripts/worktree-prepare.sh`, which links `packages/pi-plugin/node_modules` and copies the helper into the worktree.

Do the same once with `async: false` if you dispatch foreground children — that is the shape where the extension is missing entirely, and nothing in the parent session shows it.

## Migrating agent definitions that predate this

Per file: add `extend.permissions`, delete `tools:`, switch `systemPromptMode` to `append`, add `subagentOnlyExtensions` only if you dispatch foreground, keep the nine deny entries verbatim, and leave `description` alone (identity reads the body). A definition with no `extend:` block is unconstrained: it behaves as if this package were not installed.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The child runs out-of-scope commands as if nothing were configured | foreground dispatch with no `subagentOnlyExtensions`, or the path names a copy that does not exist | check 1 in [Step 5](#step-5-prove-the-role-is-in-force); declare the installed entry |
| Every bash call refused, refusal quotes a wrapped command you never wrote | two copies of this extension in one session; the second judged the first's sandbox wrapper | quote the refusal; with a current build activation happens once per session, so a second copy is inert — if you see this, the loaded copy is older than the declared one |
| `declares tools: …,edit,… but an extension … replaced the tools` | `tools:` pinned a name this host does not register | delete `tools:` |
| Two role mds are candidates / no role selected | two md bodies share their opening text, and the tag was not matched | make the bodies distinct, or keep `systemPromptMode: append` and no `tools:` |
| Writes fail with `EACCES` | the path is outside the write scope, `bash.writablePaths` and the artefact directories, or the task has no write configuration at all | widen `writeScope` / the role's `write`, name `writablePaths`, or deliver a report instead |

## Parent-side dispatch template

**Role md carries the default** — pass only these three:

```text
subagent(agent: "coder", model: "buddy/coder-d", task: "<task description>")
```

**One-off, file access only:**

```text
subagent(
  agent: "<agent-name>",
  task: "<task description>",
  extensionBindings: { "pi-subagents-extend/1": { "permissions": { "scope": ["<file/directory glob>", "..."] } } }
)
```

**One-off that runs tests:**

```text
subagent(
  agent: "<agent-name>",
  task: "<task description>; run typecheck afterwards and report the result",
  extensionBindings: {
    "pi-subagents-extend/1": {
      "permissions": {
        "scope": ["<file/directory glob>"],
        "bash": { "allow": ["pnpm run typecheck", "pnpm test"] }
      }
    }
  }
)
```

`extensionBindings` is a top-level parameter of `subagent` only: a `tasks` item, a `chain` step and a workflow script cannot carry it. That is the reason to put the policy in the role md — a fan-out has nowhere else to put it.

The dispatch spells the same fields differently from the role md: `writeScope` and `maxDenies` / `maxWriteDenies` instead of `write` and `budgets.deny` / `budgets.writeDeny`, and it nests them under `permissions`. Those spellings are not interchangeable. A field the dispatch names replaces the md's list; `bash.deny` is unioned and no dispatch can narrow it; an explicit empty array in a dispatch empties that column.

## Where the details are

- [usage](../../../docs/usage.md) — every field, the merge rules between the two layers, worked examples.
- [loading](../../../docs/loading.md) — every channel pi accepts and what is lost without it.
- [architecture](../../../docs/architecture.md) — why the layers are separate, why `deny` is a union.
- [refusals](../../../docs/architecture-refusals.md) — the refusal texts and what each one means.
- skill `pi-subagents-extend-probes` — when a child idles, loops, or finishes early.
- skill `pi-subagents-extend-context` — keeping the main-agent-only sections of `AGENTS.md` out of children.
