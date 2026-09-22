import { DATA_DIR } from "./config.js";
import { WorkflowDatabase } from "./workflow-database.js";
import { BankReferenceStore } from "./bank-reference-store.js";
import { HumanHandoffs } from "./human-handoffs.js";
let database;
export function workflowDatabase() { return database ??= new WorkflowDatabase({ dir: DATA_DIR }); }
export function bankReferenceStore() { return new BankReferenceStore(workflowDatabase()); }
let handoffs;
export function humanHandoffs(host) {
    if (!handoffs) {
        handoffs = new HumanHandoffs(workflowDatabase(), host);
        handoffs.recover();
    }
    return handoffs;
}
