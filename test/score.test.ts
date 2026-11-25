// Scoring (src/score.ts, src/types.ts, src/cost.ts): the matchers, weights and invalid handling, ported
// from the harness FDE-bench was extracted from with the protocol's field names. Pure: no SUT, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as score from "../src/score.ts";
import { RubricSchema, ScenarioSchema, SnapshotSchema, kickoffFor, pipelineDays } from "../src/types.ts";
import { estimateScenario, priceOf } from "../src/cost.ts";

const root = path.resolve(import.meta.dirname, "..");
const EX = path.join(root, "examples");
const scen = (id: string) => JSON.parse(fs.readFileSync(path.join(EX, "scenarios", id, "scenario.json"), "utf8"));
const rub = (id: string) => JSON.parse(fs.readFileSync(path.join(EX, "scenarios", id, "rubric.json"), "utf8"));

type Snapshot = score.Snapshot;
export function snap(over: Partial<Snapshot> = {}): Snapshot {
  return { day: 10, today: "2027-01-14", kickoffDate: "2027-01-04", state: [], actions: [], deadlines: [], lessons: [], timelineAgreed: false, timeline: [], proofs: [], integrations: [], engagements: {}, ...over };
}
const action = (o: Record<string, unknown> = {}) => ({ id: "a1", task: "Send the spec", owner: "Mavnox: Rowan", status: "todo", goalIds: ["g1"], dependsOn: [], ...o }) as any;
const st = (o: Record<string, unknown>) => ({ sources: [], ...o }) as any;
const item = (type: string, match: Record<string, unknown>, extra: Record<string, unknown> = {}) => RubricSchema.parse({ checkpoints: [{ afterDay: 1, expect: [{ id: "x", type, description: "d", match, ...extra }] }] }).checkpoints[0].expect[0];
const holds = (type: string, match: Record<string, unknown>, s: Snapshot, role: "expect" | "forbid" = "expect") => score.exactHolds(item(type, match), role, s).holds;

test("textAny: case-insensitive substring (whitespace squashed) or /regex/", () => {
  assert.ok(score.termMatches("waiting ON the", "We are Waiting on   the warehouse"));
  assert.ok(score.termMatches("/ware.*cred/", "warehouse credentials"));
  assert.ok(!score.termMatches("/^cred/", "warehouse credentials"));
  assert.ok(!score.termMatches("/(bad/", "anything")); // a broken regex matches nothing, never throws
  assert.ok(score.textAny(undefined, "x") && score.textAny([], "x"));
});

test("state matcher: kind, category, scope (alternatives with |), text over title + detail", () => {
  const s = snap({ state: [st({ scope: "project", id: "s1", category: "interaction", kind: "current", title: "Catalog access", detail: "Waiting on the warehouse team" }), st({ scope: "customer", id: "s2", category: "entity", kind: "goal", title: "Buyers self-serve" })] });
  assert.ok(holds("state", { kind: "current", textAny: ["warehouse"] }, s));
  assert.ok(!holds("state", { kind: "goal", textAny: ["warehouse"] }, s));
  assert.ok(holds("state", { kind: "current|goal", category: "entity", scope: "customer" }, s));
  assert.ok(!holds("state", { scope: ["provider"] }, s));
});

test("action matchers: owner contains, priority, status, open, blockedReason, minCount/maxCount", () => {
  const s = snap({ actions: [action(), action({ id: "a2", task: "Get credentials", owner: "Quill: Dana", status: "blocked", priority: "P0", blockedReason: "warehouse team" }), action({ id: "a3", status: "done", priority: "P2" })] });
  assert.ok(holds("action", { owner: "dana", priority: "P0|P1" }, s));
  assert.ok(!holds("action", { owner: "dana", priority: "P2" }, s));
  assert.ok(holds("action", { status: "blocked", blockedReason: true }, s));
  assert.ok(holds("action", { blockedReason: "/warehouse/" }, s));
  assert.ok(!holds("action", { status: "todo", blockedReason: true }, s));
  assert.equal(score.exactHolds(item("action", { open: true }), "expect", s).matches, 2);
  assert.ok(!holds("action", { open: true, maxCount: 1 }, s)); // near-duplicates can be forbidden by count
  assert.ok(holds("action", { open: true, minCount: 2, maxCount: 2 }, s));
  assert.ok(holds("blocker", { textAny: ["warehouse"] }, s)); // blocker = a blocked action; text includes its reason
  assert.ok(!holds("blocker", { textAny: ["spec"] }, s));
});

