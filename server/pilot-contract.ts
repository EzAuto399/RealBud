// Machine-readable copy of docs/PILOT-CONTRACT.md. Null/empty values are
// deliberate: release tooling must never turn demo assumptions into a named
// office contract. A live portal adapter must not start until its separate
// runtime gate also passes.

export type PilotOfficeOs = "darwin" | "win32" | "linux";
export type PilotExportIdentity = "property-id" | "address" | "property-code";

export interface PilotContract {
  agency: string;
  pmUser: string | null;
  pmsBrand: string | null;
  namedExporter: string | null;
  exportCadenceHours: number | null;
  exportIdentityColumn: PilotExportIdentity | null;
  officeOs: PilotOfficeOs | null;
  confirmedJurisdictions: string[];
  vendorTestAccount: boolean;
  jurisdiction: string;
  pmsExport: string;
  portal: string;
  reminderType: string;
  freshnessSlaHours: number;
  demo: boolean;
}

export const PILOT_CONTRACT: PilotContract = {
  agency: "RealBud Demo Book",
  pmUser: null,
  pmsBrand: null,
  namedExporter: null,
  exportCadenceHours: null,
  exportIdentityColumn: null,
  officeOs: null,
  confirmedJurisdictions: [],
  vendorTestAccount: false,
  jurisdiction: "ACT",
  pmsExport: "csv",
  portal: "fake-building-portal",
  reminderType: "non-statutory-courtesy",
  freshnessSlaHours: 12,
  demo: true,
};

export function pilotContractMissingFields(contract: PilotContract = PILOT_CONTRACT): string[] {
  const missing: string[] = [];
  if (contract.demo || !contract.agency.trim() || contract.agency === "RealBud Demo Book" || !contract.pmUser?.trim()) {
    missing.push("agency + named PM user");
  }
  if (!contract.pmsBrand?.trim()) missing.push("PMS brand");
  if (!contract.namedExporter?.trim()) missing.push("named exporter");
  if (
    contract.exportCadenceHours === null ||
    !Number.isFinite(contract.exportCadenceHours) ||
    contract.exportCadenceHours <= 0 ||
    contract.exportCadenceHours > contract.freshnessSlaHours
  ) {
    missing.push("export cadence within the freshness SLA");
  }
  if (!contract.exportIdentityColumn) missing.push("export identity column");
  if (!contract.officeOs) missing.push("office OS");
  if (!contract.confirmedJurisdictions.length || contract.confirmedJurisdictions.some((value) => !value.trim())) {
    missing.push("confirmed book jurisdiction(s)");
  }
  if (!contract.vendorTestAccount) missing.push("vendor test account");
  return missing;
}

export function pilotContractComplete(contract: PilotContract = PILOT_CONTRACT): boolean {
  return pilotContractMissingFields(contract).length === 0;
}

/** Pocket needs one real office and one named PM, but it does not depend on
 * a vendor portal account. Release packaging still uses the stricter full
 * contract gate above. */
export function pocketPilotReady(contract: PilotContract = PILOT_CONTRACT): boolean {
  return !contract.demo
    && Boolean(contract.agency.trim())
    && contract.agency !== "RealBud Demo Book"
    && Boolean(contract.pmUser?.trim());
}

export function readyForLivePortal(input: {
  realAgencyNamed: boolean;
  vendorTestAccount: boolean;
  cuaHostSupported: boolean;
}): boolean {
  return input.realAgencyNamed && input.vendorTestAccount && input.cuaHostSupported;
}
