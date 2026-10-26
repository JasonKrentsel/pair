# Pair for Pi

Review Pair proposals in the same VS Code workspace as your Pi working directory. The extension provides native, read-only diffs and an approval panel that stays available while you scroll a large change.

## Use

1. Install this companion and use Pair 0.6.0 in Pi for mixed steps and question resumption. Basic inline feedback remains compatible with Pair 0.5.0. Checkpoints require Pair 0.4.0; basic review remains compatible with Pair 0.3.0.
2. Open Pi's working directory in VS Code. A single matching Pi session connects automatically. With multiple sessions, use **Pair: Select Pi Session**.
3. Pair's next proposal opens its explanation, file list and first native diff. Choose another file or command in the numbered **Step Actions** list, or use **Pair: Next Action in Step** / **Previous Action in Step**.
4. Choose **Approve step**, **Deny**, or **Deny with note**. Approval covers the complete listed step. Pi executes the exact reviewed operations and reports their result in both interfaces.

The review buttons remain in the sidebar while the native editor scrolls. The editor toolbar also links back to the review and offers approval actions. Use the normal VS Code diff layout and language-mode controls to adjust presentation. `pair.openReviewAutomatically` can disable automatic focus for new proposals; explicitly opening a review from Pi still focuses it.

## Inline feedback and Review Desk

Keep Pair in your right sidebar. This update preserves your existing container position. Diffs and **Pair: Open Review Desk** use the active editor group; the extension does not create a second editor group over your right-side controls.

Select 1–40 lines in an original, proposed, or command snapshot. Use the native comment gutter to **Save question** or **Save change request**, or the editor context menu's **Ask About Selected Lines** / **Request Change to Selected Lines** commands. File explanations and optional line annotations appear as native Markdown comment threads. Drafts stay local. Use the inline **Send question** button for one question, or send a group from Review Desk. Question and answer threads expand when new content arrives.

Review Desk groups drafts, changed proposals, waiting questions, answers, addressed feedback and older anchors. Open an anchored diff to inspect the original exact snapshot; **Changes since feedback** compares the old proposed file with its explicitly linked revision. It never guesses that unrelated similar code is a revision. Marking feedback addressed only changes its review state and never approves execution.

Sending 1–10 comments (up to 1,500 characters each) pauses the current approval and returns one compact feedback batch to the existing Pi conversation. Question-only batches ask Pi to explain, then restore the exact step for explicit approval; requests for changes let Pi prepare a new proposal. A batch containing both questions and revision requests keeps the original step blocked for correction. While Pi answers, the panel says **Answering questions**; when the same proposal is rearmed it says **Ready to approve**. Recorded replies appear in both the native thread and Review Desk. Mixed steps show every file operation and command in execution order, each with its own rationale. Approval still covers the complete proposal, and unsent current drafts must be sent or removed before approving in VS Code.

Drafts, selections, exact snapshots and view navigation stay outside model context. Local drafts survive VS Code reload and a Pi bridge reconnect under the same actual conversation. A different conversation or branch uses its own scope. Older draft anchors remain visible but cannot be submitted against new code; recreate the feedback on the current selection. An ambiguous network response retains the exact batch for idempotent retry. History retains a bounded set of snapshots; an evicted snapshot keeps the thread's excerpt.

## Checkpoint and constraints

Open **Pair: Open Checkpoint and Constraints**, or expand **Checkpoint & Constraints** in the Pair sidebar. It keeps the objective, implemented behavior, verification, usable behavior, deferred work, and next decision separate. These are agent reports, not an independent test result. A warning marks reports that became stale after further work; missing information stays **Not recorded**. Updating this panel does not reopen the diff or reset its scroll position.

Use **Add constraint** to pin an explicit human instruction and select its scope:

- **This task:** retained until removed or you start new Pair work.
- **Current or next turn:** if Pi is working, retained for that turn; if idle, applies to your next message and expires on the following message. The panel labels a waiting constraint **Next turn**.

Use **Remove constraint** to clear one. Pinning is explicit; the companion does not guess permanent preferences from chat. Ordinary chat instructions still apply. The agent may update the checkpoint, but cannot remove these pinned instructions. Constraint changes cancel a pending review and never grant execution permission. Ask Pi to continue when ready. Commands require a connected matching session and trusted workspace, and reject changes if the session or memory revision changed during input.

## Highlighting

Diff snapshots preserve the real relative filename. Existing files inherit the workspace document's language mode. New files use workspace file associations and VS Code's language detection. These are immutable virtual documents, so language extensions that require a real project file may not provide semantic coloring or IntelliSense. The extension uses your existing VS Code font, theme and syntax grammars.

## Approval behavior

VS Code sends a decision for one exact session, proposal revision and content fingerprint over an authenticated loopback connection. Navigation and file contents stay local; no extra model requests are needed. Pi owns execution and checks the original files again before running anything. Approval in Pi or VS Code resolves the same request once.

Unsaved editor changes to an affected file must be saved or discarded before approval. Workspace Trust is required to submit decisions. Closing VS Code leaves the Pi request pending. A disconnected or historical proposal cannot be approved. Read-only diff snapshots are never read back as execution inputs.

This release supports local desktop workspaces. Remote SSH, WSL, containers and browser-hosted VS Code are not supported.

## Development

No bundler or runtime packages are required. Run `npm test` in this folder for the client tests. Launch an Extension Development Host with `--extensionDevelopmentPath=<this folder>`. For isolated integration tests, `PI_PAIR_BRIDGE_DIR` overrides the default registry at `~/.pi/agent/pair-bridge`.

The activation API exposes `getState()` (session ID, workspace, connection and cloned review, checkpoint and feedback; never credentials), `getReviewState()` (local draft anchors, pending batch, selected thread, native-thread count and desk-open state), and `refresh()` for diagnostic and integration testing. No API can bypass Pi's decision validation.

Commands have numbered source lines, indented wrapping, and a separate live output pane in the Pair sidebar. Scroll back to pause following; choose **Follow output** to return to the tail. Output is text-only and bounded to 400 lines / 32 KiB per action. Open the command for the full native shell editor and inline questions. UI streaming does not add model context or change approval identity.
