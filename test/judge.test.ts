// The judge (src/judge.ts): the rendering and the stub judge are byte-identical to the harness FDE-bench was
// extracted from (test/fixtures/oldo-judge-golden.json was produced by that harness's renderForJudge /
// stubJudge on the snapshot below, in its own field names), robust calls, and the key guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderForJudge, judgePrompt, stubJudge, withRetries, robustJudgeCall, isTransient, judgeKey, KeyRefusal } from "../src/judge.ts";
import { RubricSchema, SnapshotSchema } from "../src/types.ts";
import type { Snapshot } from "../src/score.ts";

const golden = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "oldo-judge-golden.json"), "utf8"));

/** The golden's snapshot (old field names) in the protocol's shape, as an adapter would map it. */
function goldenSnap(o: { noTimeline?: boolean; noParties?: boolean } = {}): Snapshot {
  const old = {
    state: [
      { scope: "project", stateId: "s1", category: "interaction", stateKind: "current", title: "Blocked: waiting on the warehouse team", sourceEngagementIds: ["e1"] },
      { scope: "project", stateId: "s2", category: "entity", stateKind: "goal", title: "Pilot live", detail: "Buyers self-serve\nwholesale prices " + "x".repeat(450) },
      { scope: "customer", stateId: "s3", category: "entity", stateKind: "current", title: "Runs a marzipan ledger" },
      { scope: "provider", stateId: "s4", category: "entity", stateKind: "current", title: "Team: Rowan Pike" },
    ],
    actions: [
      { actionId: "a1", task: "Run the kickoff call", owner: "Mavnox: lead", status: "done", priority: "P1", goalStateIds: ["g1"], dependsOn: [] },
      { actionId: "a2", task: "Unblock: warehouse credentials", owner: "Quillfeather: Dana", status: "blocked", blockedReason: "warehouse team", goalStateIds: ["g1"], dependsOn: ["a1"], detail: "chase Thursday" },
      { actionId: "a3", task: "Meet deadline: pilot live", owner: "unassigned", status: "todo", dueDate: "2027-02-26", dueDateSource: "deadline d1: pilot live 2027-02-26", goalStateIds: ["g1"], dependsOn: [] },
    ],
    deadlines: [{ deadlineId: "d1", what: "Pilot live", date: "2027-02-26", quote: "The pilot must be live by 2027-02-26", sourceEngagementIds: ["e2"] }, { deadlineId: "d2", what: "No quote", date: "2027-03-01", sourceEngagementIds: [] }],
    lessons: [{ lessonId: "l1", title: "Client correction: price list is wrong", detail: "retail vs wholesale", route: "repo-check", status: "captured" }],
    timeline: { agreed: true, events: [{ eventId: "t1", title: "Kickoff call", kind: "meeting", date: "2027-02-01", status: "done" }, { eventId: "t2", title: "UAT", kind: "deliverable", date: "2027-02-22", endDate: "2027-02-26", status: "moved", movedFrom: "2027-02-19" }] },
    proofs: [{ proofId: "p1", claim: "Buyers see wholesale prices", verdict: "VERIFIED" }],
  };
  const { parties: _p, ...p } = SnapshotSchema.parse({
    state: old.state.map(({ stateId, stateKind, sourceEngagementIds, ...r }) => ({ ...r, id: stateId, kind: stateKind, sources: sourceEngagementIds })),
    actions: old.actions.map(({ actionId, goalStateIds, ...r }) => ({ ...r, id: actionId, goalIds: goalStateIds })),
    deadlines: old.deadlines.map(({ deadlineId, sourceEngagementIds, ...r }) => ({ ...r, id: deadlineId, sources: sourceEngagementIds })),
    lessons: old.lessons.map(({ lessonId, ...r }) => ({ ...r, id: lessonId })),
    timelineAgreed: o.noTimeline ? false : old.timeline.agreed,
    timeline: o.noTimeline ? [] : old.timeline.events.map(({ eventId, ...r }) => ({ ...r, id: eventId })),
    proofs: old.proofs.map(({ proofId, ...r }) => ({ ...r, id: proofId })),
  });
  return {
    ...p,
    day: 10,
    today: "2027-02-11",
    kickoffDate: "2027-02-01",
    engagements: {},
    ...(!o.noParties && { parties: { provider: "Mavnox", customer: "Quillfeather Bakery Supply", people: [{ name: "Dana Thistlewood", side: "client" as const }, { name: "Rowan Pike", side: "provider" as const }] } }),
  };
}

test("renderForJudge is byte-identical to the original harness for every type (and a draft, empty timeline)", () => {
  const s = goldenSnap();
  for (const [type, want] of Object.entries(golden.render)) assert.equal(renderForJudge(type as any, s), want, type);
  assert.equal(renderForJudge("timeline", goldenSnap({ noTimeline: true, noParties: true })), golden.draftTimeline);
});

