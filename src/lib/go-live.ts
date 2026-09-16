import { agencyIsNamed } from "../../shared/office";

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

export { agencyIsNamed };

export function goLiveRows(input: GoLiveInput): GoLiveRow[] {
  const exportDone = input.mode === "live";
  const workerDone = input.workerReady;
  const agencyDone = agencyIsNamed(input.agencyName);
  return [
    {
      id: "export",
      title: "Connect your export",
      state: exportDone ? "done" : "action",
      detail: exportDone ? "CSV is live. Morning cards use those facts." : "Drop a PMS export on Properties. Rows match by address or property code.",
    },
    {
      id: "worker",
      title: "Set up Bud",
      state: workerDone ? "done" : "action",
      detail: workerDone
        ? "Bud passed the readiness check. Recheck can ask for the morning ledger."
        : "Open Bud on You, connect the model provider your office uses, then run the private readiness check.",
    },
    {
      id: "agency",
      title: "Name your agency",
      state: agencyDone ? "done" : "action",
      detail: agencyDone
        ? input.agencyName.trim()
        : "Name it on You under This office. Training names do not count.",
    },
  ];
}

export function goLiveComplete(rows: GoLiveRow[]): boolean {
  return rows.every((row) => row.state === "done");
}

export function goLiveActionCount(rows: GoLiveRow[]): number {
  return rows.filter((row) => row.state === "action").length;
}
