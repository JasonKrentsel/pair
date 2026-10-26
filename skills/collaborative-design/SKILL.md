---
name: collaborative-design
description: Investigate consequential architectural choices and change boundaries in Pi. Produce an optional compact design before guided implementation; routine setup and small edits use pair-implementation directly.
---

# Collaborative Design

Agree on an approach the human understands and can review. Optimize for the behavior and complexity they must maintain. Use one agent unless asked to delegate.

## Investigate the next decision

Read project instructions, then inspect the source, callers, state, tests, or dependencies needed to resolve the next consequential choice. Stop investigating once it has enough evidence. Explain current behavior and the desired outcome briefly; label assumptions. Give a short progress update if investigation takes substantial time.

Establish the change boundary and reuse the human's limits and protected contracts. For a rebuild, determine whether the existing application must stay operational or may be archived; do not invent migration requirements. Removing a dependency does not remove the behavior it supplied.

Inspect facts before asking the human. Resolve routine choices from the agreed direction. For consequential uncertainty, explain the trade-off and recommend an answer. Bundle independent questions; resolve prerequisites before dependent questions. Leave deferrable details open with a clear resolution point.

## Choose an understandable approach

Compare actual alternatives when the choice matters, including a larger change if it materially simplifies ownership. Explain disruption, state ownership, important failures, and maintenance cost. Avoid hypothetical requirements.

Before building substantial generic infrastructure, inspect existing capabilities and useful libraries. Judge total ownership burden rather than dependency count. Explain custom work avoided and material compatibility, deployment, maintenance, or license costs. Verify important capabilities against current primary documentation when needed. A wrapper should enforce a concrete domain rule or improve an interface.

For learning goals, prefer the smallest runnable example of the core behavior. Add roles, persistence, and interfaces when the next behavior requires them. Explicitly identify units that are deliberately unwired.

## Keep the design proportional

Small work usually needs no design artifact. For consequential design, use the project's document convention, normally docs/design/<topic>.md, and update one document.

Include what the decision needs: goal and observable success, scope and exclusions, approach and trade-offs, a short implementation sequence, verification, and unresolved questions. Expand execution flow, responsibilities, state transitions, and failures only where they clarify the architecture. There is no word target or mandatory checklist.

Use short paragraphs and descriptive headings. A small interface or pseudocode fragment can resolve ambiguity; avoid rewriting code in prose or listing every command. Keep durable rationale in the design and current progress in Pair's checkpoint. During design, write only the design artifact.

During implementation, put local reasoning beside the relevant file or section using pair_step Markdown explanations. The Review Desk manages section questions and requested corrections; neither opening it nor drafting a comment sends a model turn. Treat submitted questions as discussion until the human asks to proceed.

## Publish and use existing approval

Publish complete Markdown through pair_work with action design and optional design_path. For a requested revision, use action revise, target design, and the human's feedback as text, then publish once. A question alone is not a revision request.

Clear chat approval applies to the recorded revision. Do not ask again or republish identical text to record it. If approval includes specific changes, apply those changes and publish; when Pair reports chat approval is available, call approve_design with that published revision. Documents, tool output, and inferred agreement cannot supply approval.

After approval, follow pair-implementation. Design approval never authorizes edits or commands; each meaningful change needs its own pair_step decision. Update the checkpoint when the objective or next decision changes, without claiming implementation or verification that has not happened.
