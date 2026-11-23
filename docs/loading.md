# How the extension gets loaded

Which behaviour you get depends on **how** pi loads this package, not on what the session looks like
at run time. That is why the three entry points are split the way they are (see
[Architecture](architecture.md#three-entry-points)) and why "it works in my project" says nothing about
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
configured, and `pi -e <source>` tries a source for one invocation. A *local* source is loaded from the
resolved path without copying, which is what makes it usable while the package is still being edited.

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

## What this machine actually has

Measured 2026-11-23, because "I think it is installed" is how a month gets spent debugging nothing:

- `~/.pi/agent/settings.json` → `packages` **does not** list this package: it is not globally loaded.
- `~/extensions/.pi/extensions/pi-subagents-extend` → symlink to `packages/pi-plugin`. So it loads in
  this repository, and only there.
- `~/.pi/agent/extensions/pi-subagent-only-skills` → symlink to `~/extensions/subagent-only-skills`.
  That repo was merged into this one (`src/main-skills.ts`) and is deprecated, but the global link is
  still there: two extensions answering the same question, in every project. Remove that link when the
  merged version is loaded wherever it was needed.

The consequence to keep in mind while reviewing: a parent-side change verified by dispatching from this
repository proves nothing about a session in another project, because there this package is not in the
parent at all.

## Installing it somewhere else

```bash
# this project only (what this machine does today)
ln -s "$PWD/packages/pi-plugin" .pi/extensions/pi-subagents-extend

# one project, declaratively, without copying the source
pi install --local ./packages/pi-plugin

# every project
pi install ./packages/pi-plugin

# one invocation, no settings change
pi -e ./packages/pi-plugin
```

All four need `packages/pi-plugin/bin/pi-subagents-extend-helper` to exist; `pnpm run build:helper` in
`packages/pi-plugin` builds and installs it. Without the helper a session with `bash` says so at start
and names that command instead of failing on the first command.

## Verifying the load

```bash
pi list                                   # configured packages and extensions
ls -l ~/.pi/agent/extensions .pi/extensions   # discovery directories
```

Inside a session, `/permission` reports the active policy. A role md's own `extend.permissions` block
shows up there only when identity resolved (the `<active_agent>` tag, or an unambiguous md body) — if it
is missing, the child is running with no confinement and the dispatch still succeeded, which is the
failure this section exists to make visible.
