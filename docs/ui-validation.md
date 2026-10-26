# Pair UI validation

Pair's production `ReviewComponent` is shared by the actual permission dialog,
tests, and fixture previews. Fixtures never call a model or mutate a project.

Version 0.2 was checked with 35 passing tests, TypeScript checking, and 42
captured component frames. An isolated fullscreen Pi 1.4.0 session exercised
file switching, denial-note submission, and the command dialog. Native mouse
interaction and live resizing across all fixture widths still need manual
coverage; component tests cover those layout and input paths separately.

The reload compatibility fix adds six regression tests (41 total). A read-only
replay of the reported older conversation rendered all 52 Pair calls and 52
results in 468 frames across collapsed/expanded views and three widths. This
includes the saved schema failure with empty metadata. No model or tool ran and
the original session file was unchanged. A copy of that conversation also opened
in an isolated fullscreen Pi session; history and `/pair` displayed the latest
validation error without crashing. Use the following to repeat the audit locally:

```sh
node --import ./scripts/pi-runtime.mjs scripts/replay-session.ts path/to/session.jsonl
```

## Repeatable checks

The retired checkpoint/constraint and inline Q&A features are no longer included. Current regression coverage verifies that legacy records cannot restore approvals or add their old recovery prompts.

Version 0.3 adds authenticated bridge and companion checks. `npm test` includes
exactly-once decisions across both interfaces, stale snapshots, denied requests,
disconnects, revision fingerprints, lifecycle invalidation, delayed callbacks,
and session changes while a native tool is running. `npm run test:vscode` runs
the dependency-free companion client tests. Loopback HTTP tests need local
network access; an EACCES failure from a restricted runner is not an application
test result. TypeScript checking covers the Pi integration.

The local VSIX was installed into an isolated VS Code 1.143.1 profile and passed
16 actual Extension Host checks. Those verified the installed package path,
matching workspace/session, native TypeScript/Markdown/JSON and custom JSONC
language associations, read-only typing, exact approval/denial, duplicate
suppression, unsaved source buffers, and modified virtual preview buffers.
No model ran. Source files in the fixture stayed unchanged during editor review.

Real Windows screenshots were captured with Dark Modern and the user's
JetBrains Mono font setting. The split diff was scrolled to its final line 182;
Approve all, Deny, Deny with note, and the four-file list stayed visible in the
sidebar. These are native VS Code captures, not browser renderings. Only the
isolated test profile was configured; user settings were not changed.

For another native test run, launch an Extension Development Host against a
fixture folder, supply `PI_PAIR_BRIDGE_DIR` pointing to isolated discovery data,
and drive the public commands plus diagnostic activation API. Test the packaged
VSIX as well as source. Keep an approved proposal's snapshot identity immutable,
and verify Pi's tool execution separately from editor rendering. Native testing
does not imply remote SSH/WSL/container support or language-server features for
every custom document scheme.

Version 0.2.2 adds sixteen tests (67 total). Chat approval tests exercise real
extension input hooks, exact revisions, conditional revision approval, reload,
compaction, queued input, stale disk content, and unchanged execution guards.
Accepted approval persists in the saved state. An unconsumed approval for requested
changes expires on another human input, session/tree transition, shutdown or off.
It is never reconstructed by scanning old chat messages.

The large-diff regression uses Pi's actual fullscreen overlay compositor with a
220-line file. It opens at 80×24, grows to 110×36 and 160×45, then shrinks and
grows again. End and Page Down must show the final line while Approve/Deny/Note
and the bottom border stay visible. This reproduces the previous clipping:
Pi evaluates an overlay-options callback once, so a captured numeric height
became stale. Percentage height and native margins now follow each resize.

Version 0.2.1 adds ten tests (51 total) for concise validation and `pair_work`
receipts. The malformed third edit is exercised through Pi's real `runToolCall`
pipeline: it returns a 132-character correction before hooks, previews, or
execution. Valid legacy inputs still reach the permission dialog with their
original bytes. Receipt tests cover status, design publishing/reopening, approval
state, and preserving the full design in UI details.

