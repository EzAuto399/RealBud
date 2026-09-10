// Optional live hands: ask pinned Hermes `property` for ledger JSON.
// Any failure returns null rows plus a one-line reason. Desk holds —
// it never copies Demo values into a live check.
// Never passes --yolo. Never opens Desktop.
import { type ExecFileOptionsWithStringEncoding } from "node:child_process";

import { hardenHermesChildEnv } from "./drivers/acp/hermes.ts";
import { augmentedPath } from "./env-path.ts";
import { execFileCli } from "./procs.ts";

import type { LedgerFacts } from "../shared/contracts.ts";
import { asBoolean, asFiniteNumber, asNonEmptyString, asNullableNumber } from "./decode.ts";
import { HERMES_PIN, hermesCli, hermesIsCompatible } from "./hermes-pin.ts";
import { bootstrapPending } from "./worker-bootstrap.ts";
import { approvalsAreManual, hermesHome, packInstalled } from "./hermes-pack.ts";
import { probeHermesVersion, hermesReadinessFingerprint } from "./hermes-status.ts";
import { seedVault } from "./vault.ts";

export type HandsSource = "demo" | "hermes" | "held" | "csv" | "fixture";

export interface HermesLedgerAttempt {
  rows: LedgerFacts[] | null;
  /** Why we got rows (or why the live check missed). */
  detail: string;
}

export interface HermesPing {
  workerFingerprint?: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

const TIMEOUT_MS = 60_000;
const LEDGER_TIMEOUT_MS = 60_000;

/** Worker chatter that explains nothing about the miss to a PM. */
const WORKER_NOISE = [/^session_id:/i, /security scanner/i, /pattern matching only/i, /^warning:/i];

const WORKER_MISS_REASONS: Array<[RegExp, string]> = [
  [/UnrecognizedClient|invalid.?api.?key|incorrect api key|authentication|unauthori[sz]ed|\b401\b|\b403\b/i, "the model provider refused Bud's key; check the model connection on You"],
  [/insufficient|credit|billing|quota|\b402\b/i, "Billing or credits exhausted at the model provider"],
  [/rate.?limit|\b429\b|too many requests/i, "the model provider is rate-limiting; try again shortly"],
  [/no model|model (is )?not (set|configured)|missing model|api key (is )?(not set|missing)/i, "no model is connected; attach one on You"],
  [/ECONNREFUSED|ENOTFOUND|getaddrinfo|network|timed? ?out|unreachable/i, "the model provider could not be reached"],
];

/** One plain line a PM can act on. Raw provider output stays out of user chrome;
 * an unknown failure keeps its last meaningful line, single-line and bounded. */
export function workerMissReason(stdout: string, stderr: string): string {
  const lines = (s: string) =>
    String(s)
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !WORKER_NOISE.some((noise) => noise.test(line)));
  const all = [...lines(stdout), ...lines(stderr)];
  const text = all.join(" ");
  for (const [pattern, reason] of WORKER_MISS_REASONS) if (pattern.test(text)) return reason;
  const last = all.at(-1) ?? "";
  return last.length > 120 ? `${last.slice(0, 117)}…` : last;
}

export async function tryHermesPing(opts?: {
  cli?: string;
  timeoutMs?: number;
  root?: string;
  cwd?: string;
}): Promise<HermesPing> {
  const started = Date.now();
  let workerFingerprint: string | undefined;
  const done = (ok: boolean, detail: string): HermesPing => ({ ok, detail, elapsedMs: Date.now() - started, ...(workerFingerprint ? { workerFingerprint } : {}) });
  if (process.env.VITEST && !opts?.cli) return done(false, "tests do not ping the live worker");
  if (bootstrapPending(hermesHome(opts?.root))) return done(false, "Bud setup did not finish. Finish setup before checking the connection.");
  if (!packInstalled(opts?.root)) return done(false, "Bud is not set up — open Bud on You.");
  if (!approvalsAreManual(opts?.root)) {
    return done(false, "Bud's safeguards need attention — open Bud on You.");
  }
  const cli = opts?.cli ?? hermesCli();
  const version = await probeHermesVersion(cli);
  if (!version) return done(false, "Bud is not installed — install Bud on You.");
  if (!hermesIsCompatible(version)) {
    return done(false, "Bud needs an update — open Bud on You.");
  }

  workerFingerprint = hermesReadinessFingerprint(version, opts?.root);
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: augmentedPath() };
    hardenHermesChildEnv(env);
    const execOpts: ExecFileOptionsWithStringEncoding & { detached?: boolean } = {
      timeout: opts?.timeoutMs ?? TIMEOUT_MS,
      cwd: opts?.cwd ?? seedVault(),
      env,
      encoding: "utf8",
      detached: process.platform !== "win32",
    };
    const child = execFileCli(
      cli,
      ["--profile", HERMES_PIN.profile, "chat", "-Q", "--toolsets", "todo", "-q", "Reply with exactly one word: OK. Do not use tools.", "--max-turns", "1"],
      execOpts,
      (err, stdout, stderr) => {
        const clean = (s: string) =>
          String(s)
            .replace(/\x1b\[[0-9;]*m/g, "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !/^session_id:/.test(line));
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (timedOut && process.platform !== "win32") {
            try {
              process.kill(-child.pid!, "SIGTERM");
            } catch {}
          }
          if (timedOut) return resolve(done(false, "Bud took too long to answer."));
          const reason = workerMissReason(stdout, stderr);
          return resolve(done(false, reason ? `Bud could not answer — ${reason}.` : "Bud could not answer."));
        }
        const answer = clean(stdout).find((line) => line.trim().toUpperCase() === "OK");
        if (!answer) return resolve(done(false, "Bud answered, but not with OK — open the model connection on You."));
        resolve(done(true, "Bud answered OK — Recheck can ask for the morning ledger."));
      },
    );
  });
}

