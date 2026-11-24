---
name: pi-subagents-extend-probes
description: For a subagent that is idling, stuck, or spinning — keeps re-reading the same spot, re-runs the same failing command verbatim, keeps trying after the task is effectively complete, or starts creating probe litter files. Probes detect read-only idling, repeating a command, finished early, writing litter, and permission refusals; a hit blocks that call, and once a stop condition is reached the turn ends immediately. Documents the maxDenies and probe fields of pi-subagents-extend/1 in extensionBindings with their defaults, the difference between warn and stop (stop is a hard stop with no wrap-up turn), and what the parent agent should look at after a subagent is stopped. Scope and the bash allowlist are covered in pi-subagents-extend.
---

# Probes: detecting subagent idling and ineffective work

The scope restriction (`scope`) only governs which files a subagent can touch; probes watch whether it is making progress. Both live in the same delegation's `extensionBindings` and share the `pi-subagents-extend/1` namespace.

## When it applies

| Symptom | Criterion |
| --- | --- |
| Repeatedly reading the same file/directory with no write operations | read-only idling |
| The same kind of command or path keeps failing, but is retried verbatim every time | repeating a command |
| The task is effectively done (typecheck already passed) but it keeps trying | finished early |
| Leaving temporary probe files in the repository | writing litter |
| Repeatedly hitting the same permission refusal | permission refusal |

When a criterion hits, the current tool_call is blocked with a reason; once a stop condition is reached the turn ends immediately (every blocked result carries `terminate`), with no wrap-up turn.

## Default behavior

When `probe` is not written, only two pure error signals are active, so collateral damage is low:

| Criterion | Default | Notes |
| --- | --- | --- |
| repeating a command | on, `repeatBash: 3` | The same bash command verbatim (after trim) the 3rd time → warn, the 4th → stop |
| permission refusal | on, `maxDenies: 5` and `maxWriteDenies: 2` | The 5th consecutive **authorization-type** refusal → warn (asking it to escalate), the 6th → hard stop. Only refusals that a parent agent granting broader authorization could resolve are counted: paths outside the read scope, commands not in the allowlist, read budget, tools not in `allowTools`, bash entirely disabled. **Write refusals have their own budget**: the 2nd write refusal warns, the 3rd hard-stops; the two budgets do not share a counter. Both are **consecutive**: an allowed working call resets the count, while `contact_supervisor`/`structured_output` do not count as progress and do not reset it |

The three criteria that can misfire on slow tasks must be explicitly configured: `probe: {}` turns on all defaults at once, writing only some fields turns on just those, and `probe: false` turns everything off.

| Criterion | Fields | Default (after explicit enable) | Trigger |
| --- | --- | --- | --- |
| read-only idling | `probe.idleWriteMs` / `probe.abortGraceMs` | 6 minutes / 2 minutes | No write activity for this long → warn; after the grace period → stop |
| finished early | `probe.successIdleMs` / `probe.successPatterns` | 5 minutes / `["fail=0", "0 failed", ...]` | After bash output matches a success marker, no new changes for this long → stop |
| writing litter | `probe.forbidWritePatterns` | `[]` | A `write`/`edit` target path matches the regex → that write is refused outright |

## What counts as "write activity"

Only two kinds of events reset the idle timer:

1. `edit` / `write` tool calls
2. bash commands the classifier judges as writes

A repeat counts only when its **output did not change**. The same command returning new output is
progress — that is what measuring a repository looks like — so the count resets and a warning already
issued is withdrawn. A child that is genuinely stuck prints the same thing every time and still walks
into the threshold.

Only **read-class** commands are counted for spinning: a command that writes (a `bash.allow` entry whose command the classifier judges as a write, or an `edit`/`write` call) is progress, so it clears the counts and cancels a warning already issued. A coder that edits a file and re-runs the same test command is therefore never stopped by this criterion — listing an interpreter (`node`, `python3`) in `bash.allow` exempts that interpreter's commands entirely, since interpreters are classified as writes.

Read-class bash commands, and `read` / `grep` / `find` / `ls`, do not count. So "spinning with read-only bash commands" and "repeatedly scanning with read tools" are both judged as idling — this is intentional: no amount of read-only commands counts as progress.

Corollary: if a task genuinely needs extensive read-only investigation, either loosen `idleWriteMs` or set `readOnly: true` (which skips both time-based criteria, "read-only idling" and "finished early").

## Configuration template

```json
{
  "pi-subagents-extend/1": {
    "permissions": {
      "scope": ["src/auth/**"],
      "bash": { "allow": ["pnpm run typecheck", "pnpm test"], "writable": true },
      "maxDenies": 5,
      "probe": {
        "idleWriteMs": 360000,
        "abortGraceMs": 120000,
        "successIdleMs": 300000,
        "successPatterns": ["0 failed"],
        "forbidWritePatterns": ["scratch/.*", "_tmp-.*"]
      }
    }
  }
}
```

