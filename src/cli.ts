// fde-bench CLI (README.md, docs/schema.md, docs/sut-protocol.md). Scores a system under test against
// sealed scenarios WITHOUT showing anyone what they contain: it prints scores only.
//
//   fde-bench run --sut "<command>" [--sut-cwd dir] [--split dev|holdout] [--only id,id] [--runs N]
//                 [--model-stub] [--errors] [--json] [--yes] [--debug-unsafe] [--pack dir]
//   fde-bench seal | unseal          (the pack store's seal.sh / unseal.sh; eval maintainer only)
//
// Input: --pack <dir> (a dir with scenarios/<id>/{scenario,rubric}.json, or its parent holding work/), else
// it runs <store>/unseal.sh itself (into a fresh temp dir; the path it prints is the only output read) and
// removes that dir as soon as the pack is in memory (also on error / Ctrl-C).
// Per scenario run: a fresh adapter process (src/sut.ts), replay + checkpoints + snapshots (src/replay.ts),
// scored (src/score.ts, src/judge.ts).
// Output discipline: dev -> per scenario id: score, per-type subscores, cost, duration; holdout -> only the
// aggregate + count. Never expectation ids/descriptions/match text, judge reasons, engagement text, adapter
// messages or SUT state: the adapter's stderr is discarded and its non-protocol stdout ignored.
// --debug-unsafe prints per-expectation results, judge reasons and the adapter's stderr, and RETIRES the
// scenarios it ran (appended to retired.txt). --errors (dev only) prints error classes, redacted.
// Appends one line to <store>/results.jsonl. The store dir is touched only for results.jsonl, retired.txt,
// sealed/pack.sha (read) and unseal.sh (run).
//   env: FDE_BENCH_STORE (default ~/Dev/fde-bench-packs), FDE_BENCH_UNSEAL (default <store>/unseal.sh),
//        FDE_JUDGE_MODEL (default claude-opus-5-5), ANTHROPIC_API_KEY | FDE_JUDGE_SECRET (+ guards, src/judge.ts),
//        FDE_MAX_INFLIGHT (passed to the adapter, default 4), FDE_BENCH_TIMEOUTS ("checkpoint=900,...", seconds),
//        FDE_BENCH_COST_GUARD (dollars, default 5)
// Exit: 0 ran; 2 refused (usage, guard, cost, adapter didn't answer hello); 1 harness error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const BENCH_ROOT = path.resolve(import.meta.dirname, "..");
const stdout = (s: string) => process.stdout.write(s + "\n");
const stderr = (s: string) => process.stderr.write(s + "\n");
function refuse(msg: string): never {
  stderr(`refusing to run: ${msg}`);
  process.exit(2);
}

const STORE = process.env.FDE_BENCH_STORE ?? path.join(os.homedir(), "Dev", "fde-bench-packs");
const UNSEAL = process.env.FDE_BENCH_UNSEAL ?? path.join(STORE, "unseal.sh");

const USAGE = `fde-bench: a blind benchmark for forward-deployed-engineer software

  fde-bench run --sut "<command>" [options]   score a SUT adapter against the pack
      --sut-cwd <dir>        the adapter's working directory (default: here)
      --split dev|holdout    which split (default dev; holdout prints only the aggregate)
      --only <id,id>         dev only: just these scenarios
      --runs <N>             repeat each scenario (1-20; prints min-max) for a noise band
      --model-stub           no model anywhere: FDE_MODEL_MODE=stub for the adapter, the stub judge here
      --errors               dev only: redacted error classes on stderr (retires nothing)
      --json                 one JSON summary line on stdout
      --yes                  run although the cost estimate is over the guard ($5)
      --pack <dir>           a plaintext pack dir instead of unsealing the store (tests, examples)
      --debug-unsafe         per-expectation results + adapter stderr; RETIRES every scenario it runs
  fde-bench seal             run <store>/seal.sh   (pack builders / eval maintainer)
  fde-bench unseal           run <store>/unseal.sh (eval maintainer only; never while working on a SUT)

  store: ${STORE} (FDE_BENCH_STORE)`;