test("the stub judge decides exactly as the original harness's stub judge (reproducible stub scores)", async () => {
  const s = goldenSnap();
  assert.ok(golden.stub.length > 100);
  for (const g of golden.stub) {
    const it = RubricSchema.parse({ checkpoints: [{ afterDay: 1, expect: [{ id: "x", type: g.type, description: "d", judge: "llm", match: g.textAny.length ? { textAny: g.textAny } : {} }] }] }).checkpoints[0].expect[0];
    assert.equal((await stubJudge(it, "expect", s)).holds, g.holds, `${g.type} ${JSON.stringify(g.textAny)}`);
    assert.equal((await stubJudge(it, "forbid", s)).holds, g.holds, "role doesn't change the stub's decision");
  }
});

test("judge prompt: the statement, its role and the rendering (the system named generically)", () => {
  const s = goldenSnap();
  const it = RubricSchema.parse({ checkpoints: [{ afterDay: 1, expect: [{ id: "x", type: "lesson", description: "The lesson holds", judge: "llm" }] }] }).checkpoints[0].expect[0];
  const p = judgePrompt(it, "expect", s);
  assert.equal(p, golden.prompt.expect.replace("OLDO RECORDS:", "SUT RECORDS:"), "same prompt, the records header renamed");
  assert.match(judgePrompt(it, "forbid", s), /must NOT happen; holds = it happened/);
  assert.match(p, /LESSONS:\n- \[l1\]/);
  assert.doesNotMatch(renderForJudge("lesson", s), /ACTIONS:/);
});

test("isTransient: rate limits, overload, 5xx, timeouts are harness-side; request errors are not", () => {
  assert.ok(isTransient({ status: 429 }) && isTransient({ status: 529 }) && isTransient({ status: 503 }) && isTransient({ status: 408 }));
  assert.ok(!isTransient({ status: 400 }) && !isTransient({ status: 401 }) && !isTransient(new Error("judge refused")));
  assert.ok(isTransient({ name: "APIConnectionTimeoutError", message: "Request timed out." }));
  assert.ok(isTransient(new Error("Overloaded")) && isTransient(new Error("judge: no parsed output (stop_reason max_tokens)")));
});

test("withRetries: backoff on 429/529/overloaded up to the cap, Retry-After honoured, permanent errors not retried; concurrency capped", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  let n = 0;
  const flaky = async () => {
    n++;
    if (n === 1) throw Object.assign(new Error("rate"), { status: 429, headers: { "retry-after": "3" } });
    if (n < 4) throw Object.assign(new Error("overloaded"), { status: 529 });
    return "ok";
  };
  assert.equal(await withRetries(flaky, { attempts: 6, baseMs: 100, maxMs: 1000, sleep }), "ok");
  assert.equal(n, 4);
  assert.equal(waits[0], 1000, "Retry-After 3s, capped at maxMs");
  assert.ok(waits[1] >= 100 && waits[1] <= 200 && waits[2] >= 200 && waits[2] <= 400, `exponential with jitter: ${waits}`);
  let m = 0;
  await assert.rejects(withRetries(async () => { m++; throw Object.assign(new Error("overloaded"), { status: 529 }); }, { attempts: 3, baseMs: 1, maxMs: 1, sleep }), /overloaded/);
  assert.equal(m, 3);
  let p = 0;
  await assert.rejects(withRetries(async () => { p++; throw Object.assign(new Error("bad request"), { status: 400 }); }, { attempts: 5, baseMs: 1, maxMs: 1, sleep }), /bad request/);
  assert.equal(p, 1, "a 400 is not retried");
  let active = 0, peak = 0, calls = 0;
  const call = robustJudgeCall(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (++calls % 3 === 1) throw Object.assign(new Error("overloaded"), { status: 529 });
    return { holds: true, reason: "r" };
  }, { concurrency: 2, baseMs: 1, maxMs: 2, sleep: async () => {} });
  const out = await Promise.all(Array.from({ length: 6 }, () => call("m", "s", "p")));
  assert.ok(out.every((x) => x.holds));
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
});

test("judge key: ANTHROPIC_API_KEY first; a secret needs its guards to pass; no key is a refusal (no AWS call made)", async () => {
  assert.equal(await judgeKey({ ANTHROPIC_API_KEY: "k1", FDE_JUDGE_SECRET: "s" }), "k1");
  await assert.rejects(judgeKey({}), (e) => e instanceof KeyRefusal && /ANTHROPIC_API_KEY/.test(e.message));
  await assert.rejects(judgeKey({ FDE_JUDGE_SECRET: "s", FDE_JUDGE_AWS_PROFILE: "evals", AWS_PROFILE: "other" }), /AWS_PROFILE must be "evals"/);
  await assert.rejects(judgeKey({ FDE_JUDGE_SECRET: "s", FDE_JUDGE_AWS_PROFILE: "evals", AWS_PROFILE: "evals", AWS_ACCESS_KEY_ID: "AKIAX" }), /AWS_ACCESS_KEY_ID is set/);
});
