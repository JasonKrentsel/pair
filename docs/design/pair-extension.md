# Pair: explained change review

## Intended interaction

The human reviews one understandable decision or behavior change, sees why it is needed and the exact edits, and chooses Approve all, Deny, or Deny with note. Routine local Git setup stays available without a planning workflow.

One tool invocation was too narrow a permission boundary: creating a prompt file and wiring its loader belong together, while retry policy and compaction remain separate decisions. Raw patch documents and repeated narration also made the earlier history hard to scan.

## Review dialog and history

The review assumes Pi's fullscreen terminal mode. Its centered overlay shows a short title, change counts, file tabs, and the selected diff. Multiple replacements within a file become one coherent diff. Tabs preserve code width by default; a sidebar is optional on wide terminals. The explanation stays reachable, per-file scroll positions persist while open, and decision controls remain fixed. Approval covers the entire displayed group. Short commands use a compact dialog and appear once with their working directory.

The shared renderer uses Pi syntax highlighting with line numbers and changed-word emphasis. Unified and adaptive side-by-side views support hunk navigation, local search, and wrapping. The inline note editor keeps the proposal in context. Keyboard and mouse controls use the same component in production, test fixtures, and previews. Terminals too small to show the controls cannot approve a change.

The selected file can open in VS Code as exact before/proposed snapshots with the original extension. Approval remains in Pi, and editing those temporary snapshots never changes the approved execution payload. Snapshot files remain in the OS temporary directory so the editor can keep reading them after the review closes. Editor failures stay in the review rather than failing the proposed change.

Collapsed history retains the outcome, brief rationale, paths, and change counts at a bounded reading width. Expanded history shows full explanations, syntax-colored diffs, and output. Denied proposals retain their preview marked not applied. The model is instructed not to repeat ordinary success in a second message. A single compact footer indicator replaces the persistent tutorial. /pair focuses a pending review or reopens the latest result read-only, including while the agent is working.

## Execution and state

pair_step accepts a title, why, and 1–4 related edit/write entries for distinct files, or one standalone command. The older single change field is normalized for compatibility before validation. Pi's native edit tool with in-memory IO produces faithful proposed content using the native matching, overlap, BOM, and newline behavior. The review model derives display hunks from the before/after snapshots; display normalization does not alter the execution payload. Explicit notes expose otherwise invisible BOM and newline changes.

Approval creates a one-use permit for each exact nested native action. All file snapshots are checked before execution and remaining files are checked before each following action. Pi's executeTool preserves normal validation, hooks, and permission checks. Failure or cancellation stops later actions. Completed and partial changes remain; no rollback or automatic retry is claimed. Actual results are compared to the reviewed content and recorded per file.

Deny or Escape from the main review stops mutations for the turn. Escape in note entry returns to the pending review. Submitting a nonempty note permits preparing a corrected request, but it needs a fresh human approval. Identical denied requests are blocked. Automatic compaction invalidates pending permits while retaining denial restrictions. No permit survives a session or branch transition.

## Context and token use

A short, stable instruction contract replaces injecting the full skill on every user turn. Dynamic state is concise and sent only when changed or restored. Disabling Pair explicitly updates that context, and session/branch transitions refresh it. Navigation, syntax highlighting, search, and editor handoff run locally without model calls. UI snapshots and detailed previews remain in tool details rather than model-facing tool content. Successful results avoid storing a duplicate proposed snapshot.

## Optional designs and compatibility

pair_work maintains optional design drafts and status. A design approval accepts an approach without granting implementation. /pair design reads existing saved designs, older-review state, and baselines. Earlier increment grants cannot bypass the change review. Routine Git setup does not alter saved review state.

No new skills or runtime dependencies are introduced. The same two broad skills guide readable changes and consequential design decisions.

## Limits and verification

File previews are bounded project-local UTF-8 text. Groups are sequential, not atomic. Shell approval concerns the displayed command and is not filesystem isolation. The agent's rationale still requires judgment; group size alone does not prove conceptual simplicity.

Version 0.2 validation includes 35 passing behavior checks, TypeScript checking, and 42 captured production-component frames across four terminal sizes. An isolated Pi 1.4.0 fullscreen session exercised file switching, inline denial-note submission, and the command dialog without a model or project mutations. This exposed and fixed a host-terminal sizing bug that component fixtures alone did not catch.

Component captures establish layout; live terminal replay checks native integration; permission tests establish execution behavior. Wider live terminal resizing and native mouse behavior are not claimed as manually verified. The repeatable capture, screenshot ingestion, repair, and validation loop is documented in [UI validation](../ui-validation.md).

