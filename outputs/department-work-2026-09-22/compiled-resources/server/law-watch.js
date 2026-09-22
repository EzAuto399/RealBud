// Re-read the official tenancy Acts against the shop reference.
// Bud reports drift; a person confirms before the reference is appended.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { LAW_REFERENCE_FILE } from "./law-reference.js";
import { askWorker, lastJsonObject } from "./recipe-draft.js";
import { deleteRecipe, getRecipe, listRecipes, saveRecipe } from "./recipes.js";
import { seedVault } from "./vault.js";
export const LAW_WATCH_ID = "law-watch";
const MAX_DRIFT = 20;
const MAX_FIELD = 300;
const MAX_SOURCE = 200;
const OFFICIAL_SITES = {
    ACT: "legislation.gov.au",
    NSW: "legislation.nsw.gov.au",
    VIC: "legislation.vic.gov.au",
    QLD: "legislation.qld.gov.au",
};
function lawWatchPath() {
    return join(DATA_DIR, "law-watch.json");
}
function bad(message, status = 400) {
    throw Object.assign(new Error(message), { status });
}
function asString(value, max) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max)
        return null;
    return trimmed;
}
function asDriftItem(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    const jurisdiction = asString(row.jurisdiction, MAX_FIELD);
    const topic = asString(row.topic, MAX_FIELD);
    const reference = asString(row.reference, MAX_FIELD);
    const current = asString(row.current, MAX_FIELD);
    const note = asString(row.note, MAX_FIELD);
    if (!jurisdiction || !topic || !reference || !current || !note)
        return null;
    return { jurisdiction, topic, reference, current, note };
}
function asSources(value) {
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const item of value) {
        const source = asString(item, MAX_SOURCE);
        if (!source)
            return null;
        if (!out.includes(source))
            out.push(source);
    }
    return out;
}
function asState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    if (!Array.isArray(row.drift))
        return null;
    const drift = [];
    for (const item of row.drift) {
        const parsed = asDriftItem(item);
        if (parsed)
            drift.push(parsed);
    }
    const checkedSources = asSources(row.checkedSources) ?? [];
    const lastCheckedAt = typeof row.lastCheckedAt === "number" && Number.isFinite(row.lastCheckedAt) ? row.lastCheckedAt : 0;
    return { lastCheckedAt, drift, checkedSources };
}
function persist(state) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(lawWatchPath(), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
export function loadLawWatch() {
    try {
        const parsed = asState(JSON.parse(readFileSync(lawWatchPath(), "utf8")));
        return parsed ?? { lastCheckedAt: 0, drift: [], checkedSources: [] };
    }
    catch {
        return { lastCheckedAt: 0, drift: [], checkedSources: [] };
    }
}
export function saveLawWatch(state) {
    persist(state);
}
export function lawWatchView() {
    return { ...loadLawWatch(), scheduled: Boolean(getRecipe(LAW_WATCH_ID)) };
}
function officialHosts(jurisdictions) {
    const hosts = [];
    for (const raw of jurisdictions) {
        const host = OFFICIAL_SITES[raw.trim().toUpperCase()];
        if (host && !hosts.includes(host))
            hosts.push(host);
    }
    return hosts.length ? hosts : Object.values(OFFICIAL_SITES);
}
function watchPrompt(jurisdictions) {
    const named = jurisdictions.length ? jurisdictions.join(", ") : "not named";
    const hosts = officialHosts(jurisdictions).join(", ");
    return (`The workroom has AU-RENTAL-LAW.md — a verification guide, not a source of legal deadlines. ` +
        `Do not edit that file. Report only.\n` +
        `The book's jurisdictions: ${named}.\n` +
        `Using web research on ONLY these official legislation sites (${hosts}), ` +
        `re-read the current rent-increase, arrears-process, entry-notice, and bond-cap rules ` +
        `and compare them against the shop reference.\n` +
        `Never invent a rule. If a source cannot be read, say so in note and skip the item.\n` +
        `Return JSON only as the last line: ` +
        `{ "drift": [{ "jurisdiction": "", "topic": "", "reference": "", "current": "", "note": "" }], ` +
        `"checkedSources": ["<url>"] }\n` +
        `Empty drift array when the reference matches.`);
}
function parseWatchReply(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const row = parsed;
    if (!Array.isArray(row.drift) || row.drift.length > MAX_DRIFT)
        return null;
    const drift = [];
    for (const item of row.drift) {
        const parsedItem = asDriftItem(item);
        if (!parsedItem)
            return null;
        drift.push(parsedItem);
    }
    const checkedSources = asSources(row.checkedSources);
    if (!checkedSources)
        return null;
    return { drift, checkedSources };
}
export async function runLawWatch(opts) {
    // Re-reading several legislation sites is real research, not a one-shot
    // answer — the check gets a wider budget than a draft or a narration.
    const result = await askWorker(watchPrompt(opts?.jurisdictions ?? []), {
        timeoutMs: 300_000,
        ...opts,
        toolsets: ["file", "web"],
    });
    if (!result.ok)
        return null;
    return parseWatchReply(lastJsonObject(result.stdout));
}
export function persistLawWatchResult(result) {
    const state = {
        lastCheckedAt: Date.now(),
        drift: result.drift,
        checkedSources: result.checkedSources,
    };
    persist(state);
    return state;
}
function appendConfirmedDrift(item) {
    const vault = seedVault();
    const path = join(vault, LAW_REFERENCE_FILE);
    const existing = readFileSync(path, "utf8");
    const day = new Date().toISOString().slice(0, 10);
    const block = `\n## Confirmed drift — ${day}\n\n` +
        `- ${item.jurisdiction} · ${item.topic}: ${item.current} (reference said: ${item.reference}) — ${item.note}\n`;
    writeFileAtomic(path, `${existing}${block}`, 0o600);
}
export function applyLawDrift(index) {
    if (!Number.isInteger(index) || index < 0) {
        bad("That finding is not on the current list.");
    }
    const saved = loadLawWatch();
    const item = saved.drift[index];
    if (!item)
        bad("That finding is not on the current list.");
    appendConfirmedDrift(item);
    const next = {
        ...saved,
        drift: saved.drift.filter((_, i) => i !== index),
    };
    persist(next);
    return next;
}
export function setLawWatchScheduled(on) {
    if (on) {
        saveRecipe({
            id: LAW_WATCH_ID,
            title: "Law watch",
            steps: [
                "Read the current tenancy Acts for the book's jurisdictions on the official legislation sites.",
                "Compare them against AU-RENTAL-LAW.md in the workroom.",
                "Report any drift — never edit the reference yourself.",
            ],
            allowedOrigins: [
                "legislation.gov.au",
                "legislation.nsw.gov.au",
                "legislation.vic.gov.au",
                "legislation.qld.gov.au",
            ],
            evidence: "Drift findings, each with its source URL.",
            schedule: { time: "08:00", weekdays: [1] },
            status: "shadow",
            planApprovedAt: null,
        });
    }
    else if (getRecipe(LAW_WATCH_ID)) {
        deleteRecipe(LAW_WATCH_ID);
    }
    return listRecipes();
}
