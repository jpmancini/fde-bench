# FDE-bench

A blind benchmark for **forward-deployed-engineer software**: tools that keep an accurate picture of a
client engagement (what exists now, where it should end up, who owes what by when, what's blocked, what
the client corrected) from the emails, call transcripts and documents that arrive over weeks.

FDE-bench replays synthetic engagements into a *system under test* (SUT) day by day, asks it at
checkpoints what it believes, and scores the answer against a hidden rubric. It prints scores only. The
scenarios and rubrics are **sealed**: the people improving a SUT never see them, so a rising score means
the system got better, not that it memorized the test.

It was extracted from the blind-eval harness of [Oldo](#quick-start-with-oldo), a client-information hub,
and is system-agnostic: a SUT plugs in through a small adapter speaking JSON Lines over stdin/stdout
(docs/sut-protocol.md). FDE-bench never imports a SUT.

## Roles and blindness

| role | may read | must never |
|---|---|---|
| **SUT engineer** (anyone, human or agent, improving a system) | this repo, the protocol, their own adapter, the scores | read, list, decrypt or summarize a sealed pack; ask for per-expectation detail (`--debug-unsafe`) |
| **Eval maintainer** (keeps the harness honest) | the pack, `--errors` output (redacted), `--debug-unsafe` on retired scenarios | improve a SUT from what they read; let pack content reach a SUT engineer |
| **Pack builder** (mines, generates, audits, seals) | the firm's real history (read-only, in the mining step only) | put real names, quotes, numbers or dates in a pack; report anything but counts |

- A scenario whose rubric someone has seen is **retired** (`retired.txt`): a test you have seen measures
  memory, not the system. `--debug-unsafe` retires every scenario it runs, automatically.
- The output discipline is enforced in code: dev runs print per-scenario scores and per-type subscores;
  holdout runs print only the aggregate and the count. Never expectation ids or text, judge reasons,
  engagement text, SUT state or adapter messages. The adapter's stderr is discarded; its stray stdout is
  ignored. `--errors` (dev only) shows error classes with every pack string redacted.
- Agent harnesses opened in this repo get deny rules for the pack store (`.claude/settings.json`) and the
  rules in `AGENTS.md`.

**The hill-climbing rule**: improve the SUT from its own specs, its own tests and the scores; keep a
change when the dev aggregate rises beyond the noise band without any type subscore falling beyond it, and
confirm on holdout rarely, because every look at holdout spends it (docs/hill-climbing.md).

### Security and privacy

- **Never commit an unsealed pack**, pattern cards, real engagement data, `results.jsonl` or
  `retired.txt`. `.gitignore` covers `work/`, `packs/`, `sealed/`, those files and `.verify/`; keep packs
  in the store outside any repo.
- The judge's key comes from the environment only (`ANTHROPIC_API_KEY`, or a Secrets Manager secret named
  by `FDE_JUDGE_SECRET`); nothing in this repo points at anyone's infrastructure.
- Report a leak (a pack string in output, a sealed file in a commit) to the eval maintainer: the affected
  scenarios are retired and the pack is rebuilt.

## Quick start (toy SUT, no model, no keys)

```bash
npm install
npm test                                   # FDE-bench's own tests (uses the toy SUT)
node bin/fde-bench run --sut "node examples/toy-sut/adapter.mjs" --pack examples --model-stub
#  s-example-dev   100   state 100 | blocker 100 | action 100 | deadline 100 | lesson 100   $0.00   0.1s
#  dev aggregate 100 over 1 scenario(s) x 1 run(s); cost $0.00; 0s
```

`examples/toy-sut/adapter.mjs` (≈100 lines, keyword rules) is the reference adapter; `examples/scenarios/`
is the fictional public example (a dev and a holdout copy). `--pack examples` reads plaintext; without
`--pack` the runner unseals the store's pack itself.

## Quick start with Oldo

Oldo ships its adapter (`scripts/fde-adapter.ts` in the Oldo repo):

```bash
fde-bench run --sut "npx tsx scripts/fde-adapter.ts" --sut-cwd ~/Dev/Oldo --model-stub   # pipeline only, no model
fde-bench run --sut "npx tsx scripts/fde-adapter.ts" --sut-cwd ~/Dev/Oldo                # real models; cost-guarded
fde-bench run --sut "npx tsx scripts/fde-adapter.ts" --sut-cwd ~/Dev/Oldo --split holdout --json
```

