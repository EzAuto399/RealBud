// Optional live hands: ask pinned Hermes `property` for ledger JSON.
// Any failure (missing pin, missing pack, bad JSON, timeout) returns null
// rows plus a one-line reason, and Desk keeps the training book.
// Never passes --yolo. Never opens Desktop.
import { execFile } from "node:child_process";

import { HERMES_PIN, hermesMatchesPin } from "./hermes-pin.ts";
import { packInstalled } from "./hermes-pack.ts";
import { probeHermesVersion } from "./hermes-status.ts";
import type { LedgerFacts } from "./desk.ts";

export type HandsSource = "fixture" | "hermes";

export interface HermesLedgerAttempt {
  rows: LedgerFacts[] | null;
  /** Why we got rows (or why we fell back), for the Desk hands chip. */
  detail: string;
}

export interface HermesPing {
  ok: boolean;
  /** One human sentence — the answer or the reason it failed. */
  detail: string;
  elapsedMs: number;
}

const TIMEOUT_MS = 20_000;

/** One live headless turn to prove the worker can actually answer — the
 * same gates as the ledger call (pin, pack, profile), minus the skill. */
export async function tryHermesPing(opts?: {
  cli?: string;
  timeoutMs?: number;
  root?: string;
}): Promise<HermesPing> {
  const started = Date.now();
  const done = (ok: boolean, detail: string): HermesPing => ({ ok, detail, elapsedMs: Date.now() - started });
  if (process.env.VITEST && !opts?.cli) return done(false, "tests do not ping the live worker");
  if (!packInstalled(opts?.root)) return done(false, `the "${HERMES_PIN.profile}" pack is missing from ~/.hermes.`);
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
      { timeout: opts?.timeoutMs ?? TIMEOUT_MS },
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
      if (typeof r.propertyId !== "string") return null;
      if (!Number.isFinite(Number(r.daysSinceDue))) return null;
      out.push({
        propertyId: r.propertyId,
        daysSinceDue: Number(r.daysSinceDue),
        rentLanded: Boolean(r.rentLanded),
        levyPaid: Boolean(r.levyPaid),
        daysSinceCourtesy: r.daysSinceCourtesy == null ? null : Number(r.daysSinceCourtesy),
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export async function tryHermesLedger(
  fixture: LedgerFacts[],
  opts?: { cli?: string; timeoutMs?: number; root?: string },
): Promise<HermesLedgerAttempt> {
  const miss = (detail: string): HermesLedgerAttempt => ({ rows: null, detail });
  if (process.env.VITEST && !opts?.cli) return miss("tests run on the training book");
  if (!packInstalled(opts?.root)) {
    return miss(`Hermes is not answering — the "${HERMES_PIN.profile}" pack is missing from ~/.hermes.`);
  }
  const cli = opts?.cli ?? "hermes";
  const version = await probeHermesVersion(cli);
  if (!version) return miss("Hermes is not answering — CLI not found.");
  if (!hermesMatchesPin(version)) {
    return miss(`Hermes is not answering — installed ${version.trim()}, pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}).`);
  }

  const prompt =
    `Morning arrears check. Use skill morning-arrears.\n` +
    `Return JSON only — one object per property, same shape as this fixture (copy values if unsure):\n` +
    `${JSON.stringify(fixture)}\n` +
    `Do not send, pay, or draft a statutory notice.`;

  return new Promise((resolve) => {
    execFile(
      cli,
      ["--profile", HERMES_PIN.profile, "chat", "-Q", "-q", prompt, "--max-turns", "2"],
      { timeout: opts?.timeoutMs ?? TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (timedOut) return resolve(miss("Hermes took too long — Desk stays on the training book."));
          // surface the provider's own words (billing, auth, network) so the
          // Desk banner can say what to fix instead of just "it failed".
          // Hermes prints the real error to stdout; stderr carries warnings.
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
                ? `Hermes could not answer (${snippet}) — Desk stays on the training book.`
                : "Hermes could not answer — Desk stays on the training book.",
            ),
          );
        }
        const rows = parseLedgerFacts(String(stdout));
        if (!rows) return resolve(miss("Hermes answered without ledger JSON — Desk stays on the training book."));
        resolve({ rows, detail: `Hermes ${HERMES_PIN.product} answered with ${rows.length} ledger rows.` });
      },
    );
  });
}
