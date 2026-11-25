# Refusals, budgets and probes

This is the runtime half of [architecture.md](architecture.md): what happens to a tool call once a
scope is active. What the code is divided into and where configuration comes from stay there.

## The refusal model

While a scope is active the extension fails closed — a tool that is not listed here is refused
too.

| Tool | Behaviour |
| --- | --- |
| `read` | path resolved (a missing one means the working directory), allowed when inside the scope, subject to `maxReads` |
| `edit` / `write` | the target must be inside the write scope (`writeScope`, defaulting to `scope`); `readOnly` refuses every write unless a `writeScope` is given explicitly |
| `replace` / `replace_match` / `insert` / `undo_last_change` | as `edit`: these are the edit family of an anchored-editing host (pi-hashline-edit-pro deletes the builtin `edit` from the active tool set and registers these instead) |
| `copy` / `move` | as `edit`, plus a second judgment: these two name **two** files — `source_from`/`source_to` belong to the source file, `anchor` (and `remove_*`) to the destination. Both are resolved separately and both are judged. `copy` only reads the source, so the source must be inside the **read** scope; `move` deletes the lines it takes, so the source must be **writable** too. The destination must always be writable. `tools.<name>.transferSource` overrides the source side (`read`/`write`), and a transfer tool the defaults do not know is judged as `write` on both sides. Resolving the two into one list would return whichever anchor came first — the source — leaving the destination unchecked, which let a copy write outside the write scope |
| `outline` | as `read` |
| `grep` / `find` / `ls` | as `read` |
| `bash` | refused entirely without an allowlist; with one, only matching commands are allowed and each is rewritten to run under the helper. The command is split on `&&`, `||`, `|`, `|&` and `;`, and every segment is judged on its own against the allowlist and the deny list, so a two-step command costs one call instead of two. What refuses the call whole is a construct that runs a command the judge cannot see: command substitution, a subshell, a background job, a heredoc, a newline, a backslash escape, an unbalanced quote. Quoting otherwise follows bash, since the command runs as `bash -lc <command>`: inside single quotes nothing is special, and inside double quotes `$` and a backtick still expand. Redirection is not a segment boundary, so `pnpm run build 2>/dev/null` matches an entry of `pnpm run build`; whether the write lands is decided by the write grant, not by the command text. Leading `NAME=value` assignments are stripped before an entry is matched, since `HOME=/tmp/x node a.ts` runs `node a.ts`; the scan is quote-aware and accepts `+=`, so `HOME="/tmp/my home" node` and `A+=1 node` are stripped too, and only a *leading* run of assignments is removed. Two consequences: an entry must start with the program name (`HOME=/tmp node` can never fire), and a `re:` entry still sees the command exactly as written. Names that change which program runs or load code into it (`LD_*`, `DYLD_*`, `NODE_*`, `npm_config_*`, `PYTHON*`, `PERL*`, `RUBY*`, `GIT_*`, `BASH_ENV`/`ENV`/`BASH_FUNC_*`, `PATH`, `IFS`, `PAGER`, `LESSOPEN`) are refused with a note naming the variable, because `NODE_OPTIONS=--require=/tmp/x.js node -e ""` really does execute `/tmp/x.js` — that would make the allowlist decoration. This is a deny-list, not a sandbox boundary: `HOME` is deliberately allowed (it is the common case and needs further conditions to inject), and a name nobody listed passes |
| `powershell` / `codemode` | always refused: there is no path to judge, so they would escape the scope |
| `structured_output` | allowed: a session-level tool that touches no files |
| `contact_supervisor` / `intercom` | always allowed: asking the supervisor is the escalation channel |
| anything else | refused, except names listed in `allowTools`; executor-type tools stay refused |

The last rule is what makes the extension a boundary rather than a filter: a tool added by some
other extension is refused until someone names it.

**Path tools are judged before `allowTools`.** The order is load-bearing: if a name is reached
through the allowlist first, the path judgement never runs, so listing a write tool in
`allowTools` would let it write anywhere. Judging first means the allowlist can only widen access
to tools this layer cannot judge at all.

**Names are defaults, not the whole rule.** `access` (read or write) cannot be derived from a
schema, so it comes from `DEFAULT_TOOL_ACCESS` — the builtin names plus the anchored-editing
family. The *path argument name* is not guessed: it is read from the tool's own `parameters`
schema (`path`, else `file_path`). A parent can override either through `bindings.tools`, whose
entries are `{ "<toolName>": { "access": "read" | "write", "path": "file_path" | false } }`:

