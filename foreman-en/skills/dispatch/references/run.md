# Hands-on work (/foreman-en:run)

Read this when hands-on work is levelled 1 or higher, before writing a brief or splitting work into packages. The levels are under "Levels" in SKILL.md; when the cell has several candidates or a required agent, also read `references/seats.md`; for research tasks, also read `references/research.md`; checking and rework of what comes back are in `references/acceptance.md`.

## Who gets it
- Levels 1–3 go by `resolved_modules.run.<level>`: if it says `"claude code"`, Claude does the task itself (the script also refuses to hand off that level); if it lists candidates, pick one per seats.md and hand the task off. When the level is configured per scene (see "Scenes" in `references/config.md`), first pick the scene by the scene routing in the preferences and add `--scene <scene> --scene-why "<reason>"` when handing it off; the cell that counts is that scene's merged cell, and a resume keeps the original scene. When Claude does it, still think through the scope and the "done when" as the brief below would, and check the result per acceptance.md.
- When the user explicitly wants it handed off (for example by naming it with `/foreman-en:run`), skip the level 0 check and hand it off even if the level is `"claude code"`: add `--agent <agent ID>`, picking one whose `capabilities.modes` includes `run`, with the built-in default effort unless you give `--effort` (the result is marked `outside_cell`). When the level lists candidates, `--agent` can only pick one of them. To use another model, add `--model`; it can only switch to another model from the same provider.
- Mixed tasks: when a piece of work has parts only Claude does (design decisions, copy, names) and parts that can be handed off, Claude settles the former first and writes them into the brief, then hands off the rest. In front-end work, decisions about layout, color, type, spacing, motion and how interactions feel are Claude's; only the logic built to a settled design or to existing component patterns (state, data fetching, form validation, API wiring, tests) is handed off.

## Writing the brief
The more specific, the better the agent does. Use this structure:

```markdown
# Goal
What to build and why (a sentence or two of background).

# Scope
- May change: specific files or directories
- Read-only reference: related files
- Don't touch: …

# Size
Roughly how many lines and files the change should be, and what isn't needed this time, such as command-line options, settings, compatibility with old data, or tests.

# Requirements and constraints
Interface signatures, data formats, existing patterns and helpers to reuse, performance needs, compatibility, etc.

# Allowed adaptations
Things the agent may handle without stopping to ask. For example:
- If the given test entry point won't run, use an equivalent one that covers the same tests
- May fix a particular test fixture, but must not weaken any assertion
(Write "none" if there are none.)

# Names and text
- Names: what new files, classes, functions, key parameters and settings are called
- Comments: where they're needed and what they say
- Messages: exact wording or templates for logs, errors, help text and output headers (to be used as is)
(Leave this section out if the task doesn't involve any of these.)

# Don't
Things off-limits for this particular task.

# Done when
What counts as finished. Write verification as two items, each with the actual commands:
- Agent checks: the targeted tests and checks the agent runs, covering only what this change touches
- Final check: the full test suite or script Claude runs on the final version; the agent doesn't run this one

# Report
Anything that needs special mention in the report.
```

Agents tend to do everything and do it heavy: even simple tasks get extra options, settings, abstraction layers, compatibility branches and lots of tests. The "Size" section is there to prevent this: state the expected size and what isn't needed, and check against it when reviewing. The standing rules the script appends also say "keep to the size, only necessary tests, don't code defensively"; repeat it in the brief when the task invites overdoing it. Keep the brief itself in proportion too; don't write pages for a simple task.

Grant "Allowed adaptations" by meaning, not by size: a one-line change can move an out-of-sample boundary, a fee rate or an assertion. Anything beyond the scope that isn't in this section makes the standing rules tell the agent to stop and ask in the report's `decision_requests`. Write foreseeable environment problems (such as a same-named `tests` package in the project) into this section up front to save a stop.

Verification is split along the two items of "Done when", so the full suite runs only once on the same code: the agent runs targeted tests, rerunning the affected ones after it changes code; Claude runs the full suite on the final version. The standing rules tell the agent not to run the full suite unless the brief explicitly asks for it; when it really needs to see the full results itself (for example, the task is to fix failures the full suite shows), say so under "Agent checks".

**Names and text** are Claude's to set: outside models write weakly, with piles of jargon and stiff phrasing. Give the names of new files, modules, classes, functions, key parameters and settings as a list, and anything not on the list follows the project's existing style; say where comments go and what they say, in the same language the project uses; for logs, error messages, command-line help, output headers and other text people will see, give the exact wording or a template and require it to be used as is.

## Handing it off
- Write the brief to a UTF-8 file first (in the scratchpad directory if there is one, otherwise in the system temp directory), then start `run` in the background (Bash `run_in_background`); you get notified when it finishes. Also start the three-minute health check in `references/recovery.md`. The script appends standing rules: stay in scope, do a preflight check, start with the targeted checks given to it (and run extra targeted checks tied to the change when needed), when to stop and ask, put better approaches or problems outside the scope in the report's `suggestions` instead of stopping, only necessary tests, no commit/push, no secrets, report in the schema.
- After starting, tell the user the model and effort and add the board link as "When you hand off" in SKILL.md says, and see to the live view.
- Several runs can go in parallel, but their file scopes must not overlap. **Claude doesn't touch files an agent is changing.**
- If the allowed scope includes paths ignored by `.gitignore` (such as `tests/` or a results folder), pass them with `--track "<path>"` (can be given more than once); otherwise change tracking can't see those files. Resume keeps the previous round's `--track`.
- When Codex's sandbox isn't `read-only` / `workspace-write` (for example `danger-full-access`), `--cwd` **doesn't limit what Codex can write**. The scope is then held only by the brief and by reviewing the diff afterwards.

