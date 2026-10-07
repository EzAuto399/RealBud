import { DATA_DIR } from "./config.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import { BankReferenceStore } from "./bank-reference-store.ts";
import { decide, jevReady } from "./jev-client.ts";
import { HumanHandoffs, type HandoffHost } from "./human-handoffs.ts";
let database: WorkflowDatabase | undefined;
export function workflowDatabase() { return database ??= new WorkflowDatabase({ dir: DATA_DIR }); }
/** Jev payer hints only when the office has a Jev model and its managed key, checked at each hint pass. */
export function bankReferenceStore() { return new BankReferenceStore(workflowDatabase(), { decide, ready: jevReady }); }
let handoffs: HumanHandoffs | undefined;
export function humanHandoffs(host: HandoffHost) {
  if (!handoffs) { handoffs = new HumanHandoffs(workflowDatabase(), host); handoffs.recover(); }
  return handoffs;
}
