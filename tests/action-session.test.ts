import test from "node:test";
import assert from "node:assert/strict";
import { ModelRuntime, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type TranscriptContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ACTION_SESSION_CONTRACT, createActionSession, type ActionScope } from "../extensions/pair/action-session.ts";

const scope: ActionScope = { index: 0, label: "src/greet.ts", kind: "Edit", stepTitle: "Share a greeting", why: "Keep the public signature.",
  before: 'export function greet(name: string) { return "Hi " + name; }\n',
  proposed: 'export function greet(name: string) {\n  return "Hello " + name;\n}\n', startLine: 2, endLine: 2 };

async function fixture() {
  const faux = fauxProvider({ provider: "pair-action-test", api: "pair-action-test-api", tokensPerSecond: Infinity, models: [{ id: "local-scripted", maxTokens: 8192 }] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const registry = new ModelRegistry(runtime), parent = SessionManager.inMemory(process.cwd());
  parent.appendMessage({ role: "system", content: "Earlier system state", toolsAdded: [{ name: "write", description: "Write a file", parameters: { type: "object", properties: {} } as any }], timestamp: 1 });
  parent.appendMessage({ role: "user", content: "Keep the public function signature unchanged.", timestamp: 2 });
  parent.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "src/greet.ts" }, { id: "read-1" }), { stopReason: "toolUse" }));
  parent.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: scope.before! }], isError: false, timestamp: 4 });
  parent.appendMessage(fauxAssistantMessage(fauxToolCall("pair_step", { title: scope.stepTitle, changes: [{ path: scope.label, content: scope.proposed }] }, { id: "pending-step" }), { stopReason: "toolUse" }));
  const ctx: any = { cwd: process.cwd(), sessionManager: parent, model: faux.getModel(), modelRegistry: registry, thinkingLevel: "off", getSystemPrompt: () => "Parent effective system prompt" };
  return { faux, parent, ctx, create: (selected = scope) => createActionSession(ctx, "pending-step", selected) };
}

function flattened(context: TranscriptContext): string { return JSON.stringify(context.messages); }

test("real registry fork inherits completed context, has no tools, and never changes the blocked parent", async () => {
  const f = await fixture(), original = JSON.stringify(f.parent.getEntries()), leaf = f.parent.getLeafId();
  const requests: Array<{ context: TranscriptContext; options: SimpleStreamOptions | undefined }> = [];
  f.faux.setResponses([0, 1].map(index => (context, options) => {
    requests.push({ context: structuredClone(context), options });
    return fauxAssistantMessage(index ? "The signature still stays unchanged." : "`greet` returns the same shape with different wording.");
  }));
  const session = f.create({ ...scope, stepContext: "Action 2: Keep GreetingReply.requestId exactly unchanged." }), updates: string[] = [];
  assert.match((await session.ask("Why this implementation?", { mode: "question", onUpdate: text => updates.push(text) })).text, /same shape/);
  assert.match((await session.ask("Does the public signature change?", { mode: "question" })).text, /unchanged/);
  assert.ok(updates.length > 1, "Pi's actual provider event stream delivers text chunks");
  assert.equal(requests.length, 2);
  const first = flattened(requests[0].context), second = flattened(requests[1].context);
  assert.match(first, /Keep the public function signature unchanged/);
  assert.match(first, /read-1/);
  assert.doesNotMatch(first, /pending-step|Earlier system state|"name":"write"/);
  assert.match(first, /Parent effective system prompt/); assert.match(first, /read-only Pair action-review fork/);
  assert.equal(requests[0].options?.sessionId, requests[1].options?.sessionId);
  assert.notEqual(requests[0].options?.sessionId, f.parent.getSessionId());
  assert.match(first, /GreetingReply.requestId exactly unchanged/);
  assert.equal(second.split("GreetingReply.requestId exactly unchanged.").length, 2, "sibling context appears only once");
  assert.equal(second.split("Review this action without running it.").length, 2, "scope source appears only once");
  assert.equal(JSON.stringify(f.parent.getEntries()), original); assert.equal(f.parent.getLeafId(), leaf); assert.equal(f.parent.getSessionFile(), undefined);
  for (const request of requests) for (const message of request.context.messages) if (message.role === "system") assert.equal(message.toolsAdded?.length ?? 0, 0);
  session.dispose();
});

test("a selected-line revision returns only a candidate and streams readable explanation", async () => {
  const f = await fixture(), before = JSON.stringify(f.parent.getEntries());
  const content = '  return `Hello ${name.trim()}`;';
  f.faux.setResponses([fauxAssistantMessage(JSON.stringify({ text: "Trim whitespace inside `greet`; keep its parameters and return type.", candidate: { content, summary: "Trim the name before building the greeting." } }))]);
  const session = f.create(), updates: string[] = [];
  const result = await session.ask("Trim the incoming name without changing the signature.", { mode: "revise", onUpdate: text => updates.push(text) });
  assert.equal(result.candidate?.content, content); assert.equal(result.candidate?.summary, "Trim the name before building the greeting.");
  assert.deepEqual(updates, [result.text], "raw JSON and replacement code are not streamed into chat");
  assert.equal(JSON.stringify(f.parent.getEntries()), before); session.dispose();
});

