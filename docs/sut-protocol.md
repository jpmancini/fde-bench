# System-under-test protocol (FDE-bench ↔ adapter)

FDE-bench scores a *system under test* (SUT): software that keeps a picture of a client engagement (state,
actions, deadlines, lessons, timeline) from the emails, call transcripts and documents that arrive over
time. FDE-bench never imports a SUT. It starts the SUT's **adapter** as a child process, one process per
scenario run, and talks to it in JSON Lines over stdin/stdout: one request object per line in, one response
object per line out, in order. stderr is free for the adapter's logs (FDE-bench discards it unless told
otherwise, because logs can carry scenario content).

The adapter is configured by FDE-bench's `--sut "<command>"` (e.g. `--sut "npx tsx scripts/fde-adapter.ts"`)
and runs with cwd = `--sut-cwd` (the SUT's repo). Environment passed through: `FDE_MODEL_MODE` (`real` |
`stub`), `FDE_MAX_INFLIGHT` (model calls the adapter may have in flight at once; default 4), plus whatever
the SUT needs for its model access (e.g. `AWS_PROFILE`), i.e. FDE-bench's own environment minus its
`FDE_BENCH_*` / `FDE_JUDGE_*` settings. In `stub` mode the adapter must use no model and no network;
FDE-bench also removes `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and
`ANTHROPIC_API_KEY` from its environment.

## Process and transport

- One adapter process per scenario run (plus one short-lived process at the start of a run that only answers
  `hello`). The process is started with `shell: true` in its own process group; after `shutdown` (or on any
  failure) FDE-bench kills the whole group, so the adapter's children go with it.
- **stdout carries protocol lines and nothing else.** A line that isn't JSON, or isn't the response to the
  pending request, is ignored and only counted (never printed). A SUT that logs with `console.log` must
  redirect it to stderr inside the adapter.
- One request at a time: FDE-bench writes the next request only after the previous response (or failure).
- Every response echoes the request's `id` (a string). Success: `{ id, ok: true, ... }` (for `hello` and
  `snapshot`, `ok` may be omitted). Failure: `{ id, ok: false, error: { kind, message, retryable } }`.
- Per-request timeouts (defaults; `FDE_BENCH_TIMEOUTS="checkpoint=900,setup=60"` overrides, in seconds):
  hello 60 s, setup 120 s, ingest 60 s, **checkpoint 30 min**, snapshot 120 s, shutdown 15 s. A timeout, the
  adapter exiting, or a broken pipe is a fatal `transport` failure: the process is killed and that
  checkpoint and every later one of the scenario run are invalid.

## Requests

Every request has `id` and `op`.

| op | fields | the adapter |
|---|---|---|
| `hello` | `protocol: 1` | answers `{ name, version, commit, capabilities: ["state","actions","deadlines","lessons","timeline","proofs","integrations"] }` (what its snapshots can contain; printed with the scores, so no scenario content) |
| `setup` | `scenario`, `kickoffDate`, `template?` | creates a fresh, isolated world: the provider firm `scenario.provider.name`, the customer, the project, the people. Answers `{ ok: true }` |
| `ingest` | `engagement` ({day, kind, title, text, sourceUrl?}), `at` | stores it as an engagement dated `at`. No processing yet. Answers `{ ok: true, engagementId? }` |
| `checkpoint` | `day`, `today` | runs the SUT's own pipeline as it would in production for everything ingested so far (e.g. distill → plan), with "today" = `today`. Answers `{ ok: true, usage: [{model, input, output, cacheRead, cacheWrite}], warnings?: [] }` |
| `snapshot` | — | answers `{ snapshot }` in the shape below |
| `shutdown` | — | answers `{ ok: true }`, then exits 0 |

- `setup.scenario` is the scenario file minus `engagements` and `checkpoints` (docs/schema.md): `id`,
  `split`, `title`, `kickoffDate?`, `provider` (FDE-bench fills in `{ name: "Mavnox" }` when the scenario
  names none), `customer`, `project`, `people`. Never a rubric.
- `setup.kickoffDate` (YYYY-MM-DD) is day 0 of the simulated clock (a Monday).
- `setup.template` is present when `project.projectType` names one of FDE-bench's project templates
  (`templates/*.json`; today only `"6-week project"`): its `goals`, `defaultActions` (task, owner,
  priority, goalKeys, offsetDays) and `timelineEvents` (offsets from the kickoff Monday), with the provider
  and customer names filled in. The SUT applies it, or its own equivalent, when it creates the project.
  `project.timelineAgreed: true` means the client has confirmed that timeline (its events may then date
  actions); otherwise it is a draft.
- `ingest.at` and `checkpoint.today` are YYYY-MM-DD (kickoffDate + day). Engagements arrive in day order;
  every engagement with `day <= d` is ingested before the checkpoint of day `d`.
- `ingest` should answer the SUT's id for the engagement as `engagementId`: FDE-bench checks due-date
  evidence that cites an engagement (`dueDateSource: "engagement <id>: '<quote>'"`) against the text it
  sent under that id. Without it, FDE-bench matches the snapshot's `engagements` list to what it sent by
  day, kind and title (the SUT may decorate the title, e.g. append a date).
- `checkpoint` runs on every pipeline day (the scenario's and the rubric's checkpoint days); the adapter is
  not told which ones are scored. `usage` lists every model call the pipeline made since the last
  checkpoint (model id as served; token counts), for cost; `[]` in stub mode. `warnings` are counted (and
  shown, redacted, with `--errors`).

## Errors

`kind`:

- `transport` / `model` (an API or rate-limit failure after the adapter's own retries): the next scored
  checkpoint is **invalid** (excluded from the score). On `snapshot`, that checkpoint is invalid.
- `sut` (the system itself failed): also invalid, but **reported separately** (a loud line in the output,
  `invalidBy.sut` in the JSON and results): it is the SUT's failure, so compare runs with it in mind. A
  snapshot that fails validation counts as a `sut` failure. An unknown `kind` counts as `sut`.
- `unsupported` (a capability isn't there): never invalidates; its expectations score as failed. An
  `unsupported` snapshot is scored as an empty one.
- A failure on `setup` makes every checkpoint of that run invalid.

`retryable` is informational (FDE-bench does not retry adapter requests: the adapter owns its retries).
Adapter messages must not quote scenario text (FDE-bench never prints them outside `--errors`, where it
redacts every pack string, and `--debug-unsafe`, which retires the scenarios it ran).

## Snapshot

```json
{ "parties": { "provider": "Mavnox", "customer": "…", "people": [{ "name": "…", "side": "client|provider" }] },
  "state":     [{ "id", "scope": "project|customer|provider", "category", "kind": "current|goal", "title", "detail?", "sources?": [] }],
  "actions":   [{ "id", "task", "detail?", "owner", "status": "todo|in_progress|blocked|done", "blockedReason?",
                  "priority?", "dueDate?", "dueDateSource?", "goalIds?": [], "dependsOn?": [] }],
  "deadlines": [{ "id", "what", "date", "quote?", "sources?": [] }],
  "lessons":   [{ "id", "title", "detail?", "route", "status" }],
  "timelineAgreed": false,
  "timeline":  [{ "id", "title", "detail?", "kind", "date", "endDate?", "status", "movedFrom?",
                  "offsetDays?", "recurring?", "occurrences?": { "<original date>": { "status", "date?" } } }],
  "proofs":    [{ "id", "claim", "verdict", "note?" }],
  "integrations": [{ "id", "name", "kind", "status", "required", "waitingOn?" }],
  "engagements": [{ "id", "day", "kind", "title" }] }
```

Field names are FDE-bench's, not the SUT's: the adapter maps its own model onto them. A capability the SUT
lacks is an empty array plus its absence from `hello.capabilities`. Missing arrays count as empty, `null`
as absent, unknown keys are dropped; a wrong shape (e.g. `state` not an array, an unknown `scope`) makes
the snapshot invalid (`sut`). What the fields mean for scoring (docs/schema.md has the matchers):

- `state.category`: `entity` | `interaction`; `kind`: `current` | `goal`. `detail` is searched with the title.
- `actions.owner`: a string naming a side, matched case-insensitively: it names the provider firm or a
  provider-side person (full or first name) → provider side; it names the customer, a client-side person,
  or a generic client role (`"Client: …"`) → client side; `"unassigned"` or both → neither.
  `priority`: `P0`–`P4`.
- `actions.dueDateSource` is the evidence for `dueDate`, and only three forms count as evidence:
  `"deadline <id>: …"` (a deadline in this snapshot with the same `date`), `"timeline event <id>: …"` (an
  event of this snapshot's timeline, `timelineAgreed: true`, not cancelled, whose `date` or `endDate` is
  the due date), `"engagement <id>: '<quote>'"` (the quoted words occur in the text FDE-bench sent as that
  engagement). Anything else is a due date with no evidence.
- `deadlines.quote`: the words of the engagement that state the deadline (searched with `what`). `source`
  is accepted as an older name for `quote`.
- `lessons.route`: e.g. `repo-check` | `feature-gotcha` | `one-off`; `status`: e.g. `captured`.
- `timeline`: `movedFrom` (the date before a move) or `status: "moved"` marks a moved event; an event is
  *slipped* when it moved later, when one of its `occurrences` (recurring events, keyed by original date)
  moved later, or when a non-recurring event's `date` is after kickoffDate + `offsetDays` (its planned day).
- `proofs.verdict`: e.g. `VERIFIED` | `REFUTED` | `UNVERIFIED`.
- `integrations` are recorded for future rubric types; no rubric type scores them yet.
- `parties` is informational: FDE-bench matches owners against the scenario's own provider, customer and
  people, never the SUT's.
- `engagements` lists what the SUT holds (no text needed: evidence is checked against what was sent).

## Blindness

FDE-bench holds the sealed scenarios and rubrics; the adapter only ever receives one scenario's world
setup and engagements, one at a time, never a rubric. Engineers improving a SUT read this protocol and
their own adapter, never the sealed packs (see FDE-bench's README).

## Clarifications in this revision (v1, compatible)

The first draft left these open; adapters written against it keep working:

1. stdout discipline, `id` echo, `ok` optional for `hello`/`snapshot`, per-request timeouts, process groups.
2. `ingest` may answer `engagementId` (recommended), and how evidence quotes are checked without it.
3. `setup.template` (the named project template, so every SUT gets the same plan) and `provider` always set.
4. Deadlines: `quote` (with `source` accepted as its alias) and `sources` (engagement ids).
5. Timeline: `timelineAgreed` (top level), and `detail` / `offsetDays` / `recurring` / `occurrences` for
   moved and slipped events. `proofs.note`.
6. The three `dueDateSource` evidence forms, and how owner strings are matched to sides.
7. Error handling of malformed snapshots, unknown kinds, `setup` failures and `unsupported` snapshots.
