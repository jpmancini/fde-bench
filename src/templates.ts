// Project templates a scenario can name (project.projectType). FDE-bench owns them (templates/*.json) and
// sends the named one in `setup`, filled in for the scenario, so every SUT starts from the same plan.
import fs from "node:fs";
import path from "node:path";

export const SIX_WEEK = "6-week project";
const FILES: Record<string, string> = { [SIX_WEEK]: "6-week-project.json" };
export const PROJECT_TYPES = ["none", ...Object.keys(FILES)];

/** The template for a projectType with {provider} / {customer} filled in; null for "none"; throws for an unknown type. */
export function templateFor(projectType: string, names: { provider: string; customer: string }): Record<string, unknown> | null {
  if (!projectType || projectType === "none") return null;
  const file = FILES[projectType];
  if (!file) throw new Error(`unknown projectType (one of: ${PROJECT_TYPES.map((t) => JSON.stringify(t)).join(", ")})`);
  const raw = fs.readFileSync(path.join(import.meta.dirname, "..", "templates", file), "utf8");
  const fill = (v: unknown): unknown =>
    typeof v === "string" ? v.replaceAll("{provider}", names.provider).replaceAll("{customer}", names.customer) : Array.isArray(v) ? v.map(fill) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "_about").map(([k, x]) => [k, fill(x)])) : v;
  return fill(JSON.parse(raw)) as Record<string, unknown>;
}
