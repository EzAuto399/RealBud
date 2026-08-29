export type GoLiveState = "done" | "action";

export interface GoLiveRow {
  id: "export" | "worker" | "agency";
  title: string;
  state: GoLiveState;
  detail: string;
}

export interface GoLiveInput {
  mode: "demo" | "live";
  agencyName: string;
  workerReady: boolean;
}

const TRAINING_AGENCY = new Set(["demo agency", "realbud demo book"]);

export function agencyIsNamed(name: string | undefined): boolean {
  const trimmed = String(name ?? "").trim();
  return trimmed.length > 0 && !TRAINING_AGENCY.has(trimmed.toLowerCase());
}

export function goLiveRows(input: GoLiveInput): GoLiveRow[] {
  const exportDone = input.mode === "live";
  const workerDone = input.workerReady;
  const agencyDone = agencyIsNamed(input.agencyName);
  return [
    {
      id: "export",
      title: "Connect your export",
      state: exportDone ? "done" : "action",
      detail: exportDone ? "CSV is live. Morning cards use those facts." : "Drop a PMS export on Book. Rows match by address or property code.",
    },
    {
      id: "worker",
      title: "Attach your worker",
      state: workerDone ? "done" : "action",
      detail: workerDone
        ? "Pinned worker is answering. Recheck asks it for the morning ledger."
        : "Install the worker, apply the property pack, and attach a model on You.",
    },
    {
      id: "agency",
      title: "Name your agency",
      state: agencyDone ? "done" : "action",
      detail: agencyDone ? input.agencyName.trim() : "Shown on You. Timezone stays this computer's until you change it.",
    },
  ];
}

export function goLiveComplete(rows: GoLiveRow[]): boolean {
  return rows.every((row) => row.state === "done");
}
