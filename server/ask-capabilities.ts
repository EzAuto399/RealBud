import type { BudPromptContext } from "./bud-prompt.ts";
import { currentAskDeskBrief } from "./ask-desk-brief.ts";
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
  /** Local Connect key present. Never a live inbox claim. */
  composioLinked?: boolean;
  /** Public linked-tool status only. Never a key. */
  linkedTools?: Array<{ slug: string; label: string; connected: boolean; account?: string; lastPeekTitles?: string[] }>;
}

/**
 * Small, server-owned capability projection for Bud's current turn. This is
 * descriptive only: it grants no authority and contains no credentials,
 * arbitrary paths, URLs, Notes, tenant details or model-auth state.
 */
export function currentAskCapabilityContext(
  desk: Desk,
  options: AskCapabilityContextOptions = {},
): Pick<BudPromptContext, "capabilities" | "preparableHandoffs" | "deskBrief" | "linkedReads"> {
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
  const mailLinked = (options.linkedTools ?? []).some((tool) => (
    tool.connected && (tool.slug === "gmail" || tool.slug === "googlecalendar" || tool.slug === "outlook")
  ));

  return {
    deskBrief: currentAskDeskBrief(snapshot),
    linkedReads: linkedReadsFrom(options.linkedTools),
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
      ...(linkedOfficeCapability(options.linkedTools) ? [linkedOfficeCapability(options.linkedTools)!] : []),
      {
        id: "composio-account",
        label: "Restricted Composio account",
        status: options.composioLinked ? "ready" : "setup-required",
        detail: options.composioLinked
          ? "Linked on this device. Named login stays on the Ask card. Ask never sees the key"
          : "Not linked. If this job needs a named read, propose open-setup for composio-account",
      },
      {
        id: "mail-calendar-source",
        label: "Read-only mail and calendar source",
        status: mailLinked ? "practice-only" : "setup-required",
        detail: mailLinked
          ? "Gmail is on this device. RealBud can list recent subjects. Ask still cannot send."
          : options.composioLinked
            ? "Named login is on this device. Inbox is not listed yet. Do not claim mail was read"
            : demoInboxExercised
              ? "Demo inbox is on Desk. For a named inbox, propose composio-account first. Do not claim mail was read"
              : "If this job needs a named inbox, propose composio-account first. Do not claim mail was read",
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

function linkedOfficeCapability(
  tools: AskCapabilityContextOptions["linkedTools"],
): { id: string; label: string; status: "practice-only"; detail: string } | null {
  const ready = (tools ?? []).filter((tool) => tool.connected).slice(0, 4);
  if (ready.length === 0) return null;
  const names = ready.map((tool) => tool.label).join(", ");
  return {
    id: "linked-office-tools",
    label: "Named app keys on this device",
    status: "practice-only",
    detail: `${names} ${ready.length === 1 ? "is" : "are"} on this device. RealBud can list what they share. Ask still cannot send.`,
  };
}

function linkedReadsFrom(
  tools: AskCapabilityContextOptions["linkedTools"],
): Array<{ label: string; account?: string; titles: string[] }> {
  return (tools ?? [])
    .filter((tool) => tool.connected)
    .slice(0, 4)
    .map((tool) => ({
      label: tool.label,
      ...(tool.account ? { account: tool.account } : {}),
      titles: (tool.lastPeekTitles ?? []).slice(0, 8),
    }));
}