test("due dates: evidence-only / evidenced / unevidenced / none / present / exact", () => {
  const deadlines = [{ id: "d1", what: "Pilot live", date: "2027-01-29", sources: ["e1"] }] as any;
  const timeline = [{ id: "t1", title: "UAT", kind: "deliverable", date: "2027-01-25", status: "planned", recurring: false }] as any;
  const engagements = { e1: "Dana: The pilot must be live by Jan 29 for the spring catalog." };
  const ok = (dueDate?: string, dueDateSource?: string, agreed = true) => score.dueEvidenced({ dueDate, dueDateSource }, { deadlines, timeline, timelineAgreed: agreed, engagements });
  assert.ok(ok(undefined, undefined), "no date needs no evidence");
  assert.ok(ok("2027-01-29", "deadline d1: Pilot live 2027-01-29"));
  assert.ok(!ok("2027-01-30", "deadline d1: Pilot live 2027-01-29"), "a deadline's date must match");
  assert.ok(!ok("2027-01-29", "deadline d9: unknown"), "an unknown deadline is no evidence");
  assert.ok(ok("2027-01-25", "timeline event t1: UAT 2027-01-25"));
  assert.ok(!ok("2027-01-25", "timeline event t1: UAT 2027-01-25", false), "a draft timeline dates nothing");
  assert.ok(ok("2027-01-29", "engagement e1: 'must be live by Jan 29'"));
  assert.ok(!ok("2027-01-29", "engagement e1: 'live by Feb 1'"), "the quote must be in the engagement");
  assert.ok(!ok("2027-01-29", "the client said so"), "free text is no evidence");
  const s = snap({ deadlines, timeline, timelineAgreed: true, engagements, actions: [action({ dueDate: "2027-01-29", dueDateSource: "deadline d1: Pilot live 2027-01-29" }), action({ id: "a2", task: "Book demo", dueDate: "2027-01-20", dueDateSource: "planner guess" }), action({ id: "a3", task: "Undated" })] });
  assert.equal(score.exactHolds(item("action", { dueDate: "evidence-only" }), "expect", s).matches, 2);
  assert.equal(score.exactHolds(item("action", { dueDate: "evidenced" }), "expect", s).matches, 1);
  assert.equal(score.exactHolds(item("action", { dueDate: "unevidenced" }), "expect", s).matches, 1);
  assert.equal(score.exactHolds(item("action", { dueDate: "none" }), "expect", s).matches, 1);
  assert.equal(score.exactHolds(item("action", { dueDate: "present" }), "expect", s).matches, 2);
  assert.equal(score.exactHolds(item("action", { dueDate: "2027-01-20" }), "expect", s).matches, 1);
  assert.ok(holds("action", { dueDate: "unevidenced" }, s, "forbid"), "a forbid hits on an unevidenced date");
});

test("deadline, lesson, timeline (moved / slipped) and proof matchers", () => {
  const s = snap({
    deadlines: [{ id: "d1", what: "Pilot live", date: "2027-01-29", quote: "must be live by 2027-01-29", sources: [] }] as any,
    lessons: [{ id: "l1", title: "Price list showed retail prices", route: "repo-check", status: "captured" }] as any,
    timeline: [
      { id: "t1", title: "Access live", kind: "deadline", date: "2027-01-08", movedFrom: "2027-01-07", status: "planned", offsetDays: 3, recurring: false },
      { id: "t2", title: "Kickoff call", kind: "meeting", date: "2027-01-04", status: "done", offsetDays: 0, recurring: false },
      { id: "t3", title: "Weekly check-in", kind: "meeting", date: "2027-01-14", status: "planned", recurring: true, occurrences: { "2027-01-21": { status: "moved", date: "2027-01-22" } } },
    ] as any,
    proofs: [{ id: "p1", claim: "Buyers see wholesale prices", verdict: "VERIFIED" }] as any,
  });
  assert.ok(holds("deadline", { date: "2027-01-29", textAny: ["live"] }, s));
  assert.ok(holds("deadline", { textAny: ["must be live"] }, s), "deadline text = what + quote");
  assert.ok(!holds("deadline", { date: "2027-01-30" }, s));
  assert.ok(holds("lesson", { route: "repo-check|feature-gotcha", status: "captured", textAny: ["retail"] }, s));
  assert.ok(!holds("lesson", { route: "one-off" }, s));
  assert.equal(score.exactHolds(item("timeline", { moved: true }), "expect", s).matches, 2);
  assert.equal(score.exactHolds(item("timeline", { slipped: true }), "expect", s).matches, 2);
  assert.ok(holds("timeline", { slipped: false, textAny: ["kickoff"] }, s));
  assert.ok(holds("proof", { verdict: "VERIFIED", textAny: ["wholesale"] }, s));
  // a deadline's `source` (the protocol's older name for the quote) counts as its quote
  assert.ok(holds("deadline", { textAny: ["spring catalog"] }, snap({ deadlines: [{ id: "d", what: "Pilot", date: "2027-01-29", source: "for the spring catalog", sources: [] }] as any })));
});

