// The SUT protocol client (docs/sut-protocol.md): FDE-bench never imports a system under test. It starts the
// SUT's adapter (`--sut "<command>"`, cwd `--sut-cwd`) as a child process, one per scenario run, and talks
// JSON Lines over stdin/stdout, one request at a time, each with its own timeout.
//
//   - stderr is DISCARDED (adapter logs can carry scenario content) unless debugStderr (--debug-unsafe).
//   - stdout lines that aren't a JSON response to the pending request are ignored and only counted (never
//     printed: a stray console.log in the SUT can carry content too).
//   - an `ok: false` answer becomes a SutError of the adapter's kind (an unknown kind counts as "sut");
//     a timeout, an unparseable world (the adapter exited, a write failed) is a FATAL "transport" error:
//     the process is killed and every later request fails at once.
//   - the adapter runs in its own process group, killed as a whole on close (and when FDE-bench exits).
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Usage } from "./cost.ts";

export const PROTOCOL = 1;
export const OPS = ["hello", "setup", "ingest", "checkpoint", "snapshot", "shutdown"] as const;
export type Op = (typeof OPS)[number];
export const ERROR_KINDS = ["transport", "model", "sut", "unsupported"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];
export const CAPABILITIES = ["state", "actions", "deadlines", "lessons", "timeline", "proofs", "integrations"] as const;

/** Default per-request timeouts (ms). FDE_BENCH_TIMEOUTS="checkpoint=900,setup=60" overrides (seconds). */
export const DEFAULT_TIMEOUTS: Record<Op, number> = {
  hello: 60_000,
  setup: 120_000,
  ingest: 60_000,
  checkpoint: 30 * 60_000,
  snapshot: 120_000,
  shutdown: 15_000,
};

export function parseTimeouts(spec: string | undefined): Partial<Record<Op, number>> {
  const out: Partial<Record<Op, number>> = {};
  for (const part of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split("=").map((s) => s.trim());
    const n = Number(v);
    if (!(OPS as readonly string[]).includes(k) || !Number.isFinite(n) || n <= 0) throw new Error(`bad FDE_BENCH_TIMEOUTS entry "${part}" (op=seconds; ops: ${OPS.join(", ")})`);
    out[k as Op] = n * 1000;
  }
  return out;
}

export class SutError extends Error {
  kind: ErrorKind;
  op: Op;
  retryable: boolean;
  /** the adapter is gone (timeout, exit, broken pipe): nothing more can be asked of it */
  fatal: boolean;
  constructor(op: Op, kind: ErrorKind, message: string, o: { retryable?: boolean; fatal?: boolean } = {}) {
    super(message);
    this.name = "SutError";
    this.op = op;
    this.kind = kind;
    this.retryable = !!o.retryable;
    this.fatal = !!o.fatal;
  }
}

export interface Hello { name: string; version: string; commit: string; capabilities: string[] }

export interface SutOptions {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** --debug-unsafe: forward the adapter's stderr (prefixed) instead of discarding it */
  debugStderr?: boolean;
  timeouts?: Partial<Record<Op, number>>;
}

const live = new Set<SutClient>();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const c of live) c.kill();
  });
}

const usageNum = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
/** The checkpoint's usage[], tolerantly (a malformed entry counts as nothing rather than failing the run). */
export function parseUsage(u: unknown): Usage[] {
  if (!Array.isArray(u)) return [];
  return u.filter((x) => x && typeof x === "object").map((x: any) => ({ model: typeof x.model === "string" ? x.model : "unknown", input: usageNum(x.input), output: usageNum(x.output), cacheRead: usageNum(x.cacheRead), cacheWrite: usageNum(x.cacheWrite) }));
}

export class SutClient {
  /** stdout lines that weren't a response to the pending request (ignored, never printed) */
  noiseLines = 0;
  private child: ChildProcess;
  private timeouts: Record<Op, number>;
  private nextId = 1;
  private pending: { id: string; op: Op; resolve: (v: any) => void; reject: (e: SutError) => void; timer: NodeJS.Timeout } | null = null;
  private dead: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private exited: Promise<void>;

  constructor(o: SutOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...o.timeouts };
    this.child = spawn(o.command, { shell: true, cwd: o.cwd, env: o.env ?? process.env, stdio: ["pipe", "pipe", o.debugStderr ? "pipe" : "ignore"], detached: true });
    live.add(this);
    hookExit();
    this.exited = new Promise((r) => this.child.once("exit", () => r()));
    this.child.once("error", (e) => this.die(`adapter could not start (${(e as NodeJS.ErrnoException).code ?? e.name})`));
    this.child.once("exit", (code, sig) => this.die(`adapter exited (${sig ?? `code ${code}`})`));
    this.child.stdin!.on("error", () => this.die("adapter stdin closed"));
    if (o.debugStderr) createInterface({ input: this.child.stderr! }).on("line", (l) => process.stderr.write(`[sut] ${l}\n`));
    createInterface({ input: this.child.stdout!, crlfDelay: Infinity }).on("line", (l) => this.onLine(l));
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.noiseLines++;
      return;
    }
    const p = this.pending;
    if (!p || !msg || typeof msg !== "object" || String(msg.id) !== p.id) {
      this.noiseLines++;
      return;
    }
    this.pending = null;
    clearTimeout(p.timer);
    if (msg.ok === false) {
      const e = msg.error && typeof msg.error === "object" ? msg.error : {};
      const kind: ErrorKind = (ERROR_KINDS as readonly string[]).includes(e.kind) ? e.kind : "sut";
      p.reject(new SutError(p.op, kind, typeof e.message === "string" ? e.message : "(no message)", { retryable: !!e.retryable }));
    } else p.resolve(msg);
  }

  private die(why: string) {
    if (this.dead) return;
    this.dead = why;
    live.delete(this);
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new SutError(p.op, "transport", why, { fatal: true }));
    }
  }

  /** One request, after the previous one has settled. Resolves the response; rejects with a SutError. */
  request(op: Op, fields: Record<string, unknown> = {}): Promise<any> {
    const run = () =>
      new Promise<any>((resolve, reject) => {
        if (this.dead) return reject(new SutError(op, "transport", this.dead, { fatal: true }));
        const id = String(this.nextId++);
        const timer = setTimeout(() => {
          this.kill();
          this.die(`adapter timed out on ${op} after ${Math.round(this.timeouts[op] / 1000)}s`);
        }, this.timeouts[op]);
        this.pending = { id, op, resolve, reject, timer };
        try {
          this.child.stdin!.write(JSON.stringify({ id, op, ...fields }) + "\n");
        } catch {
          this.die("adapter stdin closed");
        }
      });
    const r = this.chain.then(run, run);
    this.chain = r.catch(() => {});
    return r;
  }

  async hello(): Promise<Hello> {
    const r = await this.request("hello", { protocol: PROTOCOL });
    const s = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : d);
    return { name: s(r.name, "unknown"), version: s(r.version, "?"), commit: s(r.commit, "unknown"), capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((c: unknown): c is string => typeof c === "string") : [] };
  }

  /** Ask the adapter to exit, then make sure it did (the whole process group). */
  async close(): Promise<void> {
    if (!this.dead) {
      try {
        await this.request("shutdown");
      } catch {
        /* it is killed below either way */
      }
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    this.kill();
  }

  private killed = false;
  /** SIGKILL the adapter's whole process group (a shell's or npx's children too). */
  kill() {
    live.delete(this);
    if (this.killed) return;
    this.killed = true;
    const pid = this.child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}
