# FDE-bench: rules for agents working in this repo

FDE-bench is a blind benchmark (README.md). Its value depends on nobody improving a system under test (SUT)
ever seeing the sealed scenarios and rubrics.

- **Never read, list, decrypt, summarize or copy a sealed pack** or its plaintext: the store
  (`$FDE_BENCH_STORE`, default `~/Dev/fde-bench-packs`: `work/`, `sealed/`, `unseal.sh`). Never run
  `fde-bench unseal`. Never run `--debug-unsafe` against the sealed pack (it prints rubric content and
  retires every scenario it runs). The deny rules in `.claude/settings.json` back this up; don't work
  around them.
- You build and test the **tooling** with the fictional public example (`examples/scenarios/`) and the toy
  SUT (`examples/toy-sut/`): `npm test`, `node bin/fde-bench run --sut "node examples/toy-sut/adapter.mjs"
  --pack examples --model-stub`.
- Output discipline is a feature: no change may print expectation ids or text, judge reasons, engagement
  text, adapter messages or SUT state outside `--debug-unsafe`, and holdout prints only the aggregate.
  Tests in `test/cli.test.ts` guard this; keep them passing and extend them with any new output.
- Keep the stub judge and `renderForJudge` byte-identical to `test/fixtures/oldo-judge-golden.json`
  (stub scores must stay reproducible); keep scoring semantics in `src/score.ts` unless docs/schema.md
  changes with it.
- The protocol (docs/sut-protocol.md) is a contract with adapters you don't own: change it compatibly and
  say so in its "Clarifications" section. The runner never imports a SUT.
- Public repo: no real client, person, product or system names, no account ids, ARNs, secret or bucket
  names, no absolute paths with a username, no pack content beyond the public example. Keys come from
  the environment only.
- If you are improving a SUT: read the protocol and your adapter, run the benchmark, read the scores
  (docs/hill-climbing.md). That is all the benchmark gives you, on purpose.
