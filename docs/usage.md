# Usage

Everything a parent agent can say to this extension, and the shapes worth copying.

## Three layers, three questions

A binding answers three separate questions, and they are deliberately not merged:

| Question | Field | What enforces it |
| --- | --- | --- |
| What may the subagent read? | `scope` | the extension, per tool call |
| What may it write by hand? | `writeScope` (or `readOnly`) | the extension, per `edit`/`write` call |
| What may its shell write? | the write scope, `bash.writablePaths`, a deliverable | the kernel, via Landlock |

They stay apart because the answers differ in practice. A coder in a linked worktree needs the
repository's `objects/` and `refs/` writable for `git commit`, and must never have them in
`writeScope` — `.git` in a hand-write scope is how a subagent plants a hook the parent later runs.

## Bindings reference

The parent passes them per dispatch:

```text
subagent(
  agent: "worker",
  task: "Fix the null pointer in login.ts",
  extensionBindings: { "pi-subagents-extend/1": { "permissions": { "scope": ["src/auth/**"], "maxReads": 20 } } }
)
```

The namespace key never holds policy fields directly: a dispatch wraps them in `permissions`. The role md's `extend.permissions` block uses the same fields under different spellings: it spells the write scope `write` and the deny budgets `budgets.deny` / `budgets.writeDeny`; a dispatch uses `writeScope`, `maxDenies` and `maxWriteDenies`, plus the dispatch-only `maxReads`. `worktree` is a sibling of `permissions` in a dispatch, never a field inside it; the role md also keeps `worktree` as a separate block. Those spellings are not interchangeable. `setup` and `output` in a dispatch are ignored with a warning; put `setup.preExec` and `output.deliverable` in the role md.

