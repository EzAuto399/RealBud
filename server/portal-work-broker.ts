// Durable broker boundary for the disposable fake portal. This module owns
// admission and typed fixture execution only. It never launches a browser,
// CUA, terminal, personal profile or the final Submit control.
import type { PortalCapability, PortalRecipe } from "../shared/contracts.ts";
import {
  createExecutionAdapterBinding,
  defineExecutionAdapterManifest,
  type ExecutionAdapterAttestation,
} from "./execution-adapters.ts";
import { runBoundedPrefill } from "./portal-handoff.ts";
import { FAKE_PORTAL_RECIPE, fakePortalRecipeAt, isFinalControl, recipeAllows } from "./portal-recipe.ts";
import {
  WorkBroker,
  workDigest,
  type WorkAdmission,
  type WorkAdmissionRequest,
  type WorkReceipt,
} from "./work-broker.ts";
import { buildWorkPlan } from "./work-plan.ts";

const RUNNER_ID = "realbud-fake-portal-prefill";
const ROUTE = "scripted-browser" as const;
const MAX_AUTHORITY_TEXT = 240;
const MAX_APPROVED_BODY = 4_000;
const LEASE_MS = 60_000;
const PLAN_TTL_MS = 15 * 60_000;

const FIXTURE_PORTAL_MANIFEST = defineExecutionAdapterManifest({
  kind: "realbud.execution-adapter.v1",
  schemaVersion: 1,
  id: "fixture-portal-browser",
  version: 1,
  label: "Fixture portal browser",
  method: "RealBud fixture recipe",
  transport: "private-browser",
  route: ROUTE,
  operations: ["prepare-approved-fields"],
  effect: "prepare-only",
  requiresNamedAccount: true,
  requiresExplicitOptIn: true,
  runtimeAvailable: true,
  maxConcurrency: 1,
});

export interface BrokeredFakePortalPrefillInput {
  broker: WorkBroker;
  baseUrl: string;
  body: string;
  capability: PortalCapability;
  now?: () => number;
}

export interface BrokeredFakePortalPrefillResult {
  receipt: WorkReceipt;
  outputDigest: string;
  executed: boolean;
}

interface PreparedPortalWork {
  recipe: PortalRecipe;
  request: WorkAdmissionRequest;
  outputDigest: string;
}

function codedError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function boundedAuthorityText(name: string, value: unknown): string {
  if (
    typeof value !== "string" || !value || value.length > MAX_AUTHORITY_TEXT ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw codedError(`${name} is invalid`, 400, "invalid-portal-work");
  }
  return value;
}

function validateCapability(capability: PortalCapability, now: number, requireFresh: boolean): void {
  boundedAuthorityText("portal capability id", capability?.id);
  boundedAuthorityText("portal work item id", capability?.workItemId);
  boundedAuthorityText("portal proposal hash", capability?.proposalHash);
  boundedAuthorityText("portal property id", capability?.propertyId);
  if (!Number.isInteger(capability.revision) || capability.revision < 0) {
    throw codedError("portal capability revision is invalid", 400, "invalid-portal-work");
  }
  if (!Number.isFinite(capability.expiresAt) || capability.expiresAt < 0) {
    throw codedError("portal capability expiry is invalid", 400, "invalid-portal-work");
  }
  if (requireFresh && capability.expiresAt <= now) {
    throw codedError("portal capability expired", 409, "work-expired");
  }
  if (requireFresh && (capability.usedAt !== undefined || capability.invalidatedAt !== undefined)) {
    throw codedError("portal capability missing or invalidated", 409, "portal-authorization-invalid");
  }
  if (
    capability.operation !== "prefill-courtesy" || capability.approver !== "pm" ||
    capability.recipeId !== FAKE_PORTAL_RECIPE.id || capability.recipeVersion !== FAKE_PORTAL_RECIPE.version
  ) {
    throw codedError("portal capability does not match the RealBud fixture recipe", 409, "portal-authorization-invalid");
  }
}

