export interface DesignApprovalIntent {
  kind: "direct" | "revision";
  /** Original human wording, retained for the caller to bind to the actual turn. */
  text: string;
  revision?: number;
}

// These clauses restrict implementation, not the separate design decision.
const executionLimit = (clause: string) => /^(?:but\s+)?(?:please\s+)?(?:don't|do not)\s+(?:(?:implement|code|edit)(?:\s+(?:anything|files|code))?|run(?:\s+(?:anything|commands|tests))?|write(?:\s+any)?\s+code)(?:\s+(?:yet|now))?$/.test(clause);

function approvalClause(clause: string): { revision?: number } | undefined {
  const value = clause.replace(/^(?:ok(?:ay)?|yes|yep|yeah|sure)\s+/, "").replace(/^please\s+/, "");
  if (/^(?:approved|i approve|(?:i )?approve (?:the |this |current |proposed )?design|(?:(?:the |this |current |proposed )?design (?:is )?approved))$/.test(value)) return {};
  const numbered = value.match(/^(?:(?:i )?approve(?:d)? (?:the )?(?:design )?(?:revision|rev|version) (\d+)|(?:design )?(?:revision|rev|version) (\d+) (?:is )?approved)$/);
  if (numbered) {
    const revision = Number(numbered[1] ?? numbered[2]);
    if (Number.isSafeInteger(revision) && revision > 0) return { revision };
  }
  return undefined;
}

/** A conservative intent hint, never an approval grant. The caller must establish
 * real human provenance and bind the result to a specific design snapshot. */
export function classifyDesignApproval(text: string): DesignApprovalIntent | undefined {
  const original = text.trim();
  if (!original || original.length > 1000) return undefined;
  // Quoted/copy-pasted approval and questions are not live decisions.
  if (/[?`"“”]/.test(original) || /^\s*>/m.test(original) || /(?:^|\s)['‘][^'’]*['’](?=\s|[,.!;:]|$)/.test(original)) return undefined;
  const value = original.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  if (/\b(?:if|when|unless|until|once|provided|assuming)\b|\bas long as\b/.test(value)) return undefined;
  // Preserve "with/but/except" as the requested revision, including without a comma.
  const clauses = value.replace(/\b(approved|i approve(?: (?:the|this|current|proposed) design)?)\s+(with|but|except)\b/g, "$1, $2")
    .split(/[,;.!]+/).map((clause) => clause.trim()).filter(Boolean);
  const decisionText = clauses.filter((clause) => !executionLimit(clause)).join("; ");
  if (/\b(?:not|never|don't|do not|didn't|did not|won't|will not|can't|cannot|isn't|is not|wasn't|was not|haven't|have not)\b|\b(?:reject|rejected|deny|denied|disapprove|unapproved)\b/.test(decisionText)) return undefined;
  if (/^(?:no|nope|nah)\s*[,;.!]/.test(value)) return undefined;
  if (/\b(?:said|says|wrote|writes|quoted|quote|example|hypothetical|pretend|suppose)\b/.test(value)) return undefined;

  if (/^(?:ok(?:ay)?[, ]+)?looks good[,;.! ]+(?:go ahead|proceed)[.!]*$/.test(value)) {
    return { kind: "direct", text: original };
  }
  let found = false;
  let revision: number | undefined;
  let revised = false;
  for (const clause of clauses) {
    if (executionLimit(clause)) continue;
    const approval = approvalClause(clause);
    if (approval) {
      found = true;
      if (approval.revision !== undefined) {
        if (revision !== undefined && revision !== approval.revision) return undefined;
        revision = approval.revision;
      }
      continue;
    }
    if (/^(?:ok(?:ay)?|yes|yep|yeah|sure|thanks|thank you|go ahead|proceed|let's do it|let's implement it)$/.test(clause)) continue;
    if (/^(?:(?:please|just)\s+)?(?:no|remove|drop|omit|add|include|use|keep|leave|change|replace|make|set|with|but|except)\s+\S/.test(clause)) {
      revised = true;
      continue;
    }
    return undefined;
  }
  if (!found) return undefined;
  return { kind: revised ? "revision" : "direct", text: original, ...(revision === undefined ? {} : { revision }) };
}
