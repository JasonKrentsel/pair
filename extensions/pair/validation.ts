import { Compile } from "typebox/compile";
import type { Static, TSchema } from "typebox";

type Issue = { keyword: string; instancePath: string; params: Record<string, any> };
type SchemaShape = TSchema & { properties?: Record<string, SchemaShape>; items?: SchemaShape; anyOf?: SchemaShape[]; const?: unknown };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const bounded = (value: string, limit = 150) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit);
const label = (path: string) => path.replace(/^\//, "").replace(/changes\/(\d+)/, (_, i) => `Action ${Number(i) + 1}`)
  .replace(/edits\/(\d+)/, (_, i) => `edit ${Number(i) + 1}`).replaceAll("/", ".") || "arguments";

function format(issue: Issue, prefix = "", choices?: unknown[]): string {
  const where = label(prefix + issue.instancePath);
  const p = issue.params;
  switch (issue.keyword) {
    case "required": return `${where}: missing ${(p.requiredProperties ?? []).join(", ")}.`;
    case "type": return `${where}: expected ${p.type ?? "the declared type"}.`;
    case "minLength": return `${where}: use at least ${p.limit} character(s).`;
    case "maxLength": return `${where}: use at most ${p.limit} characters.`;
    case "minItems": return `${where}: include at least ${p.limit} item(s).`;
    case "maxItems": return `${where}: include at most ${p.limit} items.`;
    case "minimum": return `${where}: must be at least ${p.limit}.`;
    case "maximum": return `${where}: must be at most ${p.limit}.`;
    case "anyOf": return choices?.length ? `${where}: choose ${choices.join(", ")}.` : `${where}: use a supported value.`;
    default: return `${where}: does not match the declared schema.`;
  }
}

function fail(tool: string, issues: string[]): never {
  const first = [...new Set(issues)].slice(0, 3).map((issue) => bounded(issue));
  throw new Error(`${tool}: ${first.join(" ") || "Arguments do not match the schema."} Nothing ran. Correct the fields and resubmit.`);
}

/** Validate before Pi's default error formatter can echo the entire source payload.
 * Uses the same schema as Pi; diagnostics never repair or infer executable inputs. */
export function preparePairArguments<T extends TSchema>(tool: "pair_step" | "pair_work", schema: T, normalize: (value: unknown) => unknown = (value) => value): (raw: unknown) => Static<T> {
  const validator = Compile(schema);
  const properties = (schema as SchemaShape).properties!;
  // Validate root fields and array bounds without emitting every union alternative.
  const summary = tool === "pair_step" ? Compile({ ...schema, properties: { ...properties, changes: { ...properties.changes, items: {} } } }) : validator;
  const branches = tool === "pair_step" ? properties.changes.items!.anyOf! : [];
  const byTool = new Map<string, ReturnType<typeof Compile>>();
  for (const branch of branches) {
    const discriminator = branch.properties!.tool;
    const values = "const" in discriminator ? [discriminator.const] : discriminator.anyOf!.map((part) => part.const);
    for (const value of values) if (typeof value === "string") byTool.set(value, Compile(branch));
  }
  return (raw) => {
    let args: unknown;
    try { args = normalize(raw); }
    catch (error) { fail(tool, [error instanceof Error ? error.message : "Invalid argument shape."]); }
    if (validator.Check(args)) return args as Static<T>;
    const errors = summary.Errors(args) as Issue[];
    const unions = new Set(errors.filter((error) => error.keyword === "anyOf").map((error) => error.instancePath));
    const issues = errors.filter((error) => error.keyword !== "const" || !unions.has(error.instancePath)).map((error) => {
      const property = properties[error.instancePath.slice(1)];
      const choices = property?.anyOf?.map((part) => part.const).filter((value) => typeof value === "string");
      return format(error, "", choices);
    });
    if (tool === "pair_step" && object(args) && Array.isArray(args.changes)) {
      for (const [index, change] of args.changes.slice(0, 4).entries()) {
        const where = `Action ${index + 1}`;
        if (!object(change)) { issues.push(`${where}: expected an object with tool and its input fields.`); continue; }
        const selected = typeof change.tool === "string" ? byTool.get(change.tool) : undefined;
        if (!selected) {
          const missing = !("tool" in change) ? ["tool"] : [];
          // This is only a diagnostic hint for a file-shaped entry, never a path guess.
          if (("edits" in change || "content" in change) && !("path" in change)) missing.push("path");
          issues.push(`${where}: ${missing.length ? `missing ${missing.join(", ")}. ` : ""}Set tool to edit, write, bash, or powershell.`);
          continue;
        }
        const errors = selected.Errors(change) as Issue[];
        issues.push(...errors.map((error) => format(error, `/changes/${index}`)));
      }
    }
    fail(tool, issues);
  };
}
