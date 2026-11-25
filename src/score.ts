// Scoring (pure): a SUT snapshot at a checkpoint + the rubric's expect/forbid items -> pass / fail per item ->
// a 0-100 score. Exact matchers here; `judge: "llm"` items go to an injected judge (src/judge.ts). Nothing in
// this file prints: results carry ids and reasons for --debug-unsafe only.
//
// The snapshot is the protocol's (docs/sut-protocol.md) plus what only the runner knows: the simulated clock,
// who is who (from the scenario, never from the SUT) and the text of every engagement it sent (due-date
// evidence is checked against what was sent, never against what the SUT says it holds).
import type { ExpectType, Match, ProtocolSnapshot, RubricCheckpoint, RubricItem } from "./types.ts";

export type SnapState = ProtocolSnapshot["state"][number];
export type SnapAction = ProtocolSnapshot["actions"][number];
export type SnapDeadline = ProtocolSnapshot["deadlines"][number];
export type SnapLesson = ProtocolSnapshot["lessons"][number];
export type SnapEvent = ProtocolSnapshot["timeline"][number];
export type SnapProof = ProtocolSnapshot["proofs"][number];
export type SnapIntegration = ProtocolSnapshot["integrations"][number];

export interface Parties { provider: string; customer: string; people: { name: string; side: "client" | "provider" }[] }

export interface Snapshot {
  day: number;
  today: string;
  kickoffDate: string;
  state: SnapState[];
  actions: SnapAction[];
  deadlines: SnapDeadline[];
  lessons: SnapLesson[];
  /** the timeline is agreed with the client (only then do its events evidence due dates) */
  timelineAgreed: boolean;
  timeline: SnapEvent[];
  proofs: SnapProof[];
  integrations: SnapIntegration[];
  /** SUT engagement id -> the text FDE-bench sent for it (to check "engagement <id>: '<quote>'" evidence) */
  engagements: Record<string, string>;
  /** Who is who, for owner matching by side: the provider firm, the customer, the scenario's people. */
  parties?: Parties;
}

/** error: the judge call failed (after its retries): a harness failure, so the checkpoint is invalid.
 *  errorClass / errorMessage: for the runner's --errors mode (redacted before printing). */
export interface ItemResult { id: string; type: ExpectType; role: "expect" | "forbid"; weight: number; judge: "exact" | "llm"; ok: boolean; matches?: number; reason?: string; error?: boolean; errorClass?: string; errorMessage?: string }

export type Judge = (item: RubricItem, role: "expect" | "forbid", snap: Snapshot) => Promise<{ holds: boolean; reason: string }>;

/** A deadline's evidence words: `quote`, else `source` (the protocol's older name for it). */
export const deadlineQuote = (d: Pick<SnapDeadline, "quote" | "source">) => d.quote ?? d.source;

// ---------------------------------------------------------------------------------------------------------
// Matchers

const alts = (v: string | string[] | undefined) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split("|")).map((s) => s.trim().toLowerCase()).filter(Boolean));
const inAlts = (v: string | undefined, a: string | string[] | undefined) => {
  const xs = alts(a);
  return !xs || (v !== undefined && xs.includes(v.toLowerCase()));
};
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** One textAny term against a haystack: "/re/flags" is a regex (i added), anything else a case-insensitive substring. */
export function termMatches(term: string, hay: string): boolean {
  const re = term.match(/^\/(.+)\/([a-z]*)$/s);
  if (re) {
    try {
      return new RegExp(re[1], re[2].includes("i") ? re[2] : re[2] + "i").test(hay);
    } catch {
      return false;
    }
  }
  return squash(hay).includes(squash(term));
}
export const textAny = (terms: string[] | undefined, hay: string) => !terms || !terms.length || terms.some((t) => termMatches(t, hay));

/** Is this action's due date backed by allowed evidence? A deadline with that date ("deadline <id>: ..."),
 *  an event of the AGREED timeline ("timeline event <id>: ..."), or an engagement whose text (as sent) holds
 *  the quoted words ("engagement <id>: '<quote>'"). Anything else is no evidence. */
