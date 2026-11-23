# How the extension gets loaded

Which behaviour you get depends on **how** pi loads this package, not on what the session looks like
at run time. That is why the three entry points are split the way they are (see
[Architecture](architecture.md#three-entry-points)) and why "it works in my checkout" says nothing about
any other project.

## The two ways pi finds an extension

**Auto-discovery.** pi scans one level deep and picks up any of these layouts:

| Location | Scope |
| --- | --- |
| `~/.pi/agent/extensions/*.ts` or `*.js` | every project |
| `~/.pi/agent/extensions/<name>/index.ts` or `index.js` | every project |
| `~/.pi/agent/extensions/<name>/package.json` with a `pi.extensions` field | every project |
| `.pi/extensions/…` | this project, same layouts, **only after the project is trusted** |

`packages/pi-plugin` has no `index.ts` at its root, so a link to it works through its `package.json`
manifest. Discovery also feeds `/reload`: an entry in one of these directories can be hot-reloaded, an
entry passed with `-e` cannot.

**Declarative.** `~/.pi/agent/settings.json` (or `.pi/settings.json` for one project, which again needs
trust) accepts two lists: `packages` for npm and git sources, `extensions` for local paths. `pi install
<source>` writes the personal one, `--local` writes the project one, `pi list` shows what is
configured, and `pi -e <source>` tries a source for one invocation.

## Which channel each entry point needs

| Entry point | Channel | What is lost without it |
| --- | --- | --- |
| `src/index.ts` | ambient (a discovery directory or a settings entry) | the `subagent` tool wrapper: dispatch-payload narrowing, the bash/scope judge, the tool-face preflight, the worktree default |
| `src/main-context.ts` | ambient, main session only | `.pi/main-only.md` injection in the main session, marker stripping there |
| `src/child-context.ts` | an agent's `subagentOnlyExtensions` only | marker stripping in that child |
| `src/main-skills.ts` (part of `index.ts`) | ambient, main session only | the subagent-only skill filter on the prompt the parent sends |

A subagent's own confinement does **not** depend on the parent being loaded: the role md names
`child-context.ts` and the md-role loader by absolute path in `subagentOnlyExtensions`, so the child
loads them whether or not the parent has this package. The parent-side features above are the ones that
quietly do nothing.

## Installing

The supported distribution is npm. No development symlink, in this repo or globally:

```bash
pi install npm:pi-subagents-extend
pi list                                     # what is configured
```

To try the package for a single session without writing settings, `pi -e npm:pi-subagents-extend`.

## What is in the package

- `src/` — the three entry points and the modules behind them.
- `skills/` — the three skills (`pi-subagents-extend`, `…-context`, `…-probes`).
- `bin/pi-subagents-extend-helper-<platform>-<arch>` — the sandbox helper, prebuilt for **linux-x64**
  and **linux-arm64**. It needs Landlock and unprivileged user namespaces, so it is Linux-only; on
  anything else every bash command is refused with a message that says so.

The resolver looks for exactly that one path, chosen by `process.platform` and `process.arch`. An
explicit `PI_SUBAGENTS_EXTEND_HELPER_PATH` overrides it (a build of your own, a stub in a test).

## Developing against a checkout

`pi -e ./packages/pi-plugin` loads the working tree for one session, and `pnpm run build:helper` puts
the helper at the same `bin/<platform>-<arch>` path the package uses, so the dev loop needs no
symlink either. The role mds under `.pi/agents/` still name their loaders by absolute path — that is
how a dispatched child finds them regardless of how the parent was loaded.

## Verifying the load

```bash
pi list                                       # configured packages and extensions
ls -l ~/.pi/agent/extensions .pi/extensions    # discovery directories
```

Inside a session, `/permission` reports the active policy. A role md's own `extend.permissions` block
shows up there only when identity resolved (the `<active_agent>` tag, or an unambiguous md body) — if it
is missing, the child is running with no confinement and the dispatch still succeeded, which is the
failure this section exists to make visible.
