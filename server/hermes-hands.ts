// Optional live hands: ask pinned Hermes `property` for ledger JSON.
// Any failure returns null rows plus a one-line reason. Desk holds —
// it never copies Demo values into a live check.
// Never passes --yolo. Never opens Desktop.
import { execFile } from "node:child_process";

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
    execFile(
      cli,
      ["--profile", HERMES_PIN.profile, "chat", "-Q", "-q", "Reply with exactly one word: OK", "--max-turns", "1"],
      { timeout: opts?.timeoutMs ?? TIMEOUT_MS, cwd: opts?.cwd ?? seedVault() },
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
          if (timedOut) return resolve(done(false, "Hermes took too long to answer."));
          const snippet = (pick(stdout) || pick(stderr)).slice(0, 200);
          return resolve(done(false, snippet || "Hermes could not answer."));
        }
        const answer = clean(stdout).find((line) => line.trim().toUpperCase() === "OK");
        if (!answer) return resolve(done(false, "Hermes answered, but not with OK — check the model."));
        resolve(done(true, "Hermes answered OK — the worker is live."));
      },
    );
  });
}

export function parseLedgerFacts(text: string): LedgerFacts[] | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  let raw = text.slice(start).trim();
  const fence = raw.indexOf("```");
  if (fence > 0) raw = raw.slice(0, fence).trim();
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
    return out.length ? out : null;
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
    return miss(`Hermes is not answering — the "${HERMES_PIN.profile}" pack is missing from ~/.hermes.`);
  }
  if (!approvalsAreManual(opts?.root)) {
    return miss(`Hermes is not answering — the "${HERMES_PIN.profile}" pack is not in manual approvals. Re-apply the pack.`);
  }
  const cli = opts?.cli ?? "hermes";
  const version = await probeHermesVersion(cli);
  if (!version) return miss("Hermes is not answering — CLI not found.");
  if (!hermesMatchesPin(version)) {
    return miss(`Hermes is not answering — installed ${version.trim()}, pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}).`);
  }

  const ids = propertyIds.length ? propertyIds.join(", ") : "(none)";
  const prompt =
    `Morning arrears check. Use skill morning-arrears.\n` +
    `Return JSON only — one object per property id you actually observed: ${ids}.\n` +
    `If a fact is unknown, omit that property. Do not guess. Do not copy sample values.\n` +
    `Do not send, pay, or draft a statutory notice.`;

  return new Promise((resolve) => {
    execFile(
      cli,
      ["--profile", HERMES_PIN.profile, "chat", "-Q", "-q", prompt, "--max-turns", "2"],
      { timeout: opts?.timeoutMs ?? TIMEOUT_MS, cwd: opts?.cwd ?? seedVault() },
      (err, stdout, stderr) => {
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (timedOut) return resolve(miss("Hermes took too long — facts stay held."));
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
                ? `Hermes could not answer (${snippet}) — facts stay held.`
                : "Hermes could not answer — facts stay held.",
            ),
          );
        }
        const rows = parseLedgerFacts(String(stdout));
        if (!rows) return resolve(miss("Hermes answered without ledger JSON — facts stay held."));
        resolve({ rows, detail: `Hermes ${HERMES_PIN.product} answered with ${rows.length} ledger rows.` });
      },
    );
  });
}