export function dueEvidenced(a: Pick<SnapAction, "dueDate" | "dueDateSource">, snap: Pick<Snapshot, "deadlines" | "timeline" | "timelineAgreed" | "engagements">): boolean {
  if (!a.dueDate) return true;
  const src = (a.dueDateSource ?? "").trim();
  const idAfter = (prefix: string) => src.slice(prefix.length).split(/[:\s]/)[0];
  if (src.startsWith("deadline ")) {
    const d = snap.deadlines.find((x) => x.id === idAfter("deadline "));
    return !!d && d.date === a.dueDate;
  }
  if (src.startsWith("timeline event ")) {
    if (!snap.timelineAgreed) return false;
    const e = snap.timeline.find((x) => x.id === idAfter("timeline event "));
    return !!e && e.status !== "cancelled" && (e.date === a.dueDate || e.endDate === a.dueDate);
  }
  if (src.startsWith("engagement ")) {
    const text = snap.engagements[idAfter("engagement ")];
    const quote = src.match(/['"“‘](.+)['"”’]\s*$/s)?.[1];
    return !!text && !!quote?.trim() && squash(text).includes(squash(quote));
  }
  return false;
}

function dueOk(m: Match["dueDate"], a: SnapAction, snap: Snapshot): boolean {
  if (m === undefined) return true;
  switch (m) {
    case "none": return !a.dueDate;
    case "present": return !!a.dueDate;
    case "evidence-only": return dueEvidenced(a, snap);
    case "evidenced": return !!a.dueDate && dueEvidenced(a, snap);
    case "unevidenced": return !!a.dueDate && !dueEvidenced(a, snap);
    default: return a.dueDate === m;
  }
}

const lc = (s: string) => s.toLowerCase();
const hasWord = (hay: string, w: string) => !!w && lc(hay).split(/[^a-z0-9]+/).includes(lc(w));
/** An owner string names a person by full name, or by first name as a word ("Provider: Rowan"). */
const namesPerson = (owner: string, name: string) => lc(owner).includes(lc(name)) || hasWord(owner, name.trim().split(/\s+/)[0]);

/** Which side an owner string is on (case-insensitive): it names the provider firm or a provider-side person
 *  -> provider; it names the customer, a client-side person, or a generic client role ("Client: ...") ->
 *  client. Neither (e.g. "unassigned") or both: null. */
export function ownerSide(owner: string, p: Parties): "provider" | "client" | null {
  const o = owner.trim();
  const provider = lc(o).includes(lc(p.provider)) || p.people.some((x) => x.side === "provider" && namesPerson(o, x.name));
  const client = lc(o).includes(lc(p.customer)) || /^client\b/i.test(o) || p.people.some((x) => x.side === "client" && namesPerson(o, x.name));
  return provider && !client ? "provider" : client && !provider ? "client" : null;
}

/** match.owner: "provider" = any provider-side owner; the client company's name = any client-side owner;
 *  anything else (a person's full name) = the owner string contains it. All case-insensitive. */
export function ownerMatches(want: string, owner: string, p?: Parties): boolean {
  const w = want.trim();
  if (p && lc(w) === "provider") return ownerSide(owner, p) === "provider";
  if (p && lc(w) === lc(p.customer)) return ownerSide(owner, p) === "client";
  return lc(owner).includes(lc(w));
}

const isMoved = (e: SnapEvent) => e.status === "moved" || !!e.movedFrom || Object.values(e.occurrences ?? {}).some((o) => o.status === "moved");
function isSlipped(e: SnapEvent, kickoff: string): boolean {
  if (e.movedFrom && e.date > e.movedFrom) return true;
  if (Object.entries(e.occurrences ?? {}).some(([orig, o]) => o.status === "moved" && !!o.date && o.date > orig)) return true;
  if (e.offsetDays !== undefined && !e.recurring && kickoff) {
    const planned = new Date(Date.parse(`${kickoff}T00:00:00Z`) + e.offsetDays * 864e5).toISOString().slice(0, 10);
    if (e.date > planned) return true;
  }
  return false;
}

/** The entities of the snapshot this item's type is about, filtered by every constraint in `match`. */
export function findMatches(type: ExpectType, m: Match, snap: Snapshot): unknown[] {
  switch (type) {
    case "state":
      return snap.state.filter((s) => inAlts(s.scope, m.scope) && inAlts(s.kind, m.kind) && inAlts(s.category, m.category) && textAny(m.textAny, `${s.title}\n${s.detail ?? ""}`));
    case "action":
    case "priority":
    case "blocker":
      return snap.actions.filter((a) => {
        if (type === "blocker" && a.status !== "blocked") return false;
        if (!inAlts(a.status, m.status) || !inAlts(a.priority, m.priority)) return false;
        if (m.open !== undefined && (a.status !== "done") !== m.open) return false;
        if (m.owner && !ownerMatches(m.owner, a.owner, snap.parties)) return false;
        if (m.blockedReason === true && !a.blockedReason?.trim()) return false;
        if (m.blockedReason === false && a.blockedReason?.trim()) return false;
        if (typeof m.blockedReason === "string" && !termMatches(m.blockedReason, a.blockedReason ?? "")) return false;
        if (!dueOk(m.dueDate, a, snap)) return false;
        return textAny(m.textAny, `${a.task}\n${a.detail ?? ""}${type === "blocker" ? `\n${a.blockedReason ?? ""}` : ""}`);
      });
    case "deadline":
      return snap.deadlines.filter((d) => (!m.date || d.date === m.date) && textAny(m.textAny, `${d.what}\n${deadlineQuote(d) ?? ""}`));
    case "lesson":
      return snap.lessons.filter((l) => inAlts(l.route, m.route) && inAlts(l.status, m.status) && textAny(m.textAny, `${l.title}\n${l.detail ?? ""}`));
    case "timeline":
      return snap.timeline.filter(
        (e) =>
          inAlts(e.status, m.status) &&
          (!m.date || e.date === m.date) &&
          (m.moved === undefined || isMoved(e) === m.moved) &&
          (m.slipped === undefined || isSlipped(e, snap.kickoffDate) === m.slipped) &&
          textAny(m.textAny, `${e.title}\n${e.detail ?? ""}`)
      );
    case "proof":
      return snap.proofs.filter((p) => inAlts(p.verdict, m.verdict) && textAny(m.textAny, `${p.claim}\n${p.note ?? ""}`));
  }
}

/** expect: holds when the match count is within [minCount (default 1), maxCount]. forbid: hit when at least
 *  minCount (default 1) entities match. */
export function exactHolds(item: RubricItem, role: "expect" | "forbid", snap: Snapshot): { holds: boolean; matches: number } {
  const n = findMatches(item.type, item.match, snap).length;
  const min = item.match.minCount ?? 1;
  if (role === "forbid") return { holds: n >= Math.max(1, min), matches: n };
  return { holds: n >= min && (item.match.maxCount === undefined || n <= item.match.maxCount), matches: n };
}

// ---------------------------------------------------------------------------------------------------------
// Scores

/** Score every item of a checkpoint (expect: ok = passed; forbid: ok = HIT, i.e. the bad thing happened).
 *  Judge items run up to `concurrency` at a time (the judge itself bounds its retries); results keep the
 *  rubric's order. */
export async function scoreCheckpoint(cp: RubricCheckpoint, snap: Snapshot, judge: Judge, concurrency = 4): Promise<ItemResult[]> {
  const jobs: (() => Promise<ItemResult>)[] = [];
  for (const [role, items] of [["expect", cp.expect], ["forbid", cp.forbid]] as const)
    for (const item of items) {
      const base = { id: item.id, type: item.type, role, weight: item.weight, judge: item.judge };
      if (item.judge === "llm")
        jobs.push(async () => {
          try {
            const j = await judge(item, role, snap);
            return { ...base, ok: j.holds, reason: j.reason };
          } catch (e) {
            // A failed judge call says nothing about the SUT: the item is marked, and the checkpoint is invalid.
            const err = e instanceof Error ? e : new Error(String(e));
            return { ...base, ok: false, error: true, reason: `judge error: ${err.name}`, errorClass: err.name, errorMessage: err.message };
          }
        });
      else {
        const r = exactHolds(item, role, snap);
        jobs.push(async () => ({ ...base, ok: r.holds, matches: r.matches }));
      }
    }
  return pool(jobs, concurrency);
}

/** Run async jobs at most `n` at a time, results in job order. */
export async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, worker));
  return out;
}

