// Redaction for the runner's --errors mode: an error message (an adapter error, a harness exception, an
// API error body, a judge failure) printed with every string that occurs in the loaded pack replaced by «redacted», so the
// eval maintainer sees error classes and code-level wording, never scenario or rubric content.
//
// What counts as pack content, from every string leaf of the raw scenario.json / rubric.json values:
//   - the leaf itself, each of its lines, and each clause (split on punctuation) of 4+ characters;
//   - every word of 3+ characters of an identifying leaf (names, titles, codes, emails, URLs, roles,
//     industries, owners, textAny terms) and every capitalized or digit-bearing word of 3+ characters
//     anywhere (proper nouns, product names, figures), and every other word of 4+ characters that the
//     code's own vocabulary (codeVocabulary: words of FDE-bench's src/ and the SUT protocol) doesn't use;
//   - any run of 2 consecutive words (one of 4+ letters) of the message that occurs as a run in the pack text.
// Scenario ids are not redacted (the runner already prints them).
export const REDACTED = "«redacted»";

const IDENT_KEYS = new Set(["name", "title", "code", "email", "sourceUrl", "role", "industry", "owner", "textAny", "description", "blockedReason", "fullName"]);
/** Enum-valued fields (format words like "email", "current", "llm"): not content. */
const ENUM_KEYS = new Set(["split", "kind", "type", "judge", "projectType", "side", "scope", "category", "status", "priority", "route", "verdict", "dueDate", "stateKind"]);
const norm = (s: string) => ` ${s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ")} `;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Redactor {
  (message: string): string;
  /** how many distinct fragments it knows (tests) */
  size: number;
}

/** Words the code itself uses (identifiers split on case, string literals), lowercased: an error message
 *  word in this set is code-level wording. Built from files the caller names (the runner: FDE-bench's src/ and docs/sut-protocol.md). */
export function codeVocabulary(files: string[], read: (f: string) => string): Set<string> {
  const out = new Set<string>(["error", "errors", "invalid", "expected", "received", "unrecognized", "required", "option", "options", "string", "number", "array", "object", "undefined", "null", "keys", "type", "request", "failed", "timeout", "overloaded", "rate", "limit"]);
  for (const f of files) {
    let t: string;
    try {
      t = read(f);
    } catch {
      continue;
    }
    for (const w of t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/)) if (w.length >= 3) out.add(w);
  }
  return out;
}

export function makeRedactor(values: unknown[], keep: string[] = [], code: Set<string> = new Set()): Redactor {
  const keepSet = new Set(keep.map((k) => k.toLowerCase()));
  const frags = new Set<string>();
  const vocab = new Set<string>();
  const corpus: string[] = [];
  const addFrag = (s: string) => {
    const t = s.trim();
    if (t.length >= 3 && !keepSet.has(t.toLowerCase())) frags.add(t.toLowerCase());
  };
  const leaf = (s: string, key: string | undefined) => {
    corpus.push(norm(s));
    addFrag(s);
    for (const line of s.split(/\n+/)) addFrag(line);
    for (const clause of s.split(/[.,;:!?()[\]{}"“”‘’\n]+/)) if (clause.trim().length >= 4) addFrag(clause);
    const ident = key !== undefined && IDENT_KEYS.has(key);
    for (const raw of s.split(/[^\p{L}\p{N}@._/'-]+/u)) {
      const w = raw.replace(/^[._/'-]+|[._/'-]+$/g, "");
      if (w.length < 3 || keepSet.has(w.toLowerCase())) continue;
      const lw = w.toLowerCase();
      // identifying words always; any other pack word of 4+ letters unless the code itself uses it
      // (an error message's own wording: "invalid", "expected", "engagement"...)
      if (ident || /\d/.test(w) || /[@/]/.test(w) || ((/^\p{Lu}/u.test(w) || w.length >= 4) && !code.has(lw))) vocab.add(lw);
    }
  };
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "string") leaf(v, key);
    else if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!ENUM_KEYS.has(k) && (k !== "id" || typeof x !== "string")) walk(x, k);
  };
  for (const v of values) walk(v);
  const text = corpus.join("\n");
  const sorted = [...frags].sort((a, b) => b.length - a.length);

  const redact = ((message: string) => {
    // kept strings (scenario ids) are swapped for placeholders while redacting, then restored
    const kept = [...keepSet].sort((a, b) => b.length - a.length);
    let out = message;
    kept.forEach((k, i) => (out = out.replace(new RegExp(esc(k), "gi"), `\u0000${i}\u0000`)));
    // 1. whole fragments (longest first), case-insensitive
    const low = () => out.toLowerCase();
    for (const f of sorted) {
      if (!low().includes(f)) continue;
      out = out.replace(new RegExp(esc(f), "gi"), REDACTED);
    }
    // 2. identifying words
    out = out.replace(/[\p{L}\p{N}@._/'-]+/gu, (w) => {
      const t = w.replace(/^[._/'-]+|[._/'-]+$/g, "").toLowerCase();
      return t.length >= 3 && vocab.has(t) ? REDACTED : w;
    });
    // 3. 3-word runs that occur in the pack
    const toks = out.split(/(\s+)/);
    const wordIdx = toks.map((t, i) => (/\S/.test(t) && t !== REDACTED ? i : -1)).filter((i) => i >= 0);
    const hit = new Set<number>();
    for (let k = 0; k + 1 < wordIdx.length; k++) {
      const run = wordIdx.slice(k, k + 2);
      const phrase = norm(run.map((i) => toks[i]).join(" "));
      const ws = phrase.trim().split(" ");
      if (ws.length >= 2 && ws.some((w) => w.length >= 4) && text.includes(phrase)) run.forEach((i) => hit.add(i));
    }
    for (const i of hit) toks[i] = REDACTED;
    const joined = toks.join("").replace(new RegExp(`(?:${esc(REDACTED)}[\\s,.:;'"-]*){2,}`, "g"), `${REDACTED} `).trim();
    return joined.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
  }) as Redactor;
  redact.size = sorted.length + vocab.size;
  return redact;
}
