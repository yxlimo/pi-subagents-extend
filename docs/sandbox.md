# The sandbox

`packages/helper` is one Rust binary with no runtime dependency. It confines **itself** and then
`exec`s the command, so an allowlisted `bash` command becomes a process whose files, network and
processes are already fixed.

An allowed command is rewritten to:

```text
<helper> --spec ~/.cache/pi-subagents-extend/spec-<pid>-<seq>-<toolCallId>.json -- bash -lc '<command>'
```

The spec carries the resolved paths, the offline flag, the environment and the target directory. One
spec file is written per call: the name carries the pid, a per-process sequence and the tool call id,
so parallel calls cannot collide; it is renamed into place atomically, so the helper never reads a
half-written file; and it is removed once the call's result comes back, or when its entry is evicted
from the cap. A sweep at session shutdown clears what a crash, an interrupted session or a repeated
tool call id left behind — it only touches `spec-*` files older than ten minutes, because the same
directory also holds `git-excludes` and the `xdg-cache` tree. `PI_SUBAGENTS_EXTEND_STATE` overrides that
directory; it defaults to `~/.cache/pi-subagents-extend`, and the tests point it at a throwaway one
rather than redirecting `HOME`, which would also move every toolchain's own state.
Two subcommands matter: `--spec` runs a command, `--describe` prints the capabilities as JSON and
exits 0, or 76 when the kernel is not good enough. `PI_SUBAGENTS_EXTEND_HELPER_PATH` overrides the
binary path; otherwise the extension uses `packages/pi-plugin/bin/pi-subagents-extend-helper-
<platform>-<arch>` and nothing else. There is no cargo-artifact fallback: a published package has no
build tree beside it, so a second candidate could only ever paper over a stale copy.
`cargo build --release --manifest-path packages/helper/Cargo.toml` writes
`packages/helper/target/release/pi-subagents-extend-helper`, which is what the tests execute — handed
to them through that override; `pnpm run build:helper` (or `mise run setup:helper`) is what installs a
build as `bin/`, which is gitignored and belongs to the running extension, so a test run must not
replace it.

When a session has `bash` enabled and no usable helper — the binary is missing, or the kernel is
below ABI 7 — the extension says so once at session start, naming the command that fixes it, rather
than letting each `bash` call fail on its own. A session with `bash` off says nothing, and
`/permission` always shows which path resolved, or why none did.

Order inside the helper: enter the namespaces → `chdir` → Landlock → drop capabilities → `exec`.
The command runs under a supervising PID 1 (see below), never as PID 1 itself.

## Files

