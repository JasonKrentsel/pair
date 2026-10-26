import assert from "node:assert/strict";
import test from "node:test";
import { addConstraint, compactMemory, expireTurnConstraints, markCheckpointStale, normalizeMemory, removeConstraint, updateCheckpoint } from "../extensions/pair/checkpoint.ts";

test("legacy or malformed memory cannot claim progress or introduce unsafe constraints", () => {
  assert.deepEqual(normalizeMemory(undefined), { revision: 0, constraints: [] });
  const restored = normalizeMemory({ revision: -1, checkpoint: { implemented: "done", approval: true }, constraints: [
    { id: "one", text: "Skip the full suite", scope: "task", createdAt: "2026-10-25T00:00:00Z" },
    { id: "one", text: "duplicate id", scope: "turn" },
    { id: "two", text: "unsafe\x1b[2J", scope: "task" },
    { id: "three", text: "No installation", scope: "forever" },
  ] });
  assert.equal(restored.checkpoint, undefined);
  assert.equal(restored.revision, 0);
  assert.deepEqual(restored.constraints.map(item => item.text), ["Skip the full suite"]);
  assert.equal((restored as any).approval, undefined);
});

test("agent checkpoint patches preserve human constraints and distinguish tested from usable", () => {
  const initial = addConstraint(normalizeMemory(undefined), "  CLI integration later  ", "task");
  const checkpoint = updateCheckpoint(initial, { objective: "Make workers resumable", implemented: "Checkpoint writer", verification: "23 scripted tests pass", usable: "Test fixtures only; not connected to CLI", deferred: "CLI integration by request", next: "Resume by run ID" });
  assert.deepEqual(checkpoint.constraints, initial.constraints);
  assert.equal(checkpoint.constraints[0].text, "CLI integration later");
  assert.equal(checkpoint.checkpoint?.revision, 1);
  assert.equal(checkpoint.revision, initial.revision + 1);
  assert.equal(initial.checkpoint, undefined, "saved previous state stays immutable");
  const updated = updateCheckpoint(checkpoint, { next: "Wire the recovery summary" });
  assert.equal(updated.checkpoint?.verification, "23 scripted tests pass");
  assert.equal(updated.checkpoint?.usable, "Test fixtures only; not connected to CLI");
  assert.equal(updated.checkpoint?.revision, 2);
  assert.equal(updateCheckpoint(updated, { next: "Wire the recovery summary" }), updated, "identical reports don't churn context");
  assert.throws(() => updateCheckpoint(updated, { constraints: [] } as any), /checkpoint fields/);
});

test("subsequent work marks reported verification stale without erasing or rewriting it", () => {
  const memory = updateCheckpoint(normalizeMemory(undefined), { objective: "Worker runtime", verification: "Focused tests passed" });
  const stale = markCheckpointStale(memory);
  assert.equal(stale.checkpoint?.stale, true);
  assert.equal(stale.checkpoint?.verification, "Focused tests passed");
  assert.equal(stale.checkpoint?.updatedAt, memory.checkpoint?.updatedAt);
  assert.equal(markCheckpointStale(stale), stale);
  assert.match(compactMemory(stale), /later work may make this outdated/);
  const nextOnly = updateCheckpoint(stale, { next: "Wire the CLI" });
  assert.equal(nextOnly.checkpoint?.stale, true, "changing the next decision cannot refresh old verification");
  assert.equal(nextOnly.checkpoint?.verification, "Focused tests passed");
  assert.equal(updateCheckpoint(nextOnly, { next: "Wire the CLI" }), nextOnly);
  const refreshed = updateCheckpoint(stale, { verification: "Focused tests passed again after the change" });
  assert.equal(refreshed.checkpoint?.stale, false);
  assert.ok(refreshed.revision > stale.revision);
});

