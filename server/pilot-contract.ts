// Machine-readable copy of docs/PILOT-CONTRACT.md. A live portal adapter
// must not start until `readyForLivePortal` is true. Filling You → This
// office does not invent a paying agency and does not turn CUA on.

import { officeContractComplete, type Office } from "../shared/office.ts";

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
} as const;

export function readyForLivePortal(input: {
  realAgencyNamed: boolean;
  vendorTestAccount: boolean;
  cuaHostSupported: boolean;
}): boolean {
  return input.realAgencyNamed && input.vendorTestAccount && input.cuaHostSupported;
}

export function pilotContractFromBook(input: {
  agencyName: string;
  jurisdictions: readonly string[];
  office: Office;
}): typeof PILOT_CONTRACT | {
  agency: string;
  jurisdiction: string;
  pmOs: string;
  pmsExport: string;
  portal: string;
  reminderType: "non-statutory-courtesy";
  freshnessSlaHours: 12;
  cuaHostSupported: boolean;
  demo: false;
} {
  if (!officeContractComplete(input)) return PILOT_CONTRACT;
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

export function readyForLivePortalFromBook(input: {
  agencyName: string;
  jurisdictions: readonly string[];
  office: Office;
  cuaHostSupported?: boolean;
}): boolean {
  return readyForLivePortal({
    realAgencyNamed: officeContractComplete(input),
    vendorTestAccount: input.office.vendorTestAccount.trim().length > 0,
    cuaHostSupported:
      input.cuaHostSupported ?? (process.platform === "darwin" && input.office.officeOs === "macos"),
  });
}
