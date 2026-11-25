// The CLI end to end (bin/fde-bench run): the toy SUT on the public example, output discipline (no pack
// strings on stdout / stderr / results.jsonl, holdout = aggregate only, adapter stderr and stray stdout
// discarded), the unsealed temp dir removed (success, refusal, SIGINT), the guards and the cost guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ROOT, EXAMPLES, scen, rub, leaks } from "./helpers.ts";

const BIN = path.join(ROOT, "bin", "fde-bench");
const TOY = `node ${JSON.stringify(path.join(ROOT, "examples", "toy-sut", "adapter.mjs"))}`;
const SCRIPTED = `node ${JSON.stringify(path.join(ROOT, "test", "fixtures", "scripted-sut.mjs"))}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fde-bench-cli-test-"));
const STORE = path.join(tmp, "store");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cleanEnv = (extra: Record<string, string> = {}) => {
  const env = { ...process.env, FDE_BENCH_STORE: STORE, ...extra } as Record<string, string | undefined>;
  for (const k of ["ANTHROPIC_API_KEY", "FDE_JUDGE_SECRET", "FDE_JUDGE_ACCOUNT", "FDE_JUDGE_AWS_PROFILE", "FDE_BENCH_UNSEAL", "FDE_BENCH_TIMEOUTS", "FAKE_MODE"]) if (!(k in extra)) delete env[k];
  return env as NodeJS.ProcessEnv;
};
function cli(args: string[], env = cleanEnv()) {
  const r = spawnSync(process.execPath, [BIN, "run", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const lastResult = () => JSON.parse(fs.readFileSync(path.join(STORE, "results.jsonl"), "utf8").trim().split("\n").at(-1)!);

test("dev split with the toy SUT: per-scenario score + subscores, results.jsonl line, no leaks", () => {
  const r = cli(["--sut", TOY, "--pack", EXAMPLES, "--model-stub"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^fde-bench: dev, 1 scenario\(s\) x 1 run\(s\), sut toy-sut 0\.1\.0 \(toy\), model stub, judge stub/m);
  assert.match(r.stdout, /^s-example-dev\s+100\s+state 100 \| blocker 100 \| action 100 \| deadline 100 \| lesson 100/m);
  assert.match(r.stdout, /dev aggregate 100 over 1 scenario/);
  assert.doesNotMatch(r.stdout, /s-example-holdout/);
  assert.deepEqual(leaks(r.stdout + r.stderr, "s-example-dev"), []);
  assert.doesNotMatch(r.stdout, /\b[ef][1-9]\b/, "no expectation ids");
  const j = cli(["--sut", TOY, "--pack", EXAMPLES, "--model-stub", "--json"]);
  const out = JSON.parse(j.stdout);
  assert.equal(out.aggregate, 100);
  assert.equal(out.scenarios["s-example-dev"].byType.deadline, 100);
  assert.deepEqual(out.sut, { name: "toy-sut", version: "0.1.0", commit: "toy", capabilities: ["state", "actions", "deadlines", "lessons"] });
  assert.deepEqual(out.model, { sut: "stub", judge: "stub" });
  const last = lastResult();
  assert.equal(last.split, "dev");
  assert.equal(last.scores["s-example-dev"].score, 100);
  assert.match(last.packSha, /^dir:[0-9a-f]{64}$/);
  assert.deepEqual(last.sut, { name: "toy-sut", version: "0.1.0", commit: "toy" });
  const all = fs.readFileSync(path.join(STORE, "results.jsonl"), "utf8");
  assert.deepEqual(leaks(all, "s-example-dev"), [], "results.jsonl holds scores only");
});

test("--runs N prints the min-max band", () => {
  const r = cli(["--sut", TOY, "--pack", EXAMPLES, "--model-stub", "--runs", "2"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^s-example-dev\s+100 \(100-100\)/m);
  assert.match(r.stdout, /x 2 run\(s\)/);
});

test("holdout split: only the aggregate and the count (no scenario id, no subscores), and its guards", () => {
  for (const args of [[], ["--json"]]) {
    const r = cli(["--sut", TOY, "--pack", EXAMPLES, "--model-stub", "--split", "holdout", ...args]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /s-example/, "no scenario ids");
    assert.doesNotMatch(r.stdout, /state \d|byType|lesson \d/, "no per-type subscores");
    assert.deepEqual(leaks(r.stdout + r.stderr, "s-example-holdout"), []);
    if (args.length) {
      const j = JSON.parse(r.stdout);
      assert.equal(j.aggregate, 100);
      assert.equal(j.count, 1);
      assert.equal(j.scenarios, undefined);
    } else assert.match(r.stdout, /holdout aggregate 100 over 1 scenario/);
  }
  const last = lastResult();
  assert.equal(last.split, "holdout");
  assert.equal(last.scores, undefined);
  assert.deepEqual(leaks(fs.readFileSync(path.join(STORE, "results.jsonl"), "utf8"), "s-example-holdout"), []);
  assert.equal(cli(["--sut", TOY, "--pack", EXAMPLES, "--model-stub", "--split", "holdout", "--only", "s-example-holdout"]).code, 2, "--only is refused on holdout");
  assert.equal(cli(["--sut", TOY, "--pack", EXAMPLES, "--model-stub", "--split", "holdout", "--errors"]).code, 2, "--errors is refused on holdout");
});

test("the adapter's stderr and stray stdout are discarded, its error messages never printed (unless --errors, redacted)", () => {
  for (const split of ["dev", "holdout"]) {
    const id = `s-example-${split}`;
    const env = cleanEnv({ FAKE_MODE: "leak,fail:checkpoint:model:3,fail:ingest:sut:9" });
    const r = cli(["--sut", SCRIPTED, "--pack", EXAMPLES, "--model-stub", "--split", split], env);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /LEAK|failed on/);
    assert.deepEqual(leaks(r.stdout + r.stderr, id), []);
    assert.match(r.stderr, /WARNING: 2 of 2 checkpoint\(s\) were INVALID \(model 1, sut 1\)/);
    assert.match(r.stderr, /1 of them are SUT failures/);
    if (split === "dev") {
      const e = cli(["--sut", SCRIPTED, "--pack", EXAMPLES, "--model-stub", "--errors"], env);
      assert.equal(e.code, 0, e.stderr);
      assert.match(e.stderr, /\[errors\] 1x checkpoint \(model\) SutError: failed on: «redacted»/);
      assert.match(e.stderr, /\[errors\] \d+ non-protocol stdout line\(s\) from the adapter were ignored/);
      assert.deepEqual(leaks(e.stdout + e.stderr, id), []);
    }
  }
  assert.deepEqual(leaks(fs.readFileSync(path.join(STORE, "results.jsonl"), "utf8"), "s-example-dev"), []);
});

test("--debug-unsafe forwards the adapter's stderr and per-item results, and RETIRES the scenarios it ran", () => {
  const r = cli(["--sut", SCRIPTED, "--pack", EXAMPLES, "--model-stub", "--debug-unsafe"], cleanEnv({ FAKE_MODE: "leak" }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\[sut\] LEAK stderr:/);
  assert.match(r.stdout, /\[unsafe\] s-example-dev run 1 cp 3 expect e1/);
  assert.match(fs.readFileSync(path.join(STORE, "retired.txt"), "utf8"), /^s-example-dev\t/m);
  assert.equal(lastResult().debugUnsafe, true);
});

test("judge failures: those checkpoints are invalid, excluded, and the run warns loudly", () => {
  const j = cli(["--sut", TOY, "--pack", EXAMPLES, "--model-stub", "--json", "--errors"], cleanEnv({ FDE_BENCH_TEST_JUDGE_FAIL: "1" }));
  assert.equal(j.code, 0, j.stderr);
  const out = JSON.parse(j.stdout);
  assert.equal(out.invalid, 1, "only day 10 has an llm item");
  assert.deepEqual(out.invalidBy, { judge: 1 });
  assert.equal(out.aggregate, 100, "the valid checkpoint still counts");
  assert.match(j.stderr, /WARNING: 1 of 2 checkpoint\(s\) were INVALID \(judge 1\)/);
  assert.match(j.stderr, /\[errors\] 1x judge \(judge\) InternalServerError: 529 overloaded_error \(test\)/);
  assert.deepEqual(leaks(j.stdout + j.stderr, "s-example-dev"), []);
});

test("--errors on a malformed pack: validation issues as key paths, never a pack string", () => {
  const pack = fs.mkdtempSync(path.join(tmp, "pack-"));
  fs.cpSync(path.join(EXAMPLES, "scenarios"), path.join(pack, "scenarios"), { recursive: true });
  const bad = rub("s-example-dev");
  bad.checkpoints[0].expect[0].match.ownerName = bad.checkpoints[0].expect[0].description;
  fs.mkdirSync(path.join(pack, "scenarios", "s-bad"));
  fs.writeFileSync(path.join(pack, "scenarios", "s-bad", "scenario.json"), JSON.stringify({ ...scen("s-example-dev"), id: "s-bad" }));
  fs.writeFileSync(path.join(pack, "scenarios", "s-bad", "rubric.json"), JSON.stringify(bad));
  const r = cli(["--sut", TOY, "--pack", pack, "--model-stub", "--errors"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\[errors\] s-bad rubric\.json invalid: checkpoints\.\[0\]\.expect\.\[0\]\.match unrecognized_keys/);
  assert.match(r.stderr, /\[errors\] no runtime errors/);
  assert.match(r.stdout, /1 scenario\(s\) failed validation and are skipped/);
  assert.deepEqual(leaks(r.stdout + r.stderr, "s-example-dev"), []);
});

test("guards: --sut required, unknown flags, an adapter that doesn't answer hello, a timed-out adapter", () => {
  assert.equal(cli(["--pack", EXAMPLES, "--model-stub"]).code, 2);
  assert.equal(cli(["--sut", TOY, "--pack", EXAMPLES, "--model-stub", "--nope"]).code, 2);
  const dead = cli(["--sut", "exit 1", "--pack", EXAMPLES, "--model-stub"]);
  assert.equal(dead.code, 2);
  assert.match(dead.stderr, /did not answer hello \(transport: adapter exited/);
  const slow = cli(["--sut", SCRIPTED, "--pack", EXAMPLES, "--model-stub", "--json"], cleanEnv({ FAKE_MODE: "hang:checkpoint", FDE_BENCH_TIMEOUTS: "checkpoint=0.3" }));
  assert.equal(slow.code, 0, slow.stderr);
  const out = JSON.parse(slow.stdout);
  assert.equal(out.aggregate, null, "no valid checkpoint: no score");
  assert.deepEqual(out.invalidBy, { crash: 2 });
  assert.equal(cli(["--sut", TOY, "--pack", EXAMPLES, "--model-stub"], cleanEnv({ FDE_BENCH_TIMEOUTS: "bogus=1" })).code, 2);
});

test("cost guard: a real-model estimate over $5 needs --yes; the stub costs nothing; the judge needs a key", () => {
  const pack = fs.mkdtempSync(path.join(tmp, "pack-big-"));
  for (let i = 0; i < 10; i++) {
    const d = path.join(pack, "scenarios", `s-copy-${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "scenario.json"), JSON.stringify({ ...scen("s-example-dev"), id: `s-copy-${i}` }));
    fs.writeFileSync(path.join(d, "rubric.json"), JSON.stringify(rub("s-example-dev")));
  }
  const r = cli(["--sut", TOY, "--pack", pack]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /estimated \$\d+\.\d\d is over \$5: pass --yes/);
  assert.equal(cli(["--sut", TOY, "--pack", pack, "--model-stub", "--json"]).code, 0, "stub: $0, no guard");
  const k = cli(["--sut", TOY, "--pack", pack, "--yes"]);
  assert.equal(k.code, 2, "real mode with llm items and no judge key is refused");
  assert.match(k.stderr, /the LLM judge needs a key/);
  assert.equal(cli(["--sut", TOY, "--pack", pack, "--yes"], cleanEnv({ FDE_BENCH_COST_GUARD: "100" })).code, 2, "a raised guard passes the estimate, the key is still needed");
});

