# Pair for Pi

Pair adds an explanation and a permission decision to the next coherent step. Related edits across a few files share one review: inspect the file list and individual diffs, then choose **Approve step**, **Deny**, or **Deny with note**.

## Current status

Version 0.10.0 adds focused action conversations in the right sidebar. Ask about one file, command, or selected proposed lines while Pi waits for approval. Adjust creates a candidate; inspect it in the center editor, then choose **Use revision** to replace only that part of the pending step. Nothing runs until the updated whole step is approved. Review Desk, checkpoints and pinned constraints remain removed.

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

## Explanations and discussion

Each action has a concise Markdown explanation. In VS Code, expand **Why this action** to read the rationale and optional section notes in the sidebar. Choose **Ask** or **Adjust** beside one action. For a function or smaller section, select its lines on the proposed side of the native diff and use **Pair: Ask About Selected Lines** or **Pair: Adjust Selected Lines** from the editor context menu. Ask leaves approval pending. Adjust produces a separate candidate; **Inspect diff** compares it with the original proposal. **Use revision** updates only the selected action or lines and requires fresh approval. **Back to step** keeps the conversation and unsent draft available. Navigation, draft text and expanded explanations remain local UI state and do not create model turns. Only Send invokes the current Pi model in a separate in-memory fork. It inherits completed conversation context, the current prompt and bounded pending-step context, with no execution tools. The main session stays blocked and unchanged. The fork has a stable prefix across its own turns; its first request is not guaranteed to reuse the main session's provider cache because its tool set differs. Fork conversations are ephemeral and limited to eight turns. Only accepted revisions and actual execution results enter the parent tool result; the chat transcript is not copied back. If context was clipped or a change needs a different protocol, the fork should ask for clarification.

## Group execution

Pi's native edit engine computes previews entirely in memory, including exact/fuzzy matching, overlapping-edit checks, BOMs, and line endings. Explicit newline/BOM notes cover otherwise invisible byte changes.

All files are checked against their previewed snapshots before execution. Remaining files are checked again before each action. Changed files require a new request. Actions run in order through Pi's normal validation, hooks, and permission checks.

If one action fails, later actions do not run. Completed or partial edits remain; there is no automatic rollback. History lists per-file outcomes and actual diffs. A repair or retry needs fresh approval. No pending execution permit is restored after restart.

Choose steps by understandable behavior: extracting a prompt can include creating its Markdown file and wiring the loader. Retry policy and compaction remain separate decisions. The eight-action and four-file limits bound a step; they do not make unrelated work one understandable decision. Every action in a mixed step must include its own explanation.

## Conversation history

History shows a bounded-width card with the outcome, brief rationale, and file counts. The expansion hint uses Pi's configured binding, normally Ctrl+O. Expanded results show full explanations, syntax-colored diffs, and relevant output. Denied proposals retain their previews, marked not applied. `/pair` focuses a pending review or reopens the latest result; reading is available while work runs. `/pair design` opens the saved design reader.

The card reports ordinary success. The agent should speak separately only for new decisions, deviations, failures, or a changed direction. One compact Pair indicator remains in the footer; there is no permanent tutorial widget.

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

Commands: /pair, /pair code, /pair on, /pair design, /pair new, /pair approve (design), /pair revise, /pair finish (older saved review), and /pair off. /pair resume explains the current flow. Disabling Pair does not revert files.

## Scope and limitations

File previews use project-local UTF-8 text, at most 256 KiB per file. Direct file edits reject symlinks, Git metadata, dependencies, and agent configuration. Shell requests show the full command and working directory; shell effects are not constrained to a file list. Pair is a workflow permission layer, not an operating-system sandbox. User-entered shell commands are not intercepted.

Arguments, approvals, and results remain in local Pi history. Denial does not roll back earlier approved changes. Verification results are agent-reported; no unperformed validation is implied.

## Source layout

- extensions/pair/action-session.ts, action-conversations.ts and action-revisions.ts — read-only review forks, scoped candidate adoption and exact revision guards.
- extensions/pair/permissions.ts — step requests, one-use permission, ordered execution, and denial feedback.
- extensions/pair/changes.ts — native in-memory previews, snapshot checks, and change statistics.
- extensions/pair/review-model.ts and diff-view.ts — structured hunks, syntax highlighting, line numbers, and unified/split rendering.
- extensions/pair/review.ts — fullscreen review component, navigation, search, mouse controls, and denial notes.
- extensions/pair/history.ts — compact change records and expandable diffs/outcomes.
- extensions/pair/ui.ts — overlay lifecycle, saved design/review reader, and status.
- extensions/pair/external.ts — exact before/proposed snapshots and VS Code diff handoff.
- extensions/pair/bridge.ts and review-connection.ts — authenticated local review transport and one decision shared by both interfaces.
- vscode/ — native editor companion, local client tests, and installation documentation.
- extensions/pair/context.ts — stable instruction contract, concise state updates, and compatibility normalization.
- extensions/pair/index.ts — lifecycle, optional designs, compatibility, and tool guard.
- extensions/pair/state.ts and files.ts — saved state, context, paths, snapshots, and older-review support.
- skills/ — collaborative-design and pair-implementation; no extra specialized skills.

Pi supplies UI, persistence, and tool execution. TypeBox defines input schemas; diff supplies text change statistics and older saved-review patches. The interactive command terminal uses node-pty in an owned Node helper.

## Validation and visual review

`npm test` covers approval/denial, exact snapshots, stale files, partial failure, context lifecycle, compaction restrictions, line numbers, highlighting, wrapping, navigation, note input safety, mouse actions, and narrow layouts. `npm run preview -- multi` opens synthetic data in the actual fullscreen review component. `npm run capture` records fixtures for image review. See `docs/ui-validation.md` for capture and replay commands.

Highlighting, navigation, search and editor handoff are local operations. A stable short instruction contract replaces full-skill injection on every user turn; concise state is sent only when changed or restored. UI details are not model-facing tool content.

`pair_work` results contain the action outcome, design path/revision/approval, and relevant status facts. They do not repeat the permission instructions or return the full design to the model; the published Markdown remains available in the UI.


Command review (0.7): exact commands use numbered lines and indented visual wrapping. VS Code shows a separate live output tail with a Follow output toggle; Pi shows the latest eight display rows. Output updates are display-only: no extra model calls, feedback events, or approved-snapshot changes. The live pane keeps at most 400 lines / 32 KiB per action and follows native tool buffering; final native tool output remains in the conversation.

VS Code 0.7.1 puts the command and live output in a central editor tab, with output filling the remaining editor height. The right sidebar retains step approvals and action navigation. Open command source returns to the exact native shell snapshot.

Pair 0.8 adds Bash/PowerShell syntax highlighting and xterm.js terminal rendering. Set `interactive: true` on a command action to use a real PTY after approval; the center view accepts keyboard input, paste, resize, Ctrl+C and Stop command. Interactive actions have a 300-second default timeout (configurable up to 300 seconds). Input is scoped to one running command and is not copied into prompts or review events. The PTY runs in an owned Node helper; Node.js and the selected shell must be installed. Action rationale and optional section explanations stay in the sidebar.
