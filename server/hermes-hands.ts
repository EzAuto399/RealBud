// Optional live hands: ask pinned Hermes `property` for ledger JSON.
// Any failure returns null rows plus a one-line reason. Desk holds —
// it never copies Demo values into a live check.
// Never passes --yolo. Never opens Desktop.
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";

import { hardenHermesChildEnv } from "./drivers/acp/hermes.ts";
import { augmentedPath } from "./env-path.ts";

import type { LedgerFacts } from "../shared/contracts.ts";
import { asBoolean, asFiniteNumber, asNonEmptyString, asNullableNumber } from "./decode.ts";
import { HERMES_PIN, hermesMatchesPin } from "./hermes-pin.ts";
import { approvalsAreManual, packInstalled } from "./hermes-pack.ts";
import { probeHermesVersion } from "./hermes-status.ts";
import { seedVault } from "./vault.ts";

export type HandsSource = "demo" | "hermes" | "held" | "csv" | "fixture";

export interface HermesLedgerAttempt {
  rows: LedgerFacts[] | null;
  /** Why we got rows (or why the live check missed). */
  detail: string;
}

export interface HermesPing {
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

const TIMEOUT_MS = 20_000;
const LEDGER_TIMEOUT_MS = 60_000;

export async function tryHermesPing(opts?: {
  cli?: string;
  timeoutMs?: number;
  root?: string;
  cwd?: string;
}): Promise<HermesPing> {
  const started = Date.now();
  const done = (ok: boolean, detail: string): HermesPing => ({ ok, detail, elapsedMs: Date.now() - started });
  if (process.env.VITEST && !opts?.cli) return done(false, "tests do not ping the live worker");
  if (!packInstalled(opts?.root)) return done(false, `the "${HERMES_PIN.profile}" pack is missing from ~/.hermes.`);
  if (!approvalsAreManual(opts?.root)) {
    return done(false, `the "${HERMES_PIN.profile}" pack is not in manual approvals — re-apply the pack.`);
  }
  const cli = opts?.cli ?? "hermes";
  const version = await probeHermesVersion(cli);
  if (!version) return done(false, "Hermes CLI not found.");
  if (!hermesMatchesPin(version)) {
    return done(false, `installed ${version.trim()}, pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}).`);
  }

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
    const child = execFile(
      cli,
      ["--profile", HERMES_PIN.profile, "chat", "-Q", "-q", "Reply with exactly one word: OK", "--max-turns", "1"],
      execOpts,
      (err, stdout, stderr) => {
        const clean = (s: string) =>
          String(s)
            .replace(/\x1b\[[0-9;]*m/g, "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !/^session_id:/.test(line));
        const pick = (s: string) => clean(s).slice(-2).join(" · ");
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (timedOut && process.platform !== "win32") {
            try {
              process.kill(-child.pid!, "SIGTERM");
            } catch {}
          }
          if (timedOut) return resolve(done(false, "The worker took too long to answer."));
          const snippet = (pick(stdout) || pick(stderr)).slice(0, 200);
          return resolve(done(false, snippet || "The worker could not answer."));
        }
        const answer = clean(stdout).find((line) => line.trim().toUpperCase() === "OK");
        if (!answer) return resolve(done(false, "The worker answered, but not with OK — check the model."));
        resolve(done(true, "Worker answered OK — Desk Recheck can ask it for the ledger."));
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
  if (!packInstalled(opts?.root)) {
    return miss(`The worker is not answering — the "${HERMES_PIN.profile}" pack is missing from ~/.hermes.`);
  }
  if (!approvalsAreManual(opts?.root)) {
    return miss(`The worker is not answering — the "${HERMES_PIN.profile}" pack is not in manual approvals. Re-apply the pack.`);
  }
  const cli = opts?.cli ?? "hermes";
  const version = await probeHermesVersion(cli);
  if (!version) return miss("The worker is not answering — CLI not found.");
  if (!hermesMatchesPin(version)) {
    return miss(`The worker is not answering — installed ${version.trim()}, pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}).`);
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
    const child = execFile(
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
          if (timedOut) return resolve(miss("The worker took too long — facts stay held."));
          const clean = (s: string) =>
            String(s)
              .replace(/\x1b\[[0-9;]*m/g, "")
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line && !/^session_id:/.test(line));
          const pick = (s: string) => clean(s).slice(-2).join(" · ");
          const snippet = (pick(stdout) || pick(stderr)).slice(0, 200);
          return resolve(
            miss(
              snippet
                ? `The worker could not answer (${snippet}) — facts stay held.`
                : "The worker could not answer — facts stay held.",
            ),
          );
        }
        const rows = parseLedgerFacts(String(stdout));
        if (!rows) return resolve(miss("The worker answered without ledger JSON — facts stay held."));
        if (rows.length === 0) return resolve(miss("The worker found no observed ledger facts — facts stay held."));
        resolve({ rows, detail: `Worker ${HERMES_PIN.product} answered with ${rows.length} ledger rows.` });
      },
    );
  });
}
