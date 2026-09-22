import { createHash } from 'node:crypto';
import { recipeClockRunnable } from "../shared/contracts.js";
import { agencyRecipeRole } from "../shared/agency-workflow-packs.js";
import { canonicalWebsiteCommand } from "../shared/website-commands.js";
import { isCompanyExecutionReview } from "../shared/company-execution.js";
export const departmentWorkDigest = (value) => createHash('sha256').update(canonicalWebsiteCommand(value)).digest('hex');
export function departmentWorkRecipe(recipe, instructions) {
    const review = { plan: { title: recipe.title, description: recipe.description, steps: [...recipe.steps], evidence: recipe.evidence, capabilities: [...recipe.capabilities], allowedOrigins: [...recipe.allowedOrigins], limits: { ...recipe.limits }, siteNotes: recipe.siteNotes ?? null }, instructions };
    if (!recipeClockRunnable(recipe) || agencyRecipeRole(recipe.id) || !isCompanyExecutionReview(review))
        throw Object.assign(new Error('Choose an approved analysis or drafting plan that uses only this assigned case. Private inbox, files and portal workflows need a department source connection.'), { status: 409 });
    return { id: recipe.id, revision: recipe.revision, digest: departmentWorkDigest(review.plan), instructionDigest: departmentWorkDigest(instructions), review };
}
export function assertDepartmentWorkRecipe(value) {
    if (!isCompanyExecutionReview(value.review) || departmentWorkDigest(value.review.plan) !== value.digest || departmentWorkDigest(value.review.instructions) !== value.instructionDigest)
        throw Object.assign(new Error('The complete reviewed department plan is unavailable or changed. Request a fresh owner review.'), { status: 409 });
}
