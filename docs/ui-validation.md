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


## Focused action conversations (0.10.0)

The right sidebar switches between the step and one scoped conversation. Native editor selections identify full proposed lines; the selected range receives a subtle theme-based marker. Ask leaves permission pending. Adjust creates a candidate; Inspect diff compares the current proposal with the candidate, and Use revision replaces only that action or line range. The entire updated step still requires approval. No Review Desk or checkpoint surface returns.

The design uses contextual progressive disclosure, explicit actions, a fixed composer, safe Markdown, bundled syntax highlighting, keyboard/IME support, persistent drafts and incremental message updates. References reviewed were [Vercel's web design skill](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md), the [UX Designer skill](https://github.com/szilu/ux-designer-skill/blob/main/SKILL.md), and [VS Code's webview guidance](https://code.visualstudio.com/api/ux-guidelines/webviews).

Validation on 2026-10-25: 131 Pi tests, 44 companion tests and TypeScript 6.0.3 checking passed. Two native packaged-extension runs each passed 13 checks. They used the real Pi ModelRuntime/ModelRegistry/SessionManager with a scripted local provider, native file tools, and a disposable project. No live user model request was made. The main tool stayed blocked during questions and candidate adoption; an old approval returned HTTP 409, and fresh approval executed exactly the revised edit and unchanged sibling. A command candidate was inspected and left unexecuted.

Screenshots were inspected at 1444×900 and 2560×1392 in VS Code 1.143.1, Dark Modern, Consolas, with roughly 300px and 510px right sidebars. Actual webview clicks exercised Back, conversation resume, Use revision and Approve step. An unsent draft and Adjust mode survived reopening; narrow transcript scrolling kept the composer accessible and exposed the complete candidate controls.

The capture loop corrected an empty waiting reply, an overly strong source-selection tint, candidate statistics measured against the wrong baseline, and function-specific placeholder text in command conversations. Repeated captures confirmed the fixes. Audit regressions also cover an old in-flight poll hiding a newly opened conversation and a rendering exception splitting the displayed approval identity from executable content.

Local evidence for this run is in the task workspace at `outputs/pair-0.10.0/`; the isolated native harness is in `work/action-qa/`. Its stage/advance handshake pauses at pending, ask-running, answered, candidate, revised-step, applied and command-candidate. Keep ask-running captures under the fork's 120-second timeout. The final report and cleanup record confirm three scripted provider requests, two native file actions, and no command execution.

UI navigation and drafts make no model calls. The main prompt/tools/history remain unchanged while the fork runs. Completed main context and bounded read-only sibling context are supplied once to the tool-free child. Its own prefix stays stable across turns; provider cache sharing with the main request is not guaranteed. Only accepted revisions and actual execution outcomes enter the parent's tool result.


## Unified Chat (0.10.1)

One Chat entry now handles questions and small revision requests for the selected action or lines. Opening it creates only a local conversation record. The first nonblank Send creates the child session, captures its context once and starts the model request. Follow-ups reuse that child; browsing, drafts and opening/closing the panel make no requests. Main session prompt, tools and history remain unchanged during discussion. A fixed child contract permits a readable answer and an optional validated candidate, with no mode picker or repeated mode instructions.

The composer uses a single Send action, contextual placeholders, blank-message prevention and initial input focus that does not steal focus during polling. Markdown, code highlighting, draft/scroll persistence, narrow-width wrapping and a fixed composer remain. Suggested revisions have separate Inspect diff and Use revision actions; adopting one updates the proposal and still requires approval. The screenshot loop also replaced a generic stale-conversation warning after adoption with an explicit confirmation.

Validation on 2026-10-26: 133 backend tests, 47 companion tests and TypeScript 6.0.3 checking passed. Two native packaged-extension runs each passed 14 checks using the real Pi session/runtime classes with a scripted local provider. Opening Chat produced zero provider requests. The question and revision request reused one child session, preserved the protocol and sibling action, rejected old approval, and executed only after fresh approval. Command revision preview did not execute a command. No live user model was contacted.

Screenshots were inspected in the actual packaged VS Code extension host with Dark Modern, Consolas, 1444×900 and 2560×1392 windows, and approximately 300px and 520px right sidebars. A real Send click submitted the first message; a real Use revision click adopted the fixture candidate. Captures cover the single Chat entry, focused empty composer, Markdown answer at narrow and normal widths, native code and command revision diffs, and the corrected adoption confirmation. Local evidence is in the task workspace at `outputs/pair-0.10.1/`, with the isolated harness in `work/unified-chat-qa/`.

## React sidebar and browser development (0.11.0)

Step review and scoped Chat now share one React/TypeScript app built by Vite. Radix disclosure controls, Lucide icons, safe Markdown and bundled syntax highlighting support concise action cards, visible selection, an anchored decision footer, and a fixed chat composer. The app uses VS Code theme tokens and respects reduced motion. Native editor diffs and the existing xterm.js command center retain the large center area. The host mounts the app once, then sends deduplicated snapshots instead of replacing the document. Local drafts, navigation and disclosures do not enter model context.

The same components run in Chrome with a development-only adapter and synthetic scenarios. See `vscode/webview/README.md` for commands. Browser fixtures never contact Pi or a model and never execute project actions. Production packaging bundles local assets with a restrictive CSP, excludes the preview adapter, and needs no server or CDN.

Validation on 2026-10-26: 133 Pi/backend tests, 35 companion host tests, 34 Chrome Playwright tests, and TypeScript 7.0.2 checking passed. Browser coverage includes keyboard and draft behavior, revision adoption, stale approval identity, error recovery, light/dark accessibility, long content, narrow widths, and the production assets under the actual webview CSP. Twelve browser captures cover pending review, Chat, candidate and command states at 300, 380 and 520 pixels wide. They were inspected alongside six native captures from the packaged extension in VS Code 1.143.1, Dark Modern, a 2560×1392 window, and approximately 300px and 480px right sidebars.

The visual loop identified low-contrast metadata, an invalid accessible label, an error left visible after a successful retry, and a blank production view caused by an unresolved `process.env.NODE_ENV` in the library build. Fixes were followed by fresh captures and regression checks, including a production-CSP browser test. The failed native loading capture is retained separately as pre-fix evidence, not counted as a successful UI run.

The final packaged native run passed 15 checks using real Pi session/runtime classes and native file tools with a scripted local provider and disposable project. Actual Send and Use revision clicks exercised the React bridge. Chat opening made zero provider requests; a question and revision reused one child session. Adoption preserved the sibling action and parent context, rejected the obsolete approval, and applied only the revised edit and unchanged sibling after fresh approval. A highlighted command revision remained a proposal and was never executed. Cleanup confirmed the fixture was closed and no execution remained running. No live user model was contacted.

Evidence lives in the task workspace at `outputs/pair-0.11.0/`; the isolated harness is `work/react-qa/`. This frontend refactor does not change the model prompts, tool schemas, or fork context construction. Opening and navigating the interface remains local; only sending a chat message starts or reuses the existing child session.

## Chat recovery and model activity (0.11.1)

The user's blank Chat replies exposed a protocol bug: ordinary answers were rejected unless they were JSON envelopes. Chat now accepts Markdown directly, while a requested revision uses one final `pair-revision` JSON fence that is hidden during streaming and strictly validated before it can be adopted. Existing JSON envelopes remain compatible. Invalid or incomplete candidates never become actionable. Failed prompts roll back the child branch, and Retry replaces the latest failed UI turn without consuming a successful-turn slot or changing the parent approval identity.

Each reply can display model-supplied reasoning, attempted tool calls and provider/SDK usage. Disclosure is local. Reasoning signatures and redacted payloads are excluded from presentation. Chat still advertises no tools and executes none; unexpected calls show their arguments and a Not run status, then a short inline failure. Invalid structured output has a bounded diagnostic disclosure. Cache counts are shown when supplied by the SDK, with zero explicitly treated as unconfirmed rather than proof of a miss. Successful follow-ups keep an identical child request prefix; sharing the parent's provider cache remains provider-dependent and is not claimed.

Validation on 2026-10-26: 138 backend tests, 35 host tests, 40 Chrome tests, backend TypeScript 6.0.3 checking and frontend TypeScript 7.0.2 checking passed. New regressions cover the user's DDL question followed by hello, Markdown plus a scoped revision, malformed payloads, reasoning and tool events, redaction, usage reporting, retry identity, preserved drafts, and light/dark accessibility. Screenshot review at 300, 380 and 520 pixels exposed low-contrast failure text in light mode; the warning surface now derives its background from the active theme. The browser fixture also needed unique retry message IDs.

The packaged native VS Code run passed 17 checks using real Pi SDK sessions and a scripted local provider in a disposable project. The new run returned a plain Markdown answer, a fenced revision, a blocked tool request, and a successful retry. Actual sidebar interaction expanded reasoning and tool arguments and clicked Retry. The failed turn was replaced by the recovered response, the command stayed unexecuted, and the updated proposal still required approval. Three native screenshots and 15 browser captures are saved under the task workspace's `outputs/pair-0.11.1/`, with the harness under `work/chat-recovery-qa/`. No live user model was contacted. Cleanup confirmed that the isolated run ended.

## Readability and section-to-code linking (0.11.2)

The user supplied screenshots showing muted explanation text on a blue selected card and a command screen with small rationale text and a redundant step title. This edit applies [no-slop-ui](https://github.com/LeoStehlik/no-slop-ui), including its core skill, banned patterns and review checklist. Four focused agent reviews cover sidebar typography/surfaces, Chat and activity details, section-to-editor behavior, and command display. VS Code's existing theme and font remain authoritative; this follows the skill's existing-design-system priority over its generic font preference.

Selected actions use a neutral surface with a thin selection marker. Explanation body text uses the primary foreground at 14px, with a consistent spacing scale and readable metadata. Section headings are ordinary buttons: pointer hover and keyboard focus highlight the validated annotation range in an already visible Proposed snapshot without moving focus. Clicking opens/reveals those lines with sidebar focus preserved. The host resolves ranges from the current annotation, checks session/review/gate identity, supports the current completed step, and clears highlights on stale state, leave, blur, hidden/disposed views and disconnect. Highlighting is local editor state and adds no model context.

The command screen uses a command heading with secondary step context, a readable rationale/directory, wrapping and exact-byte copying of its source, and state-specific output/input controls. The large center terminal retains xterm interaction and existing execution guards. Shell syntax highlighting still treats embedded Python inside a shell string as part of that string.

The user kept automated suites off and then explicitly requested screenshots while developing. The visual loop captured and inspected 12 React sidebar images (expanded explanations, Chat activity and revisions at 300/380/520px in dark mode and 380px in light mode), plus five command images covering dark/light completed output, pending wrapping/copy feedback and an interactive terminal fixture. That loop corrected misleading mixed-step numbering and hanging indentation that had altered the visual meaning of multiline commands, then recaptured those states. The browser and development servers were closed after capture.

An isolated VS Code profile displayed the packaged sidebar with a completed Python-file fixture. Native screenshots show the neutral explanation surface, hover mapping the UUID section to Proposed line 12 without opening or focusing an editor, and click mapping the timestamp section to lines 15–17. The range marker and section marker are visible together. This preview used synthetic data served over a local read-only bridge; no model or shell command ran. Images and review manifests are in the task workspace at `outputs/pair-0.11.2/`; the native preview driver is `work/no-slop-native/`. These are visual observations, not automated test passes or evidence of command execution. Earlier release test counts do not apply to this edit. Packaging builds the local frontend assets for installation.

## Read-enabled follow-up Chat and three-version review (0.12.0)

Research reviewed [VS Code's webview guidelines](https://code.visualstudio.com/api/ux-guidelines/webviews), its [public editor APIs](https://code.visualstudio.com/api/references/vscode-api), [documented editor layout commands](https://code.visualstudio.com/updates/v1_25), and primary component guidance for [tool inputs/results](https://elements.ai-sdk.dev/components/tool), [conversation scrolling](https://elements.ai-sdk.dev/components/conversation), and [ordered reasoning/tool parts](https://tanstack.com/ai/latest/docs/chat/thinking-content). The implementation uses those patterns with the existing React components and VS Code theme; it adds no chat framework dependency or private merge-editor command.

The child now uses Pi's public Agent SDK to own its tool loop. Four fixed tools read project text: read, ls, find and literal grep. They use filesystem APIs without processes or shell commands, validate schemas and lexical/canonical paths, skip linked traversal, open files read-only, and bound search/output work. A changing file produces a retry error instead of an incomplete result. Revisions still pass through the scoped candidate validator; only normal step approval can write the project. Context, tools and child session identity remain fixed across follow-ups. The parent remains unchanged, and presentation metadata is never replayed as model context.

Activity projection is a separate typed module. It preserves the order of text, reasoning, read requests and results across model rounds, reserves space for the final answer, excludes opaque reasoning signatures, and totals usage per reply. Tool states settle on stop/error. The UI renders those ordered parts directly, with collapsible inputs/results, readable surfaces, a visible read-permission summary and a fixed composer. Eight browser captures cover read details and revision controls at 300, 380 and 520 pixels in dark mode and 380 pixels in light mode.

Compare versions opens three immutable native editors: Current file (fresh disk snapshot), Original proposal, and Revised proposal. Native language modes and bounded jsdiff line highlights identify each change. Unsaved buffers and missing current files are labeled. The prior editor grid is recoverable through a contributed command, without closing user tabs. The diff library is the existing pinned 8.0.4 dependency bundled with its BSD license. Long lines follow the user's native editor wrapping and scrolling preferences.

An isolated native preview used the real Pi Agent/registry/session classes with a scripted provider. The first reply read a schema file, and the next human Send performed a literal search before returning a two-line candidate. Four provider requests used the same child session and fixed tools; the fixture reported the parent and disk unchanged and no parent executions. Actual clicks expanded the read result and opened all three version panes while Chat remained on the right. Three native captures plus the eight browser captures are stored under `outputs/pair-0.12.0/`, with bounded observation metadata. The model data was synthetic; no live user provider was contacted.

Independent source review found and corrected unfinished tool status after cancellation and concurrent-file growth handling. Native startup caught a TypeScript parameter-property syntax unsupported by Node's strip-only loader; explicit class fields fixed compatibility. Frontend and backend TypeScript checks passed during development. Automated test suites remain off at the user's request; the captures and scripted preview are visual/integration observations, not reported test passes. Preview windows and servers were closed after capture.