function preparePortalWork(
  input: BrokeredFakePortalPrefillInput,
  now: number,
  requireFresh: boolean,
  existing?: WorkReceipt,
): PreparedPortalWork {
  validateCapability(input.capability, now, requireFresh);
  if (
    typeof input.body !== "string" || !input.body.trim() || input.body.length > MAX_APPROVED_BODY ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.body)
  ) {
    throw codedError("approved portal wording is invalid", 400, "invalid-portal-work");
  }
  const recipe = fakePortalRecipeAt(input.baseUrl);
  if (
    !recipe.published || recipe.id !== FAKE_PORTAL_RECIPE.id || recipe.version !== FAKE_PORTAL_RECIPE.version ||
    !recipeAllows(recipe, "prefill-courtesy") || !isFinalControl(recipe, "button#submit-reminder")
  ) {
    throw codedError("fake portal recipe is not the published RealBud recipe", 409, "portal-recipe-mismatch");
  }

  const bodyDigest = workDigest(input.body);
  const authorityDigest = workDigest(JSON.stringify({
    kind: "realbud.fake-portal-prefill-input.v1",
    schemaVersion: 1,
    capabilityIdDigest: workDigest(input.capability.id),
    workItemIdDigest: workDigest(input.capability.workItemId),
    proposalHashDigest: workDigest(input.capability.proposalHash),
    propertyIdDigest: workDigest(input.capability.propertyId),
    revision: input.capability.revision,
    bodyDigest,
  }));
  const requestId = `portal-prefill-${workDigest(input.capability.id).slice(0, 32)}`;
  const createdAt = existing?.createdAt ?? now;
  const expiresAt = existing?.expiresAt ?? Math.min(input.capability.expiresAt, now + PLAN_TTL_MS);
  const attestation: ExecutionAdapterAttestation = {
    kind: "realbud.execution-adapter-attestation.v1",
    schemaVersion: 1,
    adapterId: FIXTURE_PORTAL_MANIFEST.id,
    adapterVersion: FIXTURE_PORTAL_MANIFEST.version,
    configurationGeneration: 1,
    state: "ready",
    observedAt: createdAt,
    expiresAt,
    policyDigest: workDigest("realbud.fixture-portal-browser.policy.v1"),
    accountIdentityDigest: workDigest(`fixture-portal:${recipe.origin}`),
    explicitOptIn: true,
  };
  const adapter = createExecutionAdapterBinding({
    manifest: FIXTURE_PORTAL_MANIFEST,
    attestation,
    operation: "prepare-approved-fields",
    now,
  });
  const request: WorkAdmissionRequest = buildWorkPlan({
    requestId,
    createdAt,
    expiresAt,
    bookRevision: input.capability.revision,
    caseRevision: null,
    inputDigests: [authorityDigest],
    dataClasses: ["portal-form-fields"],
    routes: [{ route: ROUTE, adapter }],
    concurrencyKey: `fake-portal:${recipe.origin}`,
    allowedOrigins: [recipe.origin],
    recipe: { id: recipe.id, version: recipe.version },
    effectClass: "possible-external",
    authority: {
      kind: "allow-decision",
      actionId: input.capability.id,
      actionRevision: input.capability.revision,
      actionDigest: authorityDigest,
    },
  });
  const outputDigest = workDigest(JSON.stringify({
    kind: "realbud.fake-portal-prefill-output.v1",
    schemaVersion: 1,
    requestId,
    inputDigest: authorityDigest,
    recipe: request.recipe,
    outcome: "prefilled-and-revoked",
    submitOwner: "human",
  }));
  return { recipe, request, outputDigest };
}

function assertReceiptMatches(receipt: WorkReceipt, prepared: PreparedPortalWork): void {
  const request = prepared.request;
  if (
    receipt.requestId !== request.requestId || receipt.bookRevision !== request.bookRevision || receipt.caseRevision !== null ||
    receipt.route !== ROUTE || receipt.effectClass !== "possible-external" ||
    receipt.concurrencyKeyDigest !== request.concurrencyKeyDigest ||
    receipt.recipe.id !== request.recipe.id || receipt.recipe.version !== request.recipe.version ||
    receipt.expiresAt !== request.expiresAt ||
    receipt.allowedOrigins.length !== 1 || receipt.allowedOrigins[0] !== prepared.recipe.origin ||
    receipt.inputDigests.length !== 1 || receipt.inputDigests[0] !== request.inputDigests[0]
  ) {
    throw codedError("fake portal receipt does not match the admitted work", 409, "work-not-runnable");
  }
}

function receiptStateError(receipt: WorkReceipt): Error {
  if (receipt.state === "effect-unknown") {
    return codedError("The fake portal may have observed the preparation. It will not be replayed.", 409, "portal-effect-unknown");
  }
  if (receipt.state === "cancelled") return codedError("Fake portal preparation was cancelled.", 409, "work-cancelled");
  if (receipt.state === "expired") return codedError("Fake portal preparation expired before it could run.", 409, "work-expired");
  if (receipt.state === "failed") return codedError("Fake portal preparation failed and cannot be replayed.", 409, "work-failed");
  return codedError("Fake portal preparation is already running.", 409, "work-busy");
}

export function admitBrokeredFakePortalPrefill(input: BrokeredFakePortalPrefillInput): WorkAdmission {
  const now = input.now?.() ?? Date.now();
  const prepared = preparePortalWork(input, now, true);
  const existing = input.broker.getByRequestId(prepared.request.requestId);
  if (existing) {
    const rebound = preparePortalWork(input, now, true, existing);
    try {
      assertReceiptMatches(existing, rebound);
    } catch {
      throw codedError("request id is already bound to different work", 409, "idempotency-conflict");
    }
    return { receipt: existing, duplicate: true };
  }
  return input.broker.admit(prepared.request);
}

