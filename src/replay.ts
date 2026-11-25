// One scenario run against a SUT adapter (docs/sut-protocol.md): setup a fresh world, ingest engagements in
// day order on the simulated clock, a `checkpoint` (the SUT's own pipeline) on every pipeline day, and on
// every rubric checkpoint day a `snapshot` scored against the rubric.
//
// Invalid checkpoints (excluded from the score, never scored as the SUT getting it wrong):
//   - a transport / model / sut error on ingest or checkpoint since the previous scored checkpoint;
//   - a transport / model / sut error on the snapshot itself, or a snapshot that fails validation (sut);
//   - a judge call that failed after its retries;
//   - the adapter is gone (timeout, exit) or setup failed: that checkpoint and every later one.
// `unsupported` never invalidates: the capability isn't there, so its expectations score as failed (an
// unsupported snapshot is scored as an empty one).
import { scoreCheckpoint, type ItemResult, type Judge, type Snapshot } from "./score.ts";
import { SutError, parseUsage, type ErrorKind, type SutClient } from "./sut.ts";
import { PROVIDER_NAME, SnapshotSchema, addDays, kickoffFor, pipelineDays, type Engagement, type ProtocolSnapshot, type Rubric, type Scenario } from "./types.ts";
import type { Usage } from "./cost.ts";
import { templateFor } from "./templates.ts";

/** One failure the run saw, for --errors (the runner redacts the message before printing it). */
export interface RunError { where: "setup" | "ingest" | "checkpoint" | "snapshot" | "judge" | "crash"; kind: ErrorKind | "judge" | "harness"; day: number; message: string; className?: string }
export type ErrorSink = (e: RunError) => void;

export type InvalidCause = "transport" | "model" | "sut" | "judge" | "crash";

export interface ScenarioRun {
  /** in the order the checkpoints were scored (day order; ties in rubric order) */
  perCheckpoint: ItemResult[][];
  /** the rubric checkpoint each entry of perCheckpoint scores (index into rubric.checkpoints) */
  checkpointIndex: number[];
  /** per entry of perCheckpoint: why it can't be scored, else null */
  invalid: (string | null)[];
  invalidCause: (InvalidCause | null)[];
  /** adapter error answers by kind (all requests) */
  errors: Record<ErrorKind, number>;
  warnings: number;
  usage: Usage[];
  engagementsSent: number;
  /** the adapter went away or setup failed (that checkpoint and every later one are invalid) */
  crashed: boolean;
}

/** The scenario as `setup` sends it: minus engagements and checkpoints, the provider filled in. */
export function setupScenario(sc: Scenario) {
  const { engagements: _e, checkpoints: _c, ...rest } = sc;
  return { ...rest, provider: rest.provider ?? { name: PROVIDER_NAME } };
}

/** SUT engagement id -> the text FDE-bench sent: ids the adapter returned on ingest first, then each
 *  snapshot engagement matched to a sent one by day, kind and title (the SUT may decorate the title). */
export function engagementTexts(sent: { e: Engagement; id?: string }[], listed: ProtocolSnapshot["engagements"]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<number>();
  sent.forEach((s, i) => {
    if (s.id) {
      out[s.id] = s.e.text;
      used.add(i);
    }
  });
  for (const l of listed) {
    if (l.id in out) continue;
    const t = l.title.trim().toLowerCase();
    const i = sent.findIndex(({ e }, k) => {
      if (used.has(k)) return false;
      if (l.day !== undefined && l.day !== null && l.day !== e.day) return false;
      if (l.kind && l.kind !== e.kind) return false;
      const et = e.title.trim().toLowerCase();
      return t === et || t.startsWith(et) || (t.length > 0 && et.startsWith(t));
    });
    if (i >= 0) {
      used.add(i);
      out[l.id] = sent[i].e.text;
    }
  }
  return out;
}

