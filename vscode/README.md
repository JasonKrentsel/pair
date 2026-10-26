# Pair for Pi

Pair 0.10.1 keeps the current step in one sidebar: an ordered list of actions, their explanations, and an approval footer that stays visible while the content scrolls. Native diffs and the command terminal open in the center editor. The extension preserves your sidebar position, including a right-side layout.

## Use

1. Install this companion and reload Pair 0.10.1 in Pi when idle.
2. Open the same project folder in Pi and VS Code. One matching session connects automatically. Use **Pair: Select Pi Session** if several sessions share the folder.
3. Select an action to open its native diff or command terminal. Expand **Why this action** for its rationale and any section notes. Use **Next Action in Step** / **Previous Action in Step** to navigate from the editor.
4. Choose **Approve step**, **Deny**, or **Deny with note**. Approval covers all listed actions in order, once. A failed or interrupted action stops the remaining actions.

Completed and denied steps keep their diffs and output available without disabled approval buttons. Running steps show progress in the center editor. `pair.openReviewAutomatically` controls automatic focus for new steps; opening a review explicitly from Pi still focuses it.

Use **Chat** beside an action to open its focused conversation in this same sidebar. Select proposed lines in the native diff and use **Pair: Chat About Selected Lines** for a smaller scope. The single composer accepts questions and small revision requests. Opening and drafting start no fork or model request; the first Send starts the child conversation. A question keeps the step pending. A requested revision can produce a candidate; **Inspect diff** opens a native proposed-versus-revised comparison. **Use revision** updates that part only and returns to step approval. **Back to step** preserves the conversation and draft. Review Desk, checkpoints and pinned constraints remain removed. Existing historical records remain readable but cannot restore execution permission.

## Commands and highlighting

Command actions open a central **Command & Output** tab with Bash/PowerShell highlighting and a full-height output stream. Bundled xterm.js renders terminal colors, progress updates and cursor movement. **Open command source** opens the exact command in a native shell editor. Output updates do not reopen the panel or steal focus repeatedly.

Commands explicitly proposed as interactive accept keyboard input and paste only during their approved run. Ctrl+C and **Stop command** interrupt execution. Input is scoped to that running command; opening a preview never runs it. Interactive actions require a connected companion before the step starts. Their timeout defaults to 300 seconds, with a maximum of 300 seconds. Node.js and the selected shell must be installed for the owned PTY helper.

File snapshots preserve relative filenames, workspace language associations and the existing file's language mode. Virtual snapshots are read-only; language extensions that require real project files may not provide semantic coloring or IntelliSense. Pair uses VS Code's fonts, theme and syntax grammars.

## Approval and context

Pi owns execution. The companion submits a decision for an exact session, revision, content fingerprint and approval gate through authenticated loopback HTTP. Pi rechecks affected files before execution. Pi and VS Code resolve the same decision once.

Unsaved target files and changed review snapshots block approval. Decisions require a trusted matching workspace. A disconnected or historical step cannot be approved. A denial does not undo earlier completed steps, and a partially executed step is not rolled back automatically.

Expanding explanations, switching actions, scrolling diffs, polling and streaming output remain local UI operations. They do not invoke a model or append UI state to its context. The instruction contract stays stable across unchanged turns. Sending a chat message uses the current Pi model in a separate in-memory fork with no tools. The main prompt and pending session stay unchanged. Child turns reuse their own stable prefix, although provider cache sharing with the main request is not guaranteed. Only adopted changes and actual outcomes enter the parent result. Fork chats last for the pending review and are not persisted across restart.

This companion supports local desktop workspaces; remote SSH, WSL, containers and browser-hosted VS Code are unsupported.

## Development

Run `npm run test:vscode` from the repository root and `npm run package:vscode` to build the local VSIX. Browser terminal assets are pinned and bundled; the webviews make no CDN requests.

For isolated integration tests, set `PI_PAIR_BRIDGE_DIR` to a disposable registry directory. The activation API exposes `getState()` (a cloned session/root/connection/review/conversation/progress/terminal state, never credentials), `getCommandViewState()`, and `refresh()`. No API bypasses Pi's approval validation.

Screenshot validation uses a real VS Code extension host with the packaged companion in an isolated profile. Cover connected idle, pending mixed steps, long explanations and paths, running commands, completed/denied steps and disconnection. Inspect narrow and normal right-side widths, the bottom of a scrolled list, and keyboard focus. Fix a visible defect and recapture the same case before accepting it.
