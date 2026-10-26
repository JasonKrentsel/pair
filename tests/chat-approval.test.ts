import assert from "node:assert/strict";
import test from "node:test";
import { classifyDesignApproval } from "../extensions/pair/chat-approval.ts";

test("clear chat approval recognizes common direct decisions", () => {
  for (const text of ["approved", "Approved!", "I approve the design", "approve this design", "the design is approved", "looks good, go ahead", "Looks good. Proceed.", "ok, approved", "yes, I approve the design", "approved; go ahead", "I approve the design. Thanks."]) {
    assert.deepEqual(classifyDesignApproval(text), { kind: "direct", text }, text);
  }
  assert.deepEqual(classifyDesignApproval("  approved  "), { kind: "direct", text: "approved" });
});

test("approval plus specific requested changes is scoped to a revision", () => {
  for (const text of ["no concurrancy cap, approved", "no concurrency cap, approved", "approved, remove the cap", "I approve the design, just use one runner", "approved with no concurrency cap", "approved, but keep the CLI unchanged", "use async workers; approved", "approved. Leave the CLI open-ended."]) {
    assert.deepEqual(classifyDesignApproval(text), { kind: "revision", text }, text);
  }
});

test("clear design approval can separately forbid implementation", () => {
  for (const text of ["I approve the design, but don't implement yet", "approved, do not code yet", "approved; don't edit files", "approved. Do not run anything yet.", "I approve this design but don't run tests yet", "approved, don't write any code", "approved, but please do not implement now"]) {
    assert.deepEqual(classifyDesignApproval(text), { kind: "direct", text }, text);
  }
  const scoped = "approved, remove the cap, but don't implement yet";
  assert.deepEqual(classifyDesignApproval(scoped), { kind: "revision", text: scoped });
  for (const text of ["don't approve the design", "approved, but don't approve this design", "do not implement yet", "approved, don't change the design", "not approved, don't implement yet"]) {
    assert.equal(classifyDesignApproval(text), undefined, text);
  }
});

test("explicit revision numbers are returned for caller matching", () => {
  for (const text of ["I approve revision 3", "approve design revision 3", "revision 3 approved", "design revision 3 is approved", "approved version 3"]) {
    assert.deepEqual(classifyDesignApproval(text), { kind: "direct", text, revision: 3 }, text);
  }
  const scoped = "I approve revision 3, remove the cap";
  assert.deepEqual(classifyDesignApproval(scoped), { kind: "revision", text: scoped, revision: 3 });
  for (const text of ["I approve revision 0", "I approve revision 9007199254740993", "approved revision 3, approved revision 4"]) assert.equal(classifyDesignApproval(text), undefined, text);
});

test("questions, negation, ambiguous acknowledgments and conditional approvals are not decisions", () => {
  for (const text of ["", "ok", "yes", "sure", "looks good", "go ahead", "approved?", "Is the design approved", "not approved", "I do not approve the design", "I didn't approve the design", "I never said approved", "approved, not really", "approved if tests pass", "when I say approved, continue", "approved unless the tests fail", "approved once the cap is removed", "assuming that works, approved", "no, approved", "nope. Approved."]) {
    assert.equal(classifyDesignApproval(text), undefined, text);
  }
});

test("quoted, fenced and reported approval cannot become a live decision", () => {
  for (const text of ['"approved"', "'approved'", "‘approved’", "“I approve the design”", "> approved", "Here is the note:\n> approved", "```\napproved\n```", "`approved`", "the document says approved", "Alice said approved", "example: approved", "pretend I said approved", "suppose I approve the design", "approved. The document says proceed.", "approved" + " ".repeat(1001) + "x"]) {
    assert.equal(classifyDesignApproval(text), undefined, text);
  }
});
