// The protocol client (src/sut.ts) and the replay over it (src/replay.ts): timeouts, error kinds -> invalid
// checkpoints, stray stdout ignored, the process group killed, engagement-id mapping for due-date evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SutClient, SutError, parseTimeouts, parseUsage } from "../src/sut.ts";
import { runScenario, engagementTexts, setupScenario } from "../src/replay.ts";
import { stubJudge } from "../src/judge.ts";
import { RubricSchema, ScenarioSchema } from "../src/types.ts";

const root = path.resolve(import.meta.dirname, "..");
const SCRIPTED = path.join(root, "test", "fixtures", "scripted-sut.mjs");
const TOY = path.join(root, "examples", "toy-sut", "adapter.mjs");
const ex = (id: string, f: string) => JSON.parse(fs.readFileSync(path.join(root, "examples", "scenarios", id, f), "utf8"));
const sc = ScenarioSchema.parse(ex("s-example-dev", "scenario.json"));
const rubric = RubricSchema.parse(ex("s-example-dev", "rubric.json"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fde-bench-sut-test-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const scripted = (mode: string, timeouts = {}) => new SutClient({ command: `node ${JSON.stringify(SCRIPTED)}`, env: { ...process.env, FAKE_MODE: mode }, timeouts });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("client: hello, ordered requests, ok:false -> SutError of the adapter's kind (unknown kind = sut)", async () => {
  const c = scripted("fail:setup:model,fail:ingest:bogus");
  try {
    const h = await c.hello();
    assert.deepEqual(h, { name: "scripted", version: "0", commit: "c0ffee", capabilities: ["state"] });
    await assert.rejects(c.request("setup", {}), (e) => e instanceof SutError && e.kind === "model" && !e.fatal && e.op === "setup");
    await assert.rejects(c.request("ingest", { engagement: { day: 1, text: "x" } }), (e) => e instanceof SutError && e.kind === "sut");
    // concurrent callers are serialized: both get their own answer
    const [a, b] = await Promise.all([c.request("checkpoint", { day: 1 }), c.request("snapshot")]);
    assert.equal(a.ok, true);
    assert.ok(b.snapshot);
  } finally {
    await c.close();
  }
});

test("client: a timeout is a fatal transport error, the adapter is killed and every later request fails at once", async () => {
  const c = scripted("hang:checkpoint", { checkpoint: 300 });
  await c.hello();
  const t0 = Date.now();
  await assert.rejects(c.request("checkpoint", { day: 1 }), (e) => e instanceof SutError && e.kind === "transport" && e.fatal && /timed out on checkpoint/.test(e.message));
  assert.ok(Date.now() - t0 < 5000);
  await assert.rejects(c.request("snapshot"), (e) => e instanceof SutError && e.fatal);
  await c.close();
});

test("client: the adapter exiting mid-request is a fatal transport error", async () => {
  const c = scripted("exit:checkpoint");
  await c.hello();
  await assert.rejects(c.request("checkpoint", { day: 1 }), (e) => e instanceof SutError && e.kind === "transport" && e.fatal && /exited \(code 3\)/.test(e.message));
  await c.close();
  const bad = new SutClient({ command: "exit 7" });
  await assert.rejects(bad.hello(), (e) => e instanceof SutError && e.fatal);
  await bad.close();
});

test("client: stray stdout lines (non-JSON, wrong id) are ignored and counted, never surfaced", async () => {
  const c = scripted("leak");
  try {
    await c.hello();
    await c.request("ingest", { engagement: { day: 1, text: "SECRET-ENGAGEMENT-TEXT" } });
    assert.ok(c.noiseLines >= 4, `noise ${c.noiseLines}`);
  } finally {
    await c.close();
  }
});

test("client: close kills the adapter's whole process group (a grandchild too)", async () => {
  const pidFile = path.join(tmp, "grandchild.pid");
  const c = scripted(`grandchild:${pidFile},hang:shutdown`, { shutdown: 200 });
  await c.hello();
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(alive(pid), "the grandchild runs");
  await c.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!alive(pid), "the grandchild was killed with the group");
});

test("timeouts spec, usage parsing", () => {
  assert.deepEqual(parseTimeouts("checkpoint=900, setup=60"), { checkpoint: 900_000, setup: 60_000 });
  assert.deepEqual(parseTimeouts(undefined), {});
  assert.throws(() => parseTimeouts("nope=1"));
  assert.throws(() => parseTimeouts("checkpoint=-1"));
  assert.deepEqual(parseUsage([{ model: "m", input: 10, output: 2 }, null, "x", { input: -3 }]), [{ model: "m", input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }, { model: "unknown", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]);
  assert.deepEqual(parseUsage(undefined), []);
});

test("setup sends the scenario without engagements, checkpoints or rubric, the provider filled in", () => {
  const s = setupScenario(sc) as Record<string, unknown>;
  assert.equal(s.engagements, undefined);
  assert.equal(s.checkpoints, undefined);
  assert.deepEqual(s.provider, { name: "Mavnox" });
  assert.equal(s.id, sc.id);
});

test("engagement texts: ids returned on ingest first, else matched by day, kind and (decorated) title", () => {
  const e = (day: number, title: string, text: string) => ({ day, kind: "email" as const, title, text });
  const sent = [{ e: e(1, "Re: access", "A") }, { e: e(1, "Re: access", "B") }, { e: e(2, "Price list", "C"), id: "x9" }];
  const map = engagementTexts(sent, [
    { id: "s1", day: 1, kind: "email", title: "Re: access (2027-02-02)" },
    { id: "s2", day: 1, kind: "email", title: "re: ACCESS" },
    { id: "x9", day: 2, kind: "email", title: "anything" },
    { id: "s4", day: 5, kind: "email", title: "Unknown" },
  ]);
  assert.deepEqual(map, { x9: "C", s1: "A", s2: "B" });
});

test("replay with the toy SUT: the public example scores as expected through the protocol", async () => {
  const c = new SutClient({ command: `node ${JSON.stringify(TOY)}` });
  try {
    const r = await runScenario(sc, rubric, { client: c, judge: stubJudge });
    assert.deepEqual(r.invalid, [null, null]);
    assert.equal(r.engagementsSent, 4);
    assert.equal(r.crashed, false);
    assert.ok(r.perCheckpoint.flat().every((x) => x.role === "forbid" ? !x.ok : x.ok), "toy SUT passes every item of the example");
  } finally {
    await c.close();
  }
});

/** Replay against the scripted adapter; returns the invalid causes per scored checkpoint (day 3, day 10). */
async function causes(mode: string, timeouts = {}) {
  const c = scripted(mode, timeouts);
  try {
    const r = await runScenario(sc, rubric, { client: c, judge: stubJudge });
    return { causes: r.invalidCause, r };
  } finally {
    await c.close();
  }
}

test("replay: error kinds map to invalid checkpoints per the protocol", async () => {
  assert.deepEqual((await causes("")).causes, [null, null], "a clean (empty) run is valid and scored");
  // ingest / checkpoint failures taint the next scored checkpoint only
  assert.deepEqual((await causes("fail:checkpoint:model:3")).causes, ["model", null]);
  assert.deepEqual((await causes("fail:checkpoint:transport:10")).causes, [null, "transport"]);
  assert.deepEqual((await causes("fail:ingest:sut:8")).causes, [null, "sut"]);
  // unsupported never invalidates; an unsupported snapshot is scored empty
  const u = await causes("fail:checkpoint:unsupported,fail:snapshot:unsupported");
  assert.deepEqual(u.causes, [null, null]);
  assert.equal(u.r.errors.unsupported, 4);
  // a snapshot error invalidates that checkpoint; a malformed snapshot is a sut failure
  assert.deepEqual((await causes("fail:snapshot:model")).causes, ["model", "model"]);
  assert.deepEqual((await causes("badsnap")).causes, ["sut", "sut"]);
  // setup failure, timeout or exit: that checkpoint and every later one
  const s = await causes("fail:setup:sut");
  assert.deepEqual(s.causes, ["crash", "crash"]);
  assert.equal(s.r.crashed, true);
  assert.deepEqual((await causes("hang:snapshot", { snapshot: 300 })).causes, ["crash", "crash"]);
  assert.deepEqual((await causes("exit:checkpoint")).causes, ["crash", "crash"]);
  // usage is collected per checkpoint
  assert.equal((await causes("usage")).r.usage.length, 2);
});

test("replay: a judge failure invalidates its checkpoint (and only it)", async () => {
  const c = new SutClient({ command: `node ${JSON.stringify(TOY)}` });
  try {
    const r = await runScenario(sc, rubric, { client: c, judge: async () => Promise.reject(new Error("529 overloaded")) });
    assert.deepEqual(r.invalidCause, [null, "judge"], "only day 10 has an llm item");
  } finally {
    await c.close();
  }
});

test("templates: the named project template is sent filled in; an unknown projectType makes every checkpoint invalid", async () => {
  const { templateFor } = await import("../src/templates.ts");
  const t = templateFor("6-week project", { provider: "Brightlane", customer: "Acme Widgets" }) as any;
  assert.equal(t.name, "6-week project");
  assert.equal(t._about, undefined);
  assert.ok(t.defaultActions.some((a: any) => a.owner === "Brightlane: lead" && /kickoff call/.test(a.task)));
  assert.ok(t.defaultActions.some((a: any) => a.owner === "Acme Widgets: IT lead"));
  assert.ok(t.timelineEvents.length > 30 && !JSON.stringify(t).includes("{provider}"));
  assert.equal(templateFor("none", { provider: "p", customer: "c" }), null);
  assert.throws(() => templateFor("12-week", { provider: "p", customer: "c" }), /unknown projectType/);
  const c = new SutClient({ command: `node ${JSON.stringify(TOY)}` });
  try {
    const r = await runScenario({ ...sc, project: { ...sc.project, projectType: "no-such-type" } }, rubric, { client: c, judge: stubJudge });
    assert.equal(r.crashed, true);
    assert.deepEqual(r.invalid, rubric.checkpoints.map(() => "runner exception"));
  } finally {
    await c.close();
  }
});
