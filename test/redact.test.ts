// Redaction for --errors (src/redact.ts): every pack string replaced, code-level wording (FDE-bench's own
// source and the SUT protocol) kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRedactor, codeVocabulary, REDACTED } from "../src/redact.ts";
import { ROOT, scen, rub, secrets, srcFiles } from "./helpers.ts";

const vocab = () => codeVocabulary([...srcFiles(path.join(ROOT, "src")), path.join(ROOT, "docs", "sut-protocol.md")], (f) => fs.readFileSync(f, "utf8"));

test("redactor: every pack string is replaced, code-level wording survives", () => {
  const s = scen("s-example-dev"), r = rub("s-example-dev");
  const red = makeRedactor([s, r], [s.id], vocab());
  const packText = JSON.stringify([s, r]).toLowerCase();
  for (const x of secrets("s-example-dev").filter((x) => packText.includes(x.toLowerCase()))) {
    const out = red(`TypeError: Cannot read properties of undefined (reading "${x}")`);
    assert.ok(!out.toLowerCase().includes(x.toLowerCase()), `leaked: ${out}`);
    assert.match(out, /TypeError: Cannot read properties of undefined/);
  }
  const line = s.engagements[0].text.split("\n").find((l: string) => l.trim().length > 20);
  assert.ok(red(`400 invalid_request_error: ${line}`).includes(REDACTED));
  assert.equal(red("529 overloaded_error: Overloaded"), "529 overloaded_error: Overloaded");
  assert.equal(red(`scenario ${s.id} failed`), `scenario ${s.id} failed`, "scenario ids are kept");
  // the client's own wording survives (short words of identifying leaves, like "out", may still be redacted: the safe side)
  assert.match(red("adapter timed out on checkpoint after 900s"), /^adapter timed .* on checkpoint after 900s$/);
});

test("redactor: an adapter message quoting the scenario is redacted, its protocol wording kept", () => {
  const s = scen("s-example-dev"), r = rub("s-example-dev");
  const red = makeRedactor([s, r], [s.id], vocab());
  const out = red(`sut failure on ingest: could not parse engagement "Re: catalog access" from Dana Thistlewood: We are waiting on the warehouse team`);
  for (const x of ["catalog access", "Dana", "Thistlewood", "warehouse"]) assert.ok(!out.toLowerCase().includes(x.toLowerCase()), `leaked ${x}: ${out}`);
  assert.match(out, /^sut failure on ingest: could .*parse engagement/, "protocol words survive");
});

test("code vocabulary: words of the files named, plus the base set", () => {
  const v = codeVocabulary(["/no/such/file"], () => {
    throw new Error("unreadable");
  });
  assert.ok(v.has("invalid") && v.has("timeout"));
  const w = codeVocabulary(["x"], () => "const snapshotTimeline = 'deadline'");
  assert.ok(w.has("snapshot") && w.has("timeline") && w.has("deadline"));
});
