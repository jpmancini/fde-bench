// FDE-bench's LLM judge for rubric items marked `judge: "llm"`: the expectation's description plus a compact
// rendering of the SUT records it concerns -> holds / doesn't, with a one-line reason. Strict and
// evidence-based: anything the rendering doesn't clearly show does not hold. The reason is returned to the
// runner, which discards it unless --debug-unsafe.
//
// The rendering (renderForJudge) and the stub judge are kept byte-identical to the harness FDE-bench was
// extracted from, so stub scores are reproducible across the split (test/judge.test.ts holds the golden).
import * as z from "zod/v4";
import { deadlineQuote, textAny, type Judge, type Snapshot } from "./score.ts";
import type { ExpectType, RubricItem } from "./types.ts";
import type { Usage } from "./cost.ts";

export const JUDGE_SYSTEM = `You are a strict evaluator of a system under test (SUT) that keeps a services firm's picture of a client
engagement. Per project it keeps STATE (two snapshots: where things are now = current, where they should
end up = goal), an ACTION set (the work from current to goal: task, owner, status, priority, due date with
its evidence), DEADLINES, LESSONS (client corrections of delivered work) and a TIMELINE. You are shown one
statement and the SUT's records at one point in a project. Decide whether the statement HOLDS in those records.
- Judge only from the records shown. Do not assume anything that is not written there.
- Paraphrase is fine; the substance must be there. Vague, partial or merely compatible records do not hold.
- If the statement is about something that must NOT happen and the records show it happened, it holds.
- When in doubt, it does not hold.
Answer with holds (true/false) and a one-sentence reason citing the record ids you relied on.`;

const VerdictSchema = z.object({ holds: z.boolean(), reason: z.string() });

const clip = (s: string | undefined, n = 400) => (!s ? "" : s.length > n ? `${s.slice(0, n)}...` : s).replace(/\n/g, " ");

/** The records an item of this type is about, compactly (project state always, for context). */
export function renderForJudge(type: ExpectType, snap: Snapshot): string {
  const st = (scope: string) =>
    snap.state.filter((s) => s.scope === scope).map((s) => `- [${s.id}] ${s.kind}/${s.category}: ${s.title}${s.detail ? ` | ${clip(s.detail)}` : ""}`).join("\n") || "(none)";
  const parts = [`TODAY: ${snap.today} (day ${snap.day} from the kickoff Monday ${snap.kickoffDate})`];
  if (snap.parties) parts.push(`PEOPLE: provider ${snap.parties.provider}${snap.parties.people.filter((x) => x.side === "provider").map((x) => `, ${x.name}`).join("")}; client ${snap.parties.customer}${snap.parties.people.filter((x) => x.side === "client").map((x) => `, ${x.name}`).join("")}`);
  parts.push("", "PROJECT STATE:", st("project"));
  if (type === "state") parts.push("", "CUSTOMER STATE:", st("customer"), "", "PROVIDER STATE:", st("provider"));
  if (type === "action" || type === "priority" || type === "blocker" || type === "deadline")
    parts.push(
      "",
      "ACTIONS:",
      snap.actions
        .map((a) => `- [${a.id}] (${a.status}) ${a.priority ?? "P?"} ${a.task} | owner: ${a.owner}${a.blockedReason ? ` | blocked: ${clip(a.blockedReason, 200)}` : ""}${a.dueDate ? ` | due ${a.dueDate} (${clip(a.dueDateSource, 200)})` : ""}${a.dependsOn.length ? ` | after ${a.dependsOn.join(",")}` : ""}${a.detail ? ` | ${clip(a.detail, 200)}` : ""}`)
        .join("\n") || "(none)"
    );
  if (type === "deadline" || type === "action" || type === "priority")
    parts.push("", "DEADLINES:", snap.deadlines.map((d) => { const q = deadlineQuote(d); return `- [${d.id}] ${d.date} ${d.what}${q ? ` | "${clip(q, 200)}"` : ""}`; }).join("\n") || "(none)");
  if (type === "lesson") parts.push("", "LESSONS:", snap.lessons.map((l) => `- [${l.id}] (${l.status}, ${l.route}) ${l.title}${l.detail ? ` | ${clip(l.detail)}` : ""}`).join("\n") || "(none)");
  if (type === "timeline")
    parts.push(
      "",
      `TIMELINE (${snap.timelineAgreed ? "agreed" : "draft"}):`,
      snap.timeline.map((e) => `- [${e.id}] ${e.date}${e.endDate ? `..${e.endDate}` : ""} (${e.kind}, ${e.status}${e.movedFrom ? `, moved from ${e.movedFrom}` : ""}) ${e.title}`).join("\n") || "(none)"
    );
  if (type === "proof") parts.push("", "PROOFS:", snap.proofs.map((p) => `- [${p.id}] ${p.verdict}: ${clip(p.claim)}`).join("\n") || "(none)");
  return parts.join("\n");
}

