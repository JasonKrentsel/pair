# Pair webview

The step review and scoped Chat are one React/TypeScript application. Vite serves the same components in Chrome and builds their local assets for VS Code. Radix supplies disclosure behavior, Lucide supplies icons, and React Markdown renders explanations with GFM and code highlighting. Native diffs and the xterm.js command center remain owned by the extension.

## Develop

From the repository root:

```powershell
npm ci --prefix vscode
npm --prefix vscode run dev
```

Open `http://127.0.0.1:5173/?scenario=pending`. Other scenarios are `chat`, `candidate`, `command`, `running`, `disconnected`, `long`, `error`, `activity`, and `completed`. The activity fixture includes reasoning, a blocked tool call, cache counts and an inline retry. Add `&theme=light` for the light palette. Resize the browser to 300, 380, or 520 pixels wide to reproduce a right sidebar.

The development adapter supplies synthetic state and records UI messages. Its replies are scripted, and its approval controls only change fixture state. It never discovers a Pi session, calls a model, writes project files, or executes commands. The preview adapter and fixture palette are excluded from production builds.

## Validate and package

```powershell
npm --prefix vscode run test
npm --prefix vscode run test:ui
npm --prefix vscode run build:webview
npm run package:vscode
```

The browser suite uses installed Google Chrome through Playwright, with screenshots, interaction checks, and accessibility checks. Its report and artifacts are under `webview/playwright-report` and `webview/test-results`. Inspect the screenshots; passing assertions alone does not establish visual quality. Then verify the packaged VSIX in an isolated VS Code extension host, particularly native diffs, real approval identities, reconnection, theme rendering, and CSP compatibility.

The production build emits `vscode/media/ui/app.js` and `app.css`. Packaging rebuilds these assets and bundles them locally; installed Pair needs no development server or CDN. Build output, test reports, and dependency folders are ignored by Git.

## Boundaries

- `types.ts` defines presentation snapshots and outbound UI messages.
- `adapter.ts` wraps the VS Code message bridge and local persisted UI state.
- `preview.ts` is a development-only implementation of that bridge.
- `App.tsx`, components, and styles are shared between browser and VS Code.
- `../webview.cjs` supplies the restrictive CSP and escaped bootstrap state.
- `../extension.cjs` owns session discovery, native editor integration, and permission validation.

The host mounts the application once per webview lifecycle and sends deduplicated state snapshots. Drafts, disclosure state, and scroll are local. Chat opening creates no fork; only Send invokes the existing backend. No frontend framework state or preview events enter model context.