/** Weighted pass rate, forbid hits subtracting: 100 * (passed - hit) / expected, clamped to 0-100. With
 *  only forbids: 100 * (1 - hit / forbidden). Nothing to score: null. */
export function weightedScore(results: Pick<ItemResult, "role" | "weight" | "ok">[]): number | null {
  const sum = (role: "expect" | "forbid", ok?: boolean) => results.filter((r) => r.role === role && (ok === undefined || r.ok === ok)).reduce((n, r) => n + r.weight, 0);
  const E = sum("expect"), P = sum("expect", true), F = sum("forbid"), H = sum("forbid", true);
  if (E > 0) return Math.min(100, Math.max(0, (100 * (P - H)) / E));
  if (F > 0) return 100 * (1 - H / F);
  return null;
}

export interface ScenarioScore {
  /** mean of the VALID checkpoint scores; null when no checkpoint is valid (nothing about the SUT was measured) */
  score: number | null;
  checkpoints: number[];
  byType: Partial<Record<ExpectType, number>>; // weighted score per type over the valid checkpoints
  judgeErrors: number;
  /** checkpoints excluded because the harness or the SUT's infrastructure failed (see the protocol's error kinds) */
  invalid: number;
}

/** A checkpoint is invalid when `invalid[i]` names a failure or any of its items is a judge error: it is
 *  excluded from the score and the subscores, never scored as the SUT getting it wrong. */
export function scenarioScore(perCheckpoint: ItemResult[][], invalid: (string | null | undefined)[] = []): ScenarioScore {
  const bad = perCheckpoint.map((r, i) => !!invalid[i] || r.some((x) => x.error));
  const valid = perCheckpoint.filter((_, i) => !bad[i]);
  const cps = valid.map((r) => weightedScore(r)).filter((s): s is number => s !== null);
  const all = valid.flat();
  const byType: Partial<Record<ExpectType, number>> = {};
  for (const t of new Set(all.map((r) => r.type))) {
    const s = weightedScore(all.filter((r) => r.type === t));
    if (s !== null) byType[t] = s;
  }
  return {
    score: cps.length ? cps.reduce((a, b) => a + b, 0) / cps.length : valid.length ? 0 : null,
    checkpoints: cps,
    byType,
    judgeErrors: perCheckpoint.flat().filter((r) => r.error).length,
    invalid: bad.filter(Boolean).length,
  };
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