const [cmd, ...argv] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  stdout(USAGE);
  process.exit(cmd ? 0 : 2);
}
if (cmd === "seal" || cmd === "unseal") {
  const script = cmd === "seal" ? path.join(STORE, "seal.sh") : UNSEAL;
  if (!fs.existsSync(script)) refuse(`no ${cmd} script at ${script} (set FDE_BENCH_STORE)`);
  if (cmd === "unseal") stderr("!!! unseal prints a plaintext pack: eval maintainer only. Anyone improving a SUT must never read it (README.md).");
  const r = spawnSync("bash", [script, ...argv], { stdio: "inherit", cwd: STORE });
  process.exit(r.status ?? 1);
}
if (cmd !== "run") {
  stderr(USAGE);
  refuse(`unknown command ${JSON.stringify(cmd)}`);
}

const KNOWN = new Set(["sut", "sut-cwd", "split", "only", "runs", "pack", "model-stub", "errors", "json", "yes", "debug-unsafe"]);
const VALUED = new Set(["sut", "sut-cwd", "split", "only", "runs", "pack"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--") || !KNOWN.has(a.slice(2))) refuse(`unknown argument ${JSON.stringify(a)} (fde-bench help)`);
  if (VALUED.has(a.slice(2))) {
    if (argv[i + 1] === undefined) refuse(`${a} needs a value`);
    i++;
  }
}
const flag = (k: string) => argv.includes(`--${k}`);
const arg = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const STUB = flag("model-stub");
const JSON_OUT = flag("json");
const YES = flag("yes");
const UNSAFE = flag("debug-unsafe");
const ERRORS = flag("errors");
const SPLIT = arg("split") ?? "dev";
const ONLY = arg("only")?.split(",").filter(Boolean);
const RUNS = Number(arg("runs") ?? 1);
const PACK = arg("pack");
const SUT = arg("sut");
const SUT_CWD = path.resolve(arg("sut-cwd") ?? process.cwd());
const COST_GUARD = Number(process.env.FDE_BENCH_COST_GUARD ?? 5);
const JUDGE_MODEL = process.env.FDE_JUDGE_MODEL ?? "claude-opus-5-5";

if (!SUT) refuse(`--sut "<command>" is required (e.g. --sut "node examples/toy-sut/adapter.mjs")`);
if (!fs.existsSync(SUT_CWD) || !fs.statSync(SUT_CWD).isDirectory()) refuse(`--sut-cwd ${SUT_CWD} is not a directory`);
if (SPLIT !== "dev" && SPLIT !== "holdout") refuse(`--split must be dev or holdout`);
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 20) refuse("--runs must be 1-20");
if (!Number.isFinite(COST_GUARD) || COST_GUARD < 0) refuse("FDE_BENCH_COST_GUARD must be a number of dollars");
if (SPLIT === "holdout" && ERRORS) refuse("--errors is dev-only: it names the scenarios its errors came from");
if (SPLIT === "holdout" && ONLY) refuse("--only is dev-only: a holdout aggregate over one scenario is that scenario's score");

const { parseTimeouts } = await import("./sut.ts");
let TIMEOUTS: ReturnType<typeof parseTimeouts>;
try {
  TIMEOUTS = parseTimeouts(process.env.FDE_BENCH_TIMEOUTS);
} catch (e) {
  refuse((e as Error).message);
}

