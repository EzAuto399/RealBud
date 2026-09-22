// Machine-readable copy of docs/PILOT-CONTRACT.md. A live portal adapter
// must not start until `readyForLivePortal` is true. Filling You → This
// office does not invent a paying agency and does not turn CUA on.
import { officeContractComplete } from "../shared/office.js";
export const PILOT_CONTRACT = {
    agency: "RealBud Demo Book",
    jurisdiction: "ACT",
    pmOs: process.platform,
    pmsExport: "csv",
    portal: "fake-building-portal",
    reminderType: "non-statutory-courtesy",
    freshnessSlaHours: 12,
    cuaHostSupported: process.platform === "darwin",
    demo: true,
};
export function readyForLivePortal(input) {
    return input.realAgencyNamed && input.vendorTestAccount && input.cuaHostSupported;
}
export function pilotContractFromBook(input) {
    if (!officeContractComplete(input))
        return PILOT_CONTRACT;
    return {
        agency: input.agencyName.trim(),
        jurisdiction: input.jurisdictions.join(", "),
        pmOs: input.office.officeOs,
        pmsExport: input.office.pmsBrand,
        portal: input.office.vendorTestAccount.trim(),
        reminderType: "non-statutory-courtesy",
        freshnessSlaHours: 12,
        cuaHostSupported: input.office.officeOs === "macos",
        demo: false,
    };
}
export function readyForLivePortalFromBook(input) {
    return readyForLivePortal({
        realAgencyNamed: officeContractComplete(input),
        vendorTestAccount: input.office.vendorTestAccount.trim().length > 0,
        cuaHostSupported: input.cuaHostSupported ?? (process.platform === "darwin" && input.office.officeOs === "macos"),
    });
}