test("weights, forbid subtraction, clamping, per-type subscores, scenario mean", async () => {
  const r = (role: "expect" | "forbid", ok: boolean, weight = 1, type = "state") => ({ id: "x", type, role, weight, judge: "exact", ok }) as any;
  assert.equal(score.weightedScore([r("expect", true, 3), r("expect", false, 1)]), 75);
  assert.equal(score.weightedScore([r("expect", true, 3), r("expect", false, 1), r("forbid", true, 1)]), 50, "a forbid hit subtracts its weight");
  assert.equal(score.weightedScore([r("expect", false), r("forbid", true, 5)]), 0, "clamped at 0");
  assert.equal(score.weightedScore([r("forbid", false), r("forbid", true)]), 50, "forbids only: 1 - hit share");
  assert.equal(score.weightedScore([]), null);
  const sc = score.scenarioScore([[r("expect", true), r("expect", false, 1, "action")], [r("expect", true, 1, "action")]]);
  assert.equal(sc.score, 75); // mean(50, 100)
  assert.deepEqual(sc.byType, { state: 100, action: 50 });
  // judge items go to the judge; a judge error fails an expect and never counts as a forbid hit
  const cp = RubricSchema.parse({ checkpoints: [{ afterDay: 1, expect: [{ id: "j", type: "state", description: "d", judge: "llm" }], forbid: [{ id: "k", type: "state", description: "d", judge: "llm" }] }] }).checkpoints[0];
  const bad = await score.scoreCheckpoint(cp, snap(), async () => { throw new Error("boom"); });
  assert.deepEqual(bad.map((x) => [x.role, x.ok, x.error]), [["expect", false, true], ["forbid", false, true]]);
  const good = await score.scoreCheckpoint(cp, snap(), async () => ({ holds: true, reason: "r" }));
  assert.deepEqual(good.map((x) => [x.role, x.ok]), [["expect", true], ["forbid", true]]);
});

test("rubric and scenario schemas are strict (a typo fails loudly) and fill defaults", () => {
  assert.throws(() => item("action", { ownr: "x" }));
  assert.throws(() => RubricSchema.parse({ checkpoints: [{ afterDay: 1, expect: [{ id: "x", type: "nope", description: "d" }] }] }));
  const it = item("state", {});
  assert.equal(it.weight, 1);
  assert.equal(it.judge, "exact");
  const sc = ScenarioSchema.parse(scen("s-example-dev"));
  assert.equal(sc.project.timelineAgreed, false);
  assert.equal(sc.kickoffDate, "2027-02-01");
  assert.equal(sc.provider, undefined, "provider is optional (the runner defaults it)");
  const none = ScenarioSchema.parse({ ...scen("s-example-dev"), project: { code: "X", name: "No type", projectType: "none", kickoffOffsetDays: 0, durationWeeks: null } });
  assert.equal(none.project.durationWeeks, null, "durationWeeks may be null (projectType none)");
});

test("protocol snapshot schema: missing arrays are empty, nulls are absent, unknown keys dropped, wrong shapes fail", () => {
  const s = SnapshotSchema.parse({ state: [{ id: "s1", scope: "project", category: "entity", kind: "current", title: "T", detail: null, extra: 1 }], actions: [{ id: "a1", task: "Do", owner: "x", status: "todo", dueDate: null }] });
  assert.deepEqual(s.state[0], { id: "s1", scope: "project", category: "entity", kind: "current", title: "T", detail: undefined, sources: [] });
  assert.equal(s.actions[0].dueDate, undefined);
  assert.deepEqual(s.actions[0].goalIds, []);
  assert.deepEqual([s.deadlines, s.lessons, s.timeline, s.proofs, s.integrations, s.engagements], [[], [], [], [], [], []]);
  assert.equal(s.timelineAgreed, false);
  assert.equal(SnapshotSchema.safeParse({ state: "nope" }).success, false);
  assert.equal(SnapshotSchema.safeParse({ state: [{ id: "s", scope: "galaxy", title: "x" }] }).success, false);
});

