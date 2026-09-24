import { loadRecipes, saveRecipesAtomically, validateRecipe } from "./recipes.js";
const PACK_REVISION = 3;
const MAX_PACK_RECIPES = 100;
/** Austin Phase 1 — bills calendar + payment prep (inbox as supporting evidence). */
export const AUSTIN_PHASE1_PACKS = [
    {
        id: "austin-expected-bills",
        title: "Expected bills",
        summary: "Prepare a bills review from supplied coverage evidence and the expected-bill register. Hold incomplete searches and funding exceptions for Kevin. Confirm sources and cadence before recurring runs.",
        phase: "phase-1",
        requiresHermesPropertyPack: true,
        recipes: [
            {
                id: "wf-austin-expected-bills",
                title: "Expected bills check",
                description: "Pack: austin-expected-bills. This is a workflow identifier, never a property identifier. Use only explicit property mappings in the source; mark other items unmapped and hold them. Prepare-only. Use only the coverage evidence and expected-bill register supplied for this run. If either is missing, hold and name the missing input; do not claim to have searched Gmail. Prepare proposed updates for Kevin; do not claim Desk was updated. Keep invoice receipt, payment arrangement, funding, and confirmed payment separate. Flag insufficient owner funds and company advances for Kevin. Never pay, never send, never invent due dates.",
                steps: [
                    "Check supplied bill evidence covers all agreed mailboxes and dates; otherwise hold",
                    "Match each invoice or absence to the expected-bill register and property",
                    "Propose arrival status separately from due dates, funding and confirmed payment",
                    "Flag insufficient funds, company advance, or owner-to-pay exceptions for review",
                    "Leave a receipt listing source items reviewed, explicit property mappings, and unmapped items needing Kevin",
                ],
                evidence: "Proposed bill findings with source property identifiers or unmapped holds, evidence, and exception reason",
                capabilities: ["read-files", "analyse", "draft"],
                schedule: null,
                allowedOrigins: [],
            },
        ],
    },
    {
        id: "austin-payment-prep",
        title: "Payment preparation",
        summary: "Prepare a supplied bank export for REI Bulk Receipting after Kevin confirms coverage and the reference mapping. Hold unclear references for Kevin. REI keeps recognition and reconciliation.",
        phase: "phase-1",
        requiresHermesPropertyPack: true,
        recipes: [
            {
                id: "wf-austin-payment-prep",
                title: "Payment reference prep",
                description: "Pack: austin-payment-prep. This is a workflow identifier, never a property identifier. Use only explicit property mappings in the source; mark other items unmapped and hold them. Prepare-only until an attended Windows route is accepted. Use only the export and verified reference mapping supplied for this run; hold if either is missing. Propose property references for the agreed bank export coverage, preserve the original file identity, and hold ambiguous rows. Never import into REI, never change amounts, never pay.",
                steps: [
                    "Confirm the agreed bank account and coverage dates for this run",
                    "Propose approved property references from the office mapping",
                    "Hold ambiguous, missing, or colliding references for Kevin",
                    "Produce a checked-copy summary linked to the original export identity",
                    "Leave a prepare receipt ready for Kevin’s REI Bulk Receipting review",
                ],
                evidence: "Original coverage receipt, proposed reference changes, held exception rows",
                capabilities: ["read-files", "analyse", "draft"],
                // The meeting did not confirm a clock time or weekday pattern.
                schedule: null,
                allowedOrigins: [],
            },
        ],
    },
];
export function listWorkflowPackDefinitions() {
    return structuredClone(AUSTIN_PHASE1_PACKS);
}
export function getWorkflowPackDefinition(id) {
    return listWorkflowPackDefinitions().find((pack) => pack.id === id);
}
function depsWithDefaults(deps = {}) {
    return {
        listRecipes: deps.listRecipes ?? (() => loadRecipes(true)),
        saveRecipes: deps.saveRecipes ?? saveRecipesAtomically,
    };
}
function statuses(recipes) {
    const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    return listWorkflowPackDefinitions().map((pack) => {
        const ids = pack.recipes.map((recipe) => recipe.id);
        const missing = ids.filter((id) => !byId.has(id));
        const present = ids.flatMap((id) => byId.has(id) ? [byId.get(id)] : []);
        return {
            id: pack.id, title: pack.title, summary: pack.summary, phase: pack.phase,
            requiresHermesPropertyPack: true,
            installed: missing.length === 0,
            installedAt: present.length ? Math.min(...present.map((recipe) => recipe.createdAt)) : null,
            recipeIds: ids, recipesPresent: present.length, recipesMissing: missing,
            packRevision: PACK_REVISION,
        };
    });
}
export function listWorkflowPackStatus(deps = {}) {
    return statuses(depsWithDefaults(deps).listRecipes());
}
function installDefinitions(definitions, deps) {
    const d = depsWithDefaults(deps);
    const existing = new Set(d.listRecipes().map((recipe) => recipe.id));
    const drafts = definitions.flatMap((pack) => pack.recipes)
        .filter((template) => !existing.has(template.id))
        .map((template) => ({
        ...template, allowedOrigins: template.allowedOrigins ?? [],
        limits: { maxRuntimeMinutes: 3, maxTurns: 8 }, status: "shadow", expectedRevision: 0,
    }));
    // Repeat installation never replaces a person's edits, approval or clock.
    return d.saveRecipes(drafts);
}
export function installWorkflowPack(packId, deps = {}) {
    const definition = getWorkflowPackDefinition(packId);
    if (!definition)
        throw Object.assign(new Error("No such workflow pack."), { status: 404 });
    const all = installDefinitions([definition], deps);
    const ids = new Set(definition.recipes.map((recipe) => recipe.id));
    return { pack: statuses(all).find((pack) => pack.id === packId), recipes: all.filter((recipe) => ids.has(recipe.id)) };
}
export function installAustinPhase1Packs(deps = {}) {
    return statuses(installDefinitions(listWorkflowPackDefinitions(), deps));
}
export function exportWorkflowPacks(deps = {}) {
    const all = depsWithDefaults(deps).listRecipes();
    const packs = statuses(all);
    const recipes = all.filter((recipe) => recipe.id.startsWith("wf-"));
    return {
        version: 1, exportedAt: Date.now(), packs, recipes,
        installs: Object.fromEntries(packs.filter((pack) => pack.installed).map((pack) => [pack.id, {
                packId: pack.id, installedAt: pack.installedAt, recipeIds: pack.recipeIds, packRevision: pack.packRevision,
            }])),
    };
}
function badImport(message) {
    throw Object.assign(new Error(message), { status: 400 });
}
/** Restore absent jobs as unapproved plans. A conflicting local plan requires
 * explicit editing in its workspace; a backup may never silently overwrite it. */
