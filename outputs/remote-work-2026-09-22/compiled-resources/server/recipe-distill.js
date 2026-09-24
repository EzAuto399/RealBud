import { listHistory } from "./computer-history.js";
import { listSessions } from "./portal-sessions.js";
import { askWorker, lastJsonObject } from "./recipe-draft.js";
import { getRecipe, saveRecipe, validateRecipe } from "./recipes.js";
function latestSessionFor(recipeId) {
    return listSessions()
        .filter((session) => session.recipeId === recipeId)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
}
function observedBlock(session, historyLines) {
    const run = session
        ? [
            `Last run: ${session.shadow ? "shadow" : "live"} · ${session.state}`,
            session.detail ? `Run note: ${session.detail}` : "",
            ...session.evidence.map((item) => item.note).filter(Boolean),
        ].filter(Boolean)
        : ["Last run: none on file."];
    const seen = historyLines.length ? historyLines : ["(no recent activity)"];
    return `${run.join("\n")}\n\nRecent activity:\n${seen.join("\n")}`;
}
function distillPrompt(recipe, session, historyLines) {
    return (`Here is the job, here is what happened on the last run. ` +
        `Rewrite the steps to be fewer, more concrete (name the actual buttons/pages seen), ` +
        `and keep every safety boundary. Also record what this run taught you about the site's layout — ` +
        `page names, button labels, quirks — one short paragraph the next run should know. ` +
        `Return JSON only as the last line: { "steps": ["…"], "siteNotes": "…" }\n\n` +
        `Job: ${recipe.title}\n` +
        `Portals: ${recipe.allowedOrigins.length ? recipe.allowedOrigins.join(", ") : "(none named)"}\n` +
        `Steps:\n${recipe.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n` +
        `Evidence each run must capture: ${recipe.evidence || "(none named)"}\n` +
        `Known about this site from earlier runs: ${recipe.siteNotes || "(nothing yet)"}\n\n` +
        observedBlock(session, historyLines));
}
export async function distillRecipe(id, opts) {
    const recipe = getRecipe(id);
    if (!recipe)
        throw Object.assign(new Error("no such recipe"), { status: 404 });
    const session = latestSessionFor(recipe.id);
    const historyLines = listHistory(20).map((entry) => `${entry.name} · ${entry.ok ? "ok" : "denied"}${entry.detail ? ` · ${entry.detail}` : ""}`);
    const result = await askWorker(distillPrompt(recipe, session, historyLines), opts);
    if (!result.ok) {
        throw Object.assign(new Error(`Bud could not tighten those steps — ${result.detail}`), { status: 503 });
    }
    const parsed = lastJsonObject(result.stdout);
    const rawSteps = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed.steps
        : undefined;
    const rawSiteNotes = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed.siteNotes
        : undefined;
    try {
        const fields = validateRecipe({
            title: recipe.title,
            steps: rawSteps,
            allowedOrigins: recipe.allowedOrigins,
            evidence: recipe.evidence,
            siteNotes: typeof rawSiteNotes === "string" ? rawSiteNotes : undefined,
        });
        const previousSteps = [...recipe.steps];
        const next = saveRecipe({ ...recipe, steps: fields.steps, siteNotes: fields.siteNotes ?? undefined });
        const saved = next.find((row) => row.id === recipe.id);
        if (!saved)
            throw Object.assign(new Error("Bud could not tighten those steps — the job was not saved."), { status: 503 });
        return { recipe: saved, previousSteps };
    }
    catch (error) {
        const status = error.status;
        if (status === 503)
            throw error;
        throw Object.assign(new Error("Bud could not tighten those steps — that rewrite was not usable."), { status: 503 });
    }
}
