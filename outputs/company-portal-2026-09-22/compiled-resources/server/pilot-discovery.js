import { PILOT_CONTRACT, pilotContractComplete } from "./pilot-contract.js";
function present(value) {
    const trimmed = value?.trim() ?? "";
    return trimmed ? trimmed.slice(0, 160) : null;
}
function field(id, label, value, question, state = value ? "confirmed" : "unconfirmed") {
    return { id, label, state, value, question };
}
function discoveryFields(contract) {
    const agency = !contract.demo && contract.agency !== "RealBud Demo Book" ? present(contract.agency) : null;
    const pm = present(contract.pmUser);
    const cadence = contract.exportCadenceHours !== null && Number.isFinite(contract.exportCadenceHours)
        && contract.exportCadenceHours > 0 && contract.exportCadenceHours <= contract.freshnessSlaHours
        ? `${contract.exportCadenceHours} hours`
        : null;
    const jurisdictions = contract.confirmedJurisdictions.length
        && contract.confirmedJurisdictions.every((value) => Boolean(value.trim()))
        ? contract.confirmedJurisdictions.map((value) => value.trim()).join(", ")
        : null;
    return [
        field("agency-pm", "Agency + working PM", agency && pm ? `${agency} · ${pm}` : agency ? `${agency} · PM not confirmed` : null, "Who will run RealBud day to day, and who is the principal or approver?", agency && pm ? "confirmed" : agency ? "partial" : "unconfirmed"),
        field("pms-brand", "PMS brand", present(contract.pmsBrand), "Which PMS owns the rent roll and current ledger?"),
        field("named-exporter", "Named exporter", present(contract.namedExporter), "Who can produce the read-only arrears or rent-roll export?"),
        field("export-cadence", "Export cadence", cadence, "How often can that export arrive, and when is it considered stale?"),
        field("export-identity", "Stable property identity", contract.exportIdentityColumn, "Which stable field joins each export row to a property: property ID, code, or address?"),
        field("office-os", "Office computer", contract.officeOs, "Which installed Mac or Windows computer will the named PM use?"),
        field("jurisdictions", "Book jurisdictions", jurisdictions, "Which states or territories are actually represented in the managed book?"),
        field("vendor-test-account", "Vendor test account", contract.vendorTestAccount ? "Approved" : null, "Which non-production vendor or portal account can prove login, MFA, expiry, revocation and human Submit?"),
    ];
}
const SHADOW_WORKFLOWS = [
    {
        id: "morning-money",
        label: "Morning money",
        outcome: "One current exception queue from the PMS book, with read-only bank corroboration only where the office approves it.",
        baselineQuestion: "How long does the PM spend, which systems are opened, and how are discrepancies handled today?",
        currentEvidence: "source-built",
    },
    {
        id: "inbox-maintenance",
        label: "Inbox and maintenance",
        outcome: "Classify incoming work, link the property, prepare a reply, and remember the next check without sending.",
        baselineQuestion: "Which inbox receives tenant/owner/tradie work, what counts as urgent, and who approves the reply or job handoff?",
        currentEvidence: "foundation-built",
    },
    {
        id: "tenancy-dates",
        label: "Tenancy dates",
        outcome: "Surface lease, inspection and follow-up preparation from confirmed fields without creating a statutory clock or notice.",
        baselineQuestion: "Which dates are trusted, where do they live, and which shop reminders does the PM currently maintain?",
        currentEvidence: "planned",
    },
];
const SYSTEM_FAMILIES = [
    {
        id: "pms-rent-roll",
        label: "PMS and rent roll",
        recognisedExamples: ["PropertyMe", "MRI Property Tree", "Reapit PM", "Managed", "Other named PMS"],
        routeOrder: ["Structured export", "Direct read API", "Restricted connector", "Bounded browser handoff"],
        proofNeeded: "Exact product, export/API scope, property identity, freshness, account and revocation path.",
    },
    {
        id: "bank-evidence",
        label: "Read-only bank evidence",
        recognisedExamples: ["Agency-named bank account"],
        routeOrder: ["Structured bank export", "Typed read-only browser recipe", "Bounded CUA for the same approved browser"],
        proofNeeded: "Approved read-only test account, PM login/MFA, bounded credit list, expiry, rate limits and no transfer/payee path.",
    },
    {
        id: "inbox-calendar",
        label: "Inbox and calendar",
        recognisedExamples: ["Microsoft 365", "Google Workspace", "Other named provider"],
        routeOrder: ["Direct read API", "Restricted Composio session", "Approved one-server MCP adapter"],
        proofNeeded: "One named account, exact read scopes, attachment quarantine, revocation and draft-only handoff.",
    },
    {
        id: "leasing-inspections",
        label: "Leasing and inspections",
        recognisedExamples: ["PMS-native workflow", "InspectRealEstate", "Inspection Express", "Other named portal"],
        routeOrder: ["PMS export/API", "Named integration", "Bounded browser preparation"],
        proofNeeded: "Trusted dates, account/origin, SSO/MFA, layout/read-back and an explicit licensed-person boundary.",
    },
    {
        id: "maintenance-compliance",
        label: "Maintenance and compliance",
        recognisedExamples: ["PMS-native maintenance", "Tapi", "ServiceM8", "Named compliance vendor", "Other named portal"],
        routeOrder: ["Read-only provider API", "Named integration", "Bounded portal preparation"],
        proofNeeded: "Urgency rules, owner approval thresholds, vendor identity, attachment handling and human dispatch/Submit.",
    },
    {
        id: "listing-leads",
        label: "Listings, enquiries and BDM",
        recognisedExamples: ["REA Partner Platform", "Agency CRM", "Other authorised listing/lead provider"],
        routeOrder: ["Authorised partner API", "CRM export/API", "Read-only inbox classification"],
        proofNeeded: "Agency delegation, granted scopes, stable listing/contact identity, revocation and no unauthorised scraping.",
    },
    {
        id: "mobile-pocket",
        label: "PM Pocket",
        recognisedExamples: ["WhatsApp Business Cloud", "Telegram"],
        routeOrder: ["Official app-owned channel into the same Ask thread"],
        proofNeeded: "Named PM identity, agency privacy approval, dedicated channel, delivery ambiguity and disable/re-enable proof.",
    },
];
function officeFor(contract, complete) {
    const agency = present(contract.agency);
    if (!contract.demo && agency) {
        return {
            agency,
            state: complete ? "contract-complete" : "partial",
            summary: complete
                ? "The office contract is complete. Installed shadow runs and exact account proofs remain separate release gates."
                : "The agency is named, but the remaining operational fields still need confirmation with the working PM.",
            signals: [
                "The named agency comes from the pilot contract; the working-PM status remains visible in the eight fields below.",
                "The PMS, exporter, cadence, identity, office OS, jurisdictions and vendor test-account fields remain visible below.",
                "A complete contract grants no send, payment, statutory, browser or release authority by itself.",
            ],
        };
    }
    return {
        agency: null,
        state: "unconfigured",
        summary: "Confirm the office's actual systems and three highest-load workflows before enabling a live adapter.",
        signals: [
            "Prefer a structured export or narrow read API when it can complete the named job.",
            "Use a restricted named connector before considering browser or desktop control.",
            "Browser and CUA work require the exact account, origin, recipe, read-back, expiry and recovery path.",
            "Recognising a provider never means its account is connected or ready.",
        ],
    };
}
export function pilotDiscoveryProjection(contract = PILOT_CONTRACT, now = Date.now()) {
    const fields = discoveryFields(contract);
    const confirmedFields = fields.filter((item) => item.state === "confirmed").length;
    const complete = pilotContractComplete(contract);
    const office = officeFor(contract, complete);
    return {
        kind: "realbud.pilot-discovery.v1",
        schemaVersion: 1,
        generatedAt: new Date(now).toISOString(),
        office,
        readiness: {
            confirmedFields,
            requiredFields: 8,
            contractComplete: complete,
            evidence: complete ? "contract-complete-unproved" : "pilot-gated",
            detail: complete
                ? "The eight contract fields are present. Installed shadow runs and exact account recovery paths still have to be proved."
                : office.state === "unconfigured"
                    ? "No office is configured. External research never unlocks Pocket, a live portal, bank access or release packaging."
                    : "The agency is named, but incomplete contract fields still block Pocket, live accounts, browser work and release packaging.",
        },
        fields,
        shadowWorkflows: SHADOW_WORKFLOWS.map((item) => ({ ...item })),
        systemFamilies: SYSTEM_FAMILIES.map((item) => ({
            ...item,
            recognisedExamples: [...item.recognisedExamples],
            routeOrder: [...item.routeOrder],
        })),
        boundaries: {
            externalResearchGrantsAuthority: false,
            manualAllow: true,
            humanSubmit: true,
            sendAvailable: false,
            paymentAvailable: false,
            statutoryDraftingAvailable: false,
            personalBrowserAccess: false,
            personalHermesAccess: false,
        },
    };
}