test("a turn constraint pinned while idle covers the next run and expires only after that run", () => {
  let memory = addConstraint(normalizeMemory(undefined), "No installation", "task", false);
  memory = addConstraint(memory, "Explain before editing", "turn", false);
  assert.equal(memory.constraints[1].pendingTurn, true);
  assert.match(compactMemory(memory), /\[next turn\] Explain before editing/);
  assert.deepEqual(normalizeMemory(JSON.parse(JSON.stringify(memory))), memory);
  const active = expireTurnConstraints(memory);
  assert.equal(active.constraints.length, 2);
  assert.equal(active.constraints[1].pendingTurn, undefined);
  assert.match(compactMemory(active), /\[this turn\] Explain before editing/);
  assert.ok(active.revision > memory.revision);
  const expired = expireTurnConstraints(active);
  assert.deepEqual(expired.constraints.map(item => item.text), ["No installation"]);
  assert.ok(expired.revision > active.revision);
});

test("explicitly pinning an existing turn instruction for the next run renews its timing", () => {
  const memory = addConstraint(normalizeMemory(undefined), "Explain first", "turn");
  const renewed = addConstraint(memory, "Explain first", "turn", false);
  assert.equal(renewed.constraints.length, 1);
  assert.equal(renewed.constraints[0].id, memory.constraints[0].id);
  assert.equal(renewed.constraints[0].pendingTurn, true);
  assert.equal(addConstraint(renewed, "Explain first", "turn", false), renewed);
  const malformed = normalizeMemory({ revision: 3, constraints: [{ id: "task-id", text: "No install", scope: "task", pendingTurn: true }] });
  assert.equal(malformed.constraints[0].pendingTurn, undefined, "task timing cannot be turned into expiry through saved metadata");
});

test("turn expiry preserves task constraints and checkpoint, removal is explicit and idempotent", () => {
  let memory = updateCheckpoint(normalizeMemory(undefined), { next: "Explain the recovery path" });
  memory = addConstraint(memory, "No installation", "task");
  memory = addConstraint(memory, "Explain before editing", "turn");
  const expired = expireTurnConstraints(memory);
  assert.deepEqual(expired.constraints.map(item => item.text), ["No installation"]);
  assert.deepEqual(expired.checkpoint, memory.checkpoint);
  assert.equal(expireTurnConstraints(expired), expired);
  assert.equal(removeConstraint(expired, "unknown"), expired);
  const removed = removeConstraint(expired, expired.constraints[0].id);
  assert.equal(removed.constraints.length, 0);
  assert.equal(removed.revision, expired.revision + 1);
});

test("bounded input rejects control sequences, invalid scope and oversized updates", () => {
  const memory = normalizeMemory(undefined);
  assert.throws(() => addConstraint(memory, "\x1b[31mNo tests", "task"), /terminal controls/);
  assert.throws(() => addConstraint(memory, "x".repeat(301), "task"), /1–300/);
  assert.throws(() => addConstraint(memory, "No tests", "forever" as any), /scope/);
  assert.throws(() => updateCheckpoint(memory, {}), /checkpoint fields/);
  assert.throws(() => updateCheckpoint(memory, { objective: "   " }), /meaningful/);
  assert.throws(() => updateCheckpoint(memory, { next: "x".repeat(301) }), /300/);
  assert.throws(() => updateCheckpoint(memory, { verification: "\x1b[2Jpassed" }), /terminal controls/);
  let full = memory;
  for (let index = 0; index < 12; index++) full = addConstraint(full, `Constraint ${index}`, "task");
  assert.equal(addConstraint(full, "Constraint 0", "task"), full);
  assert.throws(() => addConstraint(full, "One too many", "task"), /12 active constraints/);
});

test("round-trip persistence retains facts and emits no permission grant", () => {
  let memory = updateCheckpoint(normalizeMemory(undefined), { implemented: "Saved state", usable: "Internal API only", deferred: "CLI", verification: "Not run" });
  memory = addConstraint(memory, "Do not run the full suite", "task");
  assert.deepEqual(normalizeMemory(JSON.parse(JSON.stringify(memory))), memory);
  const summary = compactMemory(memory);
  assert.match(summary, /usable: Internal API only/);
  assert.match(summary, /verification: Not run/);
  assert.match(summary, /\[this task\] Do not run the full suite/);
  assert.doesNotMatch(summary, /approved|permission granted/i);
  assert.equal(compactMemory(normalizeMemory(undefined)), "");
});
