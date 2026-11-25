#!/usr/bin/env node
// A misbehaving adapter for FDE-bench's own tests. It answers the protocol with an empty world, and
// FAKE_MODE (comma-separated) makes it misbehave:
//   fail:<op>:<kind>[:<day>]   answer that op (on that checkpoint day / engagement day) with an error of <kind>
//   hang:<op>                  never answer that op
//   exit:<op>                  exit(3) on that op
//   leak                       echo every engagement's text to stderr, as stdout noise, and in error messages
//   badsnap                    answer snapshot with a malformed snapshot
//   grandchild:<file>          start a long-sleeping grandchild and write its pid to <file>
//   usage                      report one model call's usage per checkpoint
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const modes = (process.env.FAKE_MODE ?? "").split(",").filter(Boolean).map((m) => m.split(":"));
const has = (k) => modes.find((m) => m[0] === k);
let lastText = "";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");

const gc = has("grandchild");
if (gc) {
  const c = spawn("sleep", ["300"], { stdio: "ignore" });
  writeFileSync(gc[1], String(c.pid));
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "ingest") lastText = req.engagement.text;
  if (has("leak")) {
    process.stderr.write(`LEAK stderr: ${lastText}\n`);
    process.stdout.write(`LEAK stdout: ${lastText}\n`);
    out({ id: "999", note: lastText });
  }
  const day = req.op === "checkpoint" ? req.day : req.op === "ingest" ? req.engagement.day : undefined;
  for (const m of modes) {
    if (m[0] === "hang" && m[1] === req.op) return;
    if (m[0] === "exit" && m[1] === req.op) process.exit(3);
    if (m[0] === "fail" && m[1] === req.op && (m[3] === undefined || Number(m[3]) === day))
      return out({ id: req.id, ok: false, error: { kind: m[2], message: has("leak") ? `failed on: ${lastText}` : `${m[2]} failure (test)`, retryable: m[2] === "transport" } });
  }
  switch (req.op) {
    case "hello":
      return out({ id: req.id, name: "scripted", version: "0", commit: "c0ffee", capabilities: ["state"] });
    case "checkpoint":
      return out({ id: req.id, ok: true, usage: has("usage") ? [{ model: "claude-opus-5-5", input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }] : [] });
    case "snapshot":
      return out({ id: req.id, snapshot: has("badsnap") ? { state: "nope" } : { state: [], actions: [] } });
    case "shutdown":
      out({ id: req.id, ok: true });
      return setImmediate(() => process.exit(0));
    default:
      return out({ id: req.id, ok: true });
  }
});
