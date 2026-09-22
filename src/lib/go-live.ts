// What the workspace setup path needs that is not agency-setup state: the one
// workflow (the property ledger) that also needs an imported PMS export. The
// ordered seven-step path itself lives in `setup-sequence.ts`.
import { agencyIsNamed } from "./office-setup";
import type { AgencyWorkflowId } from "../../shared/agency-setup";

export type GoLiveWorkflow = "workspace" | "property-ledger" | AgencyWorkflowId;

export interface PropertyExportRow {
  title: string;
  done: boolean;
  detail: string;
}

export { agencyIsNamed };

/**
 * Only property-ledger work reads the imported CSV facts, so only that workflow
 * gets this row. Everything else returns null rather than inventing a step.
 */
export function propertyExportRow(input: { mode: "demo" | "live"; workflow?: GoLiveWorkflow }): PropertyExportRow | null {
  if (input.workflow !== "property-ledger") return null;
  const done = input.mode === "live";
  return {
    title: "Connect your property export",
    done,
    detail: done
      ? "The property ledger uses the imported CSV facts."
      : "This property-ledger workflow needs a PMS export on Properties. Rows match by address or property code.",
  };
}