export function importWorkflowPacks(payload, deps = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        badImport("That is not a workflow pack export.");
    const row = payload;
    if (row.version !== 1)
        badImport("Unsupported workflow pack export version.");
    if (!Array.isArray(row.recipes) || row.recipes.length > MAX_PACK_RECIPES) {
        badImport("A pack snapshot must contain a recipes list with at most 100 jobs.");
    }
    const ids = new Set();
    // Complete validation precedes every mutation, including the final row.
    const incoming = row.recipes.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            badImport("Each imported job must be a job card.");
        const recipe = raw;
        if (typeof recipe.id !== "string" || !/^wf-[a-zA-Z0-9_-]{1,100}$/.test(recipe.id)) {
            badImport("Imported office jobs need a valid wf- identifier.");
        }
        if (ids.has(recipe.id))
            badImport("The snapshot contains duplicate job identifiers.");
        ids.add(recipe.id);
        const fields = validateRecipe(recipe);
        if (recipe.schedule != null && fields.schedule == null)
            badImport("An imported schedule is invalid. Correct its time and weekdays.");
        return { id: recipe.id, ...fields };
    });
    const d = depsWithDefaults(deps);
    const existing = new Map(d.listRecipes().map((recipe) => [recipe.id, recipe]));
    for (const recipe of incoming) {
        const current = existing.get(recipe.id);
        if (current && JSON.stringify(validateRecipe(current)) !== JSON.stringify(validateRecipe(recipe))) {
            throw Object.assign(new Error("A snapshot job differs from the saved local plan. No jobs were changed. Review the existing plan or restore into a separate office."), { status: 409 });
        }
    }
    const recipes = d.saveRecipes(incoming.filter((recipe) => !existing.has(recipe.id)).map((recipe) => ({
        ...recipe, status: "shadow", expectedRevision: 0,
    })));
    return { packs: statuses(recipes), recipes };
}
