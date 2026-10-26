# Pair for Pi

Pair adds an explanation and a permission decision to the next coherent step. Related edits across a few files share one review: inspect the file list and individual diffs, then choose **Approve step**, **Deny**, or **Deny with note**.

## Current status

Version 0.6.0 supports mixed steps: 1–8 ordered edits, writes, and commands across at most four files, with an explanation per action. Inline questions suspend the step for an answer and restore the same exact proposal for explicit approval. Questions can be sent directly from their native thread; Review Desk shows answers before optional code excerpts. Delayed decisions from an earlier approval cycle are rejected.

Version 0.5.2 calls the approval unit a **step** and each edit, write, or command an **action**. It includes the 0.5.1 Review Desk fixes: show the proposal before comments exist, display a labeled inline overview when per-file explanations are absent, and reconnect automatically when Pi replaces its listener with a single matching session.

Version 0.5.0 adds native VS Code section comments and a Review Desk. Draft questions and requested corrections locally, then send them as one batch. Question-only feedback returns to approval after the answer; requested corrections retain unaffected proposed files and require fresh approval. The right sidebar manages the current decision; the Review Desk opens in the editor area.

Version 0.4.0 adds a shared checkpoint and human constraints panel in Pi and VS Code. The two broad skills now favor proportional design, coherent edits, focused verification, and concise milestone reports. Existing step approvals remain exact and one-use.

Version 0.2 adds a fullscreen review UI with syntax highlighting, file/hunk navigation, inline feedback, compact history, and optional VS Code diffs. Automated behavior checks, type checking, visual fixtures, and isolated Pi integration checks are documented in `docs/ui-validation.md`. Restart Pi or use /reload when idle after updating the local package.

Version 0.2.1 adds compact schema errors and short design/status receipts. Invalid Pair arguments report up to three corrections with one-based action/edit numbers, without echoing source or commands. Nothing runs before the corrected request passes validation and permission review. Existing history, including saved validation failures, remains readable.

Version 0.2.2 records design approval from chat and keeps large-diff decision controls visible after terminal resizing.

Version 0.3 adds a VS Code companion with native, read-only diffs, workspace language modes, multi-file navigation, and approval controls. Pi and VS Code share one pending decision; Pi checks and executes the exact reviewed operations.

## Everyday use

Use /pair to enable Pair in a new conversation, or /pair on to enable it explicitly. No goal form or design document is required. Existing active Pair sessions use the new permission behavior after reload.

For a meaningful step, the agent calls pair_step with a title, concise why, and a changes array. A step can contain 1–8 ordered edits, writes, and bash/powershell commands, with at most four distinct file entries. Each action carries its own explanation. Commands run where listed and can consume earlier writes. Combine multiple replacements to the same file in one edit entry. File baselines are rechecked before each action; if a command alters a later file, execution stops before applying its stale edit. Actions depending on unknown generated content need a later step after inspecting that content. The changes array and legacy single change field retain their existing names for compatibility.

The centered review fits its content. File tabs leave room for syntax-colored code; an optional sidebar is available on wide terminals. Unified and adaptive side-by-side diffs show line numbers, changed-word emphasis, and searchable hunks. The short explanation remains visible and its full text is reachable. Decision controls stay fixed. Commands appear once with their working directory.