// ---------------------------------------------------------------------------------------------------------
// Temp dir (unsealed pack): removed as soon as the pack is in memory, whatever happens.
let tempDir: string | null = null;
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
// Longest first: the dir a path is "under" is its deepest temp root (never /var/folders when $TMPDIR is
// /var/folders/xx/yy/T).
const TEMP_ROOTS = [...new Set([os.tmpdir(), process.env.TMPDIR ?? "", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].filter(Boolean).flatMap((p) => [path.resolve(p), real(p)]))].sort((a, b) => b.length - a.length);
const rootOf = (p: string) => TEMP_ROOTS.find((t) => p.startsWith(t + path.sep) && p.length > t.length + 1);
function underTemp(p: string) {
  return !!rootOf(path.resolve(p)) || !!rootOf(real(p));
}
/** mktemp dirs an unseal script makes (fde-bench.XXXX, or the older oldo-blind.XXXX). */
const OURS = /^(?:fde-bench|oldo-blind)\./;
/** The dir to remove for an unsealed path: the path itself, or, when it sits in a dir unseal.sh made with
 *  mktemp (e.g. <tmp>/fde-bench.XXXX/work), that whole dir: the child of the temp root it is under. The
 *  parent is removed only when it is one of ours or nothing else is in it. */
function removeUnsealed(dir: string) {
  const p = real(dir);
  const r = rootOf(p);
  if (!r) return;
  fs.rmSync(p, { recursive: true, force: true });
  for (let up = path.dirname(p); up !== r && up.startsWith(r + path.sep); up = path.dirname(up)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(up);
    } catch {
      break;
    }
    if (OURS.test(path.basename(up))) fs.rmSync(up, { recursive: true, force: true });
    else if (!entries.length) fs.rmdirSync(up);
    else break;
  }
}
function cleanup() {
  if (tempDir && underTemp(tempDir)) removeUnsealed(tempDir);
  tempDir = null;
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => {
    cleanup();
    process.exit(130); // the exit hook in src/sut.ts kills any live adapter
  });

// ---------------------------------------------------------------------------------------------------------
// The pack
function unseal(): string {
  if (!fs.existsSync(UNSEAL)) refuse(`no unseal script at ${UNSEAL} (set FDE_BENCH_STORE, or pass --pack <dir>)`);
  let out = "";
  try {
    out = execFileSync("bash", [UNSEAL], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 });
  } catch (e: any) {
    refuse(`unseal failed (exit ${e?.status ?? "?"})`);
  }
  const dir = out.split("\n").map((l) => l.trim()).filter(Boolean).reverse().find((l) => path.isAbsolute(l) && fs.existsSync(l) && fs.statSync(l).isDirectory());
  if (!dir) refuse("unseal printed no directory");
  tempDir = dir;
  if (!underTemp(dir)) {
    tempDir = null;
    refuse("unseal printed a directory outside the system temp dir");
  }
  return dir;
}

function scenariosDir(root: string): string {
  for (const d of [path.join(root, "scenarios"), path.join(root, "work", "scenarios")]) if (fs.existsSync(d)) return d;
  refuse("the pack has no scenarios/ dir");
}