- `path: false` declares a tool that has no path argument; a write tool declared that way is
  refused always — the target is unknowable, so no grant can cover it.
- a write tool whose path argument is absent from the call is refused with the argument named.
  Anchored-editing tools take an optional `path` until their `requirePath` option is on; that
  option is the fix, and the refusal says so.
- a malformed `tools` entry refuses everything (fail closed), like a malformed `scope`.

### The three write layers

Reads and writes are authorised by different lists, and neither is merged into the other:

| Layer | Field | Governs |
| --- | --- | --- |
| read | `scope` | `read`, `grep`, `find`, `ls` |
| write, tools | `writeScope` | `edit`, `write` |
| write, processes | the write scope, `bash.writablePaths`, a deliverable | the Landlock rules of bash subprocesses |

Without the split, "read the whole repository, write only `.pi/reviews`" cannot be expressed: a
reviewer either may edit `lib/` or may write nothing at all.

Keeping the third layer separate is not tidiness. A `git commit` inside a worktree writes to the
main checkout's `.git/objects`, which has to be granted — and `.git` must never appear in the write
scope, because that is what opens repository metadata to hand editing.

With a write grant, the sandbox is therefore given what the write scope covers plus git's own
directories and `node_modules`, not the working directory wholesale. A subagent that may read `lib/`
but not write it cannot route around the rule with a shell redirect.

The grant is read from the configuration: a write scope, `bash.writablePaths`, or a deliverable file. When all three are empty the sandbox gets no writable path at all, not even `.git` or `node_modules`, so a read-only task cannot plant a hook there.

What "covers" means is decided by the glob, because Landlock can only grant and a rule on a
directory grants everything beneath it. An entry that covers a whole subtree (`dir`, `dir/**`) opens
that directory; a file-level entry (`src/auth/*.ts`, `src/*/index.ts`) is expanded into the files it
matches, each granted as a file, so the parent directory stays read-only. Truncating at the first
wildcard instead — the earlier behaviour — handed the sandbox all of `src/auth/` for
`src/auth/*.ts`, which is wider than what `edit`/`write` may touch and defeats the point of a narrow
write scope. The price is stated rather than hidden: under a file-level entry a file that does not
exist yet cannot be created through bash, because creating it needs a directory grant; `write` still
creates it, and `dir/**` grants the directory when bash has to produce new files.

Git is the same question with a sharper edge, since `.git/hooks` and `.git/config` are code the
parent will later run. In a linked worktree the grants are the worktree's own gitdir (whole: the
index and HEAD locks are created there) plus `objects`, `refs` and `logs` of the common directory —
measured one at a time, each is what a specific command needs and nothing else, and neither `hooks`
nor `config` is among them. In a plain checkout the gitdir and the common directory are the same
directory, `index.lock` has to be created in `.git` itself, and Landlock cannot grant that directory
without granting `hooks/` and `config` with it: there `.git` is granted whole, and a subagent can
plant a hook. That is a limit of the mechanism, so it is documented rather than papered over — use a
worktree when the difference matters, which is the normal arrangement for delegated work here.

Build and test artefacts are the exception that makes this usable, and which ones they are follows
from what the project is built with. A write grant gives bash the artefact directories of every
toolchain whose manifest appears in the repository root or up to two levels below it — `package.json`
for Node, `Cargo.toml` for Rust, `go.mod` for Go, `pyproject.toml` for Python, `pom.xml` and
`build.gradle` for Java, and the rest of that table in `TOOLCHAINS` — with each directory resolved
next to its manifest, so a monorepo's `packages/web/coverage` lands in the right place.

The scan stops at two levels and at 200 directories, which is far above any real tree — this
repository reaches six — and the cap exists only so a pathological one cannot make every sandboxed
command walk thousands of entries. Its order is fixed by sorting the entries by name, because
`readdir` order is a property of the filesystem: tmpfs returns sorted names, `ext4` with `dir_index`,
XFS and NFS return hash order. Without the sort, which directories land inside the cap would differ
between two machines holding the same repository, and the writable directory set could differ with nothing in the output to explain it.

Directory symlinks are not followed. A manifest that is itself a symlink still counts, but a *package directory* reached only through a symlink is invisible to the scan. Following it would be
wrong here rather than merely incomplete: this same walk feeds the writable set, so a link pointing
outside the repository would widen what the sandbox may write instead of narrowing it, and cycles,
links to enormous trees and network mounts come along for free. Real projects rarely put a manifest
behind such a link, and the escape is to name the directory in `bash.scratchPaths`.

