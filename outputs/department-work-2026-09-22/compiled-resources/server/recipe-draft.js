// Ask Bud to shape a job description into a recipe card. The server
// validates; nothing is saved until the card is allowed.
import { managedServiceFailure } from "./managed-service.js";
import { randomUUID } from "node:crypto";
import { BUD_IDENTITY } from "../shared/bud-identity.js";
import { hardenHermesChildEnv } from "./drivers/acp/hermes.js";
import { augmentedPath } from "./env-path.js";
import { execFileCli } from "./procs.js";
import { HERMES_PIN, hermesCli, hermesIsCompatible } from "./hermes-pin.js";
import { hermesHome } from "./hermes-paths.js";
import { currentWorkerProfile } from "./hermes-profile.js";
import { approvalsAreManual, packInstalled } from "./hermes-pack.js";
import { probeHermesVersion } from "./hermes-status.js";
import { validateRecipe } from "./recipes.js";
import { seedVault } from "./vault.js";
// Narrating a recipe step-by-step runs longer than a one-shot draft; both
// share this budget. 120s covers a slow model without hanging the run.
const WORKER_TIMEOUT_MS = 120_000;
const WORKER_TOOLSETS = ["todo", "file", "web"];
function boundedToolsets(value) {
    const requested = value ?? ["todo"];
    if (!requested.length)
        return ["todo"];
    const out = [];
    for (const item of requested) {
        if (!WORKER_TOOLSETS.includes(item))
            return null;
        if (!out.includes(item))
            out.push(item);
    }
    return out;
}
export function lastJsonObject(text) {
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let last = null;
    // Quiet CLI replies can still include a fence or a stray closing brace.
    // Extract complete objects without changing their contents. Braces and
    // fences inside a quoted report are data, and a nested fragment must never
    // be mistaken for the complete receipt when its outer object is truncated.
    for (let i = 0; i < clean.length; i++) {
        const char = clean[i];
        if (start < 0) {
            if (char === "{") {
                start = i;
                depth = 1;
            }
            continue;
        }
        if (quoted) {
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
            else if (char === '"')
                quoted = false;
            continue;
        }
        if (char === '"')
            quoted = true;
        else if (char === "{")
            depth++;
        else if (char === "}" && --depth === 0) {
            try {
                const parsed = JSON.parse(clean.slice(start, i + 1));
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                    last = parsed;
            }
            catch {
                // Malformed fields remain malformed; never repair or infer them.
            }
            start = -1;
        }
    }
    return last;
}
function cleanLines(text) {
    const all = String(text)
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    // The worker prints its reasoning panel before the answer; the answer
    // follows the session_id marker. Box-drawing lines are never narration.
    const marker = all.findLastIndex((line) => /^session_id:/.test(line));
    const answer = marker >= 0 ? all.slice(marker + 1) : all;
    return answer.filter((line) => !/^[│┌┐└┘─]/.test(line) && !/^session_id:/.test(line));
}
export async function askWorker(prompt, opts) {
    if (opts?.signal?.aborted)
        return { ok: false, detail: "Preparation cancelled." };
    const serviceFailure = managedServiceFailure("reasoning");
    if (serviceFailure)
        return { ok: false, detail: serviceFailure };
    if (process.env.VITEST && !opts?.cli)
        return { ok: false, detail: "tests do not use the live worker." };
    const selection = { ...currentWorkerProfile() };
    const root = hermesHome(opts?.root);
    if (!packInstalled(root)) {
        return { ok: false, detail: `the "${selection.profile}" pack is missing.` };
    }
    if (!approvalsAreManual(root)) {
        return { ok: false, detail: `the "${selection.profile}" pack is not in manual approvals.` };
    }
    const cli = opts?.cli ?? hermesCli();
    const version = await probeHermesVersion(cli);
    if (!version)
        return { ok: false, detail: "the CLI is not available." };
    if (!hermesIsCompatible(version)) {
        return {
            ok: false,
            detail: `installed ${version.trim()}, pin is v${HERMES_PIN.product} (${HERMES_PIN.tag}).`,
        };
    }
    const toolsets = boundedToolsets(opts?.toolsets);
    if (!toolsets)
        return { ok: false, detail: "the worker tool boundary is not usable." };
    if (opts?.signal?.aborted)
        return { ok: false, detail: "Preparation cancelled." };
    const current = currentWorkerProfile();
    if (current.profile !== selection.profile || current.memberKey !== selection.memberKey || hermesHome(opts?.root) !== root) {
        return { ok: false, detail: "The selected worker profile changed. Check your workspace and try again." };
    }
    if (!packInstalled(root) || !approvalsAreManual(root)) {
        return { ok: false, detail: "The selected worker pack changed. Restore manual approvals before trying again." };
    }
    return new Promise((resolve) => {
        let cancel;
        // Launch the exact profile whose pack and approvals were checked above.
        // REALBUD_HERMES_HOME is a RealBud setting; upstream only reads HERMES_HOME.
        // Without this binding, source/helper launches can fall back to ~/.hermes.
        const env = { ...process.env, PATH: augmentedPath(), REALBUD_HERMES_HOME: root };
        const serviceFailure = managedServiceFailure("reasoning");
        if (serviceFailure)
            return resolve({ ok: false, detail: serviceFailure });
        hardenHermesChildEnv(env);
        const execOpts = {
            timeout: opts?.timeoutMs ?? WORKER_TIMEOUT_MS,
            cwd: seedVault(),
            env,
            encoding: "utf8",
            detached: process.platform !== "win32",
        };
        const child = execFileCli(cli, [
            "--profile",
            selection.profile,
            "chat",
            "-Q",
            "--toolsets",
            toolsets.join(","),
            "-q",
            `${BUD_IDENTITY}\n\n${prompt}`,
            "--max-turns",
            String(Math.max(1, Math.min(12, opts?.maxTurns ?? 6))),
        ], execOpts, (err, stdout, stderr) => {
            if (cancel)
                opts?.signal?.removeEventListener("abort", cancel);
            if (opts?.signal?.aborted)
                return resolve({ ok: false, detail: "Preparation cancelled." });
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
                    return resolve({ ok: false, detail: "Bud took too long." });
                const pick = (s) => cleanLines(s).slice(-2).join(" · ");
                const snippet = (pick(stdout) || pick(stderr)).slice(0, 200);
                return resolve({
                    ok: false,
                    detail: snippet ? `Bud could not answer (${snippet}).` : "Bud could not answer.",
                });
            }
            resolve({ ok: true, stdout: String(stdout) });
        });
        cancel = () => {
            // Stop the owned worker before shutdown removes its timeout. Prefer
            // its process group where available, with a direct-child fallback.
            try {
                if (process.platform !== "win32" && child.pid)
                    process.kill(-child.pid, "SIGKILL");
                else
                    child.kill("SIGKILL");
            }
            catch {
                try {
                    child.kill("SIGKILL");
                }
                catch { /* The worker has already exited. */ }
            }
        };
        opts?.signal?.addEventListener("abort", cancel, { once: true });
        if (opts?.signal?.aborted)
            cancel();
    });
}
function draftPrompt(text) {
    return (`The user described a recurring property-management job. Return JSON ONLY as the last line: ` +
        `{ "title": "…", "steps": ["…"], "allowedOrigins": ["portal.example.com"], "evidence": "what each run must capture", ` +
        `"capabilities": ["read-book", "read-files", "web-research", "analyse", "draft"], ` +
        `"schedule": { "time": "HH:MM", "weekdays": [0] } or null }\n` +
        `Origins are bare https hosts of the portals named in the description (no paths). ` +
        `Capabilities must contain only the safe abilities actually needed; never return send, submit, payment, trust, legal, notice, or record-mutation authority. ` +
        `The title must be 1–80 characters; include 1–12 steps of 1–200 characters each; evidence must be at most 200 characters; include at most 5 origins. ` +
        `Steps are plain imperative sentences. Never include credentials. Do not include an introduction, reasoning or commentary in this structured result. ` +
        `If the description names no portal site, allowedOrigins may be []. ` +
        `If the description names a cadence ("every Friday 4pm", "weekday mornings 7:30"), ` +
        `also return "schedule": { "time": "HH:MM" (24h), "weekdays": [0-6, 0=Sunday] }. ` +
        `Otherwise "schedule": null.\n\n` +
        `Job:\n${text}`);
}
export async function shapeRecipeDraft(text, opts) {
    const result = await askWorker(draftPrompt(text), opts);
    if (!result.ok)
        return { draft: null, detail: result.detail };
    const parsed = lastJsonObject(result.stdout);
    if (parsed == null)
        return { draft: null, detail: "Bud answered without a job card." };
    try {
        const fields = validateRecipe({ ...parsed, description: text });
        const createdAt = Date.now();
        return {
            draft: {
                id: randomUUID(),
                ...fields,
                status: "shadow",
                createdAt,
                planApprovedAt: null,
                revision: 1,
                updatedAt: createdAt,
                approvedRevision: null,
                attachment: null,
                submitAcknowledgedAt: null,
            },
            detail: "Bud shaped the job.",
        };
    }
    catch (error) {
        // Recipe validation supplies fixed, actionable field constraints. Never
        // expose raw worker output or unexpected exception details to the PM.
        const detail = error instanceof Error && error.status === 400
            ? `Bud's job card needs a correction: ${error.message}`
            : "that job card was not usable.";
        return { draft: null, detail };
    }
}
export async function draftRecipeFromText(text, opts) {
    return (await shapeRecipeDraft(text, opts)).draft;
}
export async function narrateShadowRun(recipe, opts) {
    const portals = recipe.allowedOrigins.length ? recipe.allowedOrigins.join(", ") : "(none named)";
    const prompt = `You cannot open a browser in this run. Narrate exactly what you would do at each step and what you would capture — one short line per step, no preamble, no closing summary.\n` +
        `Job: ${recipe.title}\n` +
        `Description and reviewed preparation guidance (no additional action authority): ${recipe.description || '(none)'}\n` +
        `Portals: ${portals}\n` +
        `Steps:\n${recipe.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n` +
        `Evidence each run must capture: ${recipe.evidence || "(none named)"}\n` +
        `Known about this site from earlier runs: ${recipe.siteNotes || "(nothing yet)"}`;
    const result = await askWorker(prompt, opts);
    if (!result.ok)
        return result;
    const raw = cleanLines(result.stdout);
    // The prompt demands one numbered line per step; reasoning that survives
    // the marker cut never numbers itself. The reasoning panel prints a
    // width-truncated copy of the list first, so the last line per step number
    // is the full answer. Unnumbered answers keep everything.
    const byStep = new Map();
    for (const line of raw) {
        const step = /^(\d+)[.)]\s/.exec(line);
        if (step)
            byStep.set(step[1], line);
    }
    const lines = (byStep.size ? [...byStep.values()] : raw).slice(0, 24);
    if (!lines.length)
        return { ok: false, detail: "Bud answered without a shadow walkthrough." };
    return { ok: true, lines };
}
