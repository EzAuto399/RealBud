// Optional live hands: ask pinned Hermes `property` for ledger JSON.
// Any failure returns null rows plus a one-line reason. Desk holds —
// it never copies Demo values into a live check.
// Never passes --yolo. Never opens Desktop.
import { managedServiceFailure } from "./managed-service.ts";
import { modelServiceFailure } from "./model-service-failure.ts";
import { randomUUID } from "node:crypto";

import { hardenHermesChildEnv, hermesWorkerSandbox } from "./drivers/acp/hermes.ts";
import { trackSandboxedChild } from "./worker-network-sandbox.ts";
import { applyAskModelRelayEnv, withAskModelRelayLease } from "./ask-model-relay.ts";
import { augmentedPath } from "./env-path.ts";
import { execFileCli, type OneShotOptions } from "./procs.ts";

import type { LedgerFacts, RunUsage } from "../shared/contracts.ts";
import { emptyRunUsage } from "./run-cost.ts";
import { recordUsage } from "./computer-history.ts";
import { asBoolean, asFiniteNumber, asNonEmptyString, asNullableNumber } from "./decode.ts";
import { hermesCli, hermesIsCompatible } from "./hermes-pin.ts";
import { currentWorkerProfile, withWorkerProfile } from "./hermes-profile.ts";
import { approvalsAreManual, packInstalled } from "./hermes-pack.ts";
import { probeHermesVersion, hermesReadinessFingerprint, modelAccessStatus, workerSetupPending } from "./hermes-status.ts";
import { seedVault } from "./vault.ts";

export type HandsSource = "demo" | "hermes" | "held" | "csv" | "fixture";

export interface HermesLedgerAttempt {
  rows: LedgerFacts[] | null;
  /** Why we got rows (or why the live check missed). */
  detail: string;
  /** The Modelvia requests this attempt made, when it made any. */
  usage?: RunUsage;
}

