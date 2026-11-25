// Cost model of a run: real usage priced per model (the SUT reports its usage per checkpoint; the judge's is
// FDE-bench's own), and an up-front estimate (the runner's guard: above $5 it needs --yes).
//
// FDE-bench cannot know a SUT's cost before running it, so the estimate is a conservative heuristic for a
// SUT that reads new engagements with one model call per batch and re-plans with one call per checkpoint
// (the shape of the system FDE-bench was extracted from), plus a judge call per llm item.
import { pipelineDays, type Rubric, type Scenario } from "./types.ts";

/** One model call's usage, as the protocol reports it (checkpoint `usage[]`). */
export interface Usage { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }

/** $ per MTok: input, output, cache read, cache write (5-minute). */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
};
const DEFAULT = PRICES["claude-opus-5-5"];

/** Unknown models are priced at the default (Opus 5.5) rates. */
export function priceOf(u: Usage): number {
  const key = Object.keys(PRICES).find((k) => u.model === k || u.model.startsWith(`${k}-`));
  const [i, o, cr, cw] = key ? PRICES[key] : DEFAULT;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
  return (n(u.input) * i + n(u.output) * o + n(u.cacheRead) * cr + n(u.cacheWrite) * cw) / 1e6;
}

/** Engagement characters per read call (~70K tokens). */
export const BATCH_CHARS = 280_000;

// Per-call assumptions for the estimate (conservative: high effort thinks a lot). Tokens ~ chars / 4.
export const EST = {
  read: { baseIn: 6000, out: 8000 }, // + engagement text
  plan: { in: 7000, out: 8000 },
  judge: { in: 3000, out: 2000 },
};

export interface Estimate { calls: { read: number; plan: number; judge: number }; usd: number }

/** Calls and dollars for one run of one scenario: a read call per checkpoint with new engagements (more if
 *  they overflow a batch), a plan call per checkpoint, a judge call per llm item. Priced at the given
 *  model's rates (Opus 5.5 by default). */
export function estimateScenario(sc: Pick<Scenario, "checkpoints" | "engagements">, rubric: Rubric, model = "claude-opus-5-5"): Estimate {
  const [i, o] = PRICES[model] ?? DEFAULT;
  const calls = { read: 0, plan: 0, judge: 0 };
  let usd = 0;
  let prev = -Infinity;
  for (const day of pipelineDays(sc, rubric)) {
    const chars = sc.engagements.filter((e) => e.day > prev && e.day <= day).reduce((n, e) => n + e.text.length, 0);
    prev = day;
    if (chars > 0) {
      const n = Math.ceil(chars / BATCH_CHARS);
      calls.read += n;
      usd += (n * EST.read.baseIn * i + (chars / 4) * i + n * EST.read.out * o) / 1e6;
    }
    calls.plan++;
    usd += (EST.plan.in * i + EST.plan.out * o) / 1e6;
  }
  for (const cp of rubric.checkpoints)
    for (const it of [...cp.expect, ...cp.forbid])
      if (it.judge === "llm") {
        calls.judge++;
        usd += (EST.judge.in * i + EST.judge.out * o) / 1e6;
      }
  return { calls, usd };
}