(`npm link` in this repo puts `fde-bench` on your PATH; otherwise `node <this repo>/bin/fde-bench`.)

## CLI

```text
fde-bench run --sut "<command>" [--sut-cwd dir] [--split dev|holdout] [--only id,id] [--runs N]
              [--model-stub] [--errors] [--json] [--yes] [--debug-unsafe] [--pack dir]
fde-bench seal | unseal | help
```

- `--sut` the adapter command (run with a shell, cwd `--sut-cwd`); one process per scenario run.
- `--split` dev (default; per-scenario scores) or holdout (aggregate only). `--only` is dev-only.
- `--runs N` repeats each scenario (prints min–max): run twice to see the noise band.
- `--model-stub` no model anywhere: the adapter gets `FDE_MODEL_MODE=stub` (and no cloud credentials) and
  FDE-bench uses its deterministic stub judge. Stub scores are reproducible: use them to check the harness
  and the adapter before spending money.
- `--errors` dev-only redacted diagnosis on stderr (validation issues as key paths; error classes with
  counts, scenario ids and days). Retires nothing.
- `--yes` runs although the estimate is over the cost guard ($5, `FDE_BENCH_COST_GUARD`).
- `--debug-unsafe` per-expectation results, judge reasons and the adapter's stderr. Retires every scenario
  it runs. For the eval maintainer debugging the harness on retired or public scenarios.
- `seal` / `unseal` run the store's `seal.sh` / `unseal.sh` (pack builders and the eval maintainer only).

Exit codes: 0 ran, 2 refused (usage, guard, cost, an adapter that doesn't answer `hello`), 1 harness error.
Each run appends one line to `<store>/results.jsonl`: `{at, bench (commit), sut {name, version, commit},
packSha, source, split, runs, scores per id (dev only), aggregate, count, invalid, invalidBy?, checkpoints,
model, cost}`.

### Environment

| variable | default | |
|---|---|---|
| `FDE_BENCH_STORE` | `~/Dev/fde-bench-packs` | the pack store (seal.sh, unseal.sh, sealed/, results.jsonl, retired.txt) |
| `FDE_BENCH_UNSEAL` | `<store>/unseal.sh` | the unseal script |
| `FDE_JUDGE_MODEL` | `claude-opus-5-5` | the LLM judge's model |
| `ANTHROPIC_API_KEY` | | the judge's key; else `FDE_JUDGE_SECRET` |
| `FDE_JUDGE_SECRET` | | an AWS Secrets Manager secret holding the key (ambient AWS credentials, `AWS_REGION` default us-east-1) |
| `FDE_JUDGE_ACCOUNT` | | optional guard: the secret must live in this AWS account |
| `FDE_JUDGE_AWS_PROFILE` | | optional guard: `AWS_PROFILE` must be exactly this, with no env keys overriding it |
| `FDE_MAX_INFLIGHT` | 4 | passed to the adapter |
| `FDE_BENCH_TIMEOUTS` | | per-request timeouts, e.g. `checkpoint=900,setup=60` (seconds) |
| `FDE_BENCH_COST_GUARD` | 5 | dollars above which a run needs `--yes` |

The judge key is only needed for a real-model run whose rubrics have `judge: "llm"` items.

## Layout

```text
bin/fde-bench           CLI entry (tsx)
src/cli.ts              the runner: pack loading + unseal/cleanup, guards, the run loop, the report
src/sut.ts              the protocol client (spawn, JSON Lines, timeouts, error kinds, process groups)
src/replay.ts           one scenario over the protocol -> per-checkpoint results + invalid causes
src/score.ts            matchers and scores (pure)
src/judge.ts            the LLM judge, the stub judge, retries, the judge's key
src/redact.ts           --errors redaction
src/cost.ts             pricing and the up-front estimate
src/types.ts            scenario / rubric / snapshot schemas, the clock
src/templates.ts        project templates (templates/*.json) sent in setup
examples/               the toy SUT and the public example pack
docs/                   sut-protocol.md, schema.md, building-packs.md, hill-climbing.md
```

## Writing an adapter

Read docs/sut-protocol.md and `examples/toy-sut/adapter.mjs`. Run your adapter against the public
example with `--model-stub --debug-unsafe` (its scenarios are public, so nothing is spent) until it
answers every request; then run the sealed dev split without `--debug-unsafe`.

## License

MIT (LICENSE).
