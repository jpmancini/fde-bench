# Building a pack

A pack is built in four isolated steps, each by a different agent (or person) with different access, so
that no real data reaches a scenario and no scenario reaches a SUT engineer:

```text
real history ──(1) pattern miners──▶ pattern cards ──(2) generator──▶ scenarios + rubrics
   (read-only, per client)            (anonymized)        (cards only)        │
                                                                              ▼
                              sealed pack ◀──(4) seal── (3) privacy auditor (fixes in place)
```

Every step reports **counts only** back to whoever launched it (cards written, scenarios per split, issues
fixed), never content: the launcher may be the same session that later works on a SUT.

Work in the store's `work/` directory (outside any repo), and seal at the end; `seal.sh` removes `work/`.
Never build a pack inside a git repo, and never paste pack content into a chat that isn't the step's own.

## 1. Pattern miners (one per client)

- **Access**: read-only access to one client's real history at the firm: email threads, call notes and
  transcripts, documents, the firm's own project records. One miner per client, so no miner sees two
  clients' data and cards can't be cross-referenced.
- **Output**: anonymized pattern cards (`work/patterns/<id>.json`, format in docs/schema.md): what kind of
  thing happened, how it showed up, how long it took, what worked, what a good and a bad response looked
  like. No names, quotes, numbers, products, systems, places or dates.
- **Report**: the number of cards written per category. Nothing else.

Prompt (generalized):

> You are mining delivery patterns from one client engagement of a services firm, to build a benchmark.
> You have read-only access to this client's emails, call notes/transcripts and documents. Read them and
> identify recurring delivery situations: access delays, data-quality surprises, scope drift, unavailable
> stakeholders, slow approvals, churning requirements, integration surprises, slipping UAT, handoff gaps,
> commercial friction, and anything else that cost time or changed the plan.
> For each, write one pattern card (JSON, schema below) to `work/patterns/<new id>.json`. A card is
> ABSTRACT: it must not contain any name of a person, company, product, system or place, any quote, any
> number or figure, any date, or any detail specific enough to identify the client (an unusual industry
> fact, a distinctive event). Describe the situation the way a textbook on delivery management would.
> Merge occurrences of the same situation into one card and set `sourceCount` to how many distinct
> occurrences you saw. Do not write anything else to disk. When done, reply ONLY with the number of cards
> per category. Do not summarize the client, the cards or anything you read.
> Schema: <the pattern card schema from docs/schema.md>

## 2. The generator

- **Access**: the cards only (`work/patterns/`), the format (docs/schema.md), the protocol's snapshot
  (docs/sut-protocol.md) and the public example. **Never real data**, and never a miner's chat.
- **Output**: `work/scenarios/<id>/{scenario,rubric}.json` and `work/manifest.json`.
- **Difficulty mix** across the pack (roughly): 30% clear signals (a blocker stated plainly, a dated
  deadline), 40% realistic noise (the signal inside a long thread, a call transcript with small talk,
  two people disagreeing), 20% hard (a fact superseded later, a date that is *not* a commitment, a client
  preference that is *not* a correction, a resolved blocker that must stop being blocked), 10% quiet
  checkpoints where nothing should change (forbids only: no invented work, no duplicate actions).
- **Split**: dev and holdout (e.g. 2:1). **No card is used by both splits**, so holdout measures
  generalization to situations dev never showed.
- **Report**: scenario counts per split, cards used per split, expectation counts per type.

Prompt (generalized):

> You are writing synthetic client engagements for FDE-bench, a blind benchmark for software that keeps a
> services firm's picture of a client project from its emails, calls and documents. Inputs: the pattern
> cards in `work/patterns/` (abstract situations from real delivery work), the format in docs/schema.md
> and the public example in examples/scenarios/. Use NOTHING else: invent every company, person, product,
> place, number and date (fictional names; emails at example.com; URLs at example.invalid). Never reuse a
> distinctive phrase from a card verbatim in engagement text.
> Write <N> scenarios. Each is a 3-8 week project: a provider firm (default Mavnox) and a fictional client,
> engagements (emails, call transcripts with speakers, SOW or docs) on a day-by-day clock from a kickoff
> Monday, 3-6 checkpoints, and a rubric per checkpoint: what a strong forward-deployed engineer's records
> would show at that point (expect) and the classic failures (forbid): invented due dates, a lesson made
> from a blocker or a preference, duplicate actions, the wrong side owning a task. Weave 2-4 cards into
> each scenario, at the difficulty mix: <mix>. Make every rubric item testable from the snapshot fields
> alone, with tolerant `textAny` alternatives (and `judge: "llm"` only where wording can't be pinned).
> Assign split dev or holdout so that no card appears in both splits; list the cards in `patterns`.
> Write `work/manifest.json` (ids, splits, hashes, counts). Validate every file against the schema. Reply
> ONLY with counts: scenarios per split, cards per split, expectations per type.

Validate the output with the runner itself before auditing (plaintext, stub, a throwaway SUT):
`fde-bench run --sut "node examples/toy-sut/adapter.mjs" --pack <store>/work --model-stub --errors` should
report no validation issues (it prints key paths, never content).

## 3. The privacy auditor

- **Access**: the generated `work/` and, separately, the firm's real data (to build the deny-list), but it
  never copies real data into `work/`.
- **Checks**:
  1. **Deny-list from real data**: every person, company, product, system, place, domain and unusual term
     in the real history; any occurrence in `work/` is a finding.
  2. **Phrase overlap**: n-gram overlap (e.g. any 6+ word run) between engagement text and real
     emails/transcripts; any hit is a finding.
  3. **Re-identification**: could someone who knows the firm's clients tell which client a scenario is
     about (industry + size + a distinctive event + timeline)? If yes, generalize it.
  4. **Format**: every file validates; every rubric item is answerable from the snapshot fields.
- **Fixes in place**: the auditor rewrites the offending text in `work/` (and re-runs the checks), rather
  than reporting it to anyone.
- **Report**: counts only: findings per check, fixes made, files touched.

Prompt (generalized):

> You are the privacy auditor for a synthetic benchmark pack in `work/` (format: docs/schema.md). The pack
> must contain no real data. 1) Build a deny-list from the firm's real history you have read access to:
> names of people, companies, products, systems, places, email domains, and distinctive terms. Keep the
> deny-list in memory or in a temp file you delete; never write it into `work/`. 2) Search every string
> of `work/` for deny-list terms (case-insensitive, also inside words and emails). 3) Check phrase overlap:
> any run of 6+ consecutive words shared between engagement text and real text. 4) For each scenario, ask
> whether a person who knows the firm's clients could identify the client; if so, change industry, size,
> events or timeline until they couldn't. 5) Fix every finding IN PLACE (rewrite the text, keep the
> rubric consistent with it), then re-run checks 2-4 until clean, and validate the files. Reply ONLY with
> counts: findings per check, fixes, files touched. Do not quote any finding or any real or pack text.

## 4. Sealing

```bash
fde-bench run --sut "node examples/toy-sut/adapter.mjs" --pack <store>/work --model-stub --errors   # last format check
fde-bench seal          # <store>/seal.sh: work/ -> sealed/pack.tar.gz.enc + sealed/pack.sha, removes work/
```

- The key lives in the eval maintainer's keychain (or a secret manager), never in the store or a repo.
- `unseal.sh` decrypts into a fresh temp dir and prints its path (docs/schema.md): only the runner calls
  it during a run. A person running `fde-bench unseal` is the eval maintainer, reading the pack.
- Scores are reported against `sealed/pack.sha`; a new pack starts a new series of results.
- Scenarios someone has seen go into `retired.txt`; drop them from the next pack.
