// FDE-bench formats (docs/schema.md is the contract): what the system under test sees (scenario.json, minus
// its rubric) and what it is scored on (rubric.json), plus the SUT protocol's snapshot (docs/sut-protocol.md).
// Validated strictly so an authoring mistake fails loudly instead of silently scoring 0 or 100.
import * as z from "zod/v4";

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------------------------------------------------------------------------------------------------------
// Scenario + rubric (the pack)

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  split: z.enum(["dev", "holdout"]),
  title: z.string(),
  kickoffDate: Ymd.optional(), // Week 0's Monday = day 0 of the simulated clock (engagement text dates depend on it)
  provider: z.object({ name: z.string().min(1) }).optional(), // the firm running the engagement (default PROVIDER_NAME)
  customer: z.object({ name: z.string().min(1), industry: z.string().optional() }),
  project: z.object({
    code: z.string().min(1),
    name: z.string().min(1),
    projectType: z.string().default("none"), // "6-week project" | "none"
    kickoffOffsetDays: z.number().int().default(0),
    kickoffDate: Ymd.optional(), // used only when the top-level kickoffDate is absent (kickoffFor)
    durationWeeks: z.number().int().min(1).max(104).nullable().optional(), // null (projectType "none") = absent
    timelineAgreed: z.boolean().default(false),
  }),
  people: z.array(z.object({ name: z.string(), side: z.enum(["client", "provider"]), role: z.string().optional(), email: z.string().optional() })).default([]),
  engagements: z.array(
    z.object({
      day: z.number().int(),
      kind: z.enum(["email", "transcript", "doc", "sow", "sow-draft", "proposal", "note"]),
      title: z.string().min(1),
      text: z.string(),
      sourceUrl: z.string().optional(),
    })
  ),
  checkpoints: z.array(z.number().int()).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Engagement = Scenario["engagements"][number];

export const EXPECT_TYPES = ["state", "action", "deadline", "lesson", "blocker", "priority", "timeline", "proof"] as const;
export type ExpectType = (typeof EXPECT_TYPES)[number];

/** dueDate matcher values (besides an exact YYYY-MM-DD):
 *  evidence-only  any due date the item has cites allowed evidence (no date is fine)
 *  evidenced      it has a due date AND it cites allowed evidence
 *  unevidenced    it has a due date that does NOT cite allowed evidence (use in forbid)
 *  none           no due date;  present  any due date */
export const DUE_MATCHERS = ["evidence-only", "evidenced", "unevidenced", "none", "present"] as const;

const Alt = z.union([z.string(), z.array(z.string())]); // "P0|P1" or ["P0", "P1"]

export const MatchSchema = z
  .object({
    textAny: z.array(z.string()).optional(), // case-insensitive substrings, or "/regex/flags"
    scope: Alt.optional(), // state: project | customer | provider
    kind: Alt.optional(), // state: current | goal
    category: Alt.optional(), // state: entity | interaction
    owner: z.string().optional(), // action: a person's full name, the client company's name (any client-side owner) or "provider" (any provider-side owner)
    priority: Alt.optional(),
    status: Alt.optional(), // action / lesson / timeline event status
    open: z.boolean().optional(), // action: status is not done
    blockedReason: z.union([z.boolean(), z.string()]).optional(), // true = present; a string = contains
    dueDate: z.union([z.enum(DUE_MATCHERS), Ymd]).optional(),
    date: Ymd.optional(), // deadline date / timeline event date
    route: Alt.optional(), // lesson route
    verdict: Alt.optional(), // proof verdict
    moved: z.boolean().optional(), // timeline: the event (or one occurrence) was moved
    slipped: z.boolean().optional(), // timeline: moved later than planned
    minCount: z.number().int().min(0).optional(), // default 1
    maxCount: z.number().int().min(0).optional(),
  })
  .strict();
export type Match = z.infer<typeof MatchSchema>;

const ItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(EXPECT_TYPES),
    description: z.string().min(1),
    match: MatchSchema.default({}),
    weight: z.number().positive().default(1),
    judge: z.enum(["exact", "llm"]).default("exact"),
  })
  .strict();
export type RubricItem = z.infer<typeof ItemSchema>;

