// Ask Bud to name ledger-export columns. The model proposes; the server
// keeps only header names that are actually in the file. Jev is asked first
// (header names only); anything short of all four roles falls back to the
// Hermes turn unchanged.
import { managedServiceFailure } from "./managed-service.ts";
import { decide as jevDecide, jevReady, type JevQuestion, type JevRequest, type JevResult } from "./jev-client.ts";
import { redactSecretsInText } from "./redact.ts";
import { join } from "node:path";

import { hardenHermesChildEnv, hermesWorkerSandbox } from "./drivers/acp/hermes.ts";
import { trackSandboxedChild } from "./worker-network-sandbox.ts";
import { applyAskModelRelayEnv, withAskModelRelayLease } from "./ask-model-relay.ts";
import { augmentedPath } from "./env-path.ts";
import { execFileCli, type OneShotOptions } from "./procs.ts";
import { writeBookFile } from "./vault.ts";
import { parseCsvTable } from "./csv-ledger.ts";
import { HERMES_PIN, hermesCli, hermesIsCompatible } from "./hermes-pin.ts";
import { approvalsAreManual, packInstalled } from "./hermes-pack.ts";
import { currentWorkerProfile } from "./hermes-profile.ts";
import { lastJsonBlock } from "./hermes-hands.ts";
import { probeHermesVersion } from "./hermes-status.ts";
import { seedVault } from "./vault.ts";
import type { CsvColumnMapping, RunUsage } from "../shared/contracts.ts";
import { countJevUsage, emptyRunUsage } from "./run-cost.ts";
import { recordUsage } from "./computer-history.ts";

const INSPECT_TIMEOUT_MS = 60_000;
const SAMPLE_MAX_LINES = 100;
const SAMPLE_MAX_BYTES = 64_000;
const EXPORT_REL = join("uploads", "ledger-export.txt");
const ROLES = ["identity", "daysSinceDue", "rentLanded", "levyPaid"] as const;

export interface LedgerColumnInspect {
  mapping: CsvColumnMapping | null;
  detail: string;
}

function miss(detail: string): LedgerColumnInspect {
  return { mapping: null, detail };
}

/** First 100 lines, hard-capped so a single huge header cannot fill the vault. */
function sampleLedgerExport(csv: string): string {
  let lines = 0;
  let end = 0;
  for (let i = 0; i < csv.length && lines < SAMPLE_MAX_LINES; i++) {
    end = i + 1;
    if (csv[i] === "\n") lines++;
  }
  if (lines < SAMPLE_MAX_LINES) end = csv.length;
  const sliced = csv.slice(0, end);
  return sliced.length > SAMPLE_MAX_BYTES ? sliced.slice(0, SAMPLE_MAX_BYTES) : sliced;
}

function headerRow(csv: string): string[] | null {
  try {
    const table = parseCsvTable(csv);
    const headers = (table[0] ?? []).map((h) => h.trim());
    return headers.some((h) => h) ? headers : null;
  } catch {
    return null;
  }
}

function lastJsonValue(text: string): unknown | null {
  return lastJsonBlock(text, (raw) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  });
}

function mappingFromReply(parsed: unknown, headers: string[]): CsvColumnMapping | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const source =
    rec.mapping && typeof rec.mapping === "object" && !Array.isArray(rec.mapping)
      ? (rec.mapping as Record<string, unknown>)
      : rec.mapping === null
        ? null
        : rec;
  if (!source) return null;
  const out: CsvColumnMapping = {};
  for (const key of ROLES) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const want = value.trim();
    if (!want) continue;
    const header = headers.find((h) => h === want || h.toLowerCase() === want.toLowerCase());
    if (header) out[key] = header;
  }
  return Object.keys(out).length ? out : null;
}

type JevDecide = (request: JevRequest) => Promise<JevResult>;
const ROLE_MEANING: Record<(typeof ROLES)[number], string> = {
  identity: "the property address or property code",
  daysSinceDue: "how many days the rent is overdue (days in arrears)",
  rentLanded: "whether this period's rent has been received",
  levyPaid: "whether the strata or body corporate levy has been paid",
};
/** jev-client's caps: 64 options (one is "none"), 4,000 characters each, 16 KiB of state. */
const JEV_MAX_HEADERS = 63, JEV_MAX_HEADER_CHARS = 4_000, JEV_STATE_BYTES = 15_000;