function dirSha(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(path.relative(dir, p)).update("\0").update(fs.readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

const root = PACK ? path.resolve(PACK) : unseal();
// Tests only: hold the unsealed dir open so a test can interrupt the run (SIGINT must still remove it).
if (!PACK && process.env.FDE_BENCH_TEST_PAUSE_MS) {
  stderr("paused after unseal");
  await new Promise((r) => setTimeout(r, Number(process.env.FDE_BENCH_TEST_PAUSE_MS)));
}
const sdir = scenariosDir(root);
const packSha = PACK
  ? `dir:${dirSha(sdir)}`
  : (() => {
      try {
        return fs.readFileSync(path.join(STORE, "sealed", "pack.sha"), "utf8").trim().split(/\s+/)[0];
      } catch {
        return "unknown";
      }
    })();

const { ScenarioSchema, RubricSchema } = await import("./types.ts");
type Scenario = import("./types.ts").Scenario;
type Rubric = import("./types.ts").Rubric;
const loaded: { sc: Scenario; rubric: Rubric }[] = [];
let invalidFiles = 0;
const invalidIssues: string[] = [];
const rawPack: unknown[] = []; // every parsed file, for --errors redaction only
const errorIssues: { id: string; split: unknown; file: string; issues: { path: string; code: string; message: string }[] }[] = [];
const readJson = (f: string) => {
  const v = JSON.parse(fs.readFileSync(f, "utf8"));
  rawPack.push(v);
  return v;
};
for (const id of fs.readdirSync(sdir).sort()) {
  const d = path.join(sdir, id);
  if (!fs.statSync(d).isDirectory()) continue;
  let file = "scenario.json";
  let split: unknown = undefined;
  try {
    const rawSc = readJson(path.join(d, "scenario.json"));
    split = (rawSc as { split?: unknown })?.split;
    file = "rubric.json";
    const rawRub = readJson(path.join(d, "rubric.json"));
    file = "scenario.json";
    const sc = ScenarioSchema.parse(rawSc);
    file = "rubric.json";
    const rubric = RubricSchema.parse(rawRub);
    loaded.push({ sc, rubric });
  } catch (e) {
    invalidFiles++;
    if (UNSAFE) invalidIssues.push(`${id}: ${(e as Error).message}`);
    const zi = (e as { issues?: { path: PropertyKey[]; code: string; message: string }[] }).issues;
    // the path holds keys and indexes only (format, not content); the message is redacted when printed
    errorIssues.push({ id, split, file, issues: zi ? zi.map((i) => ({ path: i.path.map((p) => (typeof p === "number" ? `[${p}]` : String(p))).join("."), code: i.code, message: i.message })) : [{ path: "", code: (e as Error).name, message: (e as Error).message }] });
  }
}
// The pack directory may also hold pattern cards / a manifest: their strings are content too.
for (const extra of [path.join(path.dirname(sdir), "patterns"), path.join(path.dirname(sdir), "manifest.json")])
  try {
    if (!ERRORS || !fs.existsSync(extra)) continue;
    if (fs.statSync(extra).isDirectory()) for (const f of fs.readdirSync(extra)) f.endsWith(".json") && readJson(path.join(extra, f));
    else readJson(extra);
  } catch {
    /* unreadable extras only weaken nothing: they are never printed */
  }
const { makeRedactor, codeVocabulary } = await import("./redact.ts");
// Code-level wording: FDE-bench's own source and the protocol it speaks (never the SUT's code).
const vocabFiles = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? vocabFiles(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
const redact = ERRORS
  ? makeRedactor(rawPack, loaded.map(({ sc }) => sc.id).concat(errorIssues.map((x) => x.id)), codeVocabulary([...vocabFiles(path.join(BENCH_ROOT, "src")), path.join(BENCH_ROOT, "docs", "sut-protocol.md")], (f) => fs.readFileSync(f, "utf8")))
  : (s: string) => s;
rawPack.length = 0;
const selected = loaded.filter(({ sc }) => sc.split === SPLIT && (!ONLY || ONLY.includes(sc.id)));
// Done with the files: the plaintext is in memory only from here on.
cleanup();
if (!selected.length) refuse(`no ${SPLIT} scenarios${ONLY ? " matching --only" : ""}${invalidFiles ? ` (${invalidFiles} failed validation)` : ""}`);

// ---------------------------------------------------------------------------------------------------------
// The adapter: environment, and a hello probe before anything is spent.
const { SutClient, SutError } = await import("./sut.ts");
const sutEnv: NodeJS.ProcessEnv = { ...process.env, FDE_MODEL_MODE: STUB ? "stub" : "real", FDE_MAX_INFLIGHT: process.env.FDE_MAX_INFLIGHT ?? "4" };
for (const k of Object.keys(sutEnv)) if (k.startsWith("FDE_BENCH_") || k.startsWith("FDE_JUDGE_")) delete sutEnv[k];
if (STUB) for (const k of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "ANTHROPIC_API_KEY"]) delete sutEnv[k]; // stub: no model, no cloud
const newClient = () => new SutClient({ command: SUT, cwd: SUT_CWD, env: sutEnv, debugStderr: UNSAFE, timeouts: TIMEOUTS });

let sut: import("./sut.ts").Hello;
{
  const probe = newClient();
  try {
    sut = await probe.hello();
  } catch (e) {
    await probe.close();
    const x = e as InstanceType<typeof SutError>;
    refuse(`the adapter did not answer hello (${x.kind ?? "error"}${x.kind === "transport" ? `: ${x.message}` : ""}); check --sut and --sut-cwd, or run with --debug-unsafe on the public example to see its stderr`);
  }
  await probe.close();
}

// ---------------------------------------------------------------------------------------------------------
// Cost guard
const { estimateScenario, priceOf } = await import("./cost.ts");
const est = selected.map(({ sc, rubric }) => estimateScenario(sc, rubric));
const estUsd = STUB ? 0 : est.reduce((n, e) => n + e.usd, 0) * RUNS;
const estCalls = est.reduce((n, e) => n + e.calls.read + e.calls.plan + e.calls.judge, 0) * RUNS;
const llmItems = selected.some(({ rubric }) => rubric.checkpoints.some((c) => [...c.expect, ...c.forbid].some((i) => i.judge === "llm")));
const gitCommit = (cwd: string) => {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ? "+dirty" : "";
    return sha + dirty;
  } catch {
    return "unknown";
  }
};
const benchCommit = gitCommit(BENCH_ROOT);
const MODEL = { sut: STUB ? "stub" : "real", judge: STUB ? "stub" : JUDGE_MODEL };
if (!JSON_OUT) {
  stdout(`fde-bench: ${SPLIT}, ${selected.length} scenario(s) x ${RUNS} run(s), sut ${sut.name} ${sut.version} (${sut.commit.slice(0, 12)}), model ${MODEL.sut}, judge ${MODEL.judge}, pack ${packSha.slice(0, 16)}, bench ${benchCommit.slice(0, 12)}`);
  stdout(`estimate: ~${estCalls} model calls, ~$${estUsd.toFixed(2)}${STUB ? " (stub: no model)" : " (heuristic: the SUT's real cost is its own)"}${invalidFiles ? `; ${invalidFiles} scenario(s) failed validation and are skipped` : ""}`);
}
if (estUsd > COST_GUARD && !YES) refuse(`estimated $${estUsd.toFixed(2)} is over $${COST_GUARD}: pass --yes to run`);

// ---------------------------------------------------------------------------------------------------------
// The judge
const judgeMod = await import("./judge.ts");
type Judge = import("./score.ts").Judge;
let judge: Judge = judgeMod.stubJudge;
let judgeRetries = 0;
let spend = 0;
let scenarioSpend = 0;
const addUsage = (u: import("./cost.ts").Usage) => {
  const c = priceOf(u);
  spend += c;
  scenarioSpend += c;
};
const retryCauses = new Map<string, number>();
if (!STUB) {
  if (llmItems) {
    let key: string;
    try {
      key = await judgeMod.judgeKey();
    } catch (e) {
      refuse((e as Error).message);
    }
    const call = await judgeMod.anthropicJudgeCall(key, addUsage);
    judge = judgeMod.makeJudge(
      judgeMod.robustJudgeCall(call, {
        onRetry: (_a, e) => {
          judgeRetries++;
          const x = e as { status?: number; name?: string };
          const k = `judge retry: ${x?.name ?? "Error"}${x?.status ? ` ${x.status}` : ""}`;
          retryCauses.set(k, (retryCauses.get(k) ?? 0) + 1);
        },
      }),
      JUDGE_MODEL
    );
  } else
    judge = async () => {
      throw new Error("no judge configured");
    };
}
if (process.env.FDE_BENCH_TEST_JUDGE_FAIL) {
  // Tests only: every judge call fails as a harness error would (exercises the invalid-checkpoint path).
  judge = async () => {
    throw Object.assign(new Error("529 overloaded_error (test)"), { name: "InternalServerError" });
  };
}

if (UNSAFE) {
  stderr("!!! --debug-unsafe: per-expectation results, judge reasons and the adapter's stderr will be printed. Every scenario this run");
  stderr(`!!! touches is now RETIRED (a test you have seen measures memory, not the system); appending their ids to ${path.join(STORE, "retired.txt")}.`);
  fs.mkdirSync(STORE, { recursive: true });
  const f = path.join(STORE, "retired.txt");
  const have = new Set(fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").map((s) => s.split("\t")[0].trim()) : []);
  const add = selected.map(({ sc }) => sc.id).filter((id) => !have.has(id));
  if (add.length) fs.appendFileSync(f, add.map((id) => `${id}\t${new Date().toISOString()}\n`).join(""));
  for (const i of invalidIssues) stderr(`invalid: ${i}`);
}
// --errors: format-level diagnosis, safe to read (every pack string redacted). Scenario ids are printed
// (as in the normal dev output); validation issues are printed as key paths, codes and redacted messages.
const errOut = (s: string) => (ERRORS ? stderr(`[errors] ${s}`) : undefined);
if (ERRORS) for (const x of errorIssues) if (x.split !== "holdout") for (const i of x.issues) errOut(`${x.id} ${x.file} invalid: ${i.path || "(root)"} ${i.code}: ${redact(i.message)}`);

// ---------------------------------------------------------------------------------------------------------
// Run
const { runScenario } = await import("./replay.ts");
const { scenarioScore, mean } = await import("./score.ts");
type Cause = import("./replay.ts").InvalidCause;
interface Row { id: string; scores: number[]; byType: Record<string, number[]>; cost: number; ms: number; errors: number; unsupported: number; crashed: number; judgeErrors: number; invalid: number; invalidBy: Partial<Record<Cause, number>>; checkpoints: number; noise: number; warnings: number }
const rows = new Map<string, Row>();
const errorClasses = new Map<string, { n: number; ids: Set<string>; days: Set<number> }>();
const started = Date.now();
for (let run = 1; run <= RUNS; run++)
  for (const { sc, rubric } of selected) {
    const row = rows.get(sc.id) ?? { id: sc.id, scores: [], byType: {}, cost: 0, ms: 0, errors: 0, unsupported: 0, crashed: 0, judgeErrors: 0, invalid: 0, invalidBy: {}, checkpoints: 0, noise: 0, warnings: 0 };
    rows.set(sc.id, row);
    scenarioSpend = 0;
    const t0 = Date.now();
    const onError = (e: import("./replay.ts").RunError) => {
      if (UNSAFE) stderr(`  [unsafe] ${sc.id} run ${run} day ${e.day} ${e.where} ${e.kind}: ${e.message}`);
      if (!ERRORS) return;
      const msg = redact(e.message).replace(/\s+/g, " ").slice(0, 600);
      const key = `${e.where} (${e.kind}) ${e.className ?? "Error"}: ${msg}`;
      const c = errorClasses.get(key) ?? { n: 0, ids: new Set(), days: new Set() };
      c.n++;
      c.ids.add(sc.id);
      c.days.add(e.day);
      errorClasses.set(key, c);
    };
    const client = newClient();
    try {
      const r = await runScenario(sc, rubric, { client, judge, onError });
      for (const u of r.usage) addUsage(u);
      const s = scenarioScore(r.perCheckpoint, r.invalid);
      if (s.score !== null) row.scores.push(s.score);
      for (const [t, v] of Object.entries(s.byType)) (row.byType[t] ??= []).push(v as number);
      row.errors += r.errors.transport + r.errors.model + r.errors.sut;
      row.unsupported += r.errors.unsupported;
      row.crashed += r.crashed ? 1 : 0;
      row.judgeErrors += s.judgeErrors;
      row.invalid += s.invalid;
      for (const c of r.invalidCause) if (c) row.invalidBy[c] = (row.invalidBy[c] ?? 0) + 1;
      row.checkpoints += r.perCheckpoint.length;
      row.warnings += r.warnings;
      if (UNSAFE)
        for (const [k, cp] of r.perCheckpoint.entries()) {
          const i = r.checkpointIndex[k];
          if (r.invalid[k]) stdout(`  [unsafe] ${sc.id} run ${run} cp ${rubric.checkpoints[i].afterDay} INVALID: ${r.invalid[k]}`);
          for (const it of cp) {
            const item = rubric.checkpoints[i][it.role].find((x) => x.id === it.id);
            stdout(`  [unsafe] ${sc.id} run ${run} cp ${rubric.checkpoints[i].afterDay} ${it.role} ${it.id} (${it.type}, ${it.judge}, w${it.weight}) ${it.role === "expect" ? (it.ok ? "PASS" : "FAIL") : it.ok ? "HIT" : "clear"}${it.matches !== undefined ? ` matches=${it.matches}` : ""} | ${item?.description ?? ""}${it.reason ? ` | judge: ${it.reason}` : ""}`);
          }
        }
    } finally {
      row.noise += client.noiseLines;
      await client.close();
    }
    row.cost += scenarioSpend;
    row.ms += Date.now() - t0;
  }

// ---------------------------------------------------------------------------------------------------------
// Report (scores only). Invalid checkpoints are excluded from every score; a scenario none of whose
// checkpoints was valid has no score and is left out of the aggregate.
const r1 = (x: number) => Math.round(x * 10) / 10;
const list = [...rows.values()];
const scored = list.filter((r) => r.scores.length);
const aggregate = scored.length ? r1(mean(scored.map((r) => mean(r.scores)))) : null;
const totalMs = Date.now() - started;
const sum = (f: (r: Row) => number) => list.reduce((n, r) => n + f(r), 0);
const errs = sum((r) => r.errors), unsupported = sum((r) => r.unsupported), jerr = sum((r) => r.judgeErrors), invalidCps = sum((r) => r.invalid), totalCps = sum((r) => r.checkpoints), noise = sum((r) => r.noise), warnings = sum((r) => r.warnings);
const invalidBy: Partial<Record<Cause, number>> = {};
for (const r of list) for (const [c, n] of Object.entries(r.invalidBy)) invalidBy[c as Cause] = (invalidBy[c as Cause] ?? 0) + n;
const perId = Object.fromEntries(
  list.map((r) => [
    r.id,
    {
      score: r.scores.length ? r1(mean(r.scores)) : null,
      ...(RUNS > 1 && r.scores.length && { min: r1(Math.min(...r.scores)), max: r1(Math.max(...r.scores)) }),
      byType: Object.fromEntries(Object.entries(r.byType).map(([t, v]) => [t, r1(mean(v))])),
      cost: Math.round(r.cost * 100) / 100,
      seconds: Math.round(r.ms / 100) / 10,
      errors: r.errors,
      ...(r.unsupported && { unsupported: r.unsupported }),
      judgeErrors: r.judgeErrors,
      invalid: r.invalid,
      ...(r.invalid && { invalidBy: r.invalidBy }),
      checkpoints: r.checkpoints,
    },
  ])
);
const sutInfo = { name: sut.name, version: sut.version, commit: sut.commit, capabilities: sut.capabilities };
const common = { split: SPLIT, runs: RUNS, count: list.length, scored: scored.length, aggregate, cost: Math.round(spend * 100) / 100, seconds: Math.round(totalMs / 1000), errors: errs, ...(unsupported && { unsupported }), judgeErrors: jerr, invalid: invalidCps, ...(invalidCps && { invalidBy }), checkpoints: totalCps, ...(judgeRetries && { judgeRetries }) };
const summary = SPLIT === "dev" ? { ...common, scenarios: perId } : common;

if (JSON_OUT) stdout(JSON.stringify({ ...summary, packSha, sut: sutInfo, bench: benchCommit, model: MODEL }));
else {
  if (SPLIT === "dev")
    for (const [id, s] of Object.entries(perId))
      stdout(`${id.padEnd(28)} ${String(s.score ?? "n/a").padStart(5)}${"min" in s ? ` (${s.min}-${s.max})` : ""}   ${Object.entries(s.byType).map(([t, v]) => `${t} ${v}`).join(" | ") || "-"}   $${s.cost.toFixed(2)}   ${s.seconds}s${s.errors ? `   errors ${s.errors}` : ""}${"unsupported" in s ? `   unsupported ${s.unsupported}` : ""}${s.judgeErrors ? `   judge errors ${s.judgeErrors}` : ""}${s.invalid ? `   INVALID ${s.invalid}/${s.checkpoints} checkpoints` : ""}`);
  stdout(`${SPLIT} aggregate ${aggregate ?? "n/a"} over ${scored.length}${scored.length !== list.length ? ` of ${list.length}` : ""} scenario(s) x ${RUNS} run(s); cost $${spend.toFixed(2)}; ${Math.round(totalMs / 1000)}s${errs ? `; errors ${errs}` : ""}${unsupported ? `; unsupported ${unsupported}` : ""}${jerr ? `; judge errors ${jerr}` : ""}${invalidCps ? `; invalid ${invalidCps}/${totalCps} checkpoints` : ""}${judgeRetries ? `; judge retries ${judgeRetries}` : ""}`);
}
if (invalidCps) {
  const by = Object.entries(invalidBy).map(([c, n]) => `${c} ${n}`).join(", ");
  stderr(`!!! WARNING: ${invalidCps} of ${totalCps} checkpoint(s) were INVALID (${by}) and are EXCLUDED from the scores${scored.length !== list.length ? `; ${list.length - scored.length} scenario(s) have no valid checkpoint and are left out of the aggregate` : ""}. The aggregate is not comparable to a clean run: fix the cause and re-run${ERRORS ? "" : " (--errors shows the error classes, redacted)"}.`);
  if (invalidBy.sut) stderr(`!!! ${invalidBy.sut} of them are SUT failures (the system itself failed, not its infrastructure): count them against the SUT when comparing.`);
}
if (ERRORS) {
  if (!errorClasses.size) errOut("no runtime errors");
  if (noise) errOut(`${noise} non-protocol stdout line(s) from the adapter were ignored (it should log to stderr)`);
  if (warnings) errOut(`${warnings} checkpoint warning(s)`);
  for (const [k, n] of retryCauses) errOut(`${n}x ${k}`);
  for (const [k, c] of [...errorClasses.entries()].sort((a, b) => b[1].n - a[1].n)) errOut(`${c.n}x ${k}  [${[...c.ids].join(",")}; days ${[...c.days].sort((a, b) => a - b).join(",")}]`);
}

const line = {
  at: new Date().toISOString(),
  bench: benchCommit,
  sut: { name: sut.name, version: sut.version, commit: sut.commit },
  packSha,
  source: PACK ? "pack-dir" : "sealed",
  split: SPLIT,
  runs: RUNS,
  ...(SPLIT === "dev" ? { scores: Object.fromEntries(Object.entries(perId).map(([id, s]) => [id, { score: s.score, byType: s.byType, ...(s.invalid && { invalid: s.invalid }) }])) } : {}),
  aggregate,
  count: list.length,
  invalid: invalidCps,
  ...(invalidCps && { invalidBy }),
  checkpoints: totalCps,
  model: MODEL,
  cost: Math.round(spend * 100) / 100,
  ...(UNSAFE && { debugUnsafe: true }),
};
try {
  fs.mkdirSync(STORE, { recursive: true });
  fs.appendFileSync(path.join(STORE, "results.jsonl"), JSON.stringify(line) + "\n");
} catch (e) {
  stderr(`could not append to results.jsonl (${(e as Error).name})`);
}
cleanup();
process.exit(0);
