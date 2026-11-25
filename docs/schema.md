# Pack format: scenarios, rubrics, pattern cards

A **pack** is a set of synthetic client engagements (scenarios), each with a hidden rubric, built from
anonymized patterns of real delivery work (docs/building-packs.md). This file is the public contract: the
format the runner validates (`src/types.ts`, strictly: an authoring mistake fails loudly instead of
silently scoring 0 or 100). Real packs are sealed (encrypted) outside this repo; the only plaintext pack
here is the fictional public example in `examples/scenarios/`.

## Store layout (outside the repo)

```text
$FDE_BENCH_STORE (default ~/Dev/fde-bench-packs)/
  seal.sh / unseal.sh        encrypt work/ -> sealed/pack.tar.gz.enc (key in the maintainer's keychain) /
                             decrypt into a fresh temp dir (mktemp, e.g. fde-bench.XXXXXX) and print its path
  sealed/pack.tar.gz.enc     the pack; sealed/pack.sha its hash (scores are reported against it)
  results.jsonl              one line per run (scores only)
  retired.txt                scenario ids whose rubric someone has seen (--debug-unsafe); never reuse them
  work/ (plaintext only while building; seal.sh removes it)
    patterns/<id>.json       anonymized pattern cards (mining output)
    scenarios/<id>/scenario.json   what the system under test sees (engagements arrive over days)
    scenarios/<id>/rubric.json     what it is scored on (never shown to the system under test)
    manifest.json            ids, splits (dev | holdout), hashes, counts
```

`unseal.sh` contract: write the plaintext pack (a dir holding `scenarios/`, or `work/scenarios/`) into a
new directory under the system temp dir and print that directory as the last absolute path on stdout. The
runner reads only that path and deletes it (and the mktemp dir around it) as soon as the pack is in memory.

## Pattern card (`patterns/<id>.json`)

Abstract: no names, quotes, numbers, products, places or dates from real work.

```json
{ "id": "p-…",
  "category": "access-delay | data-quality | scope-drift | stakeholder-unavailable | approval-latency | requirements-churn | integration-surprise | uat-slippage | handoff-gap | commercial | other",
  "trigger": "what sets it off",
  "signals": ["how it shows up in emails/calls"],
  "typicalDelay": "e.g. 3-10 business days",
  "escalation": ["what happens if ignored"],
  "resolution": ["what worked"],
  "goodResponse": ["what a good PM / agent does"],
  "badResponse": ["common mistakes"],
  "frequency": "rare | occasional | common",
  "sourceCount": 3 }
```

`sourceCount` is the number of distinct real occurrences behind the card (a card from one occurrence is a
re-identification risk: prefer 2+).

## Scenario (`scenarios/<id>/scenario.json`)

```json
{ "id": "s-…", "split": "dev | holdout", "title": "short, fictional", "kickoffDate": "YYYY-MM-DD (a Monday)",
  "provider": { "name": "optional; default Mavnox" },
  "customer": { "name": "fictional", "industry": "…" },
  "project": { "code": "XXX", "name": "…", "projectType": "6-week project | none", "kickoffOffsetDays": 0,
               "durationWeeks": "6 | null", "timelineAgreed": false },
  "people": [{ "name": "fictional", "side": "client | provider", "role": "…", "email": "…@example.com" }],
  "engagements": [{ "day": 3, "kind": "email | transcript | doc | sow | sow-draft | proposal | note", "title": "…", "text": "…", "sourceUrl": "https://example.invalid/…" }],
  "checkpoints": [3, 10, 17, 24] }
```

- `day` counts from the kickoff Monday (negative = before kickoff). Day 0 is the top-level `kickoffDate`;
  without it `project.kickoffDate`; else the Monday on or after 2027-01-04 + `kickoffOffsetDays`.
  Engagement text dates and rubric dates depend on it.
- `projectType` names a template in `templates/` (`"6-week project"`) or `"none"`; the runner sends the
  template to the SUT in `setup` (docs/sut-protocol.md). An unknown type makes the scenario's checkpoints
  invalid. `durationWeeks` is null for `"none"` (null = absent).
- `timelineAgreed: true` marks the template's timeline as confirmed by the client (its events can then
  evidence due dates); default draft.
- `checkpoints` are days the SUT's pipeline runs (a `checkpoint` request). The rubric's checkpoint days are
  added to them; only rubric days are scored. The SUT is not told which days are scored.