export async function executeAdmittedFakePortalPrefill(
  input: BrokeredFakePortalPrefillInput & { receiptId: string },
): Promise<BrokeredFakePortalPrefillResult> {
  const now = input.now?.() ?? Date.now();
  input.broker.sweepExpired();
  let receipt = input.broker.get(input.receiptId);
  if (!receipt) throw codedError("fake portal receipt was not found", 404, "work-not-found");
  if (!["queued", "evidence-ready", "reconciled"].includes(receipt.state)) throw receiptStateError(receipt);
  const prepared = preparePortalWork(input, now, false, receipt);
  assertReceiptMatches(receipt, prepared);

  if (receipt.state === "evidence-ready" || receipt.state === "reconciled") {
    if (receipt.outputDigest !== prepared.outputDigest) {
      throw codedError("fake portal output does not match its receipt", 409, "work-not-runnable");
    }
    return { receipt, outputDigest: prepared.outputDigest, executed: false };
  }
  if (receipt.state !== "queued") throw receiptStateError(receipt);
  if (input.capability.usedAt !== undefined || input.capability.invalidatedAt !== undefined) {
    input.broker.cancel(receipt.id, receipt.cancellationGeneration);
    throw codedError("portal capability missing or invalidated", 409, "portal-authorization-invalid");
  }

  const claim = input.broker.leaseNext({
    runnerId: RUNNER_ID,
    routes: [ROUTE],
    requestIds: [receipt.requestId],
    leaseMs: LEASE_MS,
  });
  if (!claim) {
    receipt = input.broker.get(receipt.id) ?? receipt;
    throw receiptStateError(receipt);
  }
  input.broker.start(claim);

  const result = await runBoundedPrefill({
    baseUrl: prepared.recipe.origin,
    body: input.body,
    capability: input.capability,
    recipe: prepared.recipe,
    now,
    beforePrefill: () => {
      input.broker.markEffectBoundary(claim);
    },
  });

  if (result.ok) {
    try {
      receipt = input.broker.complete(claim, prepared.outputDigest);
      return { receipt, outputDigest: prepared.outputDigest, executed: true };
    } catch {
      const current = input.broker.get(claim.receipt.id);
      if (current?.state === "running") {
        try {
          input.broker.fail(claim, { code: "portal-completion-unconfirmed", retryable: false });
        } catch {
          // A persisted possible-effect boundary or uncertain broker write is
          // already non-replayable. Preserve that stronger failure result.
        }
      }
      throw codedError(
        "RealBud could not durably confirm the fake portal outcome. It will not be replayed.",
        503,
        "portal-effect-unknown",
      );
    }
  }

  let failed: WorkReceipt;
  try {
    failed = input.broker.fail(claim, {
      code: result.effect === "unknown" ? "portal-effect-ambiguous" : "portal-step-failed",
      retryable: result.effect === "none",
    });
  } catch {
    const current = input.broker.get(claim.receipt.id);
    if (current) throw receiptStateError(current);
    throw codedError("Fake portal preparation lost its durable receipt.", 503, "work-not-found");
  }
  if (failed.state === "queued") {
    throw codedError("Fake portal preparation did not reach the prefill step. A bounded retry may use this receipt.", 502, "portal-work-retryable");
  }
  throw receiptStateError(failed);
}

export async function runBrokeredFakePortalPrefill(
  input: BrokeredFakePortalPrefillInput,
): Promise<BrokeredFakePortalPrefillResult> {
  const admission = admitBrokeredFakePortalPrefill(input);
  return executeAdmittedFakePortalPrefill({ ...input, receiptId: admission.receipt.id });
}

/** The future Desk/Electron owner calls this only after it has durably
 * projected handoff-ready. Keeping reconciliation separate closes the crash
 * window without pretending this fixture runner is a live vendor adapter. */
export function reconcileBrokeredFakePortalPrefill(input: {
  broker: WorkBroker;
  receiptId: string;
}): WorkReceipt {
  const receipt = input.broker.get(input.receiptId);
  if (!receipt) throw codedError("fake portal receipt was not found", 404, "work-not-found");
  if (
    receipt.route !== ROUTE || receipt.effectClass !== "possible-external" ||
    receipt.recipe.id !== FAKE_PORTAL_RECIPE.id || receipt.recipe.version !== FAKE_PORTAL_RECIPE.version ||
    receipt.allowedOrigins.length !== 1
  ) {
    throw codedError("receipt is not a brokered fake portal prefill", 409, "work-not-reconcilable");
  }
  const recipe = fakePortalRecipeAt(receipt.allowedOrigins[0]!);
  const expected = workDigest(JSON.stringify({
    kind: "realbud.fake-portal-prefill-output.v1",
    schemaVersion: 1,
    requestId: receipt.requestId,
    inputDigest: receipt.inputDigests[0],
    recipe: receipt.recipe,
    outcome: "prefilled-and-revoked",
    submitOwner: "human",
  }));
  if (recipe.origin !== receipt.allowedOrigins[0] || receipt.outputDigest !== expected) {
    throw codedError("fake portal output does not match its receipt", 409, "work-not-reconcilable");
  }
  if (receipt.state === "reconciled") return receipt;
  if (receipt.state !== "evidence-ready") {
    throw codedError("fake portal output is not ready for reconciliation", 409, "work-not-reconcilable");
  }
  return input.broker.reconcile(receipt.id, expected);
}
