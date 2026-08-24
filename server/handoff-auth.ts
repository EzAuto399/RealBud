// Immutable handoff authorization. Presentation cannot widen it.
// URL checks compare exact URL.origin — never string prefixes.
import { CLOSED_HANDOFF_OPERATIONS, FORBIDDEN_HANDOFF_ACTIONS, type HandoffAuthorization } from "../shared/desk-v3.ts";

export type BrowserPresentation = "side-by-side" | "inspector" | "window";
export type AuthorizationSource = "pm" | "routine";

export function exactOrigin(url: string): string {
  return new URL(url).origin;
}

export function originAllowed(candidate: string, allowed: readonly string[]): boolean {
  let origin: string;
  try {
    origin = exactOrigin(candidate);
  } catch {
    return false;
  }
  return allowed.includes(origin);
}

export function assertAllowedOrigin(candidate: string, allowed: readonly string[]): void {
  if (!originAllowed(candidate, allowed)) {
    throw Object.assign(new Error("origin is not on the authorization"), { status: 403 });
  }
}

export function assertRoutineCannotMint(source: AuthorizationSource): void {
  if (source === "routine") {
    throw Object.assign(new Error("a routine cannot mint or launch browser authorization"), { status: 403 });
  }
}

export function freezeAuthorization(auth: HandoffAuthorization): HandoffAuthorization {
  if (!(CLOSED_HANDOFF_OPERATIONS as readonly string[]).includes(auth.operation)) {
    throw Object.assign(new Error("handoff operation is not closed"), { status: 403 });
  }
  if (auth.allowedActions.some((action) => (FORBIDDEN_HANDOFF_ACTIONS as readonly string[]).includes(action))) {
    throw Object.assign(new Error("Submit/Send/Pay stay forbidden"), { status: 403 });
  }
  return {
    ...auth,
    allowedOrigins: [...auth.allowedOrigins],
    allowedActions: [...auth.allowedActions],
  };
}

export function withPresentation(auth: HandoffAuthorization, _presentation: BrowserPresentation): HandoffAuthorization {
  return auth;
}

export function sameAuthorization(a: HandoffAuthorization, b: HandoffAuthorization): boolean {
  return (
    a.operation === b.operation &&
    a.caseId === b.caseId &&
    a.proposalId === b.proposalId &&
    a.revisionId === b.revisionId &&
    a.proposalHash === b.proposalHash &&
    a.propertyId === b.propertyId &&
    a.tenancyId === b.tenancyId &&
    a.bindingId === b.bindingId &&
    a.recipeId === b.recipeId &&
    a.recipeVersion === b.recipeVersion &&
    a.expiresAt === b.expiresAt &&
    a.allowedOrigins.join("\0") === b.allowedOrigins.join("\0") &&
    a.allowedActions.join("\0") === b.allowedActions.join("\0")
  );
}