- Every name, company, product, place, URL and email is fictional (`example.invalid`, `example.com`).

## Rubric (`scenarios/<id>/rubric.json`, hidden)

```json
{ "checkpoints": [{ "afterDay": 10,
    "expect": [{ "id": "e1", "type": "state | action | deadline | lesson | blocker | priority | timeline | proof",
                 "description": "what must be true, in plain words",
                 "match": { "kind": "current|goal", "textAny": ["…"], "owner": "…", "priority": "P0|P1", "status": "blocked", "dueDate": "evidence-only" },
                 "weight": 1, "judge": "exact | llm" }],
    "forbid": [{ "id": "f1", "type": "action", "description": "e.g. a lesson for a preference; a due date with no evidence",
                 "match": { "dueDate": "unevidenced" }, "weight": 1, "judge": "exact | llm" }] }],
  "patterns": ["<pattern card ids it exercises>"] }
```

### Types

`state` → state items; `action`, `priority` → actions; `blocker` → actions with status `blocked`;
`deadline` → deadlines; `lesson` → lessons; `timeline` → timeline events; `proof` → proofs.

### Match keys

All optional, ANDed; strict (an unknown key fails validation).

| key | applies to | meaning |
|---|---|---|
| `textAny` | all | any of these terms, case-insensitive substring (whitespace squashed) or `"/regex/flags"`, over title + detail (state, lessons, events), task + detail (actions; + blockedReason for `blocker`), what + quote (deadlines), claim + note (proofs) |
| `scope` | state | `project` \| `customer` \| `provider` |
| `kind` | state | `current` \| `goal` |
| `category` | state | `entity` \| `interaction` |
| `owner` | actions | a person's full name = the owner string contains it; the customer's name = any client-side owner; `"provider"` = any provider-side owner (see the protocol for how sides are read) |
| `priority`, `status` | actions (status also lessons, events) | a value, `"a\|b"` or a list |
| `open` | actions | status is not `done` |
| `blockedReason` | actions | `true` (present), `false` (absent) or text it must contain |
| `dueDate` | actions | `evidence-only` (any date it has cites allowed evidence; no date is fine), `evidenced` (has one, cited), `unevidenced` (has one, not cited: use in forbid), `none`, `present`, or a YYYY-MM-DD |
| `date` | deadlines, events | exact date |
| `route` | lessons | e.g. `repo-check\|feature-gotcha` |
| `verdict` | proofs | e.g. `VERIFIED` |
| `moved`, `slipped` | events | the event (or an occurrence) moved; moved later than planned |
| `minCount` / `maxCount` | all | expect holds when the match count is within [minCount (default 1), maxCount]; a forbid hits at minCount (default 1) matches |

Allowed due-date evidence: a deadline with that date, an event of the **agreed** timeline, or an
engagement whose text (as sent) holds the quoted words. A date the SUT made up is never evidence.

### Judge

`judge: "exact"` uses the matchers above. `judge: "llm"` sends the item's `description` and a compact
rendering of the SUT's records of that type to FDE-bench's strict LLM judge ("when in doubt, it does not
hold"); in `--model-stub` runs the stub judge holds when any `textAny` term appears in that rendering, so
give llm items `textAny` terms too. A judge call that fails after its retries makes the checkpoint invalid.

### Scoring

- Checkpoint = 100 × (passed expect weight − hit forbid weight) / expect weight, clamped to 0–100; with
  only forbids, 100 × (1 − hit share).
- Per-type subscores: the same formula over all of a scenario's valid items of that type.
- Scenario = mean of its valid checkpoints; aggregate = mean of scenarios (and of runs).
- **Invalid checkpoints** (infrastructure or SUT failures per the protocol, judge errors) are excluded; a
  scenario with no valid checkpoint has no score and is left out of the aggregate. The output warns loudly
  and breaks the count down by cause (`transport`, `model`, `sut`, `judge`, `crash`).

## Authoring rules

- Each expectation tests one thing a good forward-deployed engineer would have right at that point, in
  plain words in `description`. Prefer `exact` with tolerant `textAny` alternatives; use `llm` for
  substance that wording can't pin down.
- Forbid the classic failures: invented due dates (`dueDate: "unevidenced"`), a lesson made out of a
  blocker or a preference, duplicate actions (`maxCount`), the wrong side owning a task.
- Mix difficulty (docs/building-packs.md): obvious signals, signals buried in long threads, contradictions
  resolved later, and quiet weeks where nothing should change.
