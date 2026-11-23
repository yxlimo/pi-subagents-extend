---
name: pi-subagents-extend
description: Use when delegating a pi-subagents subagent that must be confined to a file and command scope, and when giving each code area its own role. Declare the role once in its agent definition — `.pi/agents/<role>.md`, an `extend:` block holding the write grant, the command allowlist, the deny budget and the deliverable — then dispatch with `agent`, `model` and `task` only; a per-dispatch `extensionBindings` payload narrows one task further. Every out-of-scope tool_call is refused, allowlisted commands run in a Landlock sandbox (no network by default, writes confined to the grants), and a refusal names the file that decided it. Use it to keep a subagent from sweeping the whole repository, to allow typecheck/test, or to install dependencies in a worktree. Probe criteria and stopping are covered by pi-subagents-extend-probes, and stripping the main-agent-only sections of AGENTS.md by pi-subagents-extend-context.
---

# pi-subagents-extend: confine a subagent to the task scope

When delegating a subagent, pass the scope of this task through `extensionBindings` — or rely on the role md's `extend` block when the role already declares the default there (see [Area roles](#area-roles-one-md-per-code-area-policy-inside-the-md)). In the subagent's session, every tool_call outside that scope is refused (fail closed): this keeps the subagent from wandering through the repository aimlessly.

## When to use it