/** A row-0 cell that reads like data, not a column name: mostly digits, an
 * email address, an amount of money or a date. */
function looksLikeValue(cell: string): boolean {
  const digits = cell.replace(/\D/g, "").length;
  return digits > cell.replace(/\s/g, "").length / 2 || cell.includes("@") || /[$€£¥]\s*\d|\d\s*[$€£¥]|\b(?:AUD|USD|NZD)\s*\d/i.test(cell)
    || /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/.test(cell) || /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{2,4}\b/i.test(cell);
}

/** One Jev call, one choice per role over the file's header names (keys h0..hN,
 * never the names themselves) plus "none". Jev sees the header names only,
 * redacted, and never a row 0 that reads like data. All four roles must each
 * name a different real header, picked with confidence >= 0.9 and a 0.3 lead;
 * otherwise null and Bud is asked. */
export async function jevMapping(headers: string[], decide: JevDecide): Promise<CsvColumnMapping | null> {
  // Row 0 is a data row (no header line): it never leaves the computer; Bud reads the file instead.
  if (headers.some(looksLikeValue)) return null;
  const offered = [...new Set(headers.filter((h) => h && h.length <= JEV_MAX_HEADER_CHARS))];
  // Jev sees redacted names; the answer's index maps back to the real header.
  const shown = offered.map(redactSecretsInText);
  if (!offered.length || offered.length > JEV_MAX_HEADERS || Buffer.byteLength(JSON.stringify({ headers: shown })) > JEV_STATE_BYTES) return null;
  const criteria: Record<string, string> = Object.fromEntries(shown.map((h, n) => [`h${n}`, h]));
  criteria.none = "No column of this file plays this role, or not sure.";
  const questions = Object.fromEntries(ROLES.map((role): [string, JevQuestion] => [role, { type: "choice", criteria,
    instructions: `Which column of this rent ledger export holds ${ROLE_MEANING[role]}? The options are the file's header names. Choose none unless one column clearly fits.` }]));
  let result: JevResult;
  try { result = await decide({ state: { headers: shown }, questions }); } catch { return null; }
  if (!result.ok) return null;
  const mapping: CsvColumnMapping = {};
  for (const role of ROLES) {
    const answer = result.answers[role];
    // Missing confidence or probabilities count as below the threshold.
    if (answer?.type !== "choice" || !/^h\d+$/.test(answer.choice) || !answer.probabilities || (answer.confidence ?? 0) < 0.9) return null;
    const [top = 0, second = 0] = Object.values(answer.probabilities).sort((a, b) => b - a);
    if (answer.probabilities[answer.choice] !== top || top - second < 0.3) return null;
    const header = offered[Number(answer.choice.slice(1))];
    if (header === undefined || !headers.includes(header) || Object.values(mapping).includes(header)) return null;
    mapping[role] = header;
  }
  return mapping;
}

function writeExportSample(csv: string): string | null {
  try {
    // `uploads` is seeded with the book; the write refuses any planted link.
    const path = join(seedVault(), EXPORT_REL);
    writeBookFile(path, sampleLedgerExport(csv));
    return path;
  } catch {
    return null;
  }
}

type InspectOptions = { cli?: string; timeoutMs?: number; root?: string; jev?: { decide: JevDecide; ready: () => boolean } };

/** The inspection keeps no record of its own (the import may never happen), so
 * its Jev call and worker fallback are one history row for their cost. */
export async function inspectLedgerColumns(csv: string, opts?: InspectOptions): Promise<LedgerColumnInspect> {
  const usage = emptyRunUsage();
  let result: LedgerColumnInspect | undefined;
  try { return result = await inspect(csv, opts, usage); }
  finally { recordUsage("ledger columns", usage, { ok: Boolean(result?.mapping) }); }
}

