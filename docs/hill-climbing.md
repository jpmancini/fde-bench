# Hill climbing a SUT against FDE-bench

How to use the scores to make a system better without fooling yourself. The rule in one line: **improve
from the SUT's own specs and tests and the dev scores; keep a change only when it beats the noise; confirm
on holdout rarely.**

## Dev vs holdout

- **dev** is the working split: per-scenario scores and per-type subscores (state, action, blocker,
  priority, deadline, lesson, timeline, proof). Run it as often as you like; it is what you climb.
- **holdout** prints only the aggregate and the count. It answers one question: did the gains on dev
  generalize? Every look at holdout that changes a decision spends it a little (you start fitting it), so
  run it at milestones (before shipping a batch of changes), never inside the inner loop, and never with
  `--only`.
- Neither split ever shows what a scenario contains. If you need to know why a scenario fails, you don't:
  read your system's behavior on your own tests, or ask the eval maintainer whether it's a harness problem
  (`--errors`, which shows only redacted error classes).

## Noise first

Real models are not deterministic. Before comparing anything:

1. `fde-bench run --sut … --model-stub` first: stub runs are deterministic and free; a stub-score change is
   a pipeline or adapter change, not model noise. Fix harness/adapter errors here (`--errors`).
2. Baseline: `fde-bench run --sut … --runs 2` (or 3) on the unchanged system. The per-scenario min–max and
   the spread of the aggregate across runs is your **noise band**.
3. Never compare runs that have invalid checkpoints (the runner warns loudly): an aggregate with excluded
   checkpoints is over a different test. Fix the cause (rate limits: lower `FDE_MAX_INFLIGHT`; timeouts:
   `FDE_BENCH_TIMEOUTS`) and re-run. SUT failures (`invalidBy.sut`) are the system's own fault: count them
   against it when comparing.

## The keep rule

A variant is kept when, against the baseline at the same pack hash (`packSha`) and judge model:

- the dev aggregate rises by more than the noise band, and
- no per-type subscore falls by more than the noise band, and
- it holds on a second run.

Everything else is reverted, however plausible the change looked. Record each decision with the
results.jsonl lines it rests on (`bench`, `sut.commit`, `packSha`).

## A swarm of variants

Hill climbing parallelizes well:

1. Write N candidate changes (prompts, planner rules, extraction code), each in its own git worktree of the
   SUT (`git worktree add ../sut-variant-3`), each with a one-line hypothesis.
2. Run the dev split against each: `fde-bench run --sut "<adapter>" --sut-cwd ../sut-variant-3 --runs 2 --json`.
   Mind the provider's rate limits: lower `FDE_MAX_INFLIGHT` per variant when several run at once.
3. Apply the keep rule to each against the shared baseline; merge the winners one at a time (re-running
   after each merge: wins don't always add up).
4. After a batch of merges, run holdout once. A dev gain that doesn't show on holdout is overfitting:
   revert to the last holdout-confirmed state and rethink.

Agents in the swarm follow the same blindness rules as people: they read the protocol, the SUT's code and
the scores, never the pack (the deny rules in this repo's `.claude/settings.json` and in the SUT's own
settings should cover the store).

## When the pack is used up

Scores near the ceiling, or a pack someone has seen, measure nothing. Retire scenarios that leaked
(`retired.txt`), and ask the pack builders for a fresh pack (docs/building-packs.md): new cards' worth of
scenarios at the same difficulty mix. Scores are only comparable within one `packSha`.