export const RubricSchema = z.object({
  checkpoints: z.array(z.object({ afterDay: z.number().int(), expect: z.array(ItemSchema).default([]), forbid: z.array(ItemSchema).default([]) })),
  patterns: z.array(z.string()).default([]),
});
export type Rubric = z.infer<typeof RubricSchema>;
export type RubricCheckpoint = Rubric["checkpoints"][number];

// ---------------------------------------------------------------------------------------------------------
// The clock

/** Week 0's Monday when a scenario names no kickoffDate (fixed, so runs are comparable). */
export const BASE_KICKOFF = "2027-01-04";
/** The provider firm when a scenario names none (the packs were written with this firm as the provider). */
export const PROVIDER_NAME = "Mavnox";

export const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** Day 0: the scenario's kickoffDate, else project.kickoffDate, else the Monday on or after BASE_KICKOFF + kickoffOffsetDays. */
export function kickoffFor(sc: Pick<Scenario, "project"> & { kickoffDate?: string }): string {
  if (sc.kickoffDate) return sc.kickoffDate;
  if (sc.project.kickoffDate) return sc.project.kickoffDate;
  const d = addDays(BASE_KICKOFF, sc.project.kickoffOffsetDays ?? 0);
  const wd = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(d, wd ? 7 - wd : 0);
}

/** Every day the SUT's pipeline runs (a `checkpoint` request): the scenario's checkpoints and the rubric's, in order. */
export function pipelineDays(sc: Pick<Scenario, "checkpoints">, rubric: Pick<Rubric, "checkpoints">): number[] {
  return [...new Set([...sc.checkpoints, ...rubric.checkpoints.map((c) => c.afterDay)])].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------------
// The protocol snapshot (docs/sut-protocol.md). Unknown keys are dropped; missing arrays are empty.

const Str = z.string();
const OptStr = z.string().nullish().transform((v) => v ?? undefined);
const Ids = z.array(z.string()).nullish().transform((v) => v ?? []);
const arr = <T extends z.ZodType>(t: T) => z.array(t).nullish().transform((v) => (v ?? []) as z.infer<T>[]);

export const SnapshotSchema = z.object({
  parties: z.object({ provider: Str, customer: Str, people: z.array(z.object({ name: Str, side: z.enum(["client", "provider"]) })).default([]) }).nullish(),
  state: arr(z.object({ id: Str, scope: z.enum(["project", "customer", "provider"]), category: z.string().default(""), kind: z.string().default(""), title: Str, detail: OptStr, sources: Ids })),
  actions: arr(
    z.object({ id: Str, task: Str, detail: OptStr, owner: z.string().default("unassigned"), status: Str, blockedReason: OptStr, priority: OptStr, dueDate: OptStr, dueDateSource: OptStr, goalIds: Ids, dependsOn: Ids })
  ),
  deadlines: arr(z.object({ id: Str, what: Str, date: Str, quote: OptStr, source: OptStr, sources: Ids })),
  lessons: arr(z.object({ id: Str, title: Str, detail: OptStr, route: Str, status: Str })),
  timelineAgreed: z.boolean().nullish().transform((v) => !!v),
  timeline: arr(
    z.object({
      id: Str,
      title: Str,
      detail: OptStr,
      kind: z.string().default(""),
      date: Str,
      endDate: OptStr,
      status: Str,
      movedFrom: OptStr,
      offsetDays: z.number().int().nullish().transform((v) => v ?? undefined),
      recurring: z.boolean().nullish().transform((v) => !!v),
      occurrences: z.record(z.string(), z.object({ status: Str, date: OptStr })).nullish().transform((v) => v ?? undefined),
    })
  ),
  proofs: arr(z.object({ id: Str, claim: Str, verdict: Str, note: OptStr })),
  integrations: arr(z.object({ id: Str, name: Str, kind: z.string().default(""), status: Str, required: z.boolean().default(false), waitingOn: OptStr })),
  engagements: arr(z.object({ id: Str, day: z.number().int().nullish(), kind: OptStr, title: z.string().default("") })),
});
export type ProtocolSnapshot = z.infer<typeof SnapshotSchema>;
