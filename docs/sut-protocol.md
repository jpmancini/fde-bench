# System-under-test protocol (FDE-bench ↔ adapter)

FDE-bench scores a *system under test* (SUT): software that keeps a picture of a client engagement (state,
actions, deadlines, lessons, timeline) from the emails, call transcripts and documents that arrive over
time. FDE-bench never imports a SUT. It starts the SUT's **adapter** as a child process, one process per
scenario run, and talks to it in JSON Lines over stdin/stdout: one request object per line in, one response
object per line out, in order. stderr is free for the adapter's logs (FDE-bench discards it unless told
otherwise, because logs can carry scenario content).

The adapter is configured by FDE-bench's `--sut "<command>"` (e.g. `--sut "npx tsx /path/to/oldo/scripts/fde-adapter.ts"`)
and runs with cwd = the SUT's repo. Environment passed through: `FDE_MODEL_MODE` (`real` | `stub`),
`FDE_MAX_INFLIGHT`, plus whatever the SUT needs for its model access (e.g. `AWS_PROFILE`).

## Requests

Every request has `id` (echoed back) and `op`.

| op | fields | the adapter |
|---|---|---|
| `hello` | `protocol: 1` | answers `{ name, version, commit, capabilities: ["state","actions","deadlines","lessons","timeline","proofs","integrations"] }` (what its snapshots can contain) |
| `setup` | `scenario` (scenario.json minus engagements and checkpoints), `kickoffDate` (YYYY-MM-DD, day 0) | creates a fresh, isolated world: the provider (name `provider.name`, default "Mavnox"), customer, project (+ a "6-week project" template when `project.projectType` says so), people. Answers `{ ok: true }` |
| `ingest` | `engagement` ({day, kind, title, text, sourceUrl}), `at` (ISO date = kickoffDate + day) | stores it as an engagement dated `at`. No processing yet. Answers `{ ok: true }` |
| `checkpoint` | `day`, `today` (ISO date) | runs the SUT's own pipeline as it would in production for everything ingested so far (e.g. distill → plan), with "today" = `today`. Answers `{ ok: true, usage: [{model, input, output, cacheRead, cacheWrite}], warnings?: [] }` |
| `snapshot` | — | answers `{ snapshot }` in the shape below |
| `shutdown` | — | answers `{ ok: true }`, then exits 0 |

Errors: `{ id, ok: false, error: { kind: "transport" \| "model" \| "sut" \| "unsupported", message, retryable } }`.
`transport` / `model` (an API or rate-limit failure after the adapter's own retries) make FDE-bench mark the
checkpoint **invalid** (excluded from the score); `sut` (the system itself failed) also marks it invalid but
is reported separately; `unsupported` means a capability isn't there (its expectations score as failed).
Adapter messages must not quote scenario text (FDE-bench redacts what it prints anyway).

## Snapshot

```json
{ "parties": { "provider": "Mavnox", "customer": "…", "people": [{ "name": "…", "side": "client|provider" }] },
  "state":     [{ "id", "scope": "project|customer|provider", "category", "kind": "current|goal", "title", "detail?", "sources?": [] }],
  "actions":   [{ "id", "task", "detail?", "owner", "status": "todo|in_progress|blocked|done", "blockedReason?",
                  "priority?", "dueDate?", "dueDateSource?", "goalIds?": [], "dependsOn?": [] }],
  "deadlines": [{ "id", "what", "date", "source?" }],
  "lessons":   [{ "id", "title", "detail?", "route", "status" }],
  "timeline":  [{ "id", "title", "kind", "date", "endDate?", "status", "movedFrom?" }],
  "proofs":    [{ "id", "claim", "verdict" }],
  "integrations": [{ "id", "name", "kind", "status", "required", "waitingOn?" }],
  "engagements": [{ "id", "day", "kind", "title" }] }
```

Field names are FDE-bench's, not the SUT's: the adapter maps its own model onto them. A capability the SUT
lacks is an empty array plus its absence from `hello.capabilities`.

## Blindness

FDE-bench holds the sealed scenarios and rubrics; the adapter only ever receives one scenario's world
setup and engagements, one at a time, never a rubric. Engineers improving a SUT read this protocol and
their own adapter, never the sealed packs (see FDE-bench's README).