| Situation | Which field | See |
| --- | --- | --- |
| The subagent should only read/write the few files of this task | `scope`, plus `readOnly` for a read-only task | [The scope field](#the-scope-field) |
| The subagent should read the whole task scope but write into one directory (a review allowed to write only its report) | `writeScope` | [The scope field](#the-scope-field) |
| A read-only reviewer still needs to write its report somewhere outside the tree | `readOnly` + an absolute `writeScope` entry + `write` in `allowTools` | [The scope field](#the-scope-field) |
| The subagent has to run typecheck, tests or a build itself | `bash.allow` plus `writable: true` for commands whose program can write (`pnpm`/`npm`/`yarn`/`bun` with `run`/`test`/`exec` are refused at the gate without it; it also lets artefacts land on disk) | [The bash field](#the-bash-field) |
| The subagent runs in `worktree: true` and has to install dependencies | The project commits `.pi/worktree-setup.sh`, together with `writablePaths` / `network` | [bash in a worktree](#bash-in-a-worktree) |
| You do not want to hand-write the scope on every dispatch (it gets forgotten when you are busy) | the role md's `extend` block | [Area roles](#area-roles-one-md-per-code-area-policy-inside-the-md) |
| The subagent starts idling or going in circles | The other half of this package: probes | skill `pi-subagents-extend-probes` |
| AGENTS.md mixes in rules only the main agent should see | The other half of this package: context isolation | skill `pi-subagents-extend-context` |
| A heavy reference skill should load in a subagent only | mark it `subagent-only: true` in its own frontmatter — no bindings field; `disable-model-invocation` would hide it from the child too | [Subagent-only skills](../../../docs/usage.md#subagent-only-skills) |

The criteria and the stop (read-only idling, going in circles, finishing early, writing litter, colliding with permissions) are in the other skill, `pi-subagents-extend-probes`.

Context isolation (the sections fenced by `<!-- main-agent-only:start -->` in `AGENTS.md`, and `.pi/main-only.md`) is the other half of the same package: see skill `pi-subagents-extend-context`. It is decided by the entry point declared in the agent definition and has nothing to do with bindings — no field needs to be passed for it when delegating.

The delegation rules themselves (how to write the brief, how to wait, one cwd, one writer) follow the **skill shipped with pi-subagents**; this skill only adds the layer of "how to bind the scope and the command grants to a single delegation".

## Prerequisites

The delegated agent must be able to load this extension:
- the extension is installed globally (`~/.pi/agent/extensions/pi-subagents-extend`) and this delegation sets `async: true` (only background subagents use ambient discovery).

Without the extension loaded, passing bindings does nothing: no interception happens.

If the project uses the `<!-- main-agent-only:start -->` marker, add `, …/src/child-context.ts` to the same line, otherwise the subagent reads the main-agent-only sections (see skill `pi-subagents-extend-context`).

Allowlisted commands run under the sandbox helper (the Rust binary in `packages/helper`): the file scope is enforced by Landlock, the network is off by default (all outbound TCP/UDP is cut and DNS resolution fails, but loopback works inside the sandbox, so a local server can be started and reached), and processes and capabilities are isolated as well (the host processes are invisible, the command has no capability at all). The host needs Landlock ABI 7 (Linux 6.15+); when the helper is missing or the kernel is too old, bash stays disabled (the remaining features are unaffected).

## Call template

**When the role md already carries the default, pass only `agent`, `model` and `task`:**

```text
subagent(agent: "coder", model: "buddy/coder-d", task: "<task description>")
```

Hand-written `extensionBindings` narrows one task further than its role md, and is also the only way to bind a role whose md does not declare an `extend` block. It fails in two ways when used as the default:

- **A fan-out cannot carry it.** `extensionBindings` is a top-level parameter of `subagent` only. A `tasks` item accepts `agent`, `task`, `cwd` and `model` and nothing else, and rejects any other field; the same holds for a `chain` step and for `args.tasks` of a `workflow: "parallel"` script. There is no place in a parallel dispatch to declare a scope.
- **It is forgotten.** A dispatch that carries neither bindings nor a role md with an `extend` block is not constrained at all: the extension is loaded and inactive.

Declaring the default once in the role md removes both — see [Area roles](#area-roles-one-md-per-code-area-policy-inside-the-md).
Reading or writing files, no commands needed:

```text
subagent(
  agent: "<agent-name>",
  task: "<task description>",
  extensionBindings: { "pi-subagents-extend/1": { "permissions": { "scope": ["<file/directory glob>", "..."] } } }
)
```

The subagent has to run tests or typecheck itself:

```text
subagent(
  agent: "<agent-name>",
  task: "<task description>; run typecheck afterwards and report the result",
  extensionBindings: {
    "pi-subagents-extend/1": {
      "permissions": {
        "scope": ["<file/directory glob>"],
        "bash": { "allow": ["pnpm run typecheck", "pnpm test"], "writable": true }
      }
    }
  }
)
```

The namespace is fixed at `pi-subagents-extend/1`. Pass it on every delegation, and narrow the scope to the files and directories this task actually touches; do not default to the whole repository.

A dispatch's `extensionBindings` and the role md's `extend` block use the same fields under different spellings: the dispatch nests them under `permissions` and spells the write scope `writeScope`, the deny budgets `maxDenies` / `maxWriteDenies`, plus the dispatch-only `maxReads`; the role md spells the write scope `write` and the budgets `budgets.deny` / `budgets.writeDeny`, and keeps `worktree` as its own block. Those spellings are not interchangeable. `setup` and `output` in a dispatch are ignored with a warning; put `setup.preExec` and `output.deliverable` in the role md.
The subagent runs in a worktree (`worktree: true`) and has to install dependencies or run verification:

```text
subagent(
  agent: "<agent-name>",
  task: "<task description>",
  options: { worktree: true },
  extensionBindings: {
    "pi-subagents-extend/1": {
      "permissions": {
        "scope": ["src/auth/**"],
        "bash": {
          "allow": ["pnpm run typecheck", "pnpm test"],
          "writable": true,
          "writablePaths": ["~/.local/share/pnpm/store"]
        }
      }
    }
  }
)
```

`worktree` is a sibling of `permissions` in a dispatch, never a field inside it; the role md also keeps `worktree` as a separate block. A dispatch can therefore carry `{"pi-subagents-extend/1": {"permissions": {...}, "worktree": true}}`.

## The `scope` field

| Field | Type | Meaning |
| --- | --- | --- |
| `scope` | `string[]` | Required. Globs describing what the subagent may read; an empty array refuses all file access |
| `writeScope` | `string[]` | Optional. Globs describing what `edit`/`write` may touch. Omitted means the same as `scope`; `[]` means no writes at all while reads keep working. Relative entries are bound to the task tree; an **absolute** entry grants that path wherever it is |
| `readOnly` | `boolean` | Defaults to `false`; when `true`, `edit`/`write` are refused — the same as `writeScope: []` — which suits read-only research and review agents. An explicit `writeScope` beside it, in the same layer, wins, so a reviewer can be given exactly one file to write. In a **dispatch** it also beats the role md's `writeScope`: read-only means read-only unless this dispatch names a directory |
| `maxReads` | `number` | Optional. Upper bound on successful `read` calls; once it is exceeded, every read is refused |
| `maxWriteDenies` | `number` | Optional. Write refusals have their own budget: defaults to 2, `0` disables. Kept apart from `maxDenies` because repeatedly trying to write is a usage mistake, answered by delivering a report |
| `allowTools` | `string[]` | Optional. Extra tool names to allow; executor-type tools such as `bash` cannot be allowed this way. It cannot widen a path tool: file tools are judged by the scope first, so listing a write tool here does not free it from `writeScope`. A dispatch naming it replaces the role md's list; an omitted field is filled from the role md |
| `tools` | `object` | Optional. Per-tool overrides for tools the defaults do not cover: `{ "my_edit": { "access": "write", "path": "file" } }`. `path` names the argument that carries the target; `false` means the tool has no path argument, and a write tool declared that way is always refused. Omit `path` and the argument name is read from the tool's own schema. `access` is `read` or `write`; a tool that touches a **second** file (`copy`/`move`) takes `transferSource: "read"\|"write"` as well — `copy`'s source is only read, `move`'s is written to, and an undeclared transfer tool is judged as a write on both sides |
| `worktree` | `boolean` | Optional, defaults to `false`. `true` in the role md's `extend.worktree` block (or in a dispatch's own bindings) fills `worktree: true` on `subagent` and nested `subagent_launch` calls for that role when the caller did not supply it — `??=` semantics, so `null` / `undefined` are filled while an explicit `false` (or any other value) on the call wins. It only fills a value: no refusal, no deny-budget charge. An `agent` with no strategy is left alone (fail open). The role md is committed with the project, so a worktree copy carries it; a dispatch-only value does not survive a worktree by itself either way. |

Glob rules: `**` matches any number of levels (including zero), `*` matches characters within a single level, `?` matches a single character.

For a directory, `dir`, `dir/` and `dir/**` are equivalent: all three cover the directory itself and its contents at any depth; `dir/*` covers only the direct children. So write the scope as directories, not as a list of files — listing files is easy to get wrong, and files added to the directory later are refused too. A path directly under `dir/**`, such as `dir/a.ts`, is inside it.

Reads and writes are authorised by three separate lists, and this is deliberate:

| Layer | Field | Governs |
| --- | --- | --- |
| read | `scope` | `read`, `grep`, `find`, `ls` |
| write, tools | `writeScope` | `edit`, `write` |
| write, processes | `bash.writablePaths` (with `bash.writable`) | the Landlock rules of bash subprocesses |

So "read the whole repository, write only `.pi/reviews`" is `scope: ["."]`, `writeScope: [".pi/reviews"]`.

`"."` and `"./x"` are normalised, so they mean the whole tree and `x`; they are not matched literally.

Targets are judged by their **real** path, not the text of the call. A symlink inside the scope that points outside it is refused, and so is any target whose real path leaves the working tree — including under `scope: ["."]`. A scope is written relative to the project, and the project is that tree, so `src/link` pointing elsewhere is not "inside `src/`" just because the string says so. This matters for `edit`/`write`, which run in the parent process where no sandbox backs them up.

Keep `.git` out of `writeScope` — the sandbox is given the parts of it git has to write on its own, and putting `.git` in the write scope lets a subagent hand-edit repository metadata (`hooks`, `config`) that the parent later executes.

## The `bash` field

| Field | Type | Meaning |
| --- | --- | --- |
| `bash` | `object` | Optional. Without it bash is forbidden entirely; an allowlist with no entries also means forbidden |
| `bash.allow` | `string[]` | The allowlist column. It answers only *may this command run here*; whether the command reads or writes is judged from the command itself — a program table plus argument predicates (git subcommands and their flags, `sed -i`, `find -delete`/`-exec`/`-fprint*`, package-manager subcommands with `config`/`store`/`version` judged by their second token, interpreters, `xargs`). A literal is matched token by token as a prefix after splitting on whitespace; an entry starting with `re:` is matched as a regex against the whole string |
| `bash.read` / `bash.write` | `string[]` | Legacy columns, kept with their exact old meaning: a `read` entry grants read-only, a `write` entry grants write and counts as "write activity". The matching rules are the same. A config that spells them gets one migration warning per source; in an agent-md `permissions.bash` block they are rejected — that block takes only `allow`, `deny`, `writable` and `network` |
| `bash.writable` | `boolean` | Defaults to `false`, the sandbox root is read-only; when `true`, the paths the **write scope** covers, git's own directories and `node_modules` are writable inside the sandbox (test artefacts, snapshots). Only a scope entry that covers a whole subtree (`dir`, `dir/**`) opens that directory; a file-level entry (`src/auth/*.ts`) opens just the files it matches today, so a brand-new file under it is not writable through bash — write those with the `write` tool. In a linked worktree, git's own grant is the worktree's gitdir plus the common directory's `objects`, `refs` and `logs`; `hooks/` and `config` are deliberately outside it, because planting a hook there would later run it as the parent agent. In a plain checkout the index and `HEAD` lock files sit in `.git` itself, so there `.git` is granted whole and `hooks`/`config` stay writable — a Landlock limit, not a choice. The working directory is not granted wholesale, so a subagent allowed to read `lib/` but not write it cannot route around that with a shell redirect; anything else it needs goes in `writablePaths` |
| `bash.writablePaths` | `string[]` | Additional paths granted write access (absolute paths, starting with `~`, or relative to the cwd). Put the global directories the toolchain has to write here, such as the pnpm store |
| `bash.scratchPaths` | `false \| string[]` | Adjusts the build/test artefact directories, which are otherwise derived from the manifests the project has. `false` disables detection, an array appends explicit directories (created if missing) |
| `bash.env` | `object` | Environment variables injected into the sandbox (written into the spec's `env`). `XDG_RUNTIME_DIR` (the sandbox's private /tmp, which pnpm's lock directory relies on) and, in the worktree case, `MISE_STATE_DIR` are injected by default. A `TMPDIR` set here is the directory the helper shadows with its private tmpfs |
| `bash.gitExcludes` | `boolean` | Defaults to `true`. Injects global exclude rules into git inside the sandbox (`node_modules/`, `.pnpm-store/`), so that `git add -A` does not pull the dependency directories into the index |
| `bash.deny` | `string[]` | Blacklist: a matched command is **always refused, and the caller's allowlist cannot widen it**. Usually written in the role md's `bash.deny` to enforce the project skeleton (`git stash`, `git reset`) |
| `bash.dependencyGate` | `boolean \| string[]` | Defaults to `true`. Every directory in the tree (two levels down) that has a package-manager lockfile (pnpm, npm, yarn, bun) must also have `node_modules/.bin`. When one does not, build and package-manager commands are refused with the directory named; read-only commands and `git` run anyway, because `git` needs no dependencies and committing is what keeps a worktree from being discarded. Wrappers are seen through (`sh -c "pnpm test"`, `env pnpm test`), but a script file (`node build.mjs`) is opaque — the gate reduces a confusing failure, it does not make one impossible. It reports a missing install, not an install that has drifted from the lockfile. Not a permission the parent can widen: the install has to finish (`worktreeSetupHook`) or the store has to be writable. An array lists directory prefixes to skip, for a lockfile nobody installs (a `fixtures/` sample, a vendored example): a plain path covers that directory and everything below it, resolved against the working directory, and the match stops at a path boundary (`fixtures` does not cover `fixtures-old`); globs are not accepted. `[]` skips nothing, the same as `true`. `false` turns it off for a task that never builds |
| `bash.cpuStallSeconds` | `number \| false` | Off by default. Armed, the helper kills the command tree after that many seconds with **no** CPU use, prints the reason and exits `79`. It separates a deadlock from a slow build — a compiling tree gains CPU every sample, a tree waiting on a lock or an orphaned child gains none — which a wall-clock timeout cannot do. Costs: a command that deliberately waits (`sleep`, a backoff loop) is killed too, and the helper cannot see output (stdio is inherited, not piped), so a quiet-but-healthy gap longer than the number is a false positive. Choose a value well above the longest gap between CPU bursts; the result carries a `[sandbox]` note saying a retry stalls the same way. |

For a bash command outside the allowlist, the refusal text carries the detected pnpm store path — the model can see it and report it together with "what the parent agent wants to write". The extension only detects it; it does not allow it automatically.

**Build and test artefacts are writable where the project says they belong.** `bash.writable` grants the write scope plus the artefact directories of the toolchains the project actually uses. The extension decides that from manifest files in the repository root and up to two levels down (so `packages/web/package.json` counts): `package.json` means Node, `Cargo.toml` Rust, `go.mod` Go, `pyproject.toml` Python, `pom.xml` or `build.gradle` Java, `mix.exs` Elixir, `Gemfile` Ruby, `Package.swift` Swift, `build.zig` Zig, `*.csproj` .NET, and so on. Each toolchain carries its own conventional output directories, resolved next to its manifest.

A directory that already exists is granted. A toolchain's main output (`target` for Rust, `__pycache__` for Python, `_build` for Elixir) is also created when missing, because the first `cargo test` in a fresh checkout would otherwise fail. The rest — `dist`, `.next`, `coverage` — are granted only if the project already has them; the extension does not invent directories. Build caches that live outside the repository (`go`'s, `mypy`'s) go to a persistent `~/.cache` directory through `XDG_CACHE_HOME`; the sandbox's private `/tmp` would make every run recompile.

`bash.scratchPaths` adjusts the list: `false` turns detection off entirely, an array appends explicit directories (created if missing). Put it in the role md when a role always runs the same build, so no dispatch has to repeat it.

Everything else is still refused. A plain `echo x > tmp.txt` in the working directory, or a tool writing into a directory the project does not have, fails with `Permission denied` — deliberately, because otherwise `lib/a > lib/b` would walk straight around a directory the subagent may read but not write. Fix it by naming the location:

- the directory goes in `writeScope` if the subagent may also write it by hand (a review writing its report);
- it goes in `bash.writablePaths` if only the toolchain needs it;
- or point the tool at a temporary directory: the sandbox already makes it writable **and** mounts an empty tmpfs over it, so what lands there is scratch, not state. That is `/tmp` and also the command's own temp directory — the host's `TMPDIR`, or the one pinned through `bash.env`: `"env": { "COVERAGE_DIR": "/tmp/coverage" }`.

A grant **inside** one of those mount points is a mistake, and it is dropped rather than obeyed: the private tmpfs is mounted over `/tmp` (and over a `bash.env.TMPDIR`), so a directory under it does not exist in the child as it does on the host, and every command that needs it would fail with "spec path does not exist". The extension drops such a grant when it builds the sandbox spec and prints one warning naming the path, instead of writing a spec the helper will refuse. The helper refuses it too (exit `77`) if one reaches it anyway. The two ways out are the ones above: let the tool write under the tmpfs (it is already writable, and the contents are scratch), or move the directory out from under `/tmp`, for instance `bash.env.TMPDIR: "/var/tmp/pi"`.

Entries come in two forms:

- Literal: split on whitespace and match token by token as a prefix. `"pnpm test"` allows `pnpm test -t foo`, but not `pnpm publish`.
- `re:` prefix: a regex, anchored against the whole string. `"re: ^pnpm -r (test|build)$"`. Regexes are not guessed automatically — command arguments often contain `*` and `.`, and guessing wrong in that direction grants more than was intended.

## Area roles: one md per code area, policy inside the md

Per-role defaults live in the role's own agent definition, `.pi/agents/<role>.md`, under an
`extend:` block — not in a bindings file. The block carries:

- `extend.permissions` — the same fields as the two tables above, in the role md's spellings:
  `scope`, `write` (the write scope), `readOnly`, `allowTools`, `budgets` (`budgets.deny` /
  `budgets.writeDeny`), and `bash` with `allow`, `deny`, `writable` and `network`;
- `extend.setup.preExec` — commands run **unsandboxed** at session start;
- `extend.output.deliverable` — what the role must hand back;
- `extend.worktree` — the dispatch default for `worktree`.

One file holds the area's write grant, its allowlist, its budget and the one command that decides
the work, and a dispatch to that role needs only `agent`, `model` and `task`; a per-dispatch
`extensionBindings` payload narrows one task further on top of that default.

The mechanism: nothing reads a bindings file; the reader recomputes the policy from the merged fields,
so a md that supplies `scope` produces an active policy with no other configuration at all.
A dispatch that carries neither bindings nor a role md with an `extend`
block leaves the extension loaded and inactive — fail open. A md that **exists and declares
an `extend` block but cannot be applied** — unreadable file, invalid YAML, `extend` not an
object, unknown block names, bad field values — fails **closed**: every tool call is refused
and the refusal names the md path and the problems, so a typo cannot silently drop a grant.

What bites, in the order it bit here:

- **`systemPromptMode: append`, not `replace`.** `replace` drops the `<active_agent>` tag; identity
  then falls back to matching the md body against the prompt, and when identity is not resolved the
  policy stays inactive — **fail open**, not fail closed. A role md whose body is empty can never
  be identified.
- **`write` entries are relative to the session cwd, which is the worktree root.** Write
  `packages/pi-plugin/src/paths`, never `src/paths`: the short spelling matches nothing, so
  *every* write is refused and it reads exactly like the area boundary working correctly.
- **The grant is an exact file list.** A new file is refused even inside the area. Grant a directory
  (e.g. `packages/pi-plugin/test`) for areas that legitimately add files.
- **A fresh worktree has no sandbox helper.** `packages/pi-plugin/bin` is gitignored and
  `mise run setup:helper` cannot create it once the sandbox is up, so a gate that needs the helper
  dies before its first case. `extend.setup.preExec` runs **unsandboxed** at session start; use it
  to copy the prebuilt helper in and to create the scratch directory:
  `mkdir -p packages/pi-plugin/bin .test-state && cp <main-checkout>/packages/pi-plugin/bin/… packages/pi-plugin/bin/`.
- **Local green does not prove sandbox green.** Anything that falls back to a working path outside
  the sandbox (the harness falls back to a package-local scratch directory when `.test-state` is
  absent) passes locally and fails in a child. Verify a role by dispatching to it and reading what
  it measured, not by running the gate yourself.
- `mise run test:all` is deliberately not in any area's allowlist: the parent runs the full set
  before merging. Give each area the narrowest task that covers it, and state its case count in the
  md — a count that moves is a case copied or lost.

`setup` and `output` are role contract, not dispatch input: a dispatch that supplies them is
warned about and ignored, because a caller must not be able to install a dependency or move a
deliverable.

## bash in a worktree

Two things need extra handling when the subagent runs in a pi-subagents managed worktree (`worktree: true`):

- **Installing dependencies is not the extension's job**: the worktree's `node_modules` is a symlink to the main checkout, so `pnpm install` follows the link and installs into the main checkout, and the link itself is not replaced, which leaves the hierarchy wrong. Leave this to pi-subagents' `worktreeSetupHook` (this repository's `packages/worktree-setup`), which handles it before the subagent starts; see the next section. The extension only manages write access inside the sandbox.
- **Both pnpm and mise write outside the sandbox**: pnpm's lock directory lives in `XDG_RUNTIME_DIR` (`/run/user/<uid>`), and mise has to register the worktree's `mise.toml` in `~/.local/state/mise/trusted-configs`. The extension points both at the sandbox's private /tmp by default, so those two failures no longer need handling; places that genuinely have to be writable and persistent, such as the pnpm store, are given explicitly with `bash.writablePaths`. A host whose `TMPDIR` is somewhere other than `/tmp` gets a private tmpfs over that directory as well, so temp files stay inside the sandbox either way.
- **Which store pnpm uses inside the sandbox depends on write access**: when the global store (`~/.local/share/pnpm/store`) is not writable under the read-only root, pnpm detects that and falls back to `<project>/node_modules/.pnpm-store`; list the store directory in `bash.writablePaths` and `pnpm store path` still points at the global store (measured). Both of them run tests — the in-project store lands under `node_modules/`, which is writable anyway. The extension's git global exclude rules keep it out of the index, but the project's own `.gitignore` should ignore `node_modules/` as well.
- **Installing dependencies inside the sandbox needs the network** (`"network": true`): whichever store is used, installing a new package has to reach the registry. With the network off by default, `pnpm install` is bound to fail.

## Worktree dependency installation (worktree hook)

pi-subagents runs the `worktreeSetupHook` once after each worktree is created and before the subagent starts, with the cwd set to the new worktree root. The hook provided by this repository is `packages/worktree-setup/worktree-setup.sh`; only one symlink is installed globally:

```text
~/.pi/agent/extensions/subagent/worktree-setup.sh -> <this repository>/packages/worktree-setup/worktree-setup.sh
```

A project only has to commit a shell script at `<repo>/.pi/worktree-setup.sh`; without that file nothing happens (which is why one global hook serves every project):

```sh
#!/bin/sh
set -eu
cd packages/pi-plugin      # cd yourself when the manifest is not in the root directory
pnpm install --prefer-offline
```

- **The exit code is the contract**: the hook does not judge a second time whether the install worked; the project decides in its own script. pnpm 12 still exits 1 after installing because of `ERR_PNPM_IGNORED_BUILDS`, so write `|| true` yourself or add a self-check. A self-check means writing "what counts as usable" as the project's own criterion:

```sh
#!/bin/sh
set -u
cd packages/pi-plugin                  # cd yourself when the manifest is not in the root directory
pnpm install --prefer-offline || true  # ignore pnpm 12's ignored-builds exit code

# the criterion belongs to the project: make sure the shim really resolves **in this worktree**, not in the inherited copy
if ! node -e 'require.resolve("typescript")' >/dev/null 2>&1; then
	printf 'worktree setup: dependencies are unusable in %s\n' "$PWD" >&2
	exit 1
fi
```

Skipping silently is the most expensive failure mode here: the declaration exits 0, the hook believes it succeeded, and the subagent only discovers `Cannot find module` once it starts.
- **The hook deletes the `node_modules` symlink first**. When upstream creates a worktree it symlinks the **main checkout's root** `node_modules` into the worktree (`linkNodeModulesIfPresent`), so that a worktree which installs nothing can still run; the symlink points at **whatever the main checkout happens to have installed**, and both sides go wrong:
- **Nothing installed**: a package the worktree's manifest declares but the main checkout's tree does not have (someone added the manifest earlier and never reinstalled) makes the subagent get `Cannot find module` — even though the package is right there in the worktree's own `package.json` (measured: `is-number` resolves to `<main checkout>/node_modules/.pnpm/...`, `left-pad` fails outright). This has nothing to do with whether `package.json` changed during the work.
- **Installed**: pnpm writes through the symlink into the main checkout's copy — the main checkout's directory inode is unchanged, but it gains the package the worktree needed (measured: 4 top-level entries → 5, and the main checkout's own `package.json` never declared it).
- **The bookkeeping is written into someone else's directory**: with `virtualStoreType: global` (the worktree usage pnpm officially recommends), each project records the virtual store as a **relative path** in `node_modules/.modules.yaml`. Opened through the symlink, that file is the main checkout's, while pnpm computes the depth from the worktree, so the install rewrites the main checkout's copy: measured `../../../../.local/share/pnpm/store/v11/links` → `../../../../../../.local/share/pnpm/store/v11/links`, with the manifest untouched throughout. That value only holds for the project that wrote it last; resolved from the worktree it points at a directory that does not exist. So the hook deletes this symlink before running the declaration, leaves a real directory alone, and the declaration gets a clean starting point. A project that wants the symlink back can recreate it in its own script. Projects without a `node_modules` in the root do not get a symlink, so there is no impact.
- Output goes to `~/.cache/pi-worktree-setup/<worktree directory name>.log`; on failure the hook prints the last 20 lines and the log path to stderr, and when the output contains `not trusted` it additionally points at mise's `trusted_config_paths`.
- **The hook does not go through the sandbox**: it runs before the subagent, with host permissions. If the subagent runs `pnpm install` itself, it still needs write access inside the sandbox and `network`.
- The hook is POSIX sh, so the kernel has to honour the shebang; on Windows it has to be a native executable (upstream uses `spawn(hookPath, [], { shell: false })`, and Node will not run `.cmd` for you).

## Rules in effect

- Inside the scope: `read`/`edit`/`write`/`grep`/`find`/`ls` are allowed (with `readOnly`, `edit`/`write` are refused).
- Always refused: `powershell`/`codemode`; unknown tools outside `scope`/`allowTools`.
- **Anchored-editing hosts**: when an extension such as pi-hashline-edit-pro replaces the builtin `edit`, the write tools are `replace`, `replace_match`, `insert`, `copy`, `move`, and `undo_last_change`. They are judged exactly like `edit` — do not declare them in `allowTools` expecting them to escape `writeScope`.
- **`copy` / `move` touch two files**, not one: `source_from` / `source_to` belong to the source, `anchor` to the destination, and both are judged. `copy` only reads the source, so the source may sit in the read scope while the destination is the writable one; `move` deletes from the source, so the source must be writable too. A cross-file copy whose destination is outside the write scope is refused — it is not a way to move content out.
- **Do not pin `edit` in an agent definition's `tools` field.** That field is a strict allowlist over *registered* names, so on an anchored-editing host `edit` never registers and the child stops at its first request ("declares tools: …, but an extension loaded in this child replaced the tools sent to the model"). Naming the anchored family instead breaks the child on every host that still has the builtin. Naming both is fatal too: a declared tool that never registered is itself a run error. Leave `tools` out and let this layer bound the child — it refuses any tool that is not a known path tool, a safe tool, or allowlisted.
- **`acceptanceRole` in the frontmatter accepts only `read-only` or `writer`** (pi-subagents validates it and rejects the whole definition otherwise — `analyst` or `reviewer` fails the dispatch before the run). It also changes what the child is asked to produce: `writer` yields a `checked` acceptance contract, `read-only` a `none` level with findings. With an async or dynamic writer, pi-subagents additionally marks an independent review by an agent named `reviewer` as **required** in that contract; it does not dispatch that agent, so the parent still has to run the review itself.
- **An anchored write with no `path`** gets its target from anchor ownership, which this layer reads from the host's session registry (`sessions/<sha256(sessionFile)[0:24]>.registry.jsonl`). A resolver miss refuses rather than allows, so anchors that expired (`free`/`clear`) produce a refusal saying the anchor is not in this session's registry. The anchor pair names differ per tool (`replace` uses `remove_from`/`remove_to`, `replace_match` uses `replace_from`/`replace_to`, `insert` uses `anchor`, `copy`/`move` use `source_from`/`source_to` plus `anchor`), and all of them resolve. `requirePath: true` in the host's config makes every call carry a path and removes that dependency.
- `contact_supervisor` / `intercom` / `structured_output` are always allowed, **allowed after the stop as well**: reporting to the supervisor mid-run is a legitimate channel and must not be shut off by a criterion or a probe.
- The stop is hard (`terminate`): when the whole batch of results is terminating, the turn ends right there, with no closing round. So ask for help before the stop; do not expect to be able to report anything after being stopped.
- **bash**: without an allowlist it is refused outright; with one, only allowlisted commands run, and each is rewritten to run in the helper sandbox — the file scope is enforced by Landlock, the network is off by default, and the writable paths are the ones the write scope covers (whole-subtree entries as directories, file-level entries as the files they match), git's own directories, `node_modules` (when `writable`), plus `writablePaths`. The cwd is not granted wholesale. Shell control characters are judged **outside quotes only**, because the command runs as `bash -lc <command>`: `; & | < > ( )` inside single or double quotes are ordinary characters, while `$` and a backtick still expand inside double quotes and are refused there too. So `python3 -c "print(1)"` and `echo 'a; b'` pass, but `pnpm test && cat other-file` and `echo "$(cat other-file)"` do not. An unterminated quote is refused. A leading `NAME=value` assignment is stripped before matching, so `HOME=/tmp/x node a.ts` matches an entry `node`; the scan is quote-aware and accepts `+=`, only the leading run is removed, and a `re:` entry still sees the command as written. Since the prefix is stripped, an entry must start with the program name — `HOME=/tmp node` is a rule that can never fire. Assignments that change which program runs or load code into it (`NODE_OPTIONS`, `LD_PRELOAD`, `GIT_EXTERNAL_DIFF`, `PATH`, `PYTHONPATH`, `BASH_ENV`, …) are refused with the variable named: `NODE_OPTIONS=--require=/tmp/x.js node -e ""` runs `/tmp/x.js`, so allowing it would make the allowlist decoration. If you genuinely need such a variable, the parent sets it in `bash.env`. Note the consequence: listing an interpreter (`node`, `python3`, `sh`) in the allowlist lets it run arbitrary code — the sandbox and the scope are the boundary, not the command text, and an interpreter belongs in the allowlist only when the task needs it.
- **Offline network commands are refused before they start**: when `bash.network` is off, a fixed list of round-trip-only commands is rejected after the allowlist and path checks but before the sandbox spec is written — `curl`, `wget`, `nc`/`ncat`/`netcat`, `telnet`, `ssh`, `scp`, `sftp`, `ping`, `dig`, `host`, `nslookup`, `traceroute`, `gh`, `docker pull|push|login`, `npm|pnpm|yarn publish`, and `git clone|fetch|pull|push|ls-remote|remote update|submodule update --remote`. The refusal says the network is off per the parent's bindings, that packets are dropped rather than refused (so these commands hang with no failure text to annotate), and to ask via `contact_supervisor` for `"network": true`; it counts as a permission collision on the grant budget, not the write budget. The matcher looks through absolute paths (`/usr/bin/curl` counts) and the pass-through wrappers `env`, `sudo`, `nice`, `timeout`, `command` and `stdbuf`, skipping their flags and flag values; it also skips `git`'s global flags (`-C`, `--git-dir`, `--work-tree`, `--no-pager`, `--progress`, `-c`) before the subcommand, so `git -C repo fetch` is judged while `git log --fetch` is not. It deliberately does not parse quoted text — `bash -c "curl …"` is allowed through — and anything it cannot resolve confidently (an unknown wrapper flag, `command -v curl`, a name assembled at run time) is allowed too. Local forms excluded on purpose: `curl file:///…` reads a file, and `curl --version` / `-V` / `--help` / `-h` print local information and exit, while `gh --version` / `version` / `help` / `config get …` only read local state; other `gh` subcommands and other curl URLs are still judged. **Accepted false positives**: `git push /local/path` and `nc -z localhost` are still refused even though both could complete offline — telling them apart would mean resolving a git remote URL or parsing a netcat host, which costs more than this guidance is worth; the way out is the same `contact_supervisor` request for `"network": true`. Looking past path prefixes has the same cost: `foo/curl`, `./curl` and `curl/` all count as curl even for a local file, because resolving the actual executable would cost more than this pre-spawn guidance is worth. Local work — `git status`/`diff`/`log`/`show`/`add`/`commit`, `node`, `rg`, `ls`, `cat`, `pnpm install`, `npm ci`, `cargo fetch`, package scripts — is never refused by this rule. The annotation below stays as a fallback for network failures the list does not cover.
- The notes below require that the command **actually failed** (the tool result's `isError`); a successful command whose printed output merely contains those strings is not annotated.
- **Network failures inside the sandbox are annotated**: when an offline bash hits `ENETUNREACH` / `EAI_AGAIN` / `ENOTFOUND` / `getaddrinfo failed`, a `[sandbox]` note is appended at the end of the result: the network was turned off by the parent agent, the machine is not broken, changing the registry / flag / timeout fails the same way, and if the network is needed, ask `contact_supervisor` (`"network": true`). `ECONNREFUSED` is not annotated — loopback works, that is a normal test result.
- **Out-of-scope writes are annotated as well**: when bash writes outside the granted scope, the kernel returns `EACCES` / `Permission denied` — the same wording as an ordinary file permission problem. The decision is not made by guessing at the wording: the extension takes the path out of the failure line and compares it with this command's `spec.write`; if the path is outside the grant and the host can read it, a `[sandbox]` note is appended at the end of the result, saying that this is an authorisation rather than a filesystem fault, and that writing requires `contact_supervisor`. Failures inside the grant, and failures caused by insufficient host permissions themselves (such as reading `/etc/shadow`), are not annotated. Paths ending in `.lock` are not annotated either: git probes for lock files it does not need (`packed-refs.lock` in a worktree), prints that refusal with exit status 0, and the commit lands anyway — reporting it would send the parent off to widen a correct grant.
- **A command that ran but cannot work is annotated**: when an allowlisted command fails because the working directory has no manifest (`pnpm` reports `No package.json found`), a `[sandbox]` note is appended at the end of the result: it names the allowlist entry that cannot work from that directory, the reason, and the form that would work (`pnpm --dir packages/pi-plugin run typecheck`). It names **the entry the allowlist actually used to authorise the command**, not just another entry that matches it — a wider `pnpm` in the same list must not be pinned on a command another entry granted. With several candidate packages it lists up to eight of them instead of picking one (the rest as `… and N more`), and when the only candidate has no such script it says ``no candidate has a `typecheck` script`` rather than inventing a form or asking which package was meant. A truncated list says so (`only the first 8 are listed`). `bun test` is never reported: it runs bun's own runner and needs no manifest at all.
- The text of an out-of-scope **file-tool** refusal is in English, and it spells out "which path is out of scope, do not retry, report it if you need it", and lists the current scope. The bash path nudge is a different refusal: it names a path outside the working tree and lists the working tree. A refusal for a missing path does not count as a permission problem: `grep`/`find` without a path are handled as the cwd (the text says `no path was given`), and `write`/`edit` must be given a path (the text says `needs a path`). Such refusals do not count towards the collision count.
- **Refusal counts are consecutive**: any allowed working call resets both budgets, so a mistake that has been corrected is not carried to the end of the run. `contact_supervisor` and `structured_output` are exempt from that reset — they are a report, not progress, so alternating a probe with an escalation does not keep the run alive at the warning level.
- Inside the scope a session can use `/permission` to see the current policy: `Source`, `Bindings`, `Mode`, `Write scope` (when it differs), `Read scope`, `Read denials: … · write denials: …`, the `bash allow:` column (with the no-write note when `writable: false` and entries exist), the legacy `bash (legacy columns, migrate to allow):` line when legacy entries exist, `Sandbox`, `Sandbox writable paths`, `Reads` and the probe state.

## Notes for the parent agent

- When the subagent reports `no path was given` or `needs a path`: the tool argument was missing, it did not go to the wrong directory. Put the file paths into the task you give the subagent.
- When the subagent reports `is outside this task's scope`, decide whether that path really belongs to this task: if it does, widen `scope` and dispatch again; if it does not, the task description is ambiguous, so fix the task description first. Check the scope syntax itself first (a directory has to be written as `dir` / `dir/` / `dir/**`), and only then suspect that the subagent went to the wrong directory.
- When a batch contains an allowed result (the batch is not all terminating), the turn continues, and every later call gets the text of the "stop reason" (it holds historical paths). When judging, trust only the criterion on the last line; do not treat the paths inside it as this task's paths.
- Do not retry out-of-scope paths over and over to get around a refusal.
- When the subagent has to run tests/typecheck itself, list the commands in `bash.allow` — one column, and the extension judges from the command itself whether it reads or writes (use a `re:` regex when you need to be precise, but never `re: .*`). Add `"writable": true` for any command whose program can write: package managers (`pnpm`/`npm`/`yarn`/`bun` with `run`/`test`/`exec`) are refused at the gate without it, and it is also what lets their artefacts land on disk. The sandbox has no network by default, so installing dependencies and the like is refused.
- The read face stays open on purpose: running tests has to read the whole tree, the toolchain lives in `/nix/store`, and narrowing the read root would kill every command at once, so an allowlisted command can still `cat` a file outside the tree inside the sandbox. Do not treat the bash allowlist as a way of locking reads down. What the extension adds is a nudge, not a wall: for a **read-class** command, an argument that counts as a path — it contains a slash and nothing but path characters, so `src/index.ts` and `~/x` qualify — is resolved (symlinks by their real target) and refused when it lands outside the **working tree**, the directory the command runs in. That is deliberately not the read scope: a scope can be much narrower than the tree (`scope: ["src/auth/**"]` is the normal shape), while a build has to read the whole tree, so the tree is what a command is judged against. The toolchain directories are **not** exempt — the program token is, because that is the tool being run rather than a file of the task's. What is exempt is the system's `/etc`, `/proc`, `/dev` and `/sys`, the working tree itself and the command's private scratch directory. Anything doubtful is skipped rather than guessed at — quoted arguments, `$VAR`, globs, URLs, and bare words such as `foo` or `--flag`. A child that needs a file outside the tree should use `read` when the scope covers it, or say what it needs — not hunt through `/nix/store` with `rg`.
- When the subagent reports `command not in the allowlist`, first decide whether that command is really needed for this task: if it is, add it to the matching column and dispatch again; if it is not, change the task description instead of letting it keep trying. The refusal text carries the pnpm store path and the `bash.writablePaths` hint — copy it in when the subagent has to install dependencies, instead of letting it install them itself.
- Nested subagents do not inherit bindings: when you lock down an agent that may delegate in turn, do not also enable `allowNestedSubagents`.
- The bindings are capped at 16 KiB in total, so keep the scope globs terse; all fields of this extension share the namespace `pi-subagents-extend/1`, and the cap applies to the whole bindings object.