| Field | Level | Type | Meaning |
| --- | --- | --- | --- |
| `scope` | `permissions` | `string[]` | Globs describing what the subagent may read. Required; an empty array refuses all file access. |
| `writeScope` | `permissions` | `string[]` | Globs describing what a write tool may touch (`edit`/`write`, or the host's anchored-editing family: `replace`, `replace_match`, `insert`, `copy`, `move`, `undo_last_change`). Defaults to `scope`; an empty array makes writing impossible while reads keep working. Relatives are bound to the task tree; an **absolute** entry is an absolute grant and may point outside it (a review writing one report file). A refused write is charged to `maxWriteDenies`, not `maxDenies`, and the refusal points at a report. |
| `readOnly` | `permissions` | `boolean` | Refuse `edit` and `write`. On its own it is the same as `writeScope: []`; an explicit `writeScope` alongside it wins, so "read-only except this one file" is expressible. Charged to `maxWriteDenies`, answered with a report rather than an escalation. A **dispatch** that sets this without its own `writeScope` is read-only even when the role md carries one (`review`'s report directory is the shape): the dispatch's intent wins. Name a `writeScope` in the same layer to keep "read-only except this one file". |
| `maxReads` | `permissions` | `number` | Cap on successful reads. |
| `allowTools` | `permissions` | `string[]` | Extra non-executor tool names to allow. It cannot widen a path tool: names this layer already judges are judged first, so adding `replace` here does not let it write outside the write scope. A dispatch naming it replaces the role md's list; an omitted field is filled from the role md. |
| `setup` | md `extend` block | `object` | `preExec` is one shell command the child runs at session start, **before the sandbox is applied** — the only moment dependencies can be installed, since a fresh worktree has no workspace `node_modules` and the sandbox has no network. Leaving it out does not fail loudly: a package manager asked to run a script decides the dependencies are stale, tries to install them, and retries each failed fetch after a minute, so the task can sit there for half an hour with nothing on stdout. See [Step 2b](../packages/pi-plugin/skills/pi-subagents-extend/SKILL.md#step-2b-install-dependencies-in-setuppreexec). |
| `worktree` | md `extend` block | `object` | Optional, defaults to no intervention. `enabled: true` makes a `subagent` or nested `subagent_launch` call whose `agent` resolves to this strategy get `worktree: true` filled in if the caller did not supply one (`??=` on the *dispatch argument*: `null` and `undefined` count as absent; an explicit `false` wins). This is a default, not a grant: no call is refused and neither deny budget changes. No resolvable strategy means no fill. `nodeModules` (`keep`, the default, or `remove` to unlink the freshly created worktree's `node_modules` symlink) is the other field. The dispatch *argument* `worktree` is the plain boolean; this block is not, and a boolean here is reported and ignored. |
| `tools` | `permissions` | `object` | Per-tool overrides for tools the defaults do not cover: `{ "my_edit": { "access": "write", "path": "file" } }`. `access` is `read` or `write`; `path` names the argument holding the target path, or is `false` for a tool with no path argument (a write tool declared that way is always refused); `transferSource` (`read`/`write`) says how a two-file tool's **source** is judged — `copy` reads its source while `move` deletes from it, and the built-in defaults already say so. The path argument name is taken from the tool's own schema when omitted, so anchors-based tools usually need only `access`. A malformed entry refuses everything. |
| `maxDenies` | `permissions` | `number` | Consecutive grant refusals before the run stops; an allowed working call resets the count. `0` disables. Defaults to 5. |
| `maxWriteDenies` | `permissions` | `number` | The same budget for write refusals, which are counted separately; defaults to 2. |
| `probe` | `permissions` | `object \| boolean` | Circles-and-collisions detection; see [probes](architecture-refusals.md#probes). |

### bash

| Field | Type | Meaning |
| --- | --- | --- |
| `bash.allow` | `string[]` | The allowlist column. It answers only *may this command run here*; what it may write is a directory question, settled by the write scope and `bash.writablePaths`. Matching is per token as a prefix, or `re:` regexes (which see the command exactly as written). |
| `bash.network` | `boolean` | Restore networking inside the sandbox. |
| `bash.writablePaths` | `string[]` | Further writable paths, such as the pnpm store. They also count as a write grant: a task with only `writablePaths` still gets the git and artefact-directory machinery the sandbox needs. |
| `bash.scratchPaths` | `false \| string[]` | Adjusts the build/test artefact directories, which are derived from the toolchain manifests the project has; `false` disables detection, an array appends explicit directories. |
| `bash.env` | `object` | Environment variables injected into the sandbox. |
| `bash.deny` | `string[]` | Commands no caller can re-allow. A role md's entries are unioned in from the caller's own, so a dispatch can add deny entries but never remove one. |
| `bash.cpuStallSeconds` | `number \| false` | Off by default. When set, the helper samples the CPU time of the whole command tree — it is PID 1 of a private PID namespace, so the tree is what `/proc` shows — and kills it once the tree has used **no** CPU for that many seconds, printing why and exiting `79`. The point is to separate a deadlock from a slow build, which a wall-clock limit cannot: a compiling tree gains CPU in every sample, a tree waiting on a lock, a socket, or an orphaned child gains none. Two limits to know before turning it on: a command that deliberately waits (`sleep 300`, a backoff loop) also uses no CPU and will be killed, and the helper cannot see output because stdio is inherited rather than piped, so "no output" cannot corroborate the reading. That is why nothing is armed by default — pick a number well above your slowest quiet gap between CPU bursts. The kill is annotated with `[sandbox]` in the result, saying a retry will stall the same way. |


There is no command read/write classification: `allow` only decides whether a command may run. Every allowed command runs under the same Landlock rules. A write outside the granted directories is refused by the kernel at runtime, and the failed result gets a note: `[sandbox] <path> is outside the writes the parent granted (<granted paths>) — a permission, not a filesystem fault. Writing elsewhere will not help; use contact_supervisor to ask for writablePaths or a wider write scope.`
With the network off, `git push /some/local/path` and `nc -z localhost` are still refused as network commands even though both could complete offline; the fixed list and its carve-outs are in [refusals](architecture-refusals.md#what-a-refusal-adds).

### What bash may read

The sandbox's read face stays open: `node`, `rg`, `cargo` and the rest live in `/nix/store`, so narrowing
the read root would kill every command at once. Reads are the file tools' job — `read`, `grep`, `find`
and `ls` are judged against `scope` before they run.

One nudge applies on top, to **every** allowed bash command, and it is judged
against the **working tree**: the directory the command runs in, which is the session's cwd. A token
qualifies as a path when it contains a slash and consists only of path characters — `src/index.ts`,
`./a.ts`, `../outside/x` and `~/x` all do, while `foo`, `--flag` and `@scope/pkg` do not. It is resolved
(symlinks by their real target) and, when that real path lands outside the working tree, the command is
refused with the path named:

```text
pi-subagents-extend: "/home/someone/notes" is outside the working tree (source: …). This is a path nudge,
not a wall: the command runs in /home/shay/extensions/pi-subagents-extend, and a file outside it is not
yours to read — say what you need from it instead.
Working tree: /home/shay/extensions/pi-subagents-extend
```

The point is the shape of a wasted run, measured: a child hunting for an API inside a 258 MB package with
`rg -a -o '<pattern>' /nix/store/…` produced empty output for every pattern that did not exist, read that
as "no match", and burned half an hour on 140 more guesses. Naming the path ends that in one turn — and
that command is refused now, because a toolchain directory is where a child goes looking, not what the
task is about.

It is a nudge, so it is deliberately loose, and the looseness is the design, not an oversight: a token
that could be something else — quoted, containing `$VAR` or a backtick, a glob, a URL, a colon — is
skipped rather than guessed at, and nothing is checked past the first 32 candidates or in tokens over 200
characters. These count as allowed:

| Command | Why it passes |
| --- | --- |
| `/nix/store/…/bin/rg -n pattern` | the program token is exempt: it is the tool being run, not a file of the task's |
| `cat /etc/passwd` | `/etc`, `/proc`, `/dev` and `/sys` are the system's, not the task's |
| `node -e 'require("/nix/store/x")'` | the token is quoted, so it is skipped |
| `rg "$DIR"` | dynamic, so the token is skipped |
| `rg foo https://example.com/a` | a URL, so skipped |
| `rg foo /tmp/out.md` | the command's private scratch directory, unless the session's cwd is itself under it — then the helper does not privatise that directory and it is an ordinary host path |
| `rg foo ~/.cache/pnpm/store` | a path covered by a write grant, such as `bash.writablePaths` or an absolute `writeScope`, is exempt — otherwise that grant would be unusable from bash |
| `rg -n ./src/auth/login.ts` | inside the working tree, so the check passes — the same holds for the bare spelling `src/auth/login.ts`, which is a candidate too since it contains a slash |
| `rg foo escape-link/x` | **refused** when `escape-link` is a symlink to `/home/other`: the relative spelling is not an escape route, the real path is what counts |

A quoted token is skipped whole, so `rg foo "/home/other/x"` runs: the quoting is the reason, not what
the argument means. One gap is worth knowing: `~user/x` is not expanded — only `~/` is — so the token
lands under the working tree and passes, while `~/x` does expand and points at the home directory, which
is outside the tree.

Refusals here are charged to `maxDenies`, like the other refusals a wider grant would answer, and the
message says which way out applies: use `read` when the read scope covers the file, or say what is
needed from a file outside the tree.

**`scope` and the working tree are two different contracts.** `scope` is the authorisation for the
**file tools** — `read`, `grep`, `find`, `ls`, `edit`, `write` — and it can be much narrower than the
tree: `scope: ["src/auth/**"]` is the normal shape. The **working tree** is where a command runs, and it
is what this nudge judges, because a build or a test run has to read the whole tree: `cargo build` reads
`Cargo.toml`, `pnpm` reads the root `package.json`. Judging a bash argument by `scope` would refuse
those ordinary commands. So the two answer different questions: `scope` answers *may this file tool read
this file*, the working tree answers *may this command point at this path*.

### Allowlist entries that cannot work from the working directory

Some allowlist entries can never fire from the session's working directory. The extension says so
once at session start, instead of letting the child discover it by running the command:

- A package-manager entry (`pnpm`, `npm`, `yarn`, `bun`) needs a `package.json`, and `cargo` needs a
  `Cargo.toml`. Both are looked up **from the working directory upwards** (eight levels at most),
  the way the tools themselves do it: a child running in `packages/pi-plugin/` still finds the
  repository's manifest, so such an entry is not reported. Entries that need no manifest at all
  (`pnpm --version`, `pnpm store path`, `npm --help`, `pnpm dlx`, `bun test`) are not reported either, and
  neither are entries whose scope the working directory does not decide (`--manifest-path`, `-r`,
  `--filter`, cargo's `-C`). An entry that names its own package directory (`--dir`, `--prefix`)
  is judged against that directory, not against the working tree.
  The walk starts at the **resolved** path: a command runs in the process's physical working directory,
  so a `package.json` that exists only on the literal path (an ancestor reached through a symlink) is one
  the tool will never see. Walking both chains would judge such a dead grant reachable and stop reporting
  it — the opposite of what this check is for. If the path cannot be resolved (it no longer exists), the
  literal path is used so the judgement does not throw.
- An absolute-path entry is checked against the file system. A path inside a build-artefact
  directory (`target`, `dist`, `build`, `out`, `node_modules`, `.git`, `.venv`, `__pycache__`) is
  not reported while the file is missing: it only needs one `cargo build`.

A reported entry comes with the reason, and with the form that would work when the working tree
holds exactly one package that has the script (`pnpm --dir packages/pi-plugin run typecheck`).
With several candidate packages it lists up to eight of them instead of picking one — which package an
entry meant is the parent's to say — and summarises the rest as `… and N more`, because a monorepo can
hold hundreds and one message has to stay readable. When the only candidate does not have the script
the entry names, it says ``no candidate has a `typecheck` script`` rather than asking which package was
meant: that is a missing script, not a wrong directory, and moving to another package cannot fix it.

The same fact reaches the child: when such a command runs and fails, the result is annotated with
`[sandbox] this command ran, but "pnpm run typecheck" cannot work from <cwd>: …`, followed by the
form to use or the candidate list (capped the same way). The entry it names is **the one the allowlist
actually used to authorise the command**, not merely another entry that matches it: the allowlist can hold
a reachable `pnpm --dir packages/a run build` next to an unreachable `pnpm run typecheck`, or next to a
wider `pnpm` that would also match — a failure of the first must not be explained with either of the
others. Once the list is truncated, the text says so (`only the first 8 are listed`): asking someone to
pick from a list whose tail was cut is asking for a guess. The annotation is only added to a failed result.

## Recommended scenarios

Each JSON block in this section is the inner `permissions` object; put it under `permissions` in the namespace key when dispatching.

### A reviewer that may write exactly one report

The report is longer than a reply can carry, and a reviewer that cannot write has to compress it.
`readOnly` alone forbids every write; naming one absolute path allows that file and nothing else.

```json
{
  "scope": ["."],
  "readOnly": true,
  "writeScope": [".pi/review-reports"],
  "allowTools": ["read", "grep", "find", "ls", "bash", "write", "contact_supervisor"],
  "maxDenies": 12,
  "maxWriteDenies": 2,
  "bash": { "allow": ["git diff", "git show", "rg", "cat", "ls"] }
}
```

The grant is the path, not the name: `read` / `write` / the host's edit family are judged by the scopes
*before* `allowTools` is consulted, so listing `write` there neither authorises nor restricts it — the
example lists it only because a reader otherwise wonders. Bash redirection (`>`, `>>`) is not refused by
the command judge — the redirect stays inside its segment — so `rg foo > report.md` runs and the write
itself is decided by the write grant: under `readOnly` the kernel refuses it, and the failed result says
`[sandbox] … is outside the writes the parent granted`. The report still belongs in the `write` tool,
where the path is judged before anything runs.

That ordering has one consequence worth knowing: a tool this layer does not recognise is *not* judged by
the scopes, so allowlisting a **new** write tool (a plugin's own edit tool) allows it unjudged. Declare
it under `tools` — `{ "access": "write", "path": "<its path argument>" }` — and the scopes apply.

### A coder in a worktree

The whole tree readable and writable, with publishing reserved to the parent.

```json
{
  "scope": ["."],
  "writeScope": ["."],
  "bash": {
    "allow": ["git status", "git diff", "git log", "ls", "rg", "cat", "node", "sh", "pnpm", "cargo", "mkdir", "cp", "mv", "rm", "touch", "git add", "git switch", "git stash"],
    "deny": ["git commit", "git push", "git rebase", "git merge", "git reset", "git clean", "rm -rf"]
  }
}
```

`git commit` is in `deny` rather than simply left out of `write`, so no dispatch can re-allow it —
that is what a deny list is for, and it is the one part of the role md a caller cannot override.

### A read-only researcher

```json
{ "scope": ["."], "readOnly": true, "maxReads": 60, "bash": { "allow": ["rg", "git log", "git show", "ls"] } }
```

`maxReads` is a task-shape signal, not a security control: a researcher that needs 200 reads is
usually reading the wrong things. Hitting the cap is a refusal, so it is charged to `maxDenies`.

### A build or test runner

```json
{ "scope": ["."], "writeScope": ["."], "bash": { "allow": ["pnpm test", "cargo test", "cargo check"] } }
```

A write grant opens the write scope plus the machinery a build needs: `node_modules`, the
artefact directories of whichever toolchains the project declares (detected from manifests, never
from git), and in a linked worktree the parts of `.git` that `git add`/`commit`/`stash` write.
The grant is read from the configuration, not from what exists today: a write scope naming a file
the task will create still counts. With no write configuration at all the sandbox receives no
writable paths — not even `.git` or `node_modules`.

## Writing a report instead of escalating

A refusal is meant to end in a report, not a widened grant. The extension says which way out
applies, and the two differ:

- **A write refusal** (outside `writeScope`, `readOnly`, `writeScope: []`) cannot be fixed by
  asking for a wider read scope, so it is charged to `maxWriteDenies` and the answer is *deliver
  this as a report*.
- **A grant refusal** (path outside `scope`, a command not in the list, `allowTools`) is charged to
  `maxDenies`, and `contact_supervisor` is the way to ask for it.

Neither counts usage errors — a missing path, command substitution or another construct that runs a
command the judge never sees, an empty command — so a malformed call never spends the budget. A compound
whose second segment is merely not listed *does* spend it: that is a grant mismatch the parent can fix.

## Role defaults

Bindings written per dispatch are easy to forget, and forgetting them means no restriction at all.
A project declares per-role defaults in the role's own agent definition, `.pi/agents/<role>.md`,
under an `extend:` block:

```markdown
---
name: review
extend:
  permissions:
    scope: ["."]
    readOnly: true
    write: [".pi/review-reports"]
    bash:
      deny: ["git push"]
---
```

The `extend.permissions` block uses the same fields as the dispatch in the role md's spellings —
the write scope is `write`, the deny budgets are `budgets.deny` / `budgets.writeDeny`; a dispatch
spells them `writeScope`, `maxDenies` and `maxWriteDenies`. The reader recomputes the policy from the
md's merged fields, so a md that supplies `scope` produces an active policy with no other configuration
at all.

Two layers, one direction — role md → dispatch:

| Layer | Where it is written | What it does |
| --- | --- | --- |
| role md | the role's `extend` block in `.pi/agents/<role>.md` | the role's default: its write grant, its allowlist, its budget |
| dispatch | the `extensionBindings` of one call | the dispatch's values for the fields it names; the fields it omits keep the role md's default |

A dispatch inherits the role md's defaults only in the fields it does not name. Naming a field
replaces the md's list, so a dispatch is made tighter than its role simply by writing a shorter
list — and `bash.deny` is the one field no dispatch can narrow.

Merging is **per field**: a field the dispatch names wins, a field it omits is filled from the
role md, and the field list is the whole rule:

| Category | Fields | Why |
| --- | --- | --- |
| **replaced** | `allowTools`, `bash.allow`, `bash.writablePaths` | a field the dispatch names replaces the role md's list; a field it omits is filled from the md. These are grants, so a caller narrowing them is legitimate — a dispatch is made tighter than its role simply by writing a shorter list. An **empty array written in the dispatch** is not "add nothing" — it empties that column (see below). |
| **union, hard floor** | `bash.deny` | a deny entry is a restriction, not a grant, and no layer can lift one: "structurally forbidden" has to survive a dispatch that rewrites the allowlist. That is why it is unioned while the grant fields are replaced: a restriction survives, a grant may be narrowed |
| **replaced** | `scope`, `writeScope` | a task's range has to be able to be **narrower** than the role default. A union would grow file access on every dispatch — the wrong direction for the one field that decides what may be read, and it would make "narrower than the role" inexpressible |
| **the call wins** | `readOnly`, `maxReads`, `maxDenies`, `maxWriteDenies`, `probe`, `tools`, `worktree`, `bash.network`, `bash.cpuStallSeconds`, `bash.scratchPaths` | these describe *this* task, so the dispatch's value is the value. `probe` and `tools` are replaced whole, not deep-merged. `bash.env` merges per variable name, the call winning on a collision |

Why `deny` can never be anything but a union: the role md's deny list is where a project writes what must
not happen at all (`git push`, `git reset`). If a call could replace it, every dispatch would have to
restate the whole list, and the one that forgets silently opens the command.

`reset` (and `bash.reset`) is still accepted by the parser but **does nothing**: the merge step
that gave the key its meaning is gone, so a dispatch carrying `reset: true` simply inherits the
role md's lists. To narrow a dispatch, name the fields you want instead — a named field replaces
the role md's list, an omitted field is filled from it:

```json
{
  "pi-subagents-extend/1": {
    "permissions": {
      "scope": ["src/auth/**"],
      "allowTools": ["read"],
      "bash": { "allow": ["pnpm run typecheck"] }
    }
  }
}
```

That dispatch may run `pnpm run typecheck` and nothing else, and its `allowTools` is exactly
`["read"]`, not a union with the role's list, however many commands and tools that role md carries.

An explicit empty list is a third instruction, distinct from both "omitted" and "one more entry":
`"allow": []` says *this column is empty* and replaces the allowlist the role md supplied, while
omitting `allow` inherits it and `"allow": ["x"]` replaces it with one entry. So
`"bash": { "allow": [] }` turns bash off for a dispatch even when its role carries a
long allowlist — writing the empty list is how you say "none of it", and it is the same refusal
as having no `bash` field at all.

A dispatch that sets `readOnly: true` without a `writeScope` is read-only even when the role md carries
one (`review`'s report directory is that shape): the read-only intent would otherwise be cancelled by
a grant the dispatch never asked for. Add `"writeScope": [".pi/review-reports"]` in the same
dispatch to keep "read-only except this one directory".

When both layers are in play the refusal's `source:` names both —
the role md plus `extensionBindings` — because the entry that answered may have come from either.

A dispatch to a role whose md carries the defaults passes only `agent`, `model` and `task` —
how a new role is wired up is in the usage skill
[`pi-subagents-extend`](../packages/pi-plugin/skills/pi-subagents-extend/SKILL.md#area-roles-one-md-per-code-area-policy-inside-the-md).
A role's `extend.worktree.enabled: true` fills the dispatch input instead of asking every caller to write it. The fill is `??=`: a missing or `null` `worktree` becomes `true`, and an explicit `false` keeps the call in the parent's working tree. The nested `subagent_launch` that pi-subagents sends before workflow children is treated the same way, keyed by that call's `agent` — so `tasks[]`, `chain` and script workflows are covered too. An agent with no resolvable strategy is left alone, and filling a value never refuses a call or moves a deny counter.
### Do not pin the edit tool in an agent definition

An agent definition's `tools` field is a strict allowlist over *registered* names, not a request to
load anything. That makes it host-dependent: the builtin `edit` disappears on a host running
`pi-hashline-edit-pro` (which deletes it and registers `replace`, `replace_match`, `insert`, `copy`,
`move`, `undo_last_change`), so a definition listing `edit` stops at the child's first request with
"declares tools: …, but an extension loaded in this child replaced the tools sent to the model".
Listing the anchored family instead breaks the child on every host that still has the builtin, and
listing both is fatal too, since a declared tool that never registered is itself a run error.

Leave `tools` out and let this layer bound the child: it judges path tools by the scope and refuses
everything that is not a known path tool, a safe tool, or allowlisted. Read-only roles can keep a
narrow `tools` list as long as every name exists on every host (`read`, `grep`, `find`, `ls`,
`bash`, `write` all do).

## Subagent-only skills

A skill that only a subagent should ever load — a heavy reference document, a workflow that
depends on the child's tool face — is marked in its own frontmatter, once:

```markdown
---
name: repo-architecture-reference
description: ...
subagent-only: true
---
```

Before each run, the extension drops such skills from the main session's advertised skill
list: the main agent's prompt carries neither the noise nor the temptation to run the job
it should delegate. The child keeps the skill, because pi-subagents injects the skill text
into the child's prompt directly — a child session has no pi-level skill catalogue to
strip, so nothing needs to be done for it.

`disable-model-invocation: true` is the wrong tool for this: pi honours it in the child
too, so the child would lose the skill along with the main agent. The two flags answer
different questions — `disable-model-invocation` means "no session's model may load this",
`subagent-only` means "only a subagent's model may". One escape hatch exists on purpose: a
prompt that explicitly names a `subagent-only` skill keeps it visible even in the main
session, so an explicit request still wins over the default hiding.

## Without a parent agent

Hand bindings reach the extension through `PI_SUBAGENT_EXTENSION_BINDINGS`:

```bash
PI_SUBAGENT_EXTENSION_BINDINGS='{"pi-subagents-extend/1":{"permissions":{"scope":["src/**"],"readOnly":true}}}' \
pi -e ~/extensions/pi-subagents-extend/packages/pi-plugin/src/index.ts -p "<task>"
```

`/permission` reports what the session actually resolved: source, read scope, write scope when it
differs, the bash allowlist, the helper path, `Sandbox: network on|offline` with its writable paths, both denial counters and the probe state.