## Stop semantics (what the parent agent must know)

warn only blocks a single tool_call and writes the reason to it; stop is a **hard stop**: every blocked result carries `terminate`, and pi ends the turn when the whole batch of tool results is terminating (`docs/extensions.md`). The call that trips the stop gets the full reason; calls after it get a status line ("the run was stopped earlier") rather than the old reason over again. A stop fired by a timer (idling, finished early) has no call to answer, so the first boundary after it delivers the reason and only the later ones get the status line, because that reason names the action that caused the stop and a subagent that changed course reads it as a verdict on the new command. `contact_supervisor` and `structured_output` stay open either way. Therefore:

- **There is no wrap-up turn after a stop.** The subagent gets no further chance to "write a final report"; the parent agent has to infer what happened from what was produced before the stop plus the refusal reasons. If you want the subagent to explain itself, have it report before it crosses the line.
- **Escalation channels are unaffected by a stop.** `contact_supervisor` / `intercom` / `structured_output` are checked before the stop decision and are always allowed through — this only truly saves you when **the same batch contains an allowed result** (the batch is not entirely terminating, so the turn continues): the stopped subagent can still get "where I am stuck and what I need" out.
- A `[sandbox]` annotation at the end of a result (network disabled, write out of bounds) is **not a refusal**: it only explains a call that already failed inside the sandbox; it does not count toward permission refusals, does not trigger a stop, and does not consume the read budget. Do not treat it as "refused again"; just follow the suggestion inside (use `contact_supervisor` if authorization is needed).
- The stop reason is not a judgment of the current call. The text explicitly says "which criterion stopped the run" and names the call that triggered it; do not treat the path in it as "the path that was just refused" — that is history.

## Notes for the parent agent