test("default input: runs the store's unseal script, reads sealed/pack.sha, removes the temp dir (success, refusal, SIGINT)", async () => {
  fs.mkdirSync(path.join(STORE, "sealed"), { recursive: true });
  fs.writeFileSync(path.join(STORE, "sealed", "pack.sha"), "abc123def456  pack.tar.gz.enc\n");
  // a flat temp dir
  const record = path.join(tmp, "unsealed-path.txt");
  const open1 = path.join(tmp, "open-flat.sh");
  fs.writeFileSync(open1, `#!/bin/bash\nset -e\nd=$(mktemp -d)\ncp -R "${EXAMPLES}/scenarios" "$d/"\necho "$d" > "${record}"\necho "unsealed into:"\necho "$d"\n`);
  const env1 = cleanEnv({ FDE_BENCH_UNSEAL: open1 });
  const r = cli(["--sut", TOY, "--model-stub", "--json"], env1);
  assert.equal(r.code, 0, r.stderr);
  const dir = fs.readFileSync(record, "utf8").trim();
  assert.ok(dir.length > 5 && !fs.existsSync(dir), `temp dir ${dir} was removed`);
  assert.equal(JSON.parse(r.stdout).packSha, "abc123def456");
  assert.equal(lastResult().source, "sealed");
  assert.ok(!r.stdout.includes(dir), "the temp path isn't echoed");
  const r2 = cli(["--sut", TOY, "--model-stub", "--only", "no-such-id"], env1);
  assert.equal(r2.code, 2);
  const dir2 = fs.readFileSync(record, "utf8").trim();
  assert.ok(dir2 !== dir && !fs.existsSync(dir2), "removed on refusal too");
  const r3 = cli(["--sut", "exit 1", "--model-stub"], env1);
  assert.equal(r3.code, 2, "refused at hello");
  assert.ok(!fs.existsSync(fs.readFileSync(record, "utf8").trim()), "removed before the adapter even starts");

  // the whole mktemp dir the script made (parent of work/)
  const recordP = path.join(tmp, "unsealed-parent.txt");
  const open2 = path.join(tmp, "open-work.sh");
  fs.writeFileSync(open2, `#!/bin/bash\nset -e\nd=$(mktemp -d "\${TMPDIR:-/tmp}/fde-bench.XXXXXX")\nmkdir -p "$d/work"\ncp -R "${EXAMPLES}/scenarios" "$d/work/"\necho "$d" > "${recordP}"\necho "$d/work"\n`);
  const env2 = cleanEnv({ FDE_BENCH_UNSEAL: open2 });
  const gone = () => {
    const d = fs.readFileSync(recordP, "utf8").trim();
    return { d, gone: d.length > 5 && !fs.existsSync(d) };
  };
  assert.equal(cli(["--sut", TOY, "--model-stub", "--json"], env2).code, 0);
  assert.ok(gone().gone, `success: ${gone().d} removed`);
  // SIGINT while the pack is unsealed
  const child = spawn(process.execPath, [BIN, "run", "--sut", TOY, "--model-stub"], { cwd: ROOT, env: { ...env2, FDE_BENCH_TEST_PAUSE_MS: "30000" } });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("never paused")), 60_000);
    child.stderr.on("data", (b) => {
      if (String(b).includes("paused after unseal")) {
        clearTimeout(t);
        res();
      }
    });
  });
  const unsealed = gone().d;
  assert.ok(fs.existsSync(path.join(unsealed, "work")), "unsealed while paused");
  child.kill("SIGINT");
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  assert.equal(code, 130);
  assert.ok(!fs.existsSync(unsealed), "SIGINT: removed");
});

test("seal / unseal wrappers call the store's scripts; help", () => {
  const store = path.join(tmp, "wrap-store");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "seal.sh"), `#!/bin/bash\necho sealed-ok\nexit 3\n`);
  const env = { ...cleanEnv(), FDE_BENCH_STORE: store };
  const s = spawnSync(process.execPath, [BIN, "seal"], { env, encoding: "utf8" });
  assert.equal(s.status, 3, "the script's exit code");
  assert.match(s.stdout, /sealed-ok/);
  const u = spawnSync(process.execPath, [BIN, "unseal"], { env, encoding: "utf8" });
  assert.equal(u.status, 2, "no unseal script: refused");
  const h = spawnSync(process.execPath, [BIN, "help"], { encoding: "utf8" });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /fde-bench run --sut/);
});