## Splitting work to run in parallel
Most of the time an agent's run takes goes into the model thinking, and only a small part into running commands. So splitting a big task across several sessions running at once noticeably cuts the wait. The cost is more tokens in total (each session reads the background on its own), and Claude has to write more briefs and check more results.

**Complex (level 3) work must first be decomposed.** Before dispatch, list the work packages, their dependencies, writable files, interface contracts and targeted checks. If two substantive packages can start together, assign them to at least two sessions and start them in the same background batch. There is no ten-minute minimum per package. For lower levels, split only when the saved time is worth the overhead.

- Write scopes in a batch must not overlap. Set signatures, formats and other contracts up front; no package should need another package's unfinished code. Independent modules, tests against a fixed contract and read-only investigations can run alongside one another. The host owns integration and final verification. Do not give multiple workers the same implementation.
- Do blocking work first, then split as soon as the cause or interface is known. If there is no safe split (for example, one shared core file and no useful independent investigation), or config and available capacity only allow one seat, record the reason. Never bypass configuration. Check `agents_status.<ID>.max_parallel`; runs from other sessions use those slots too.

**How to hand it off**:
- Level each part by its own difficulty. If a part is level 0 or its level is `"claude code"` in the config, Claude does that part itself, also staying out of the other parts' files; hand off the rest as usual. When the parts have different levels and one of those levels has another required agent, create one plan per level under the same group name.
- Give the group a name (an ASCII code name plus the date, such as `factor-scripts-1013`, used only on command lines; the live view shows each part's `--title`; use a different name for each group within a conversation; names repeated across conversations are fine, since the view only counts runs from the current conversation; only letters, digits and `. _ -`, because the live view puts it on a terminal command line, and the script rejects other characters) and hand off each part with `run --level <level> --group <name> --scope <path it may change>`; `--scope` can be given more than once. When parts go to different agents in the same cell and the cell has a required agent, handing them off one by one is refused: first create a plan with `plan --module run --cell <level> --group <name> --seat <agent>=<part name> …`, then hand off each part with `run --plan <plan_id> --seat <n> --scope …`. Start the parts together in the background, in the same message.
- The script refuses two cases: the agent already has as many runs in progress as its limit allows (counted across all groups and sessions), or the write scope overlaps with a hands-on run in progress in the same group (discussions and reviews don't write files, so their scopes aren't checked). If refused, split the scope again as the error says, or wait for an earlier run to finish.
- Besides the general structure, each brief says: what the other parts of the group do and which files they change (those files are off-limits); the shared interface agreements (copied word for word into every brief); how to verify this part on its own.
- The terminal live view (while the web board is off) gets just one tab: `watch.mjs --group <name>`, titled "Run: <short title>".
- Tell the user how many parts there are and what each does, with the model and effort of each.
- **Checking**: check each part on its own (its diff and its targeted checks, not the full suite: the other parts aren't merged in yet, so the full suite can't pass anyway), and send back only the parts that fail (resume keeps the group and scope). Once all pass and any needed integration steps are done, Claude does an **overall check**: run the full tests or scripts on the combined final version. In the report, list each part's run_id and token use, then the total.

## Overlapping review with the next batch
**Review gates integration and delivery, not the start of the next batch.** Once A's implementation is finished, the host has checked the changes and run targeted checks, and the review candidate is fixed, start B alongside A's review whenever B meets the conditions below. Don't wait for review results. Prepare B's brief and baseline ahead of time. Keep the existing authorization, seats, concurrency limits, write scopes and health checks. If A's review needs confirmation, start an already authorized B in the background before opening the confirmation dialog. If B can start independently even earlier, dispatch it as described above.

1. **Choose B's starting point.** If B doesn't depend on A, start from the shared stable baseline without A's changes. If B needs an implemented, sufficiently stable interface from A, it may start from A's exact candidate version as a provisional baseline. If review could change the interfaces, permissions or data contracts B depends on, or the provisional baseline can't be safely fixed, start only B's independent part and hold the rest until the blocker is cleared.
2. **Decide on isolation.** Before planning A's review, the host pins the review `--cwd`, candidate and scope, as well as B's `--cwd`, starting point and write scope. Use separate worktrees by default to isolate review from concurrent writes; switching branches in one worktree isn't isolation. Share a worktree only if B cannot change A's patch, attachments, configuration or context the reviewer needs. Disjoint write scopes alone aren't enough (see `references/review.md`). Plan and launch from the respective worktree directories, checking that project settings and preferences still apply. The host handles any checkpoints, branches and integration under project rules and user authorization. Don't stage or commit the user's changes to make this work; workers still don't commit or push. If safe isolation isn't possible, only start work that won't interfere with the review.
3. **Dispatch and check separately.** Track A's review and B's execution in separate groups. In B's brief specify its starting point (record the SHA when committed), dependency versions and interfaces, write scope and targeted checks. Check B on its own as soon as it's done and follow its own review level. If B needs review, use its actual baseline to scope the review to B's changes, with A's changes as context only.
4. **Keep the integration gate.** Only integrate A after it has a valid review, blocking findings have been resolved and any required re-review is complete. Work that depends on A must wait for that gate and pass its own checks and any required review. If A needs fixes, fix A first, bring B onto the corrected baseline, inspect the combined changes and rerun affected checks, then use the usual review rules to decide whether B needs a re-review. If A's review fails, is incomplete or is `stale`, continue genuinely independent work but don't integrate or deliver work that depends on A. The host handles final integration and runs the full checks on the combined version as specified in `references/acceptance.md`.
