#!/usr/bin/env node
// A tiny deterministic FDE-bench adapter (docs/sut-protocol.md): keyword rules, no model, no storage. It
// exists so FDE-bench can be tested without a real system, and as a reference for adapter authors.
//   - every engagement -> a current state item (a line with "waiting on" -> "Blocked: <line>" + a blocked
//     action owned by the sender); a goal per "Goal: <text>" line;
//   - a line with "by|due|before YYYY-MM-DD" -> a deadline (that line is its quote) + an action dated by it;
//   - a line saying something "is|was|are wrong" -> a lesson routed to a repo check;
//   - the project template FDE-bench sends in setup (if any) -> its goals and default actions.
// Logs go to stderr only: stdout carries protocol lines and nothing else.
import { createInterface } from "node:readline";

let world = null;
const reply = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);

function setup(scenario, kickoffDate, template) {
  const provider = scenario.provider?.name ?? "Mavnox";
  world = { scenario, kickoffDate, provider, n: 0, inbox: [], engagements: [], state: [], actions: [], deadlines: [], lessons: [] };
  const id = (p) => `${p}${++world.n}`;
  world.id = id;
  const goals = {}; // the template's goals and default actions, as FDE-bench sent them (names filled in)
  for (const g of template?.goals ?? []) world.state.push((goals[g.key] = { id: id("s"), scope: "project", category: "entity", kind: "goal", title: g.title, sources: [] }));
  for (const a of template?.defaultActions ?? [])
    world.actions.push({ id: id("a"), task: a.task, owner: a.owner, status: "todo", priority: a.priority, goalIds: a.goalKeys.map((k) => goals[k]?.id).filter(Boolean), dependsOn: [] });
}

/** Who wrote it ("From: Name <addr>"), as an owner string naming their side. */
function ownerOf(text) {
  const name = text.match(/^From:\s*([^<\n]+?)\s*</m)?.[1];
  if (!name) return "unassigned";
  const p = world.scenario.people?.find((x) => x.name === name);
  return p?.side === "client" ? `${world.scenario.customer.name}: ${name}` : p?.side === "provider" ? `${world.provider}: ${name}` : name;
}

function distill(e) {
  const lines = e.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const goalId = () => world.state.find((s) => s.kind === "goal")?.id;
  const waiting = lines.find((l) => /\bwaiting on\b/i.test(l));
  if (waiting) {
    world.state.push({ id: world.id("s"), scope: "project", category: "interaction", kind: "current", title: cut(`Blocked: ${waiting}`, 120), sources: [e.id] });
    world.actions.push({ id: world.id("a"), task: cut(`Unblock: ${waiting}`, 120), owner: ownerOf(e.text), status: "blocked", blockedReason: waiting, priority: "P0", goalIds: [goalId()].filter(Boolean), dependsOn: [] });
  } else world.state.push({ id: world.id("s"), scope: "project", category: "entity", kind: "current", title: e.title, detail: cut(e.text, 400), sources: [e.id] });
  for (const l of lines) {
    const g = l.match(/^Goal:\s*(.+)$/i);
    if (g) world.state.push({ id: world.id("s"), scope: "project", category: "entity", kind: "goal", title: cut(g[1], 120), sources: [e.id] });
    const d = l.match(/\b(?:by|due|before)\s+(\d{4}-\d{2}-\d{2})\b/i);
    if (d && !world.deadlines.some((x) => x.date === d[1])) {
      const dl = { id: world.id("d"), what: cut(l.replace(/^[-*]\s*/, ""), 80), date: d[1], quote: l, sources: [e.id] };
      world.deadlines.push(dl);
      world.actions.push({ id: world.id("a"), task: cut(`Meet deadline: ${dl.what}`, 120), owner: "unassigned", status: "todo", priority: "P1", dueDate: dl.date, dueDateSource: `deadline ${dl.id}: ${dl.what} ${dl.date}`, goalIds: [goalId()].filter(Boolean), dependsOn: [] });
    }
    if (/\b(?:is|was|are)\s+wrong\b/i.test(l)) world.lessons.push({ id: world.id("l"), title: cut(`Client correction: ${l}`, 120), route: "repo-check", status: "captured" });
  }
}

function handle(req) {
  switch (req.op) {
    case "hello":
      return { name: "toy-sut", version: "0.1.0", commit: "toy", capabilities: ["state", "actions", "deadlines", "lessons"] };
    case "setup":
      setup(req.scenario, req.kickoffDate, req.template);
      return { ok: true };
    case "ingest": {
      if (!world) throw Object.assign(new Error("ingest before setup"), { kind: "sut" });
      const e = { ...req.engagement, id: `eng-${world.engagements.length + 1}`, at: req.at };
      world.engagements.push(e);
      world.inbox.push(e);
      return { ok: true, engagementId: e.id };
    }
    case "checkpoint":
      for (const e of world.inbox.splice(0)) distill(e);
      return { ok: true, usage: [] };
    case "snapshot": {
      const { provider, scenario, state, actions, deadlines, lessons, engagements } = world;
      const people = (scenario.people ?? []).map((p) => ({ name: p.name, side: p.side }));
      return { snapshot: { parties: { provider, customer: scenario.customer.name, people }, state, actions, deadlines, lessons, timeline: [], proofs: [], integrations: [], engagements: engagements.map(({ id, day, kind, title }) => ({ id, day, kind, title })) } };
    }
    case "shutdown":
      setImmediate(() => process.exit(0));
      return { ok: true };
    default:
      throw Object.assign(new Error(`unknown op ${req.op}`), { kind: "unsupported" });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return process.stderr.write("toy-sut: unparseable request\n");
  }
  try {
    reply({ id: req.id, ...handle(req) });
  } catch (e) {
    reply({ id: req.id, ok: false, error: { kind: e.kind ?? "sut", message: e.message, retryable: false } });
  }
});
