export const FAKE_PORTAL_RECIPE = {
    id: "fake-building-portal",
    version: 1,
    origin: "http://127.0.0.1",
    published: true,
    steps: ["open-login", "open-property", "read-ledger", "prefill-courtesy"],
    finalControlFingerprint: "button#submit-reminder",
};
export function recipeAllows(recipe, step) {
    return recipe.steps.includes(step) && step !== "submit" && step !== "pay" && step !== "send";
}
export function isFinalControl(recipe, fingerprint) {
    return fingerprint === recipe.finalControlFingerprint;
}
export function saveCandidate(base, _reason) {
    return {
        ...base,
        version: base.version + 1,
        published: false,
        steps: [...base.steps],
        id: base.id,
        origin: base.origin,
        finalControlFingerprint: base.finalControlFingerprint,
    };
}
export function publishRecipe(recipe) {
    if (recipe.published)
        return recipe;
    return { ...recipe, published: true };
}
