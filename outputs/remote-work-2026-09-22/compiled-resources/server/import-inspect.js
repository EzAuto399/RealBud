// Ask Bud to name ledger-export columns. The model proposes; the server
// keeps only header names that are actually in the file.
import { managedServiceFailure } from "./managed-service.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hardenHermesChildEnv } from "./drivers/acp/hermes.js";
import { augmentedPath } from "./env-path.js";
import { execFileCli } from "./procs.js";
import { writeFileAtomic } from "./atomic.js";
import { parseCsvTable } from "./csv-ledger.js";
import { HERMES_PIN, hermesCli, hermesIsCompatible } from "./hermes-pin.js";
import { approvalsAreManual, packInstalled } from "./hermes-pack.js";
import { probeHermesVersion } from "./hermes-status.js";
import { seedVault } from "./vault.js";
const INSPECT_TIMEOUT_MS = 60_000;
const SAMPLE_MAX_LINES = 100;
const SAMPLE_MAX_BYTES = 64_000;
const EXPORT_REL = join("uploads", "ledger-export.txt");
const ROLES = ["identity", "daysSinceDue", "rentLanded", "levyPaid"];
function miss(detail) {
    return { mapping: null, detail };
}
/** First 100 lines, hard-capped so a single huge header cannot fill the vault. */
function sampleLedgerExport(csv) {
    let lines = 0;
    let end = 0;
    for (let i = 0; i < csv.length && lines < SAMPLE_MAX_LINES; i++) {
        end = i + 1;
        if (csv[i] === "\n")
            lines++;
    }
    if (lines < SAMPLE_MAX_LINES)
        end = csv.length;
    const sliced = csv.slice(0, end);
    return sliced.length > SAMPLE_MAX_BYTES ? sliced.slice(0, SAMPLE_MAX_BYTES) : sliced;
}
function headerRow(csv) {
    try {
        const table = parseCsvTable(csv);
        const headers = (table[0] ?? []).map((h) => h.trim());
        return headers.some((h) => h) ? headers : null;
    }
    catch {
        return null;
    }
}
function lastJsonValue(text) {
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
    const starts = [];
    for (let i = clean.length - 1; i >= 0; i--) {
        if (clean[i] === "[" || clean[i] === "{")
            starts.push(i);
    }
    for (const start of starts) {
        let raw = clean.slice(start).trim();
        const fence = raw.indexOf("```");
        if (fence > 0)
            raw = raw.slice(0, fence).trim();
        try {
            return JSON.parse(raw);
        }
        catch {
            const close = raw.startsWith("[") ? raw.lastIndexOf("]") : raw.startsWith("{") ? raw.lastIndexOf("}") : -1;
            if (close > 0) {
                try {
                    return JSON.parse(raw.slice(0, close + 1));
                }
                catch {
                    /* try an earlier bracket */
                }
            }
        }
    }
    return null;
}
function mappingFromReply(parsed, headers) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const rec = parsed;
    const source = rec.mapping && typeof rec.mapping === "object" && !Array.isArray(rec.mapping)
        ? rec.mapping
        : rec.mapping === null
            ? null
            : rec;
    if (!source)
        return null;
    const out = {};
    for (const key of ROLES) {
        const value = source[key];
        if (typeof value !== "string")
            continue;
        const want = value.trim();
        if (!want)
            continue;
        const header = headers.find((h) => h === want || h.toLowerCase() === want.toLowerCase());
        if (header)
            out[key] = header;
    }
    return Object.keys(out).length ? out : null;
}
function writeExportSample(csv) {
    try {
        const vault = seedVault();
        const dir = join(vault, "uploads");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const path = join(vault, EXPORT_REL);
        writeFileAtomic(path, sampleLedgerExport(csv), 0o600);
        return path;
    }
    catch {
        return null;
    }
}
export async function inspectLedgerColumns(csv, opts) {
    const serviceFailure = managedServiceFailure("reasoning");
    if (serviceFailure)
        return miss(serviceFailure);
    if (process.env.VITEST && !opts?.cli)
        return miss("tests do not use the live worker");
    if (!packInstalled(opts?.root)) {
        return miss(`Bud is not answering — the "${HERMES_PIN.profile}" pack is missing.`);
    }
    if (!approvalsAreManual(opts?.root)) {
        return miss(`Bud is not answering — the "${HERMES_PIN.profile}" pack is not in manual approvals.`);
    }
    const cli = opts?.cli ?? hermesCli();
    const version = await probeHermesVersion(cli);
    if (!version)
        return miss("Bud is not answering — CLI not found.");
    if (!hermesIsCompatible(version)) {
        return miss(`Bud is not answering — installed ${version.trim()}, pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}).`);
    }
    const headers = headerRow(csv);
    if (!headers)
        return miss("The file has no header row.");
    if (!writeExportSample(csv))
        return miss("Could not write the export for Bud to read.");
    const prompt = `Read uploads/ledger-export.txt.\n` +
        `Identify which column plays each role (identity = property address or code; daysSinceDue; rentLanded; levyPaid).\n` +
        `Use the file's literal header names. If a role has no column, omit the key. If the file is unreadable, mapping is null.\n` +
        `Return JSON ONLY as the last line: { "mapping": { "identity": "<header>", "daysSinceDue": "<header>", "rentLanded": "<header>", "levyPaid": "<header>" }, "confidence": "high|low" }`;
    return new Promise((resolve) => {
        const env = { ...process.env, PATH: augmentedPath() };
        const serviceFailure = managedServiceFailure("reasoning");
        if (serviceFailure)
            return resolve(miss(serviceFailure));
        hardenHermesChildEnv(env);
        const execOpts = {
            timeout: opts?.timeoutMs ?? INSPECT_TIMEOUT_MS,
            cwd: seedVault(),
            env,
            encoding: "utf8",
            detached: process.platform !== "win32",
        };
        const child = execFileCli(cli, ["--profile", HERMES_PIN.profile, "chat", "-Q", "-q", prompt, "--max-turns", "6"], execOpts, (err, stdout, stderr) => {
            if (err) {
                const timedOut = err.killed;
                if (timedOut && process.platform !== "win32") {
                    try {
                        process.kill(-child.pid, "SIGTERM");
                    }
                    catch {
                        /* already gone */
                    }
                }
                if (timedOut)
                    return resolve(miss("Bud took too long to read the columns."));
                const clean = (s) => String(s)
                    .replace(/\x1b\[[0-9;]*m/g, "")
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line && !/^session_id:/.test(line));
                const pick = (s) => clean(s).slice(-2).join(" · ");
                const snippet = (pick(stdout) || pick(stderr)).slice(0, 200);
                return resolve(miss(snippet ? `Bud could not answer (${snippet}).` : "Bud could not answer."));
            }
            const parsed = lastJsonValue(String(stdout));
            if (parsed == null)
                return resolve(miss("Bud answered without column JSON."));
            if (parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed) &&
                parsed.mapping === null) {
                return resolve(miss("Bud could not read the columns."));
            }
            const mapping = mappingFromReply(parsed, headers);
            if (!mapping)
                return resolve(miss("Bud named columns that are not in the file."));
            resolve({ mapping, detail: "Bud read the columns." });
        });
    });
}
