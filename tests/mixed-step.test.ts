import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { prepareChanges, type ChangeInput } from "../extensions/pair/changes.ts";
import { registerStepPermissions } from "../extensions/pair/permissions.ts";

function fixture(decision = "approve") {
  const root = mkdtempSync(join(tmpdir(), "pair-mixed-"));
  let tool: any;
  const events: string[] = [], previews: any[] = [];
  const pi: any = { on() {}, appendEntry() {}, registerTool(value: any) { tool = value; } };
  const controller = registerStepPermissions(pi, { active: () => ({ root }), changed() {},
    review: async (_ctx, _title, _why, changes) => { previews.push(...changes); return { action: decision as "approve" | "deny" }; },
  });
  let shell: (command: string) => boolean = () => true;
  const ctx: any = { hasUI: true, mode: "tui", tools: ["write", "edit", "bash", "powershell"].map(name => ({ name })),
    sessionManager: { getBranch: () => [] }, executeTool: async (name: string, input: any) => {
      assert.equal(controller.guard({ toolName: name, input, parentToolCallId: "mixed-request" } as any), undefined);
      events.push(name + ":" + (input.command || input.path));
      if (name === "bash" || name === "powershell") {
        const ok = shell(input.command);
        return { isError: !ok, result: { content: [{ type: "text", text: ok ? "Command completed" : "Command failed" }] } };
      }
      const result = await (name === "write" ? createWriteTool(root) : createEditTool(root)).execute("native-file", input);
      return { isError: Boolean(result.isError), result };
    },
  };
  return { root, events, previews, tool: () => tool, onShell: (run: typeof shell) => { shell = run; },
    run: (changes: ChangeInput[]) => tool.execute("mixed-request", { title: "Wire and verify the feature", why: "Create its source, check it, then wire the caller.", changes }, new AbortController().signal, undefined, ctx),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("mixed previews retain all eight actions in order without executing any", async () => {
  const f = fixture();
  try {
    const changes: ChangeInput[] = Array.from({ length: 4 }, (_, i) => [
      { tool: "write" as const, path: `file${i}.ts`, content: `export const n = ${i};`, why: `Create module ${i}.` },
      { tool: "bash" as const, command: `check ${i}`, why: `Verify module ${i}.` },
    ]).flat();
    const previews = await prepareChanges(f.root, changes);
    assert.deepEqual(previews.map(value => value.tool), changes.map(value => value.tool));
    assert.deepEqual(previews.map(value => value.preview.why), changes.map(value => value.why));
    assert.equal(existsSync(join(f.root, "file0.ts")), false);
    assert.equal(f.events.length, 0);
    assert.deepEqual(f.tool().prepareArguments({ title: "A", why: "B", changes }).changes, changes);
    await assert.rejects(prepareChanges(f.root, [...changes, { tool: "bash", command: "extra" }]), /1–8 ordered actions/);
    await assert.rejects(prepareChanges(f.root, Array.from({ length: 5 }, (_, i) => ({ tool: "write", path: `f${i}.ts`, content: "x" }))), /at most four/);
    await assert.rejects(prepareChanges(f.root, [{ tool: "write", path: "same.ts", content: "a" }, { tool: "bash", command: "check" }, { tool: "write", path: "same.ts", content: "b" }]), /Combine all replacements/);
  } finally { f.close(); }
});

test("approved writes, commands, and edits execute in displayed order and commands see earlier writes", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "caller.ts"), "const answer = 0;\n");
    f.onShell(command => {
      assert.equal(readFileSync(join(f.root, "answer.ts"), "utf8"), "export const answer = 42;\n");
      assert.equal(readFileSync(join(f.root, "caller.ts"), "utf8"), command === "check source" ? "const answer = 0;\n" : "const answer = 42;\n");
      return true;
    });
    const result = await f.run([
      { tool: "write", path: "answer.ts", content: "export const answer = 42;\n", why: "Supply the shared answer." },
      { tool: "bash", command: "check source", why: "Check the source before wiring it." },
      { tool: "edit", path: "caller.ts", edits: [{ oldText: "answer = 0", newText: "answer = 42" }], why: "Use the corrected answer." },
      { tool: "powershell", command: "check caller", why: "Verify the integrated caller." },
    ]);
    assert.equal(result.details.status, "Applied");
    assert.deepEqual(f.events.map(value => value.split(":")[0]), ["write", "bash", "edit", "powershell"]);
    assert.deepEqual(result.details.changes.map((value: any) => value.status), ["Applied", "Completed", "Applied", "Completed"]);
  } finally { f.close(); }
});