Two tiers keep this quiet. A directory that exists is granted; a directory the toolchain always
creates (`target`, `__pycache__`, `_build`) is also created when missing, because the first
`cargo test` in a fresh checkout would otherwise fail; anything merely conventional (`dist`, `.next`,
`coverage`) is granted only when the project already has it. The extension does not invent
directories it has no evidence for, and it never consults git for this: `git ls-files --ignored`
answers what is generated, which is not the same question as what the project builds with, and it
costs two subprocesses per sandboxed command.

Caches that belong outside the repository (`go`'s build cache, mypy's) are moved with a single
`XDG_CACHE_HOME` pointing at a persistent `~/.cache` directory. The sandbox's `/tmp` is a per-call
tmpfs, so a cache there is thrown away every command: measured on a fresh module, `go test` takes
3.5 s cold and 51 ms from the second call with the redirect, while a read-only host cache only lets
go reuse what is already there.

**A missing path is its own message.** `read` without a `path` assumes the repository root, and
`write` without one cannot be judged at all. Both say so, instead of pretending the scope rule
was the problem — an agent that reads "out of scope" tries a different path, while an agent that
reads "no path was supplied" supplies one.

### Probes

Four criteria detect a subagent going in circles or colliding with its permissions. The two
error-signal ones are on by default, because they misfire rarely. The two time-based ones misfire
on slow tasks, so they only apply when named: `"probe": {}` or `"probe": true` enables every
default, a partial object enables only the fields it names, `"probe": false` disables all of them.

| Criterion | Default | Behaviour |
| --- | --- | --- |
| Read-only idling | explicit: `idleWriteMs: 360000`, `abortGraceMs: 120000` | no write activity within `idleWriteMs` warns at the next tool boundary; after `abortGraceMs` more, the turn stops |
| Repeating a command | on, `repeatBash: 3` | the third `bash` command whose output did not change warns, the next one stops |
| Finished early | explicit: `successIdleMs: 300000`, `successPatterns` | once output matches a success marker, no new change within `successIdleMs` stops the turn |
| Writing litter | explicit: `forbidWritePatterns: []` | a `write`/`edit` target matching the pattern is refused outright |

Write activity is what the file tools do — `edit`, `write`, `copy`, `move` — plus what the kernel sees
a bash command do. The helper holds an inotify watch on the write scope (plus explicit
`writablePaths`, existing directories only) and reports at `<spec>.observe` whether anything changed
there, so a build or a code generator that produces files counts as progress without the extension
having to guess from the command line. Two runs leave no evidence either way: one whose change landed
outside the watched roots, and one where no watch could be installed — `watched: 0` means the write
scope does not exist yet. Neither is read as "wrote nothing". A task with
`readOnly: true` skips the two time-based criteria, which are meaningless for it.

A relative `writeScope` entry is bound to the task tree: `matches()` refuses anything whose real path
falls outside it, which is the only defence against a symlink escaping the scope. An **absolute**
entry is compared by prefix against the target's real path instead, so it can name something outside
the tree. That is deliberate rather than an exception to the rule — an absolute path is the parent
naming a destination, and a subagent cannot construct one to escape with. It is how a read-only
review is given exactly one file to write: `readOnly: true` together with
`writeScope: [".pi/review-reports"]`, plus `write` in `allowTools`. Without an explicit
`writeScope`, `readOnly` still means no writes at all.

The repeating-command criterion means "the same thing repeated **without progress**", so a file edit
clears its counts and cancels a warning already issued: a subagent that edits a file and re-runs the
same test command is working, not spinning. Every allowed bash command is counted, including
interpreters such as `node`; a command that the kernel sees change a watched path resets the check, and
so do the file tools. This was measured
the hard way: two coding subagents were stopped mid-task by the criterion before the reset existed.

### The stall watchdog

`bash.cpuStallSeconds` arms a watchdog in the helper, not in the extension, because only the helper
can see the whole command tree: it is PID 1 of the private PID namespace, so `/proc` inside it lists
the subtree plus the supervisor itself, which is excluded from the sum; without a namespace it falls
back to walking parent links. Either way the measurement is cumulative
`utime + stime + cutime + cstime` — the `cutime`/`cstime` halves keep the sum from dropping when a
short-lived child is reaped, which would otherwise read as idleness and kill a working build — sampled
at `clamp(threshold / 4, 250 ms, 1 s)`. The upper clamp matters: sampling and exit detection share the
loop, so a period that grew with the threshold would delay every command's completion by up to that
much (with a 90 s threshold, a `true` took 22.5 s to return before the clamp existed).