async function inspect(csv: string, opts: InspectOptions | undefined, usage: RunUsage): Promise<LedgerColumnInspect> {
  const serviceFailure = managedServiceFailure("reasoning");
  if (serviceFailure) return miss(serviceFailure);
  // Tests inject Jev; under VITEST the office's live Jev is never called.
  const jev = opts?.jev ?? (process.env.VITEST ? undefined : { decide: jevDecide, ready: jevReady });
  if (jev?.ready()) {
    const headers = headerRow(csv);
    const mapping = headers && await jevMapping(headers, countJevUsage(usage, jev.decide));
    if (mapping) return { mapping, detail: "Bud read the columns." };
  }
  if (process.env.VITEST && !opts?.cli) return miss("tests do not use the live worker");
  // The pack checks read the scoped seat's profile; launch that same profile,
  // never the shared base, so a member's upload stays in their own worker.
  const profile = currentWorkerProfile().profile;
  if (!packInstalled(opts?.root)) {
    return miss(`Bud is not answering — the "${profile}" pack is missing.`);
  }
  if (!approvalsAreManual(opts?.root)) {
    return miss(`Bud is not answering — the "${profile}" pack is not in manual approvals.`);
  }
  const cli = opts?.cli ?? hermesCli();
  const version = await probeHermesVersion(cli);
  if (!version) return miss("Bud is not answering — CLI not found.");
  if (!hermesIsCompatible(version)) {
    return miss(`Bud is not answering — installed ${version.trim()}, pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}).`);
  }

  const headers = headerRow(csv);
  if (!headers) return miss("The file has no header row.");
  if (!writeExportSample(csv)) return miss("Could not write the export for Bud to read.");

  const prompt =
    `Read uploads/ledger-export.txt.\n` +
    `Identify which column plays each role (identity = property address or code; daysSinceDue; rentLanded; levyPaid).\n` +
    `Use the file's literal header names. If a role has no column, omit the key. If the file is unreadable, mapping is null.\n` +
    `Return JSON ONLY as the last line: { "mapping": { "identity": "<header>", "daysSinceDue": "<header>", "rentLanded": "<header>", "levyPaid": "<header>" }, "confidence": "high|low" }`;

  return withAskModelRelayLease(() => new Promise((resolve) => {
    const env = { ...process.env, PATH: augmentedPath() };
    const serviceFailure = managedServiceFailure("reasoning");
    if (serviceFailure) return resolve(miss(serviceFailure));
    hardenHermesChildEnv(env);
    // Strip first, then reason through Ask's loopback relay (the office key
    // stays in this process), and only while the checked profile names the
    // granted endpoint. The selected worker is refused without usable access;
    // a caller-supplied (development) CLI just gets no access.
    const refusal = applyAskModelRelayEnv(env, opts?.root);
    if (refusal && !opts?.cli) return resolve(miss(refusal));
    const execOpts: OneShotOptions = {
      timeout: opts?.timeoutMs ?? INSPECT_TIMEOUT_MS,
      cwd: seedVault(),
      env,
      encoding: "utf8",
    };
    // Reading one uploaded text file needs the file tools, never a terminal.
    const args = ["--profile", profile, "chat", "-Q", "--toolsets", "todo,file", "-q", prompt, "--max-turns", "6"];
    let launch: ReturnType<typeof hermesWorkerSandbox>;
    try { launch = hermesWorkerSandbox("cli", cli, args, env, []); }
    catch (error) { return resolve(miss(error instanceof Error ? error.message : String(error))); }
    trackSandboxedChild(execFileCli(
      launch.command,
      launch.args,
      execOpts,
      (err, stdout, stderr) => {
        launch.release();
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (timedOut) return resolve(miss("Bud took too long to read the columns."));
          const clean = (s: string) =>
            String(s)
              .replace(/\x1b\[[0-9;]*m/g, "")
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line && !/^session_id:/.test(line));
          const pick = (s: string) => clean(s).slice(-2).join(" · ");
          const snippet = (pick(stdout) || pick(stderr)).slice(0, 200);
          return resolve(miss(snippet ? `Bud could not answer (${snippet}).` : "Bud could not answer."));
        }
        const parsed = lastJsonValue(String(stdout));
        if (parsed == null) return resolve(miss("Bud answered without column JSON."));
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          (parsed as Record<string, unknown>).mapping === null
        ) {
          return resolve(miss("Bud could not read the columns."));
        }
        const mapping = mappingFromReply(parsed, headers);
        if (!mapping) return resolve(miss("Bud named columns that are not in the file."));
        resolve({ mapping, detail: "Bud read the columns." });
      },
    ));
  }), { usage });
}
