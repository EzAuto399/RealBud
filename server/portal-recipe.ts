// Versioned portal recipes. Candidates may auto-save; they never auto-publish.
import type { PortalRecipe } from "../shared/contracts.ts";

export const FAKE_PORTAL_RECIPE: PortalRecipe = {
  id: "fake-building-portal",
  version: 1,
  origin: "http://127.0.0.1",
  published: true,
  steps: ["open-login", "open-property", "read-ledger", "prefill-courtesy"],
  finalControlFingerprint: "button#submit-reminder",
};

/** Bind the training recipe to the exact ephemeral loopback origin used by
 * its fake portal. A host-only prefix is not an authorization boundary. */
export function fakePortalRecipeAt(baseUrl: string): PortalRecipe {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw Object.assign(new Error("fake portal URL is invalid"), { status: 400 });
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw Object.assign(new Error("fake portal must be an exact credential-free loopback origin"), { status: 400 });
  }
  return { ...FAKE_PORTAL_RECIPE, origin: parsed.origin };
}

export function recipeAllows(recipe: PortalRecipe, step: string): boolean {
  return recipe.steps.includes(step) && step !== "submit" && step !== "pay" && step !== "send";
}

export function isFinalControl(recipe: PortalRecipe, fingerprint: string): boolean {
  return fingerprint === recipe.finalControlFingerprint;
}

export function saveCandidate(base: PortalRecipe, _reason: string): PortalRecipe {
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

export function publishRecipe(recipe: PortalRecipe): PortalRecipe {
  if (recipe.published) return recipe;
  return { ...recipe, published: true };
}