A wall-clock timeout cannot distinguish the two failures this targets. A six-minute `cargo build` and
a six-minute deadlock look identical from outside; CPU time separates them, because a compiling tree
gains CPU in every sample and a tree blocked on a lock, a socket, or a child that died without closing
a pipe gains none. When the tree has been quiet for the full threshold the helper kills it — inside
the namespace that means killing the subtree, on a host it means walking the descendants first — prints
one line naming the measurement, and exits with `79`, a code distinct from "the spec was bad" (`77`)
and "the sandbox failed" (`78`) so the caller can tell them apart. Landlock does not permit an unknown
exit path either way; the code is a signal, not a channel.

It is off by default and both of its limits are real. A command that waits on purpose — `sleep 300`, a
backoff loop — uses no CPU and will be killed. And the helper cannot corroborate with output, because
stdio is inherited rather than piped; making it visible would mean buffering the command's output
inside the supervisor, which is a different piece of work with its own cost for large builds. The
result is annotated with a `[sandbox]` note that says a retry stalls the same way, since the natural
model reaction to a killed command is to run it again.

### What a stopped run is told next

The call that trips a stop gets the reason in full, naming the command or the path involved. Every
call after it gets a status line instead: the run was stopped earlier, nothing further will execute,
report to the parent. Re-serving the original reason is the trap — it describes the action that caused
the stop, and a subagent that has since changed course reads it as a verdict on the new command.