export async function runScenario(sc: Scenario, rubric: Rubric, o: { client: SutClient; judge: Judge; onError?: ErrorSink }): Promise<ScenarioRun> {
  const onError = o.onError ?? (() => {});
  const run: ScenarioRun = { perCheckpoint: [], checkpointIndex: [], invalid: [], invalidCause: [], errors: { transport: 0, model: 0, sut: 0, unsupported: 0 }, warnings: 0, usage: [], engagementsSent: 0, crashed: false };
  const kickoff = kickoffFor(sc);
  const parties = { provider: (sc.provider ?? { name: PROVIDER_NAME }).name, customer: sc.customer.name, people: sc.people.map((p) => ({ name: p.name, side: p.side })) };
  let current = 0;
  /** non-fatal failures since the last scored checkpoint (they make it invalid) */
  let taint: ErrorKind | null = null;
  const rank: Record<string, number> = { sut: 1, model: 2, transport: 3 };
  const note = (where: RunError["where"], e: SutError) => {
    run.errors[e.kind]++;
    onError({ where, kind: e.kind, day: current, message: e.message, className: e.name });
    if (e.kind !== "unsupported" && (!taint || rank[e.kind] > rank[taint])) taint = e.kind;
  };
  /** Run one request; a non-fatal adapter error is noted and returns null; a fatal one throws. */
  const ask = async (where: RunError["where"], op: Parameters<SutClient["request"]>[0], fields: Record<string, unknown>) => {
    try {
      return await o.client.request(op, fields);
    } catch (e) {
      if (!(e instanceof SutError) || e.fatal) throw e;
      note(where, e);
      return null;
    }
  };

  const sent: { e: Engagement; id?: string }[] = [];
  try {
    try {
      const template = templateFor(sc.project.projectType, parties);
      await o.client.request("setup", { scenario: setupScenario(sc), kickoffDate: kickoff, ...(template && { template }) });
    } catch (e) {
      if (e instanceof SutError) {
        run.errors[e.kind]++;
        onError({ where: "setup", kind: e.kind, day: 0, message: e.message, className: e.name });
        throw Object.assign(new Error("setup failed"), { cause: e, noted: true });
      }
      throw e;
    }
    const pending = [...sc.engagements].sort((a, b) => a.day - b.day);
    for (const day of pipelineDays(sc, rubric)) {
      current = day;
      while (pending.length && pending[0].day <= day) {
        const e = pending.shift()!;
        const r = await ask("ingest", "ingest", { engagement: { day: e.day, kind: e.kind, title: e.title, text: e.text, ...(e.sourceUrl && { sourceUrl: e.sourceUrl }) }, at: addDays(kickoff, e.day) });
        sent.push({ e, ...(r && typeof r.engagementId === "string" && r.engagementId && { id: r.engagementId }) });
        run.engagementsSent++;
      }
      const cp = await ask("checkpoint", "checkpoint", { day, today: addDays(kickoff, day) });
      if (cp) {
        run.usage.push(...parseUsage(cp.usage));
        if (Array.isArray(cp.warnings)) {
          run.warnings += cp.warnings.length;
          for (const w of cp.warnings) onError({ where: "checkpoint", kind: "harness", day, message: `warning: ${typeof w === "string" ? w : JSON.stringify(w)}`, className: "Warning" });
        }
      }
      const idx = rubric.checkpoints.flatMap((c, i) => (c.afterDay === day ? [i] : []));
      if (!idx.length) continue;

      let snapInvalid: InvalidCause | null = null;
      let proto: ProtocolSnapshot = SnapshotSchema.parse({});
      try {
        const r = await o.client.request("snapshot", {});
        const parsed = SnapshotSchema.safeParse(r?.snapshot);
        if (parsed.success) proto = parsed.data;
        else {
          snapInvalid = "sut";
          run.errors.sut++;
          const paths = [...new Set(parsed.error.issues.map((i) => `${i.path.map((p) => (typeof p === "number" ? "[]" : String(p))).join(".") || "(root)"} ${i.code}`))].slice(0, 5);
          onError({ where: "snapshot", kind: "sut", day, message: `malformed snapshot: ${paths.join("; ")}`, className: "SnapshotInvalid" });
        }
      } catch (e) {
        if (!(e instanceof SutError) || e.fatal) throw e;
        run.errors[e.kind]++;
        onError({ where: "snapshot", kind: e.kind, day, message: e.message, className: e.name });
        if (e.kind !== "unsupported") snapInvalid = e.kind;
      }
      const snap: Snapshot = {
        day,
        today: addDays(kickoff, day),
        kickoffDate: kickoff,
        state: proto.state,
        actions: proto.actions,
        deadlines: proto.deadlines,
        lessons: proto.lessons,
        timelineAgreed: proto.timelineAgreed,
        timeline: proto.timeline,
        proofs: proto.proofs,
        integrations: proto.integrations,
        engagements: engagementTexts(sent, proto.engagements),
        parties,
      };
      const cause: InvalidCause | null = snapInvalid ?? taint;
      taint = null;
      for (const i of idx) {
        const items = cause ? [] : await scoreCheckpoint(rubric.checkpoints[i], snap, o.judge);
        for (const it of items) if (it.error) onError({ where: "judge", kind: "judge", day, message: it.errorMessage ?? it.reason ?? "judge error", className: it.errorClass });
        const judgeErr = items.some((it) => it.error);
        run.perCheckpoint.push(items);
        run.checkpointIndex.push(i);
        run.invalid.push(cause ? `${cause} failure in the SUT run` : judgeErr ? "judge error" : null);
        run.invalidCause.push(cause ?? (judgeErr ? "judge" : null));
      }
    }
  } catch (e) {
    const err = e as Error & { noted?: boolean; cause?: unknown };
    if (e instanceof SutError) {
      run.errors[e.kind]++;
      onError({ where: e.op === "setup" ? "setup" : e.op === "snapshot" ? "snapshot" : e.op === "checkpoint" ? "checkpoint" : e.op === "ingest" ? "ingest" : "crash", kind: e.kind, day: current, message: e.message, className: e.name });
    } else if (!err.noted) onError({ where: "crash", kind: "harness", day: current, message: `${err?.message ?? String(e)}${err?.stack ? `\n${err.stack.split("\n").slice(1, 6).join("\n")}` : ""}`, className: err?.name });
    const done = new Set(run.checkpointIndex);
    for (const [i] of rubric.checkpoints.entries())
      if (!done.has(i)) {
        run.perCheckpoint.push([]);
        run.checkpointIndex.push(i);
        run.invalid.push(e instanceof SutError || err.noted ? "the adapter failed (setup failed, timed out or exited)" : "runner exception");
        run.invalidCause.push("crash");
      }
    run.crashed = true;
  }
  return run;
}