- The "finished early" trap: after a success marker hits, it only stops once there are no new changes, so a task that still has work after verification will be judged "time to finish". **Put the verification command as the last step of the task**, or do not configure this criterion.
- `successPatterns` defaults to test-summary markers like `fail=0` / `0 failed`; if the project uses a different output format, write your own (e.g. `no errors`, `All files pass`). Do not use overly broad `ok` or `passed` — almost every command would match.
- To stop a subagent from carelessly writing debug files, use `forbidWritePatterns` to name the project's own temporary file patterns (e.g. `scratch/.*`, `_tmp-.*`). A hit refuses that single write, without stopping the run.
- Frequent "repeating a command" in the same delegation indicates a problem with the task description (it asks for the same action repeatedly); fix the task first instead of raising `repeatBash`.
- **Permission refusal** only counts **authorization-type** refusals, judged by whether the parent agent could resolve it by granting broader authorization or adjusting settings. Counted: paths outside the read scope (including using `.` as a path), commands not in the allowlist, read budget exhausted, tools not in `allowTools`, bash entirely disabled. **Write refusals are counted separately** (`maxWriteDenies`, default 2): a subagent whose scope is readable but whose `writeScope` is narrower keeps trying to write, which is a usage mistake answered by delivering the report — not evidence that the grant was wrong. The refusal names the write scope and says so, and the read budget is untouched by it. Not counted: usage errors (missing path, shell metacharacters, empty command), hard rules (tools that are permanently unavailable such as `powershell`/`codemode`, and the role md's `bash.deny`), and the dependency gate (a lockfile directory with no `node_modules/.bin`), which reports an unfinished install rather than a grant that does not fit — counting these against the budget would let a single parameter typo kill a long task prematurely. When a subagent reports a usage error, fix the task to be clearer instead of masking it with a larger `maxDenies`.
- Probes only handle deterministic signals. Semantic-level missed tests and unsafe changes are left to pi-subagents' built-in LLM watchdog (`subagents.watchdog`); the two complement each other.

## Working with pi-subagents' built-in capabilities

Delegation rules (how to write a brief, one writer per cwd, how to use resume/steer) follow **pi-subagents' built-in skill**; this skill only covers the probe layer: scope restrictions govern "what can be touched", probes govern "whether progress is being made".

pi-subagents' own skill defines how to wait; this skill does not restate it. To check details, read one section on demand rather than reading it all:

```js
subagent({ action: "guide", options: { topic: "tool-reference/execution-parameters" } })
subagent({ action: "guide", options: { topic: "workflows/supervisor-coordination-child-asks-parent" } })
```

The topics listed below are real section names in pi-subagents' bundled documentation; after a version upgrade, read them at the same address.

| What you want to look up | guide topic |
| --- | --- |
| `timeoutMs` / `toolTimeoutMs` / `checkpointBeforeDeadlineMs` / `toolBudget` / `extensionBindings` | `tool-reference/execution-parameters` |
| Subagent status and transcript | `tool-reference/status` |
| Retaining subagents, resume eligibility | `tool-reference/retained-children` |
| Exact semantics of resume / steer / stop | `tool-reference/resume`, `tool-reference/steer`, `tool-reference/stop` |
| Acceptance evidence and gates | `tool-reference/acceptance-gates` |
| A subagent proactively asking its parent (`contact_supervisor`) | `workflows/supervisor-coordination-child-asks-parent` |
| When the LLM watchdog runs and model choice | `watchdog/when-it-runs`, `watchdog/choosing-a-model` |

Probes only handle deterministic signals (counts, time, path patterns); the items below handle other concerns and need no probe once configured.

### Division of labor

| Need | What to use | How to configure |
| --- | --- | --- |
| Overall cap on how long a run may take | Native run-level deadline | `options.timeoutMs` (or agent frontmatter `timeoutMs`); when it expires the run is over |
| A single tool call hangs | Native tool deadline | Known-fast commands default to 5 minutes; change with `options.toolTimeoutMs` |
| Wrap up before the deadline | Native checkpoint steer | `options.checkpointBeforeDeadlineMs` (**async single agent only**): delivers "checkpoint and stop" at the next tool boundary before the deadline, asking for changed files / build-test status / remaining work |
| Cap on total tool calls | Native `toolBudget` | `{ soft, hard, block }`; at hard, read/grep/find/ls are blocked by default. **Do not set it for implementation subagents** (reads get blocked before writes) |
| Semantic quality: missed tests, out-of-scope changes, loop risk | Native LLM watchdog | `subagents.watchdog`, boundary review + cadence review every N tools; high severity is surfaced to the model |
| Delivery acceptance: which files changed, whether tests ran | Native acceptance gate | `options.gate: "pnpm test"` or `acceptance: { level, criteria, evidence, verify }` |
| Subagent needs resources/authorization mid-task | `contact_supervisor` / `intercom` | Always allowed; the parent can also interject via `subagent({ action: "steer", id, message })` |
| Idling, spinning, not finishing after verification, writing temporary files carelessly | **Probes** | The items above in this document |

### How they combine

**Probes + run deadline.** The deadline governs total duration; probes govern "acting but not progressing". When both are on, note: `checkpointBeforeDeadlineMs` sends a wrap-up steer before the deadline, and if a probe also judges idling at that moment, the subagent receives both instructions at once — whichever arrives first wins. In practice: back the main task with `timeoutMs`, and set `idleWriteMs` to about a third of `timeoutMs` so idling is caught earlier than the overall timeout.

**Probes + acceptance gate.** "Finished early" infers that verification passed from success markers in bash output — it is heuristic; real acceptance should be left to the gate — `gate: "pnpm test"` is executed by the host and recorded as evidence. So: **hand the verification command to the gate and do not configure `successPatterns` in probes to guess**. When both are on, if `successPatterns` matches too early (e.g. the command's echo rather than the real result), a subagent still working will be misjudged as done.

**Probes + permission refusals + steer.** After a stop from permission refusals, the parent agent has two options: re-delegate a fresh task (exploratory tasks, low cost) or `resume` the retained session with added authorization (long tasks you do not want to redo). `resume` reuses the original subagent's session and contract; the bindings belong to a new launch and can be changed.

**Probes + LLM watchdog.** They do not conflict; they use different configuration channels: probes go through `extensionBindings`, the watchdog through `subagents.watchdog` in settings. The watchdog has its own `stalemateRepeats` (default 3 identical warnings) that ends a turn — that is at the semantic level; the probe's repeating criterion is at the command level. Both may fire at once; they are not billed twice and do not need to disable each other.

**Probes + background runs.** Background (`async: true`) subagents run in a separate process and probes work as usual; `checkpointBeforeDeadlineMs` only works on async single agents. Foreground blocking runs have no such wrap-up mechanism, and a probe stop is a **hard stop**: the turn ends immediately, with no chance for the subagent to write a report.

### Things not to stack

- **Do not set `toolBudget.hard` for implementation subagents**: it blocks reads and searches first, the subagent gets less context and idles more easily, and the probe then kills the run — it looks like a probe misfire. To restrict, limit the scope (`scope`) and duration (`timeoutMs`).
- **Do not configure the same verification in both `successPatterns` and the gate**: one place deciding success is enough; two places tend to disagree over time.
- **Do not use `probe: false` to "save effort"**: by default only repeating and permission refusals are on, so turning it off gives up the two cheapest error signals. To actually silence it, write a specific relaxation such as `probe: { repeatBash: 50 }`.

