export const NEVER_ACTIONS = ["statutory-send", "trust-pay"];
export const COURTESY_DISCLAIMER = "This is not a formal notice and does not start any notice period.";
/** Safe abilities a taught job may ask of the pinned worker.
 * Pay, sign, send, statutory notice, and PMS mutation are never granted.
 * portal-submit is an opt-in click on a non-money control; every press still asks. */
export const JOB_CAPABILITIES = [
    "read-book",
    "read-files",
    "web-research",
    "analyse",
    "draft",
    "portal-read",
    "portal-prefill",
    "portal-submit",
];
/** Clock-runnable: active and a person has approved the plan. Shadow stays manual. */
export function recipeClockRunnable(recipe) {
    return (recipe.status === "active" &&
        recipe.planApprovedAt != null &&
        recipe.approvedRevision === recipe.revision);
}
export function aud(cents) {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}
