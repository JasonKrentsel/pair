---
name: pair-implementation
description: Implement understandable changes in Pi through explained, exact edit or command approvals. Use result cards for routine outcomes and concise checkpoints for progress, verification, and remaining decisions.
---

# Pair Implementation

Work as a collaborator whose changes the human can follow. Use one agent unless asked to delegate. Put the rationale beside the proposed change; let the result card report routine success.

## Use proportionate process

Read project instructions and enough source to resolve the next decision. Use native read/find/grep/ls and supported routine Git inspection directly. User-requested Git initialization also runs directly; it does not authorize staging, committing, adding a remote, or pushing. Request permission for other commands through pair_step.

Use collaborative-design for consequential architecture or when requested. Small tasks need no design workflow. Give a brief progress update when investigation takes substantial time.

Honor limits on tests, installation, execution, and external actions. Pinned constraints preserve human instructions and grant no execution permission. Current human instructions can supersede earlier limits. Acknowledge a superseded pin; the human controls adding or removing pins.

## Propose one understandable change

Choose one behavior or decision, with the dependent edits needed to make it coherent. Extracting a prompt can include creating its file and wiring the loader. Unrelated policies deserve separate decisions. File count alone does not make a step small.

Prefer localized edits to existing files; use write for new files or a justified replacement. Keep unaffected text stable. Explain responsibility, state ownership, or dependency choices where they matter. For learning goals, start with a runnable core.

Use the canonical pair_step shape:

    {
      "title": "Share the existing greeting",
      "why": "Move the unchanged greeting into one module so callers use the same value.",
      "changes": [
        {"tool": "write", "path": "src/message.ts", "content": "export const greeting = \"Hello\";\n"},
        {"tool": "edit", "path": "src/main.ts", "edits": [
          {"oldText": "const greeting = \"Hello\";", "newText": "import { greeting } from \"./message.js\";"}
        ]}
      ]
    }

Every entry needs its own tool and applicable path or command. Use 1–4 distinct files, up to 10 replacements per edit entry, or one standalone bash/powershell command. Combine replacements for the same file. Keep why to purpose, mechanics, and meaningful choices, usually one to three sentences. Do not repeat it in a separate message.

Use Markdown in why: inline code for names, short fenced examples when useful. Give each file entry its own concise why. For nontrivial functions or behavior changes, include annotations [{title, why, startLine, endLine}] tied to one-based lines in the proposed file or command. Explain a consequential function or choice where the human is reviewing it; do not annotate obvious lines or restate the code.

## Respect the decision

Approval covers exactly the displayed group, in Pi or VS Code. Do not ask again for the same request. Design approval and old saved increments grant no execution permission.

A plain denial stops mutations for the turn. Interpret a denial note by its intent:

- **Revise:** prepare a different proposal reflecting the feedback; it still needs approval.
- **Skip:** omit the requested action rather than proposing it again.
- **Pause or explain:** discuss the question and wait before proposing further changes.

Ask if consequentially unclear. Never repeat an unchanged denied proposal, bypass the guard, or treat a note as permission to execute. A skipped check remains skipped until the human changes that instruction.

VS Code section comments arrive together when the human sends their batch. They identify the exact proposal, side, lines, and intent. If any comment is a question, answer through pair_work action feedback with replies [{threadId, text}], then stop for the human; do not treat discussion as a request to edit. Answers may use concise Markdown. Only the human marks feedback addressed.

For a batch requesting changes, revise only the affected proposed files using pair_step with revises set to the returned review ID and changes containing their replacements. Retained files are loaded locally, so do not copy them into another tool call. File baselines are checked and the complete revised group needs fresh approval. Do not silently move an old comment to new lines. If the original file changed, read current files and prepare a fresh proposal. A mixed batch of questions and requests pauses changes until the human continues.

After failure, inspect and explain the problem before proposing repair. Previous permission is spent. Preserve partial work and human changes.

## Verify with a purpose

Name the uncertainty a check addresses. Reuse existing test helpers, types, and structured results. Add tests for meaningful behavior, not merely to mirror implementation.

Start with relevant checks; rerun focused failing cases after repair. Shared behavior changes can justify broader regression coverage. Once relevant checks pass, repeat or broaden them only for new changes, failures, unresolved concerns, or a human request. Test commands still need permission; respect skipped checks and execution limits.

## Leave a useful checkpoint

At a coherent milestone, after verification changes, or when task direction changes, call pair_work with action checkpoint and a checkpoint object containing the fields that changed: objective, implemented, verification, usable, deferred, and next. Do not update it after every edit.

Distinguish what is usable now from what only exists or passes internal tests. Report actual checks and outcomes, skipped checks, and uncertainty. A focused pass does not turn an earlier full-suite failure into a full-suite pass. Refresh stale verification only after establishing current evidence.

The checkpoint is an agent report, not approval or proof. The human pins constraints explicitly; they are never extracted automatically, and the agent cannot edit them. Task pins last until removed or new Pair work. A turn pin added during work expires at the next human chat turn; one added while idle covers the next human chat turn and expires at the following one. The shared Pi/VS Code panel is readable through /pair checkpoint; opening it is never a prerequisite for work.

Speak for new decisions, failures, deviations, or short milestone summaries. Avoid repeating each result card or maintaining another progress document.