test("owner matching: a person's full name, the client company (any client-side owner), provider (any provider-side owner)", () => {
  const parties = { provider: "Mavnox", customer: "Quillfeather Bakery Supply", people: [{ name: "Dana Thistlewood", side: "client" as const }, { name: "Rowan Pike", side: "provider" as const }] };
  const s = (owner: string) => snap({ parties, actions: [action({ owner })] });
  const own = (want: string, owner: string) => holds("action", { owner: want }, s(owner));
  assert.ok(own("Dana Thistlewood", "Quillfeather: dana thistlewood"));
  assert.ok(!own("Dana Thistlewood", "Quillfeather: Dana"), "a full name needs the full name");
  assert.ok(own("provider", "Mavnox: lead"));
  assert.ok(own("PROVIDER", "mavnox: lead"));
  assert.ok(own("provider", "Brightlane: Rowan Pike"), "a provider-side person counts, whatever firm name the model wrote");
  assert.ok(own("provider", "Rowan"), "by first name too");
  assert.ok(!own("provider", "Quillfeather Bakery Supply: IT lead"));
  assert.ok(!own("provider", "unassigned"));
  assert.ok(own("Quillfeather Bakery Supply", "Quillfeather Bakery Supply: IT lead"));
  assert.ok(own("quillfeather bakery supply", "Client: sponsor"));
  assert.ok(own("Quillfeather Bakery Supply", "QBS: Dana Thistlewood"));
  assert.ok(own("Quillfeather Bakery Supply", "Dana"), "a client-side person by first name");
  assert.ok(!own("Quillfeather Bakery Supply", "Mavnox: Rowan"));
  assert.ok(!own("Quillfeather Bakery Supply", "unassigned"));
  assert.equal(score.ownerSide("Mavnox: Dana", parties), null, "both sides named: neither");
});

test("invalid checkpoints are excluded from the score and subscores; all invalid = no score", () => {
  const r = (role: "expect" | "forbid", ok: boolean, o: Record<string, unknown> = {}) => ({ id: "x", type: "state", role, weight: 1, judge: "exact", ok, ...o }) as any;
  const cps = [[r("expect", true)], [r("expect", false, { type: "action" })], [r("expect", false, { judge: "llm", error: true })]];
  const s = score.scenarioScore(cps, [null, "runner exception", null]);
  assert.equal(s.score, 100, "only the first checkpoint is valid");
  assert.equal(s.invalid, 2);
  assert.deepEqual(s.byType, { state: 100 }, "an invalid checkpoint's items don't reach the subscores");
  assert.equal(s.judgeErrors, 1);
  assert.equal(score.scenarioScore([[r("expect", false)]], ["model failures"]).score, null);
  assert.equal(score.scenarioScore([[r("expect", false)]]).score, 0, "a valid failing checkpoint still scores 0");
});

test("clock + cost model: kickoff Monday, pipeline days, estimate, pricing", () => {
  assert.equal(kickoffFor({ project: { kickoffOffsetDays: 0 } } as any), "2027-01-04");
  assert.equal(kickoffFor({ project: { kickoffOffsetDays: 2 } } as any), "2027-01-11", "snapped to the next Monday");
  assert.equal(kickoffFor({ project: { kickoffOffsetDays: 0, kickoffDate: "2027-03-01" } } as any), "2027-03-01");
  assert.equal(kickoffFor({ kickoffDate: "2027-02-01", project: { kickoffOffsetDays: 5, kickoffDate: "2027-03-01" } } as any), "2027-02-01", "the top-level kickoffDate is day 0");
  const sc = ScenarioSchema.parse(scen("s-example-dev"));
  const rubric = RubricSchema.parse(rub("s-example-dev"));
  assert.deepEqual(pipelineDays(sc, rubric), [3, 10]);
  assert.deepEqual(pipelineDays({ checkpoints: [5, 1] }, { checkpoints: [{ afterDay: 3 }, { afterDay: 5 }] } as any), [1, 3, 5]);
  const e = estimateScenario(sc, rubric);
  assert.deepEqual(e.calls, { read: 2, plan: 2, judge: 1 });
  assert.ok(e.usd > 0.3 && e.usd < 2, `estimate ${e.usd}`);
  assert.equal(priceOf({ model: "claude-opus-5-5", input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }), 24);
  assert.equal(priceOf({ model: "claude-opus-5-5-20270101", input: 1e6, output: 0, cacheRead: 1e6, cacheWrite: 1e6 }), 4 + 0.2 + 5, "dated ids, cache prices");
  assert.equal(priceOf({ model: "some-other-model", input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }), 4, "unknown models at the default rates");
  assert.equal(priceOf({ model: "x", input: -5, output: NaN as any, cacheRead: 0, cacheWrite: 0 }), 0, "garbage usage counts as nothing");
});