test("denying a mixed step executes no command or file action", async () => {
  const f = fixture("deny");
  try {
    await f.run([{ tool: "bash", command: "before", why: "Check the environment before creating the source." }, { tool: "write", path: "a.ts", content: "a", why: "Create the source file." }]);
    assert.equal(f.events.length, 0);
    assert.equal(existsSync(join(f.root, "a.ts")), false);
  } finally { f.close(); }
});

test("a failed middle command preserves completed writes and stops later actions", async () => {
  const f = fixture();
  try {
    f.onShell(() => false);
    const result = await f.run([{ tool: "write", path: "a.ts", content: "a", why: "Create the core source." }, { tool: "bash", command: "fail check", why: "Verify the core before wiring its caller." }, { tool: "write", path: "b.ts", content: "b", why: "Add the caller after verification." }]);
    assert.equal(result.isError, true);
    assert.equal(f.events.length, 2);
    assert.equal(readFileSync(join(f.root, "a.ts"), "utf8"), "a");
    assert.equal(existsSync(join(f.root, "b.ts")), false);
    assert.equal(result.details.changes[2].status, "Not run — proposed");
  } finally { f.close(); }
});

test("a command changing a later file invalidates its approved edit and stops the rest", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "later.ts"), "original");
    f.onShell(() => { writeFileSync(join(f.root, "later.ts"), "generated by command"); return true; });
    const result = await f.run([{ tool: "write", path: "a.ts", content: "a", why: "Create the source used by generation." }, { tool: "bash", command: "generate later", why: "Regenerate derived project data." },
      { tool: "edit", path: "later.ts", edits: [{ oldText: "original", newText: "proposed" }], why: "Update the reviewed integration point." }, { tool: "powershell", command: "should not run", why: "Verify integration after the edit." }]);
    assert.equal(result.isError, true);
    assert.equal(f.events.length, 2);
    assert.equal(readFileSync(join(f.root, "later.ts"), "utf8"), "generated by command");
    assert.match(result.details.changes[2].text, /changed since the preview/);
    assert.equal(result.details.changes[3].status, "Not run — proposed");
  } finally { f.close(); }
});

test("mixed steps require an explanation for every action before review or execution", async () => {
  const f = fixture();
  try {
    const actions: ChangeInput[] = [
      { tool: "write", path: "a.ts", content: "a", why: "Create the source." },
      { tool: "bash", command: "check source", why: "Verify the new source." },
    ];
    for (const index of [0, 1]) for (const why of [undefined, "  \n "]) {
      const invalid = actions.map((action, i) => i === index ? { ...action, why } : action);
      await assert.rejects(f.run(invalid), new RegExp(`Action ${index + 1}: add why`));
      assert.equal(f.previews.length, 0);
      assert.equal(f.events.length, 0);
      assert.equal(existsSync(join(f.root, "a.ts")), false);
    }
    // Existing file-only and standalone-command history keeps its group-rationale fallback.
    assert.equal((await prepareChanges(f.root, [{ tool: "write", path: "a.ts", content: "a" }])).length, 1);
    assert.equal((await prepareChanges(f.root, [{ tool: "bash", command: "check source" }])).length, 1);
  } finally { f.close(); }
});
