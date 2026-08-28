import type { BudPromptContext } from "./bud-prompt.ts";
import type { Desk } from "./desk.ts";
import { PILOT_CONTRACT, pilotContractComplete, type PilotContract } from "./pilot-contract.ts";
import type { PocketHubStatus } from "./pocket-hub.ts";
import { currentBankSourceHealth } from "./source-capability.ts";

export interface AskCapabilityContextOptions {
  now?: () => number;
  portalMode?: "practice" | "pilot";
  pocket?: PocketHubStatus | null;
  pilotContract?: PilotContract;
  bankAdapterConfigured?: boolean;
}

/**
 * Small, server-owned capability projection for Bud's current turn. This is
 * descriptive only: it grants no authority and contains no credentials,
 * arbitrary paths, URLs, Notes, tenant details or model-auth state.
 */
export function currentAskCapabilityContext(
  desk: Desk,
  options: AskCapabilityContextOptions = {},
): Pick<BudPromptContext, "capabilities" | "preparableHandoffs"> {
  const now = options.now?.() ?? Date.now();
  const portalMode = options.portalMode ?? "practice";
  const pocket = options.pocket;
  const pilotContract = options.pilotContract ?? PILOT_CONTRACT;
  const snapshot = desk.snapshot();
  const bank = currentBankSourceHealth(snapshot, now);
  const bankObserved = bank.source !== null;
  const bankLiveReady = bank.health === "current" && snapshot.mode === "live" && !pilotContract.demo &&
    pilotContractComplete(pilotContract) && options.bankAdapterConfigured === true;
  const demoInboxExercised = snapshot.sources.some((source) => source.kind === "mail" && source.stableKey === "demo:read-only-inbox");
  const preparableHandoffs = snapshot.drafts.flatMap((draft) => {
    if (draft.status !== "allowed") return [];
    const work = snapshot.workItems.find((item) => item.id === draft.workItemId || item.draftId === draft.id);
    const property = snapshot.properties.find((item) => item.id === draft.propertyId);
    const capability = desk.capabilityFor(draft.id);
    if (
      !work || !property || work.state !== "approved" || !capability ||
      capability.expiresAt <= now || capability.revision !== snapshot.revision ||
      capability.proposalHash !== work.proposalHash
    ) return [];
    return [{
      draftId: draft.id,
      address: property.address,
      kind: draft.kind,
      mode: portalMode,
    }];
  }).slice(0, 20);

  const handoffDetail = preparableHandoffs.length
    ? `${preparableHandoffs.length} approved handoff${preparableHandoffs.length === 1 ? " is" : "s are"} ready for an Allow decision`
    : "No approved handoff is ready; wording must be allowed on Desk first";

  return {
    capabilities: [
      {
        id: "selected-evidence-review",
        label: "Review PM-selected files and images",
        status: "ready",
        detail: "Only private copies of files explicitly attached to this turn are in scope; tool access is denied",
      },
      {
        id: "property-intake",
        label: "Stage properties from selected evidence",
        status: "ready",
        detail: "Creates Desk proposals; the book changes only after Allow",
      },
      {
        id: "realbud-changes",
        label: "Run or retune routines and change bounded book settings",
        status: "ready",
        detail: "Every change is a review card and uses the owning Desk, Schedule or You command",
      },
      {
        id: "bounded-portal-handoff",
        label: "Prepare approved wording in a case-bound portal handoff",
        status: portalMode === "practice" ? "practice-only" : "ready",
        detail: handoffDetail,
      },
      {
        id: "bank-payment-observation",
        label: "Compare bounded read-only bank credits with the property book",
        status: bankLiveReady ? "ready" : bankObserved ? "practice-only" : "pilot-gated",
        detail: bankLiveReady
          ? "A current named-pilot observation can create evidence or holds from exact property-code and weekly/fortnightly matches; PMS remains authoritative"
          : bank.health === "stale"
            ? "A prior observation is stale and grants no current payment truth; the named read-only check must be restored"
            : bankObserved
              ? "The bounded fixture path has been exercised; no verified bank account is connected and the observation is practice-only"
          : "A named bank test account and typed read-only browser recipe are required; login and MFA stay with the PM",
      },
      {
        id: "desktop-reminders",
        label: "Privacy-safe desktop routine reminders",
        status: "setup-required",
        detail: "The PM owns the on/off choice in You; no tenant or property detail leaves the window",
      },
      {
        id: "pm-pocket",
        label: "Use the same Ask thread from the PM's private messaging channel",
        status: pocket?.state === "ready"
          ? "ready"
          : pocket?.state === "pilot-gated" || !pocket?.pilotReady
            ? "pilot-gated"
            : "setup-required",
        detail: pocket?.state === "ready"
          ? `${pocket.connectedCount} allowlisted PM channel${pocket.connectedCount === 1 ? " is" : "s are"} connected; changes still require manual Allow`
          : pocket?.detail ?? "Pocket is not connected",
      },
      {
        id: "mail-calendar-source",
        label: "Read-only mail and calendar source",
        status: "pilot-gated",
        detail: demoInboxExercised
          ? "The bounded Demo inbox case flow is available on Desk; no verified provider source is connected"
          : "No verified source adapter is connected in this build",
      },
      {
        id: "sandboxed-cli",
        label: "Run command-line utilities in an isolated task workspace",
        status: "unavailable",
        detail: "No contained CLI adapter is installed; raw host shell access is blocked",
      },
      {
        id: "computer-history",
        label: "Use prior device activity as case evidence",
        status: "pilot-gated",
        detail: "No consented, case-scoped history adapter is connected",
      },
    ],
    preparableHandoffs,
  };
}