- `npm test` runs permission, context, renderer, and input tests.
- `npm run preview -- multi` opens a synthetic fullscreen terminal review.
- `npm run capture` records the actual component's ANSI rows and a JSON manifest.
- `tsc --noEmit -p tsconfig.json` checks types when TypeScript is available.

Development commands reuse installed Pi 1.4.0 peer packages. Set
`PI_PAIR_RUNTIME` to a different Pi `node_modules` directory if needed.
No package is installed by these commands. Node 22.19+ is required.

Fixtures cover short/long commands, TypeScript, new JSON, Markdown, two/four files,
denial notes, Unicode paths, and partial failure. Captures use 80×24, 110×36,
160×45, and a deliberately tiny 38×12 viewport, plus expanded/collapsed history.
The manifest records scenario, dimensions, theme, UI state and frame hash.

## Image review

The earlier temporary-snapshot fallback was opened with TypeScript files and
visually checked in the desktop editor: the before and proposed text appeared
side by side. Approval remains in Pi for that fallback. The native companion
added in 0.3 supports the shared decision controls described above.

`scripts/render-captures.mjs` converts captured ANSI rows into PNGs and a gallery.
It takes the artifact directory, an optional Playwright module path, and an
optional Chromium executable path. These are component render captures, not
proof that native Pi input or execution worked.

For native integration, launch Pi in a disposable profile with no models or
normal extensions, loading `extensions/pair/index.ts` and
`scripts/live-preview-extension.ts` explicitly. Use `/pair-preview multi`,
`/pair-preview command`, and the other fixture names. Enable `PI_TUI_WRITE_LOG`
to capture actual terminal output. `scripts/terminal-screenshot.mjs` replays that
output through xterm.js and captures its pixels. Optional QA packages
Playwright/xterm live outside the installed extension; specify their locations
with `PAIR_PLAYWRIGHT`, `PAIR_XTERM`, and optionally `PAIR_CHROMIUM`.

Capture → inspect → describe a specific defect → fix → recapture the same case.
Inspect the adjacent widths and rerun behavior tests affected by each fix.
Keep original screenshots and successful replacements with their source
revision, dimensions, font, theme, scenario and UI state. User screenshots become
new regression fixtures when the state can be reproduced; unknown versions or
terminal settings stay marked unknown.

Acceptance: no clipped actions; readable source; content-sized short commands;
clear file/hunk position and approval scope; note input retains review context;
compact history; no model calls or context changes caused by navigation.
Screenshots establish appearance. Execution tests separately establish denial,
exact reviewed content, stale-file rejection, partial-failure stopping, and
preservation of restrictions across compaction.

## Sidebar simplification (0.9.0)

Capture the packaged companion in a real VS Code extension host, with an isolated profile and the sidebar on the right. Cover connected idle, pending mixed actions, long paths and rationale, running interactive commands, completed/denied steps and disconnection. Check narrow and normal widths and scroll to the last action: the decision footer must remain available.

There is one review view and no duplicate action tree, Review Desk, inline Q&A or checkpoint view. Exact approval, stale decisions, dirty buffers, native diff language modes, ordered mixed execution and interactive input remain behavior checks. Expansion and scroll restoration must stay local; unchanged polling and terminal chunks must not rebuild the sidebar or add model context.

Record actual screenshots with theme, font, dimensions and test stage. Inspect each capture, identify a specific defect, fix it and recapture before accepting the UI.

The 0.9.0 release passed 111 Pi tests, 28 companion tests, TypeScript 6.0.3 checking, and seven native packaged-extension checks. The native run executed an approved write → interactive PowerShell PTY → edit sequence, verified that browsing executes nothing, denied a follow-up without writing its file, and exercised disconnection. Screenshots were inspected in VS Code 1.143.1 with Dark Modern, a right sidebar at narrow and normal widths, and 1444×900 and 2560×1392 windows. Long-path and five-action fixtures verified scrolling with a fixed approval footer.

Screenshot review exposed and corrected stale expanded explanations after selecting another action, an obsolete live-output caption after command completion, and raw connection-error copy. A separate navigation regression covers shorter replacement steps with automatic opening disabled. Repeated captures verified the corrected states. UI navigation and streaming still make no additional model calls.
