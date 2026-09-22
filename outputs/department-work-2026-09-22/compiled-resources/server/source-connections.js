import { PILOT_CONTRACT, pilotContractComplete } from "./pilot-contract.js";
import { redactSecretsInText } from "./redact.js";
import { currentBankSourceHealth, currentPmsSourceHealth } from "./source-capability.js";
function gatedMethodState(contract) {
    return pilotContractComplete(contract) ? "not-built" : "pilot-gated";
}
export function sourceConnectionCatalog(desk, contract = PILOT_CONTRACT, options = {}) {
    const now = options.now ?? Date.now();
    const pms = currentPmsSourceHealth(desk, now);
    const bank = currentBankSourceHealth(desk, now);
    const liveSourceReady = desk.mode === "live" && desk.hands === "csv" && pms.health === "current" && !desk.recovery.active;
    const bookState = desk.recovery.active
        ? "attention"
        : liveSourceReady
            ? "ready"
            : desk.mode === "demo"
                ? "practice"
                : "attention";
    const bookStatus = desk.recovery.active
        ? "Recovery paused"
        : liveSourceReady
            ? "Live source matched"
            : desk.mode === "demo"
                ? "Practice book"
                : pms.health === "stale"
                    ? "PMS source is stale"
                    : pms.health === "incomplete"
                        ? "PMS coverage needs review"
                        : "Recheck source";
    const alternateState = gatedMethodState(contract);
    const inboundGateComplete = pilotContractComplete(contract);
    const sourceDetail = desk.handsDetail ? redactSecretsInText(desk.handsDetail).slice(0, 300) : null;
    const bankObserved = bank.source !== null;
    const bankLiveReady = bank.health === "current" && desk.mode === "live" && !contract.demo &&
        pilotContractComplete(contract) && options.bankAdapterConfigured === true;
    const bankMethodState = bankLiveReady
        ? "active"
        : bank.health === "stale"
            ? "attention"
            : bankObserved
                ? "practice"
                : "pilot-gated";
    const demoInboxExercised = desk.sources.some((source) => source.kind === "mail" && source.stableKey === "demo:read-only-inbox");
    return [
        {
            id: "property-book",
            title: "Property and money source",
            description: liveSourceReady
                ? `A current structured PMS export is the money authority for ${desk.properties.length} properties.`
                : desk.recovery.active
                    ? "Recovery is protecting the current book. Source changes stay paused until the book is restored."
                    : desk.mode === "demo"
                        ? "Practice data is available now. Match a current structured PMS export before relying on live balances."
                        : sourceDetail ?? "The live book is present, but its current money source needs another check.",
            state: bookState,
            status: bookStatus,
            capabilities: [
                "Match portfolio records",
                "Verify current PMS money facts",
                "Compare read-only bank credits and hold discrepancies",
                "Create holds and draft work on Desk",
            ],
            methods: [
                {
                    id: "local-export",
                    label: "Current structured PMS export",
                    state: "active",
                    detail: "Best for the complete portfolio and current money facts. The verified route currently accepts the PMS CSV, validates it locally and holds unmatched or ambiguous rows.",
                },
                {
                    id: "selected-evidence",
                    label: "Selected files, screenshots or photos",
                    state: "active",
                    detail: "Best for building or filling the property book from Excel, PDFs, documents, inspection material, screenshots or photos selected in Ask. Extracted records remain proposals and never verify live balances.",
                },
                {
                    id: "paste-manual",
                    label: "Paste or manual add",
                    state: "active",
                    detail: "Best for small books and gaps. Quick paste works without a model; Desk can add one property. Both paths require an explicit book decision.",
                },
                {
                    id: "read-only-bank-browser",
                    label: "Read-only bank activity",
                    state: bankMethodState,
                    detail: bankLiveReady
                        ? "A current typed observation from the named pilot adapter has reached Desk. It can suppress questionable warning wording; it cannot transfer, add payees or perform trust reconciliation."
                        : bank.health === "stale"
                            ? "A prior bank-credit observation is now stale. It grants no current connection or payment truth; run the named read-only check again after the PM restores login if required."
                            : bankObserved
                                ? "A typed practice observation has reached Desk. It proves the bounded fixture path only—not a live bank connection, current payment truth or account authority."
                                : "Pilot-gated until the office names its bank and test account. The PM completes login and MFA in a RealBud-owned browser; Bud may read the bounded credit list only.",
                },
                {
                    id: "direct-api",
                    label: "Direct PMS read API",
                    state: alternateState,
                    detail: inboundGateComplete
                        ? "Not built until the named PMS and read-only account are proven in the pilot."
                        : "Pilot-gated until the office names its PMS, exporter, cadence and identity column.",
                },
                {
                    id: "private-pms-browser",
                    label: "Private PMS browser recipe",
                    state: alternateState,
                    detail: inboundGateComplete
                        ? "Not built until one named PMS account proves login, MFA, session safety, exact origins, selectors, read-back and recovery."
                        : "Pilot-gated fallback when no safe export or read API covers the job. It uses a RealBud-owned browser, never the PM's personal browser or ambient desktop.",
                },
            ],
        },
        {
            id: "inbound-mail-calendar",
            title: "Incoming mail and calendar",
            description: inboundGateComplete
                ? "The pilot fields are present, but this exact read-only adapter has not been built or authorised yet."
                : demoInboxExercised
                    ? "The bounded Demo inbox case flow has been exercised on Desk. No provider account is connected; the first office pilot still chooses one named read-only inbox."
                    : "The first office pilot chooses one named read-only inbox. RealBud will classify items and stage reply drafts on Desk; it will not send or write calendars.",
            state: inboundGateComplete ? "attention" : "pilot-gated",
            status: inboundGateComplete ? "Adapter not built" : demoInboxExercised ? "Demo flow tested · live adapter gated" : "Pilot-gated",
            capabilities: ["Read named inbound items", "Link items to portfolio cases", "Stage reply drafts on Desk"],
            methods: [
                {
                    id: "direct-api",
                    label: "Direct provider API",
                    state: alternateState,
                    detail: "Preferred when the named provider offers exact read-only scopes and stable account identity.",
                },
                {
                    id: "restricted-composio",
                    label: "Restricted Composio session",
                    state: alternateState,
                    detail: "Fallback only: one named account, explicit read actions, no sandbox and no broad discovery session.",
                },
                {
                    id: "approved-mcp",
                    label: "Approved MCP server",
                    state: alternateState,
                    detail: "Fallback only: one reviewed server and account with an exact operation allowlist; raw MCP tools never reach Bud.",
                },
            ],
        },
    ];
}