export function judgePrompt(item: RubricItem, role: "expect" | "forbid", snap: Snapshot): string {
  return [
    `STATEMENT (${role === "forbid" ? "something that must NOT happen; holds = it happened" : "something that should be true"}; about: ${item.type}):`,
    item.description,
    "",
    "SUT RECORDS:",
    renderForJudge(item.type, snap),
  ].join("\n");
}

export type JudgeCall = (model: string, system: string, prompt: string) => Promise<{ holds: boolean; reason: string }>;

/** A judge over a model call. */
export function makeJudge(call: JudgeCall, model: string): Judge {
  return (item, role, snap) => call(model, JUDGE_SYSTEM, judgePrompt(item, role, snap));
}

/** Deterministic stand-in (--model-stub): holds when any of the item's textAny terms appears in the
 *  rendering it would show the model. */
export const stubJudge: Judge = async (item, _role, snap) => {
  const hay = renderForJudge(item.type, snap);
  const holds = !!item.match.textAny?.length && textAny(item.match.textAny, hay);
  return { holds, reason: `stub judge: ${holds ? "a textAny term is in the rendering" : "no textAny term in the rendering"}` };
};

// ---------------------------------------------------------------------------------------------------------
// Robust calls: bounded retries with backoff on transient failures, a per-call timeout, a concurrency cap.

export interface RetryOptions {
  /** total attempts (first call included) */
  attempts: number;
  baseMs: number;
  maxMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** called before each retry (the runner counts them) */
  onRetry?: (attempt: number, err: unknown, waitMs: number) => void;
}
export const JUDGE_RETRY: RetryOptions = { attempts: 6, baseMs: 2000, maxMs: 60_000 };
/** Per judge call: a verdict is short, so a call this slow is stuck. */
export const JUDGE_TIMEOUT_MS = 4 * 60 * 1000;
/** Judge calls in flight at once, across the whole run. */
export const JUDGE_CONCURRENCY = 4;

/** Transient: rate limit (429), overload (529 / overloaded_error), request timeout / conflict (408/409),
 *  server errors (5xx), dropped connections and client timeouts, and a truncated answer (no parsed output
 *  at max_tokens: sampling can land differently next time). Not: 4xx request errors, refusals. */
export function isTransient(e: unknown): boolean {
  const x = e as { status?: number; name?: string; message?: string; error?: { type?: string; error?: { type?: string } }; code?: string };
  if (typeof x?.status === "number") return [408, 409, 429, 529].includes(x.status) || x.status >= 500;
  const name = x?.name ?? "";
  if (/APIConnection(Timeout)?Error|AbortError|TimeoutError|FetchError/.test(name)) return true;
  const msg = `${x?.message ?? ""} ${x?.code ?? ""} ${x?.error?.type ?? ""} ${x?.error?.error?.type ?? ""}`;
  return /overloaded|rate.?limit|timed? ?out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|connection error|fetch failed|stop_reason max_tokens/i.test(msg);
}

/** Seconds from a Retry-After header, if the error carries one. */
function retryAfterMs(e: unknown): number | null {
  const h = (e as { headers?: Headers | Record<string, string> })?.headers;
  const v = !h ? null : typeof (h as Headers).get === "function" ? (h as Headers).get("retry-after") : (h as Record<string, string>)["retry-after"];
  const n = v === null || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : null;
}

/** fn, retried on transient failures with exponential backoff + jitter (honouring Retry-After), at most
 *  `attempts` times in all; the last error is rethrown. */