A Landlock ruleset. `/` stays readable and executable, so `cat` can read outside the tree as
noted in [architecture](architecture.md#boundaries). That is deliberate, and the nudge that comes with
it is separate from the ruleset: before a read-class command starts, the extension checks its path
arguments against the **working tree** — the directory the command runs in, not the read scope (see
[usage](usage.md#what-bash-may-read)) — and a command that gets past that nudge can still read anything.
Only these are writable:

- the paths the write scope **covers**, when `bash.writable` is set. Landlock can only grant, never
exclude, and a rule on a directory grants everything beneath it — so a scope entry opens a directory
only when it covers a whole subtree (`dir`, `dir/**`). A file-level entry such as `src/auth/*.ts` is
expanded into the files it actually matches, each granted as a file: the parent directory stays
read-only, which is what keeps `src/auth/*.ts` from opening all of `src/auth/`. The cost is that a
file that does not exist yet cannot be created through bash under a file-level entry; use `write`
for those, or grant the directory with `dir/**`
- git's index and refs. The lock files (`index.lock`, `HEAD.lock`) are created in the gitdir root, so
that directory has to be granted whole:
  - in a linked worktree it is `<common>/worktrees/<id>`, which holds `HEAD`, `index`, `logs` and
    `refs` and **no** hooks or config. The common directory is then granted only `objects`, `refs` and
    `logs` — the three git writes through, measured: dropping any one fails a specific command on the
    object database, a ref lock or the reflog
  - in a plain checkout the gitdir *is* the common directory, with `hooks/` and `config` in it, so
    there `.git` is granted whole and both stay writable. That is a Landlock limit, not a choice: the
    index lock cannot be created without also allowing files next to it. A subagent in a plain
    checkout can therefore plant a hook or point `core.hooksPath` elsewhere, and the parent will run
    it; in a worktree it cannot
- `<cwd>/node_modules`, resolved through symlinks, because pnpm writes the shims in `.bin`
- the artefact directories of the toolchains the project uses (see
  [architecture](architecture-refusals.md#the-three-write-layers))
- `bash.writablePaths` entries, and the device nodes below
- the temporary directories: the one the command itself uses (the host's `TMPDIR`, or a `TMPDIR`
  pinned through `bash.env`, `/tmp` when neither is set) and the conventional `/tmp`, which the
  extension's own runtime and state directories point into. Both are shadowed by the private tmpfs
  described under [Namespaces](#namespaces) — granting a directory that is *not* mounted over would
  be a host write, not a sandbox one, which is why the former is now named in the spec's `tmp`

A grant *below* one of those mounted directories cannot take effect: the tmpfs is mounted empty, so
the path the rule would attach to is gone, and the write would never reach the host file the grant
was meant for. The helper refuses that spec before the command starts, with exit 77, naming the grant
and the directory that hides it — the alternative, and what it used to do, is failing later with
`spec path ... does not exist`, which reads like a typo in the spec. A grant naming the mounted
directory *itself* is fine (the mount point survives, which is why the extension's own `/tmp` entry
works), and a directory holding the working directory is not mounted at all, so grants below it stay
usable.

The extension drops such a grant from the spec rather than let it take the command with it. A
`bash.writablePaths` entry below `/tmp` (or below a pinned `TMPDIR`) is removed before the spec is
written, the command runs with its remaining grants, and the parent gets one warning naming the path.
The alternative is disproportionate: one unusable grant would fail every bash call in the session —
including the `git status` a review role needs — and the child would see only an exit code it cannot
interpret. The helper's refusal stays as the backstop for a spec written by something else.

Both sides of that comparison resolve symlinks before they are compared, on the extension side as well
as in the helper: a grant spelled through a link that points into `/tmp` looks innocent as a string and
is not. Resolving only one side would reintroduce the failure in the other direction — the extension
keeps a grant the helper then refuses, and every bash call dies on a spec the plugin believed was fine.
The deepest existing ancestor is resolved and the missing tail is kept as typed, because the granted
path may be a directory the command is about to create.

A write outside them fails with `EACCES`. Landlock rules attach to the resolved inode, so a
symlink inside a granted directory that points outside stays read-only: the rule follows the
target. `node_modules` is the one deliberate exception, realpath'd before being granted.

A read-only sandbox gets none of the git or `node_modules` grants — silently widening the main
repository's `.git` is worse than a failing git command.

The kernel requirement is **Landlock ABI 7 (Linux 6.15 or later)**. Below that the extension does
not support the sandbox at all rather than falling back to weaker rules, and `--describe` reports
the measured ABI with `supported: false` — the number is the diagnosis, so it is never replaced by
a placeholder.

## Namespaces

Unshared in the helper, before Landlock:

- **User**, needed for the rest, plus a uid/gid map. The ids are captured **before** the unshare:
  after `unshare(CLONE_NEWUSER)` `getuid()` returns the overflow id 65534, and a map written from
  that fails with `EPERM`.
- **Mount**, always, which is what gives the command a private scratch space — an unmixed tmpfs over
  the conventional `/tmp` and, when the command's own temporary directory is somewhere else (the
  host's `TMPDIR` is not always `/tmp`), over that directory too. The extension names it in the
  spec's `tmp`; the helper defaults to `/tmp` alone when the field is absent, so a spec written by an
  older extension still reads. A directory that contains the working directory is skipped, since the
  tmpfs would hide it.
- **Network**, only for an offline command. See below.
- **PID**, always, with a freshly mounted `/proc`, so only the sandbox's own processes are visible:
  host processes cannot be seen, another process's `/proc/<pid>/environ` cannot be read, and no
  signal crosses the boundary. Mounting procfs only happens when a PID namespace was entered —
  from outside one it would fail and hide nothing anyway.

PID 1 of a namespace does not get default signal dispositions, so `kill <helper>` would leave a
shell that ignores `SIGTERM`. The tree is:

```text
caller ── helper ──┬─ init   (PID 1, forwards signals, sets PDEATHSIG)
                   │   └─ the command
                   └─ waits, mirrors the exit status
```

The supervisor forwards `SIGTERM`, `SIGINT`, `SIGHUP` and `SIGQUIT`, and `PDEATHSIG` makes the
whole namespace die with the caller. Exit status is mirrored, a signal death becoming `128 + N`.

Before `exec` the bounding set and the effective set are cleared, so `CapEff` and `CapBnd` are both
zero, matching the bubblewrap defaults.

## Offline means "no route out"

The network namespace starts empty; its loopback interface is brought up with
`SIOCSIFFLAGS` and nothing else exists in it. There is no route, so a connection fails with
`ENETUNREACH` and a name lookup with `EAI_AGAIN`. The `nscd` and `systemd-resolved` socket
directories are shadowed with an empty tmpfs, because a unix socket crosses a network namespace —
without that, host names would still resolve.

Loopback being **up** is the point. Landlock's network rules are per port and cannot express "only
loopback", so an earlier version that handled `ConnectTcp` refused the local connections a test
suite needs. Measured, with the rules in place: `bind 127.0.0.1` succeeded and the loopback client
in the same sandbox got `EACCES` — a server nothing can connect to. Handling `BindTcp` instead and
leaving `ConnectTcp` open has the mirror problem. The namespace is the mechanism that actually
expresses the requirement, so an offline command gets **no Landlock network rules at all**.

Measured on ABI 11:

| Scenario | Result |
| --- | --- |
| local round trip (server and client in one sandbox) | `CONNECTED` / `pong` |
| `bind 127.0.0.1`, `bind 0.0.0.0` | ok |
| `connect 1.1.1.1:80` | `ENETUNREACH` |
| `dns.lookup("github.com")` | `EAI_AGAIN` |
| control, `offline: false` | `CONNECTED` |

The guarantee is structural: there is no interface to leave by, capabilities were dropped after
the namespaces were set up, and the resolver directories are shadowed. It would break if a veth
pair were ever added to that namespace, which is a design convention rather than something the
code can enforce.

### The notice appears once per session

A successful offline command prints one line on stderr naming the directories it shadowed, so a run
that is genuinely isolated is distinguishable in the log from one that silently took a different
path. It used to print on **every** command, which meant a fifty-command session put fifty identical
lines into the model's context — a fact the reader already had, paid for fifty times.

Now the first offline command of a session announces it and the rest stay quiet. The plugin passes
`PI_SUBAGENTS_EXTEND_QUIET_NETWORK_NOTICE=1` on its own helper invocation — never on the user's
command, which is byte-identical either way — and the session flips that flag only when the spec is
offline, so a session that opens with online commands still gets its first offline command
announced.

Silence here carries no risk of hiding a degradation: the fallback path above still speaks on
**every** occasion. Quiet on success, loud when something is wrong is what keeps the signal while
dropping the repetition.

## When the host refuses namespaces

Some hosts create the user namespace and then refuse `setgroups`, mount, network and PID. Measured
on GitHub's runner (Ubuntu 26.04, `apparmor_restrict_unprivileged_userns=1`): `unshare(NEWUSER)`
succeeds, `setgroups` fails with `EPERM`, and `unshare` of mount, network and PID all fail with
`EPERM`. With the restriction lifted, all four succeed.

The helper degrades rather than fails, and says so on stderr:

- Landlock takes over the network cut, since the namespace that gave it structurally is missing.
  The port rules are coarse — loopback is refused along with everything else, so a local server
  cannot be reached — and a refused connect reads as `EACCES` instead of `ENETUNREACH`.
- There is no private scratch directory and no process hiding, because those came from the mount
  and PID namespaces.
- Procfs is not remounted.

Scope enforcement, the file rules and the capability drop are unaffected: they are Landlock and
`prctl`, not namespaces.

## Devices

`/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`, `/dev/tty` and `/dev/pts` are
writable by default, those that exist. Without them a redirect such as `2>/dev/null` fails
outright.

## What the helper does not do

No seccomp. The contract is preventing out-of-scope writes and network access for delegated,
allowlisted commands, not defending the kernel against hostile code; seccomp would shrink the
syscall surface and break ordinary commands in exchange. No read confinement, for the same reason
it is not in the extension: a test suite has to read the tree.
