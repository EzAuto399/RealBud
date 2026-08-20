// Machine-readable copy of docs/PILOT-CONTRACT.md. A live portal adapter
// must not start until `readyForLivePortal` is true.

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
