import { randomUUID } from "node:crypto";
import { MANUAL_JOB_REQUEST_ID, manualJobRequestKey } from "../shared/manual-job-request.js";
export function manualRecipeRequestKey(recipe, body, mode) {
    // Older callers retain the legacy one-click/one-attempt behavior.
    if (body.requestId === undefined)
        return manualJobRequestKey(recipe.id, recipe.revision, mode, randomUUID());
    if (typeof body.requestId !== "string" || !MANUAL_JOB_REQUEST_ID.test(body.requestId)) {
        throw Object.assign(new Error("A valid run request ID is required."), { status: 400 });
    }
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
        throw Object.assign(new Error("The saved plan version is required for this run request."), { status: 400 });
    }
    return manualJobRequestKey(recipe.id, Number(body.expectedRevision), mode, body.requestId);
}