export interface HermesPing {
  workerFingerprint?: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

const TIMEOUT_MS = 60_000;
const LEDGER_TIMEOUT_MS = 60_000;

/** Shipped in pack/property/skills. Preloaded with `chat -s`: naming a skill in
 * the prompt alone does not load it in a one-shot `chat -q` run. */
export const LEDGER_SKILL = "morning-arrears";

/** Worker chatter that explains nothing about the miss to a PM. */
const WORKER_NOISE = [/^session_id:/i, /security scanner/i, /pattern matching only/i, /^warning:/i];
// This exact supported-worker startup diagnostic is emitted on stdout before
// the model answer. Other warnings/prose must not turn a failed check into OK.
const PING_STARTUP_NOTICE = /^(?:⚠\s*)?tirith security scanner enabled but not available — command scanning will use pattern matching only$/;

const WORKER_MISS_REASONS: Array<[RegExp, string]> = [
  // Hermes refuses to start when no preloaded skill resolves in the profile.
  [/Unknown skill\(s\)/i, "Bud's pack skill is missing; re-apply Bud's safeguards in Workspace → Settings & help"],
  [/UnrecognizedClient|invalid.?api.?key|incorrect api key|authentication|unauthori[sz]ed|\b401\b|\b403\b/i, "the model provider refused Bud's key; check the model connection in Workspace → Settings & help"],
  [/insufficient|credit|billing|quota|\b402\b/i, "Billing or credits exhausted at the model provider"],
  [/rate.?limit|\b429\b|too many requests/i, "the model provider is rate-limiting; try again shortly"],
  [/no model|model (is )?not (set|configured)|missing model|api key (is )?(not set|missing)/i, "no model is connected; attach one in Workspace → Settings & help"],
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
  const serviceFailure = modelServiceFailure(text);
  if (serviceFailure) return serviceFailure;
  for (const [pattern, reason] of WORKER_MISS_REASONS) if (pattern.test(text)) return reason;
  const last = all.at(-1) ?? "";
  return last.length > 120 ? `${last.slice(0, 117)}…` : last;
}

async function scopedHermesPing(opts?: {
  cli?: string;
  timeoutMs?: number;
  root?: string;
  cwd?: string;
  /**
   * The authenticated seat this execution acts for. Omitted means the shared
   * base profile, which is correct for a single-seat install. Callers pass the
   * seat identity — never a model- or request-supplied name.
   */
  memberKey?: string | null;
}): Promise<HermesPing> {
  const started = Date.now();
  let workerFingerprint: string | undefined;
  const done = (ok: boolean, detail: string): HermesPing => ({ ok, detail, elapsedMs: Date.now() - started, ...(workerFingerprint ? { workerFingerprint } : {}) });
  const serviceFailure = managedServiceFailure("reasoning");
  if (serviceFailure) return done(false, serviceFailure);
  if (process.env.VITEST && !opts?.cli) return done(false, "tests do not ping the live worker");
  // A withdrawn grant holds with its own reason. Running the check would spend
  // a minute to produce an auth failure the office cannot act on.
  const access = modelAccessStatus(opts?.root);
  if (access.withdrawn) return done(false, access.detail);
  if (workerSetupPending(opts?.root)) return done(false, "Bud setup did not finish. Finish setup before checking the connection.");
  if (!packInstalled(opts?.root)) return done(false, "Bud isn't set up yet. Finish setup in Workspace.");
  if (!approvalsAreManual(opts?.root)) {
    return done(false, "Bud's safeguards need attention. Check them in Workspace.");
  }
  const cli = opts?.cli ?? hermesCli();
  const version = await probeHermesVersion(cli);
  if (!version) return done(false, "Bud isn't installed yet. Install it from Workspace.");
  if (!hermesIsCompatible(version)) {
    return done(false, "Bud needs an update. Update it from Workspace.");
  }

  workerFingerprint = hermesReadinessFingerprint(version, opts?.root);
  // The check reasons through the relay like any model call; its Modelvia requests are a history row so they are costed.
  const usage = emptyRunUsage();
  const ping = await withAskModelRelayLease(() => new Promise<HermesPing>((resolve) => {
    const env = { ...process.env, PATH: augmentedPath() };
    const serviceFailure = managedServiceFailure("reasoning");
    if (serviceFailure) return resolve(done(false, serviceFailure));
    hardenHermesChildEnv(env);
    // Strip ambient credentials first, then reason through the same loopback
    // relay as Ask (the office key stays in this process; the worker gets the
    // relay's token), only while the profile names the granted endpoint. The
    // selected worker is refused outright without usable access; a
    // caller-supplied (development) CLI just gets no access.
    const refusal = applyAskModelRelayEnv(env, opts?.root);
    if (refusal && !opts?.cli) return resolve(done(false, refusal));
    const execOpts: OneShotOptions = {
      timeout: opts?.timeoutMs ?? TIMEOUT_MS,
      cwd: opts?.cwd ?? seedVault(),
      env,
      encoding: "utf8",
    };
    // New explicit checks have distinct request bodies. A worker's transport
    // retry keeps this same marker, preserving the gateway's replay fence.
    const args = ["--profile", currentWorkerProfile().profile, "chat", "-Q", "--toolsets", "todo", "-q", `Readiness check ${randomUUID()}. Reply with exactly OK, without punctuation or explanation. Do not use tools.`, "--max-turns", "1"];
    let launch: ReturnType<typeof hermesWorkerSandbox>;
    try { launch = hermesWorkerSandbox("cli", cli, args, env, []); }
    catch (error) { return resolve(done(false, error instanceof Error ? error.message : String(error))); }
    trackSandboxedChild(execFileCli(
      launch.command,
      launch.args,
      execOpts,
      (err, stdout, stderr) => {
        launch.release();
        const clean = (s: string) =>
          String(s)
            .replace(/\x1b\[[0-9;]*m/g, "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !/^session_id:/.test(line) && !PING_STARTUP_NOTICE.test(line));
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (timedOut) return resolve(done(false, "Bud took more than a minute to answer. Try the check again; if it keeps happening, save a support file for hello@realbud.app."));
          const reason = workerMissReason(stdout, stderr);
          return resolve(done(false, reason ? `Bud could not answer — ${reason}.` : "Bud could not answer."));
        }
        const answer = clean(stdout).join("\n");
        if (!/^OK[.!]?$/i.test(answer)) {
          // The supported CLI can print a provider failure and still exit 0.
          const refusal = modelServiceFailure(answer);
          if (refusal) return resolve(done(false, `Bud could not answer — ${refusal}.`));
          return resolve(done(false, "Bud answered, but not with OK — check the model connection in Workspace → Settings & help."));
        }
        resolve(done(true, "Bud answered OK — Recheck can ask for the morning ledger."));
      },
    ));
  }), { usage });
  recordUsage("readiness check", usage, { ok: ping.ok });
  return ping;
}

export function uncoveredPropertyIds(requested: string[], rows: LedgerFacts[]): string[] {
  const got = new Set(rows.map((row) => row.propertyId));
  return requested.filter((id) => !got.has(id));
}

export function parseLedgerFacts(text: string): LedgerFacts[] | null {
  return lastJsonBlock(text, parseLedgerRows);
}

/**
 * The worker reasons before answering, and that reasoning can quote the
 * instruction "return [] exactly", so the FIRST bracket is often prose. The
 * answer is the LAST complete bracketed block that `read` accepts. Starts are
 * scanned from the end, but an enclosing block wins over one nested inside it:
 * the last `{` of `[{...},{...}]` is one row, not the answer.
 */
export function lastJsonBlock<T>(text: string, read: (raw: string) => T | null): T | null {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  let best: { end: number; value: T } | null = null;
  for (let start = clean.length - 1; start >= 0; start--) {
    if (clean[start] !== "[" && clean[start] !== "{") continue;
    const end = blockEnd(clean, start);
    if (end < 0 || (best && end < best.end)) continue;
    const value = read(clean.slice(start, end + 1));
    if (value !== null) best = { end, value };
  }
  return best ? best.value : null;
}

/** Index of the bracket closing the block opened at `start`, skipping JSON strings; -1 if unclosed. */
function blockEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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

async function scopedHermesLedger(
  propertyIds: string[],
  opts?: {
    cli?: string;
    timeoutMs?: number;
    root?: string;
    cwd?: string;
    /** See `tryHermesPing.memberKey`: the authenticated seat, never a supplied name. */
    memberKey?: string | null;
  },
): Promise<HermesLedgerAttempt> {
  const miss = (detail: string): HermesLedgerAttempt => ({ rows: null, detail });
  const serviceFailure = managedServiceFailure("reasoning");
  if (serviceFailure) return miss(serviceFailure);
  if (process.env.VITEST && !opts?.cli) return miss("tests do not use the live worker — unknown facts stay held");
  const access = modelAccessStatus(opts?.root);
  if (access.withdrawn) return miss(`${access.detail} Saved facts are unchanged.`);
  if (workerSetupPending(opts?.root)) return miss("Bud setup did not finish. Finish setup before checking property facts.");
  if (!packInstalled(opts?.root)) {
    return miss("Bud isn't set up yet. Finish setup in Workspace. Saved facts are unchanged.");
  }
  if (!approvalsAreManual(opts?.root)) {
    return miss("Bud's safeguards need attention. Check them in Workspace. Saved facts are unchanged.");
  }
  const cli = opts?.cli ?? hermesCli();
  const version = await probeHermesVersion(cli);
  if (!version) return miss("Bud isn't installed yet. Install it from Workspace. Saved facts are unchanged.");
  if (!hermesIsCompatible(version)) {
    return miss("Bud needs an update. Update it from Workspace. Saved facts are unchanged.");
  }

  const ids = propertyIds.length ? propertyIds.join(", ") : "(none)";
  // The worker is asked for facts "you actually observed", so it has to be told what
  // to look at. Ask has always pointed the worker at DESK-CONTEXT.md
  // (ask-book.ts:101); this path did not, so the morning check asked for book facts
  // while naming no book, no property file and no id-to-address mapping. The honest
  // result was a one-of-six answer with the rest held — a missing input, not a weak
  // model, and not something a better provider would have fixed.
  const prompt =
    `Morning arrears check. Use skill ${LEDGER_SKILL}.\n` +
    `The office book for this run is the working directory. Read DESK-CONTEXT.md there for the\n` +
    `book facts, and the property notes under properties/ (or owners/) for preferences. Notes are\n` +
    `preferences only — they never change balances, day counts, or create a notice. If the book\n` +
    `does not cover a property, say so by omitting it; do not guess a fact to fill the row.\n` +
    `Return JSON only — one object per property id you actually observed: ${ids}.\n` +
    `If a fact is unknown, omit that property. If none are observable, return [] exactly. Do not guess. Do not copy sample values.\n` +
    `The last line of your reply must be the JSON array (at minimum []), with no text after it.\n` +
    `Do not send, pay, or draft a statutory notice.`;

  const usage = emptyRunUsage();
  const attempt = await withAskModelRelayLease(() => new Promise<HermesLedgerAttempt>((resolve) => {
    const env = { ...process.env, PATH: augmentedPath() };
    const serviceFailure = managedServiceFailure("reasoning");
    if (serviceFailure) return resolve(miss(serviceFailure));
    hardenHermesChildEnv(env);
    // Same relay and sandbox as the ping above.
    const refusal = applyAskModelRelayEnv(env, opts?.root);
    if (refusal && !opts?.cli) return resolve(miss(refusal));
    const execOpts: OneShotOptions = {
      timeout: opts?.timeoutMs ?? LEDGER_TIMEOUT_MS,
      cwd: opts?.cwd ?? seedVault(),
      env,
      encoding: "utf8",
    };
    // The check reads the book (DESK-CONTEXT.md, property notes) and answers;
    // it never needs a terminal, the web or vision.
    const args = ["--profile", currentWorkerProfile().profile, "chat", "-Q", "--toolsets", "todo,file", "-s", LEDGER_SKILL, "-q", prompt, "--max-turns", "6"];
    let launch: ReturnType<typeof hermesWorkerSandbox>;
    try { launch = hermesWorkerSandbox("cli", cli, args, env, []); }
    catch (error) { return resolve(miss(`${error instanceof Error ? error.message : String(error)} Saved facts are unchanged.`)); }
    trackSandboxedChild(execFileCli(
      launch.command,
      launch.args,
      execOpts,
      (err, stdout, stderr) => {
        launch.release();
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (timedOut) return resolve(miss("Bud took too long — facts stay held."));
          const reason = workerMissReason(stdout, stderr);
          return resolve(
            miss(
              reason
                ? `Bud could not answer — ${reason}. Saved facts are unchanged.`
                : "Bud could not answer — facts stay held.",
            ),
          );
        }
        const rows = parseLedgerFacts(String(stdout));
        if (!rows) return resolve(miss("Bud answered without ledger facts — facts stay held."));
        if (rows.length === 0) return resolve(miss("Bud found no ledger facts — facts stay held."));
        resolve({ rows, detail: `Bud answered with ${rows.length} ledger rows.` });
      },
    ));
  }), { usage });
  return usage.calls ? { ...attempt, usage } : attempt;
}

const activePings = new Set<string>();
export function tryHermesPing(opts?: Parameters<typeof scopedHermesPing>[0]): Promise<HermesPing> {
  return withWorkerProfile(opts?.memberKey ?? currentWorkerProfile().memberKey, async () => {
    const scope = JSON.stringify([opts?.root ?? "", currentWorkerProfile().profile]);
    if (activePings.has(scope)) return { ok: false, elapsedMs: 0, detail: "Another model request is still running for this readiness check. Wait for it to finish before checking again." };
    activePings.add(scope);
    try { return await scopedHermesPing(opts); }
    finally { activePings.delete(scope); }
  });
}
export function tryHermesLedger(propertyIds: string[], opts?: Parameters<typeof scopedHermesLedger>[1]): Promise<HermesLedgerAttempt> {
  return withWorkerProfile(opts?.memberKey ?? currentWorkerProfile().memberKey, () => scopedHermesLedger(propertyIds, opts));
}