test("invalid, out-of-scope and truncated model revisions fail closed and do not poison retries", async () => {
  const f = await fixture(), session = f.create(); let retryContext = "";
  f.faux.setResponses([
    fauxAssistantMessage("this is not JSON"),
    fauxAssistantMessage(JSON.stringify({ text: "Changed.", candidate: { content: "x", summary: "Changed.", path: "unrelated.ts" } })),
    fauxAssistantMessage(JSON.stringify({ text: "Changed.", candidate: { content: scope.proposed, summary: "Whole file." } })),
    fauxAssistantMessage('{"text":"Cut off"', { stopReason: "length" }),
    (context) => { retryContext = flattened(context); return fauxAssistantMessage("Use a local string expression."); },
  ]);
  await assert.rejects(session.ask("malformed attempt", { mode: "revise" }), /usable reply/);
  await assert.rejects(session.ask("unexpected path attempt", { mode: "revise" }), /only the scoped replacement/);
  await assert.rejects(session.ask("whole file attempt", { mode: "revise" }), /whole file instead of the selected lines/);
  await assert.rejects(session.ask("truncated attempt", { mode: "revise" }), /did not finish/);
  await session.ask("What is the smallest expression?", { mode: "question" });
  assert.doesNotMatch(retryContext, /malformed attempt|unexpected path attempt|whole file attempt|truncated attempt/);
  session.dispose();
});

test("tool calls from the fork never execute and are not accepted as replies", async () => {
  const f = await fixture(), session = f.create();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "bad.txt", content: "bad" }), { stopReason: "toolUse" })]);
  await assert.rejects(session.ask("Explain the function", { mode: "question" }), /did not finish/);
  assert.equal(f.faux.state.callCount, 1); session.dispose();
});

test("cancellation and disposal stop child requests without touching the parent", async () => {
  const f = await fixture(), session = f.create(), original = JSON.stringify(f.parent.getEntries());
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.faux.setResponses([async (_context, options) => {
    started(); await new Promise<void>(resolve => { options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
    return fauxAssistantMessage("Too late.");
  }]);
  const controller = new AbortController(), result = session.ask("Explain", { mode: "question", signal: controller.signal });
  await ready;
  await assert.rejects(session.ask("Second concurrent question", { mode: "question" }), /Wait for/);
  controller.abort(); await assert.rejects(result, /stopped|aborted/i);
  session.dispose(); await assert.rejects(session.ask("Again", { mode: "question" }), /closed/);
  assert.equal(JSON.stringify(f.parent.getEntries()), original);
});

test("quick forks reject invalid scopes and bound repeated turns without new model calls", async () => {
  const f = await fixture();
  assert.throws(() => f.create({ ...scope, startLine: 2, endLine: 99 }), /valid range/);
  assert.throws(() => f.create({ ...scope, proposed: "x".repeat(256 * 1024 + 1) }), /too large/);
  assert.throws(() => f.create({ ...scope, stepContext: "x".repeat(32769) }), /32 KiB/);
  const session = f.create(); f.faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Yes.")));
  await assert.rejects(session.ask("x".repeat(3001), { mode: "question" }), /3,000/);
  for (let index = 0; index < 8; index++) await session.ask("Check " + index, { mode: "question" });
  await assert.rejects(session.ask("Ninth", { mode: "question" }), /eight turns/);
  assert.equal(f.faux.state.callCount, 8); session.dispose();
  assert.match(ACTION_SESSION_CONTRACT, /No extra keys/);
});

test("one chat naturally answers then suggests a requested revision while streaming only readable text", async () => {
  const f = await fixture(), original = JSON.stringify(f.parent.getEntries()), requests: TranscriptContext[] = [];
  const answer = 'The `name` value stays a string.\n\nIt can contain "quotes", a backslash \\, and Unicode 😀.';
  const replacement = '  return `Hello ${name.trim()}`;';
  f.faux.setResponses([
    context => { requests.push(structuredClone(context)); return fauxAssistantMessage(JSON.stringify({ text: answer }).replace('😀', '\\ud83d\\ude00')); },
    context => { requests.push(structuredClone(context)); return fauxAssistantMessage(JSON.stringify({ text: 'Trim only the selected expression.', candidate: { content: replacement, summary: 'Trim the name without changing the signature.' } })); },
  ]);
  const session = f.create(), questionUpdates: string[] = [], revisionUpdates: string[] = [];
  const explanation = await session.ask('What does this do, and why is the public signature unchanged?', { mode: 'chat', onUpdate: value => questionUpdates.push(value) });
  assert.equal(explanation.text, answer); assert.equal(explanation.candidate, undefined);
  assert.ok(questionUpdates.length > 1, 'unified questions still stream through the real provider');
  assert.ok(questionUpdates.every(value => answer.startsWith(value)), 'only decoded Markdown prefixes reach the UI');
  const revision = await session.ask('Please trim the name in those lines, keeping the same protocol.', { mode: 'chat', onUpdate: value => revisionUpdates.push(value) });
  assert.equal(revision.candidate?.content, replacement);
  assert.ok(revisionUpdates.every(value => revision.text.startsWith(value)));
  assert.ok(revisionUpdates.every(value => !value.includes(replacement) && !value.includes('candidate')));
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages, 'the child request prefix stays stable');
  assert.match(JSON.stringify(requests[0]), /Questions, requests for explanation/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /Mode: chat|Mode: revise|Mode: question/);
  assert.equal(JSON.stringify(f.parent.getEntries()), original); session.dispose();
});
