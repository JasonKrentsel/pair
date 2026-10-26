import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { PairReviewBridge } from "../extensions/pair/bridge.ts";
import { registerStepPermissions } from "../extensions/pair/permissions.ts";
import { codeReviewArguments } from "../extensions/pair/external.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-vscode-integration-"));
  const registryDir = join(root, "registry");
  const bridge = new PairReviewBridge({ registryDir });
  const handlers = new Map<string, Function[]>();
  let tool: any;
  let calls = 0;
  let terminalClosed = false;
  let changedCalls = 0;
  const entries: unknown[] = [];
  const historyViews: string[] = [];
  const pi: any = { on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, registerTool(t: any) { tool = t; }, appendEntry(...args: unknown[]) { entries.push(args); } };
  const controller = registerStepPermissions(pi, { active: () => ({ root }), changed() { changedCalls++; }, bridge,
    review: async (_ctx, title, _why, _changes, signal, options) => new Promise((resolve) => {
      if (options?.readOnly) { historyViews.push(title); resolve({ action: "deny" }); return; }
      const abort = () => { terminalClosed = true; resolve({ action: "deny" }); };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    }),
  });
  const ctx: any = { hasUI: true, mode: "tui", cwd: root, tools: [{ name: "write" }], ui: { notify() {} }, sessionManager: { getBranch: () => [] },
    executeTool: async (name: string, input: any) => {
      assert.equal(controller.guard({ toolName: name, input, parentToolCallId: "step" } as any), undefined);
      calls++;
      const result = await createWriteTool(root).execute("write", input);
      return { isError: false, result };
    },
  };
  const abort = new AbortController();
  const run = () => tool.execute("step", { title: "Update greeting", why: "Make the example clearer.", changes: [{ tool: "write", path: "example.ts", content: "export const greeting = 'hello';\n" }] }, abort.signal, undefined, ctx);
  const ready = async () => {
    for (let n = 0; !bridge.current?.pending && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(bridge.current?.pending);
    const registration = JSON.parse(readFileSync(join(registryDir, readdirSync(registryDir)[0]), "utf8"));
    return registration;
  };
  const decide = async (action: string, note?: string) => {
    const registration = await ready();
    const review = bridge.current!;
    return fetch(`http://127.0.0.1:${registration.port}/decision`, { method: "POST", headers: { authorization: `Bearer ${registration.token}`, "content-type": "application/json" }, body: JSON.stringify({ reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, action, note }) });
  };
  return { root, bridge, handlers, ctx, abort, run, ready, decide, controller, entries, historyViews, get changedCalls() { return changedCalls; }, get calls() { return calls; }, get terminalClosed() { return terminalClosed; }, async close() { await bridge.close(); rmSync(root, { recursive: true, force: true }); } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("VS Code approval closes Pi prompt and executes reviewed content exactly once", async () => {
  const f = await fixture();
  try {
    const running = f.run();
    assert.equal((await f.decide("approve")).status, 200);
    const result = await running;
    assert.equal(result.details.status, "Applied");
    assert.equal(f.calls, 1);
    assert.ok(f.terminalClosed);
    assert.equal(f.bridge.current?.pending, false);
    assert.equal(f.bridge.current?.status, "Applied");
    assert.equal(f.bridge.decide({ action: "approve" }), false);
    assert.match(readFileSync(join(f.root, "example.ts"), "utf8"), /hello/);
  } finally { await f.close(); }
});

test("VS Code denial note reaches agent without applying files", async () => {
  const f = await fixture();
  try {
    const running = f.run();
    assert.equal((await f.decide("deny", "Keep the existing greeting")).status, 200);
    const result = await running;
    assert.equal(result.details.status, "Denied");
    assert.match(result.content[0].text, /Keep the existing greeting/);
    assert.equal(f.calls, 0);
    assert.equal(existsSync(join(f.root, "example.ts")), false);
    assert.ok(f.terminalClosed);
  } finally { await f.close(); }
});

test("disk change rejects editor approval before execution; denial remains possible", async () => {
  const f = await fixture();
  try {
    const running = f.run();
    await f.ready();
    writeFileSync(join(f.root, "example.ts"), "human edit");
    assert.equal((await f.decide("approve")).status, 409);
    assert.equal(f.calls, 0);
    assert.equal(f.bridge.current?.pending, true);
    assert.equal((await f.decide("deny")).status, 200);
    await running;
    assert.equal(readFileSync(join(f.root, "example.ts"), "utf8"), "human edit");
  } finally { await f.close(); }
});

test("aborting or changing the session revokes the remote approval", async () => {
  for (const mode of ["abort", "session_tree"]) {
    const f = await fixture();
    try {
      const running = f.run();
      const outcome = running.then((value: any) => ({ value }), (error: Error) => ({ error }));
      await f.ready();
      if (mode === "abort") f.abort.abort();
      else for (const handler of f.handlers.get(mode) ?? []) handler({}, f.ctx);
      await outcome;
      assert.notEqual(f.bridge.current?.pending, true);
      assert.equal(f.bridge.decide({ action: "approve" }), false);
      assert.equal(f.calls, 0);
    } finally { await f.close(); }
  }
});

test("editor launcher identifies the cwd and never reuses an unrelated window", () => {
  const args = codeReviewArguments(process.cwd());
  assert.ok(args.includes(process.cwd()));
  assert.ok(!args.includes("--reuse-window"));
});

test("delayed tool completion cannot overwrite a restored branch's review or history", async () => {
  const f = await fixture();
  const complete = deferred();
  try {
    const executed = deferred();
    const execute = f.ctx.executeTool;
    f.ctx.executeTool = async (...args: unknown[]) => {
      const result = await execute(...args);
      executed.resolve();
      await complete.promise;
      return result;
    };
    const running = f.run();
    assert.equal((await f.decide("approve")).status, 200);
    await executed.promise;
    const restored = { title: "Restored branch result", why: "Different saved work", status: "Applied", changes: [{ label: "restored.ts", kind: "Edit", before: "a", after: "b", added: 1, removed: 1 }] };
    f.ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "toolResult", toolName: "pair_step", details: restored, content: [] } }];
    for (const handler of f.handlers.get("session_tree") ?? []) handler({}, f.ctx);
    assert.equal(await f.controller.review(f.ctx), true);
    const editorState = f.bridge.current;
    assert.equal(editorState?.title, restored.title);
    const entriesBeforeCompletion = f.entries.length;
    complete.resolve();
    const result = await running;
    assert.equal(result.details.status, "Failed");
    assert.match(result.content[0].text, /session changed/);
    assert.equal(f.calls, 1);
    assert.equal(f.changedCalls, 0);
    assert.equal(f.entries.length, entriesBeforeCompletion);
    assert.deepEqual(f.bridge.current, editorState);
    assert.equal(await f.controller.review(f.ctx), true);
    assert.deepEqual(f.historyViews, ["Applied · Restored branch result", "Applied · Restored branch result"]);
  } finally { complete.resolve(); await f.close(); }
});

test("history reopening cannot cancel a live proposal that arrives during bridge startup", async () => {
  const f = await fixture();
  const started = deferred();
  try {
    const running = f.run();
    assert.equal((await f.decide("approve")).status, 200);
    await running;
    f.bridge.start = async () => started.promise;
    const history = f.controller.review(f.ctx);
    let decisions = 0;
    const live = f.bridge.publish({ title: "New live proposal", why: "Needs a fresh decision", changes: [{ label: "next.ts", kind: "New file", before: "", after: "new", added: 1, removed: 0 }] }, () => decisions++);
    started.resolve();
    assert.equal(await history, true);
    assert.equal(f.bridge.current?.id, live.id);
    assert.equal(f.bridge.current?.pending, true);
    assert.equal(decisions, 0);
    assert.deepEqual(f.historyViews, []);
  } finally { started.resolve(); await f.close(); }
});