A stop fired by a timer is the exception that has to be handled rather than assumed: the idle and
done-early paths have no tool call to answer, and their reason goes to the session's UI notification,
which the model never sees. (The stall watchdog is a different mechanism entirely — it is the helper
killing a command, so its reason arrives in that command's own result.) So the first tool boundary after such a stop delivers the
reason, and only the ones after that get the status line. Announcing "the stop message above says why"
when no such message was ever delivered is worse than saying nothing.
Measured: a child stopped for repeating `ls -la …/.pnpm` moved to `ls -la docs` and was told the
`.pnpm` story again, so it spent its remaining turns looking for a problem in `docs`.

Whether there *are* turns after a stop depends on pi, not on this extension: a hard stop ends the turn
when every result in the batch carries `terminate`, and a subagent that keeps calling tools continues
to get refusals. `contact_supervisor` and `structured_output` stay open throughout, so a stopped
subagent can still report.

### The denial budget

`maxDenies` defaults to five; an explicit `0` disables it. Only refusals that **widening the
parent's authorisation could resolve** count: an out-of-scope path, a command not in the
allowlist, the read budget, a tool missing from `allowTools`, bash disabled.
An offline command from the fixed network-command list is in the same class: the parent can grant
`"network": true`, so refusing it before the command starts counts toward the collision budget.
It charges the grant budget, not the write budget: no file was touched.

Write refusals have their own budget, `maxWriteDenies`, defaulting to two. It is separate on
purpose: a reviewer that keeps trying to write its report is making a usage mistake, and the answer
is to deliver the report another way, not to conclude that the parent granted the wrong scope. A
`readOnly: true` write belongs on this budget rather than the one above, because it is the same
refusal as an empty `writeScope`: writing will not become possible however much is granted, so the
way out is a report, not an escalation. A single out-of-scope read therefore does not push a write
refusal towards a stop, and the refusal says so — it names the write scope (or the read-only mode)
and points at the report.

Usage errors and hard rules never count: a missing path, a construct that runs a command the judge never
sees (command substitution, a subshell, a background job, a heredoc), an empty command,
`powershell`/`codemode`, or a command matched by the role md's `bash.deny`. Those cannot be fixed by
granting more, so charging them against the budget would stop a task for the wrong reason.

The budget is **consecutive**, which is what the refusal text and the README promise: any allowed
working call resets both counters, so a subagent that tries a path, learns, and moves on is never
stopped for a mistake it already corrected. The rescue channel is the exception — `contact_supervisor`
and `structured_output` are always allowed, but they are a report, not progress, and counting them as
progress would let a subagent alternate a probe with an escalation and sit at the warning level
forever. A broken binding (unparseable `extensionBindings`, a `scope` that is missing or malformed)
uses the default budgets rather than `0`: everything is refused, and the run has to stop after a few
refusals instead of retrying until the deadline.

### The stop is hard

At the grant budget the subagent is warned that the parent most likely authorised the wrong paths,
and is told to escalate; at the write budget it is told that a report is the deliverable and that
the write scope is the limit. One more counted refusal ends the run either way. Every blocked
result carries `terminate`, so pi ends the turn as soon as the whole batch is terminating. There is
no closing report after a stop: the parent reads what the subagent produced before it, plus the
refusal text.

That is why `contact_supervisor` and `intercom` are checked **before** every stop mechanism. Once
a run is stopping, the model cannot act on advice — the refusal text addresses the parent instead,
and the rescue channel stays open so a difficulty can be reported rather than silently absorbed.

Refusals are written for the model that reads them: short, and saying what would have to change.

## What a refusal adds

Two annotations are appended to a `bash` result, both to stop an agent from retrying something
that cannot start working. Both apply **only when the command actually failed** — the tool result's
`isError` is the gate, not the text of the output. Without that gate a successful command whose
*output* mentions `EACCES` is annotated: measured on a subagent running `git diff`, whose own patch
contained such a string and came back carrying "this is outside the writes the parent granted".

`bash.network` off, `requiresNetwork` in `src/bash/network.ts` names a fixed list of programs and subcommands that only make sense with a round
trip: `curl`, `wget`, the netcat family, `telnet`, `ssh`/`scp`/`sftp`, the DNS and host-reachability
probes, `gh`, `docker pull|push|login`, `npm|pnpm|yarn publish`, and `git clone|fetch|pull|push|ls-remote`
plus `git remote update` and `git submodule update --remote`. The check runs after the allowlist and
path judgements but before a spec is written, and names the tool that would hang, explains that the
offline netns drops packets rather than refusing connections (so there is no failure text for a
post-hoc note), and tells the model to ask the parent for `"network": true`. It is a permission
collision on the grant budget, not the write budget.

The matcher looks past surface spellings: the program goes through `basename()`, so `/usr/bin/curl`
counts, and the pass-through wrappers `env`, `sudo`, `nice`, `timeout`, `command` and `stdbuf` are
peeled to the program they actually run, skipping the wrapper's own flags and flag values. `git`'s
global flags (`-C`, `--git-dir`, `--work-tree`, `--no-pager`, `--progress`, `-c`) are skipped when
locating the subcommand, so `git -C repo fetch` is judged but `git log --fetch` is not. Anything the
matcher cannot resolve confidently — an unknown wrapper flag, `command -v curl`, a name assembled
at run time — is allowed through. Quoted text is never parsed: `bash -c "curl …"` is deliberately
not judged, because deciding what a shell string would execute is a different problem from naming
the program on the command line.

A few narrow local forms are excluded on purpose: `curl file:///…` (and `file:/…`) reads a file, not
the network, and `curl --version` / `-V` / `--help` / `-h` print local information and exit. `gh --version`, `gh version`, `gh help` and `gh config get …` only read local state;
every other `gh` subcommand and every other curl URL is still judged.

**Accepted false positives.** `git push /local/path` is judged as a network git subcommand and
`nc -z localhost` as netcat, even though both could complete offline. Telling those apart would mean
resolving a git remote's URL or parsing a netcat target host; that costs more than this guidance is
worth, so the boundary is accepted and documented rather than parsed. The way out is the same
`contact_supervisor` request for `"network": true` used for any other network refusal. The annotation
below remains as a fallback for network failures the list does not cover.
Looking past path prefixes has the same cost: `foo/curl`, `./curl` and `curl/` all count as curl even when they name a local file, because resolving the actual executable costs more than this pre-spawn guidance is worth.

**Network.** When the command ran offline and failed on the network (`ENETUNREACH`, `EAI_AGAIN`,
`ENOTFOUND`, a resolve failure), a one-line `[sandbox]` note says the network is off per the
parent's bindings, that this is a permission rather than a broken machine, that retrying will fail
the same way, and that `contact_supervisor` asking for `"network": true` is the way out. A raw
errno reads like a broken machine, which is exactly what makes an agent retry with another
registry, flag or timeout.

**Writes.** A `bash` write outside the granted directories is decided by evidence, not wording:
the extension keeps the `write` list of the spec the command ran under, takes the path out of the
refusal line, and annotates only when that path is outside the list **and** the host can read it.
A readable path that Landlock refused cannot have been refused for reading, since reads are
unrestricted — that is what keeps `cat /etc/shadow: Permission denied` from being blamed on the
sandbox. Unresolvable cases stay silent rather than guess. Paths ending in `.lock` are skipped as
well: in a worktree the common directory only grants `objects`, `refs` and `logs`, so git prints
`Unable to create '…/packed-refs.lock': Permission denied` on every commit while exiting 0 and
committing anyway — annotating it would send the parent to widen a grant that is correct.

Neither note counts toward the denial budget, triggers a stop, or consumes the read budget: they
explain a result that already happened.
