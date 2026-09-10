import { DATA_DIR } from "./config.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import { BankReferenceStore } from "./bank-reference-store.ts";
import { HumanHandoffs, type HandoffHost } from "./human-handoffs.ts";
let database: WorkflowDatabase | undefined;
export function workflowDatabase() { return database ??= new WorkflowDatabase({ dir: DATA_DIR }); }
export function bankReferenceStore() { return new BankReferenceStore(workflowDatabase()); }
let handoffs: HumanHandoffs | undefined;
export function humanHandoffs(host: HandoffHost) {
  if (!handoffs) { handoffs = new HumanHandoffs(workflowDatabase(), host); handoffs.recover(); }
  return handoffs;
}