export async function withRetries<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= o.attempts || !isTransient(e)) throw e;
      const backoff = Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1));
      const wait = Math.min(o.maxMs, retryAfterMs(e) ?? backoff * (0.5 + Math.random() / 2));
      o.onRetry?.(attempt, e, wait);
      await sleep(wait);
    }
  }
}

/** A counting semaphore: at most n holders of `run` at once. */
export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** Wrap a judge call with the retries, the timeout (passed to the call) and the concurrency cap. */
export function robustJudgeCall(call: JudgeCall, o: Partial<RetryOptions> & { concurrency?: number } = {}): JudgeCall {
  const limit = limiter(o.concurrency ?? JUDGE_CONCURRENCY);
  const retry = { ...JUDGE_RETRY, ...o };
  return (model, system, prompt) => limit(() => withRetries(() => call(model, system, prompt), retry));
}

/** The real judge call: structured output; usage reported to `onUsage`. The SDK's own retries are off
 *  (robustJudgeCall owns them, bounded and logged); the timeout is per attempt. */
export async function anthropicJudgeCall(apiKey: string, onUsage: (u: Usage) => void, timeoutMs = JUDGE_TIMEOUT_MS): Promise<JudgeCall> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return async (model, system, prompt) => {
    const res = await client.beta.messages.parse(
      {
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "high", format: zodOutputFormat(VerdictSchema) },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: prompt }],
      } as any,
      { timeout: timeoutMs }
    );
    const u = res.usage as { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    onUsage({ model: res.model, input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 });
    if (res.stop_reason === "refusal") throw new Error("judge refused");
    const parsed = (res as { parsed_output?: { holds: boolean; reason: string } | null }).parsed_output;
    if (!parsed) throw new Error(`judge: no parsed output (stop_reason ${res.stop_reason})`);
    return parsed;
  };
}

// ---------------------------------------------------------------------------------------------------------
// The judge's key: ANTHROPIC_API_KEY, else the AWS Secrets Manager secret FDE_JUDGE_SECRET (read with the
// ambient AWS credentials, e.g. AWS_PROFILE). Guards (configurable, all optional):
//   FDE_JUDGE_AWS_PROFILE      AWS_PROFILE must be exactly this (and no env keys may override it)
//   FDE_JUDGE_ACCOUNT          the secret must live in this AWS account (checked on its ARN before reading)

export class KeyRefusal extends Error {}

export async function judgeKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  const secret = env.FDE_JUDGE_SECRET;
  if (!secret) throw new KeyRefusal("the LLM judge needs a key: set ANTHROPIC_API_KEY, or FDE_JUDGE_SECRET (an AWS Secrets Manager secret name) with AWS credentials");
  const wantProfile = env.FDE_JUDGE_AWS_PROFILE;
  if (wantProfile) {
    if (env.AWS_PROFILE !== wantProfile) throw new KeyRefusal(`AWS_PROFILE must be ${JSON.stringify(wantProfile)} to read the judge's key (got ${JSON.stringify(env.AWS_PROFILE ?? "")})`);
    for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) if (env[k]) throw new KeyRefusal(`${k} is set: env keys override AWS_PROFILE; unset it`);
  }
  let sm: typeof import("@aws-sdk/client-secrets-manager");
  try {
    sm = await import("@aws-sdk/client-secrets-manager");
  } catch {
    throw new KeyRefusal("FDE_JUDGE_SECRET needs the optional dependency @aws-sdk/client-secrets-manager (npm install)");
  }
  const client = new sm.SecretsManagerClient({ region: env.AWS_REGION ?? "us-east-1" });
  const wantAccount = env.FDE_JUDGE_ACCOUNT;
  if (wantAccount) {
    let acct: string | undefined;
    try {
      const d = await client.send(new sm.DescribeSecretCommand({ SecretId: secret }));
      acct = d.ARN?.split(":")[4];
    } catch (e) {
      throw new KeyRefusal(`cannot read the judge secret's metadata (${(e as Error).name})`);
    }
    if (acct !== wantAccount) throw new KeyRefusal(`secret ${secret} is in account ${acct}, expected ${wantAccount}`);
  }
  try {
    const v = (await client.send(new sm.GetSecretValueCommand({ SecretId: secret }))).SecretString;
    if (!v) throw new Error("no string value");
    return v.trim();
  } catch (e) {
    throw new KeyRefusal(`cannot read the judge secret (${(e as Error).name})`);
  }
}
