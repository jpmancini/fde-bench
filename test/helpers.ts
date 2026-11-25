// Shared test helpers: the public example and the strings of it that output must never contain.
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const EXAMPLES = path.join(ROOT, "examples");
export const scen = (id: string) => JSON.parse(fs.readFileSync(path.join(EXAMPLES, "scenarios", id, "scenario.json"), "utf8"));
export const rub = (id: string) => JSON.parse(fs.readFileSync(path.join(EXAMPLES, "scenarios", id, "rubric.json"), "utf8"));

/** Distinctive strings of the example the output must never contain: every description, match text, the
 *  engagement text, the customer, people and project names, and what the SUTs derive from them. */
export function secrets(id: string): string[] {
  const s = scen(id), r = rub(id);
  const out = [s.title, s.customer.name, s.project.name, ...s.people.map((p: any) => p.name), ...s.engagements.flatMap((e: any) => [e.title, ...e.text.split("\n").filter((l: string) => l.trim().length > 12)])];
  for (const cp of r.checkpoints) for (const it of [...cp.expect, ...cp.forbid]) out.push(it.description, ...(it.match.textAny ?? []), ...(it.match.owner ? [it.match.owner] : []));
  out.push("marzipan ledger", "stub judge", "retail prices", "Blocked:", "Unblock:", "Meet deadline", "Client correction");
  return [...new Set(out)].filter((x) => x.length >= 4 && x !== "provider"); // "provider" is a match keyword, not example text
}
export const leaks = (text: string, id: string) => secrets(id).filter((x) => text.toLowerCase().includes(x.toLowerCase()));

export const srcFiles = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
