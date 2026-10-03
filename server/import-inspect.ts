// Ask Bud to name ledger-export columns. The model proposes; the server
// keeps only header names that are actually in the file.
import { managedServiceFailure } from "./managed-service.ts";
import { join } from "node:path";

import { hardenHermesChildEnv, hermesWorkerSandbox } from "./drivers/acp/hermes.ts";
import { trackSandboxedChild } from "./worker-network-sandbox.ts";
import { applyAskModelRelayEnv } from "./ask-model-relay.ts";
import { augmentedPath } from "./env-path.ts";
import { execFileCli, type OneShotOptions } from "./procs.ts";
import { writeBookFile } from "./vault.ts";
import { parseCsvTable } from "./csv-ledger.ts";
import { HERMES_PIN, hermesCli, hermesIsCompatible } from "./hermes-pin.ts";
import { approvalsAreManual, packInstalled } from "./hermes-pack.ts";
import { currentWorkerProfile } from "./hermes-profile.ts";
import { probeHermesVersion } from "./hermes-status.ts";
import { seedVault } from "./vault.ts";
import type { CsvColumnMapping } from "../shared/contracts.ts";

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
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const starts: number[] = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    if (clean[i] === "[" || clean[i] === "{") starts.push(i);
  }
  for (const start of starts) {
    let raw = clean.slice(start).trim();
    const fence = raw.indexOf("```");
    if (fence > 0) raw = raw.slice(0, fence).trim();
    try {
      return JSON.parse(raw);
    } catch {
      const close = raw.startsWith("[") ? raw.lastIndexOf("]") : raw.startsWith("{") ? raw.lastIndexOf("}") : -1;
      if (close > 0) {
        try {
          return JSON.parse(raw.slice(0, close + 1));
        } catch {
          /* try an earlier bracket */
        }
      }
    }
  }
  return null;
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

export async function inspectLedgerColumns(
  csv: string,
  opts?: { cli?: string; timeoutMs?: number; root?: string },
): Promise<LedgerColumnInspect> {
  const serviceFailure = managedServiceFailure("reasoning");
  if (serviceFailure) return miss(serviceFailure);
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

  return new Promise((resolve) => {
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
  });
}