- **a — Approve step:** execute every displayed action in the step.
- **d — Deny:** execute nothing and stop the turn.
- **n — Deny with note:** execute nothing and explain what should change.
- **Escape:** deny from the main review. Inside note entry, return to the still-pending review.
- **Left/Right, Tab/Shift+Tab, or 1–8:** select an action; each keeps its own scroll position.
- **[ / ]:** previous/next changed section. **i:** full explanation; Escape returns.
- **/**: search; **f / F:** next/previous match. **w:** wrap. **s:** unified/split. **t:** sidebar. **?:** help.
- **v:** open the selected change in the VS Code companion. Without the companion, open temporary before/proposed snapshots and decide in Pi. Snapshot edits never alter the execution payload.
- **Up/Down, Page Up/Down, Home/End:** navigate longer changes.

Fullscreen mouse controls select file tabs and actions and scroll the review. Type feedback inside the same dialog; submitting it denies the proposal. Small terminals prevent approval until the full controls can be shown.

A denial note can request a revision, skip an action, or ask for discussion. A revised proposal still needs approval; a skipped action should not be proposed again unless the human changes that instruction. An unchanged denied request cannot be resubmitted in the same run. Automatic compaction preserves denial restrictions.

## VS Code review

Install the local companion from `vscode/` with `npm run package:vscode`, then install the generated VSIX in VS Code. Use `/pair code` to open Pi's current working directory in VS Code and focus this session. A single matching session connects automatically; multiple sessions have an explicit selector. The next proposal opens its explanation, file list, and native diff. `pair.openReviewAutomatically` controls automatic opening.

The sidebar keeps **Approve step**, **Deny**, and **Deny with note** available while the diff scrolls. Approval covers the complete listed step. Commands display their exact text and working directory. Approving in either interface resolves the same request once; the result appears in both. Closing VS Code leaves the Pi request pending. A single replacement Pi listener reconnects automatically; use `/pair code` to reveal the review. saved results are read-only.

Diffs inherit the actual file's language mode or workspace file associations for a new file, using your VS Code theme and font. Virtual documents provide syntax highlighting, but language servers requiring real project files may not provide semantic colors or IntelliSense. A modified preview cannot be approved. VS Code approval also blocks unsaved affected source buffers; save or discard those edits before approving. Pi's terminal only checks on-disk state and cannot see unsaved editor buffers.

The connection is authenticated and restricted to the local machine and matching workspace. Snapshot transport, navigation, focus and polling use no model calls; unchanged reviews use ETags. This release supports local desktop VS Code; remote SSH, WSL, containers, and web VS Code are outside its scope. Optional design approval continues through chat or `/pair approve`; companion approval applies to `pair_step` steps.

## Section feedback and Review Desk

Select lines in a Pair before/proposed diff and use **Ask about section** or **Request section change**. Native comment threads keep the feedback beside the exact snapshot. You can edit or discard drafts before sending; the sidebar shows drafts and unresolved threads. Open **Review Desk** for a larger overview, original anchors, answers, revision comparisons, and addressed/open controls. Opening it uses the active editor group and leaves your right sidebar in place.

**Send question** sends one inline question; **Send feedback** sends a batch. Question-only feedback temporarily suspends approval without applying anything. Pi records its answers and uses a reference-only `pair_step {resume: reviewId}` call to restore the same exact proposal as **Ready to approve**. Resumption does not resend source code or grant permission. A batch requesting revisions needs a corrected proposal; mixed questions/revisions first pause for discussion. The agent can send replacement files using `revises`; Pair retains other actions in their original order and rechecks every file. Changing a command or action order requires a fresh complete step. There is no partial-hunk approval in this version. Marking feedback addressed is a human bookkeeping action, never permission to run.

Per-file rationales and optional section explanations use Markdown, including inline code and fenced examples. Comment anchors remain attached to their original immutable snapshots. Revised content does not silently inherit the old line range. The Desk can compare the original proposal with the later proposal; if the archive was evicted, it reports that instead of inventing a match.

Drafts, navigation, selection, rendering, polling, and addressed/open changes make no model calls. Submitted feedback enters through the pending `pair_step` result exactly once; answers use `pair_work` action `feedback`. Stable tool definitions and the system contract contain no changing UI state. Local review events and full snapshots are excluded from model-facing content; reload/compaction adds only a bounded recovery brief. Cache reuse still depends on the model provider and Pi's compaction behavior.

The local archive retains up to eight reviews and eighty threads within a 16 MiB snapshot budget. Draft storage is bounded and scoped to the project and conversation. No pending approval survives reload. Earlier **Discussion requested** results remain reference-only; ask Pi to propose the saved step again for approval. `/pair new` clears this task's feedback lineage.

## Checkpoint and constraints

Open `/pair checkpoint` or the companion's checkpoint panel to read the current objective, implemented work, verification, usable behavior, deferred work, and next decision. These are the agent's reports, not independently proven results or permission to execute. Later actions mark the checkpoint as potentially outdated until the agent refreshes its verification report. The panel remains available without a pending proposal.

The agent updates changed fields with `pair_work` action `checkpoint` at meaningful milestones, after verification changes, or when direction changes. It should distinguish working behavior from unwired code or internal test coverage, and keep skipped or failed checks visible. Routine result cards do not need duplicate chat summaries or a checkpoint after every edit.

Pin human instructions from either panel, or use `/pair constraint task <instruction>` and `/pair constraint turn <instruction>`. `/pair constraint` offers interactive text and scope selection. Remove pins from the panel. Pair does not automatically extract constraints from chat, and the agent cannot add, change, or remove pins.

- **Task:** applies until removed or `/pair new` starts new pairing work.
- **Turn:** if added while the agent is working, applies to that turn and expires when the next human chat turn starts. If added while idle, applies to the next human chat turn and expires when the following one starts. Queued human input advances the lifetime when delivered to the agent.

Direct human instructions still apply and can supersede an older pin. Pins grant no edit, command, or test permission. Changing pins invalidates a pending proposal so the agent can account for the instruction before requesting a fresh decision. The panel supports up to 12 active pins of 300 characters each. Reading and navigating it do not call a model; only changed or restored checkpoint/constraint facts enter context.

## Group execution

Pi's native edit engine computes previews entirely in memory, including exact/fuzzy matching, overlapping-edit checks, BOMs, and line endings. Explicit newline/BOM notes cover otherwise invisible byte changes.

All files are checked against their previewed snapshots before execution. Remaining files are checked again before each action. Changed files require a new request. Actions run in order through Pi's normal validation, hooks, and permission checks.

If one action fails, later actions do not run. Completed or partial edits remain; there is no automatic rollback. History lists per-file outcomes and actual diffs. A repair or retry needs fresh approval. No pending execution permit is restored after restart.

Choose steps by understandable behavior: extracting a prompt can include creating its Markdown file and wiring the loader. Retry policy and compaction remain separate decisions. The eight-action and four-file limits bound a step; they do not make unrelated work one understandable decision. Every action in a mixed step must include its own explanation.

## Conversation history

History shows a bounded-width card with the outcome, brief rationale, and file counts. The expansion hint uses Pi's configured binding, normally Ctrl+O. Expanded results show full explanations, syntax-colored diffs, and relevant output. Denied proposals retain their previews, marked not applied. `/pair` focuses a pending review or reopens the latest result; reading is available while work runs. `/pair design` opens the saved design reader.

The card reports ordinary success. The agent should speak separately only for new decisions, deviations, failures, or useful checkpoints. One compact Pair indicator remains in the footer; there is no permanent tutorial widget.

## Routine tasks

Native read/find/grep/ls remain available. Supported local Git inspection/setup bypasses an additional Pair prompt:

- git --version
- git status, git status --short, git status --short --branch
- git diff, git diff --stat, git diff --cached, git diff --cached --stat
- git rev-parse --show-toplevel, git branch --show-current, git remote -v
- git init, git init --initial-branch=main, git init --initial-branch=main --template=

Status flags such as `--untracked-files=all` and ordinary diff inspection flags such as `--check` are recognized, including literal file paths after `--`. Shell composition, expressions, arbitrary options, staging, commits, and pushes still need an explained permission request. These commands do not change Pair's saved review state.

## Optional designs and compatibility

Use /pair new to establish a larger design. pair_work can publish/revise the optional Markdown design. A clear chat decision such as “approved” or “I approve the design” records approval for the current revision immediately. The reader and /pair approve remain available; they recognize an already-approved revision. Actual edits and commands still request permission.

Approval with a requested change, such as “no concurrency cap, approved,” applies once to the resulting design revision. The agent publishes those changes and records that revision with `pair_work approve_design`; no second human confirmation is needed. Later unrelated revisions require their own approval. Republishing identical text preserves the revision and its approval. Questions, quoted approval and bare “ok/yes” do not count as approval.

Existing version-1 session state, design documents, and older approval-baseline diffs remain readable in /pair design. Earlier increment approvals no longer grant execution. The old propose/pause/finish/apply_operations workflow is retired. Routine Git setup does not pause or replace an application review. Changes to files in an older saved review invalidate its prior completion/check report while retaining its baseline.

Commands: /pair, /pair code, /pair checkpoint, /pair constraint [task|turn] <instruction>, /pair on, /pair design, /pair new, /pair approve (design), /pair revise, /pair finish (older saved review), and /pair off. /pair resume explains the current flow. Disabling Pair does not revert files.

## Scope and limitations

File previews use project-local UTF-8 text, at most 256 KiB per file. Direct file edits reject symlinks, Git metadata, dependencies, and agent configuration. Shell requests show the full command and working directory; shell effects are not constrained to a file list. Pair is a workflow permission layer, not an operating-system sandbox. User-entered shell commands are not intercepted.

Arguments, approvals, and results remain in local Pi history. Denial does not roll back earlier approved changes. Verification results are agent-reported; no unperformed validation is implied.

## Source layout

- extensions/pair/permissions.ts — step requests, one-use permission, ordered execution, and denial feedback.
- extensions/pair/changes.ts — native in-memory previews, snapshot checks, and change statistics.
- extensions/pair/review-model.ts and diff-view.ts — structured hunks, syntax highlighting, line numbers, and unified/split rendering.
- extensions/pair/review.ts — fullscreen review component, navigation, search, mouse controls, and inline feedback.
- extensions/pair/history.ts — compact change records and expandable diffs/outcomes.
- extensions/pair/ui.ts — overlay lifecycle, saved design/review reader, and status.
- extensions/pair/external.ts — exact before/proposed snapshots and VS Code diff handoff.
- extensions/pair/bridge.ts and review-connection.ts — authenticated local review transport and one decision shared by both interfaces.
- vscode/ — native editor companion, local client tests, and installation documentation.
- extensions/pair/context.ts — stable instruction contract, concise state updates, and compatibility normalization.
- extensions/pair/checkpoint.ts and checkpoint-ui.ts — bounded milestone reports, human constraint lifetimes, and the Pi reader.
- extensions/pair/index.ts — lifecycle, optional designs, compatibility, and tool guard.
- extensions/pair/state.ts and files.ts — saved state, context, paths, snapshots, and older-review support.
- skills/ — collaborative-design and pair-implementation; no extra specialized skills.

Pi supplies UI, persistence, and tool execution. TypeBox defines input schemas; diff supplies text change statistics and older saved-review patches. No new runtime dependencies.

## Validation and visual review

`npm test` covers approval/denial, exact snapshots, stale files, partial failure, context lifecycle, compaction restrictions, line numbers, highlighting, wrapping, navigation, note input safety, mouse actions, and narrow layouts. `npm run preview -- multi` opens synthetic data in the actual fullscreen review component. `npm run capture` records fixtures for image review. See `docs/ui-validation.md` for capture and replay commands.

Highlighting, navigation, search and editor handoff are local operations. A stable short instruction contract replaces full-skill injection on every user turn; concise state is sent only when changed or restored. UI details are not model-facing tool content.

`pair_work` results contain the action outcome, design path/revision/approval, and relevant status facts. They do not repeat the permission instructions or return the full design to the model; the published Markdown remains available in the UI.


Command review (0.7): exact commands use numbered lines and indented visual wrapping. VS Code shows a separate live output tail with a Follow output toggle; Pi shows the latest eight display rows. Output updates are display-only: no extra model calls, feedback events, or approved-snapshot changes. The live pane keeps at most 400 lines / 32 KiB per action and follows native tool buffering; final native tool output remains in the conversation.

VS Code 0.7.1 puts the command and live output in a central editor tab, with output filling the remaining editor height. The right sidebar retains step approvals and action navigation. Open source / inline feedback returns to the exact native shell snapshot.