export function uncoveredPropertyIds(requested: string[], rows: LedgerFacts[]): string[] {
  const got = new Set(rows.map((row) => row.propertyId));
  return requested.filter((id) => !got.has(id));
}

export function parseLedgerFacts(text: string): LedgerFacts[] | null {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  // The worker reasons before answering, and that reasoning can quote the
  // instruction "return [] exactly" — so the FIRST bracket is often prose.
  // The answer is the LAST bracketed block; try candidates from the end.
  const starts: number[] = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    if (clean[i] === "[" || clean[i] === "{") starts.push(i);
  }
  for (const start of starts) {
    let raw = clean.slice(start).trim();
    const fence = raw.indexOf("```");
    if (fence > 0) raw = raw.slice(0, fence).trim();
    const rows = parseLedgerRows(raw);
    if (rows) return rows;
    // Trailing prose after the JSON: retry cut at the matching close bracket.
    const close = raw.startsWith("[") ? raw.lastIndexOf("]") : raw.startsWith("{") ? raw.lastIndexOf("}") : -1;
    if (close > 0) {
      const trimmed = parseLedgerRows(raw.slice(0, close + 1));
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function parseLedgerRows(raw: string): LedgerFacts[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const out: LedgerFacts[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      try {
        out.push({
          propertyId: asNonEmptyString(r.propertyId, "propertyId"),
          daysSinceDue: asFiniteNumber(r.daysSinceDue, "daysSinceDue"),
          rentLanded: asBoolean(r.rentLanded, "rentLanded"),
          levyPaid: asBoolean(r.levyPaid, "levyPaid"),
          daysSinceCourtesy: asNullableNumber(r.daysSinceCourtesy, "daysSinceCourtesy"),
        });
      } catch {
        return null;
      }
    }
    return out;
  } catch {
    return null;
  }
}

export async function tryHermesLedger(
  propertyIds: string[],
  opts?: { cli?: string; timeoutMs?: number; root?: string; cwd?: string },
): Promise<HermesLedgerAttempt> {
  const miss = (detail: string): HermesLedgerAttempt => ({ rows: null, detail });
  if (process.env.VITEST && !opts?.cli) return miss("tests do not use the live worker — unknown facts stay held");
  if (bootstrapPending(hermesHome(opts?.root))) return miss("Bud setup did not finish. Finish setup before checking property facts.");
  if (!packInstalled(opts?.root)) {
    return miss("Bud is not set up — open Bud on You. Facts stay held.");
  }
  if (!approvalsAreManual(opts?.root)) {
    return miss("Bud's safeguards need attention — open Bud on You. Facts stay held.");
  }
  const cli = opts?.cli ?? hermesCli();
  const version = await probeHermesVersion(cli);
  if (!version) return miss("Bud is not installed — install Bud on You. Facts stay held.");
  if (!hermesIsCompatible(version)) {
    return miss("Bud needs an update — open Bud on You. Facts stay held.");
  }

  const ids = propertyIds.length ? propertyIds.join(", ") : "(none)";
  const prompt =
    `Morning arrears check. Use skill morning-arrears.\n` +
    `Return JSON only — one object per property id you actually observed: ${ids}.\n` +
    `If a fact is unknown, omit that property. If none are observable, return [] exactly. Do not guess. Do not copy sample values.\n` +
    `The last line of your reply must be the JSON array (at minimum []), with no text after it.\n` +
    `Do not send, pay, or draft a statutory notice.`;

  return new Promise((resolve) => {
    const env = { ...process.env, PATH: augmentedPath() };
    hardenHermesChildEnv(env);
    const execOpts: ExecFileOptionsWithStringEncoding & { detached?: boolean } = {
      timeout: opts?.timeoutMs ?? LEDGER_TIMEOUT_MS,
      cwd: opts?.cwd ?? seedVault(),
      env,
      encoding: "utf8",
      detached: process.platform !== "win32",
    };
    const child = execFileCli(
      cli,
      ["--profile", HERMES_PIN.profile, "chat", "-Q", "-q", prompt, "--max-turns", "6"],
      execOpts,
      (err, stdout, stderr) => {
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (timedOut && process.platform !== "win32") {
            try {
              process.kill(-child.pid!, "SIGTERM");
            } catch {}
          }
          if (timedOut) return resolve(miss("Bud took too long — facts stay held."));
          const reason = workerMissReason(stdout, stderr);
          return resolve(
            miss(
              reason
                ? `Bud could not answer — ${reason}. Facts stay held.`
                : "Bud could not answer — facts stay held.",
            ),
          );
        }
        const rows = parseLedgerFacts(String(stdout));
        if (!rows) return resolve(miss("Bud answered without ledger facts — facts stay held."));
        if (rows.length === 0) return resolve(miss("Bud found no ledger facts — facts stay held."));
        resolve({ rows, detail: `Bud answered with ${rows.length} ledger rows.` });
      },
    );
  });
}
