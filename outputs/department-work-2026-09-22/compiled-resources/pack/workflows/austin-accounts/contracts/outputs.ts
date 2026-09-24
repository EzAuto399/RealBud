/** Review-only output contracts. Schemas validate shape; host/business checks remain required. */
export type ReviewStatus = "complete" | "partial" | "blocked";
export interface Hold { itemId: string; reason: string }
export interface ReviewBase { version: 1; sourceReference: string; status: ReviewStatus; coverageComplete: boolean; holds: Hold[]; actionsPerformed: [] }
export interface InboxReview extends ReviewBase {
 kind: "accounts-inbox-triage"; skillSource: "email-inbox-triage@0.1.0";
 threads: { threadId: string; disposition: "urgent-review"|"reply-review"|"action-review"|"waiting"|"reference"|"noise"|"hold"; owner: "accounts-reviewer"|"property-manager"|"source-owner"|"unassigned"; priority: "high"|"normal"|"low"; sourceMessageIds: string[]; reason: string; nextAction: string; missingFacts: string[] }[];
}
export interface InvoiceEntry { supplierId: string|null; invoiceId: string|null; propertyId: string|null; amount: string|null; currency: string|null; dueDate: string|null; costType: string|null }
export interface InvoiceReview extends ReviewBase { kind: "accounts-invoice-entry-review"; documents: { documentId: string; decision: "queue"|"duplicate"|"hold"; duplicateOf: string|null; conflictGroup: string|null; proposedEntry: InvoiceEntry; sourceIds: string[]; reason: string }[] }
export type BillFlag = "due-without-confirmed-payment"|"insufficient-funds"|"advance-unrecovered"|"owner-to-pay"|"conflicting-invoice"|"missing-arrival"|"coverage-gap"|"missing-due-date";
export interface BillExceptionReview extends ReviewBase { kind: "accounts-bill-exception-review"; findings: { occurrenceId: string; propertyId: string; arrival: "received"|"missing"|"not-due"|"unknown"; dueDate: string|null; payment: "confirmed"|"arranged-unconfirmed"|"unknown"; funding: "sufficient"|"insufficient"|"unknown"; advance: "none"|"outstanding"|"recovered"|"unknown"; flags: BillFlag[]; sourceIds: string[]; reason: string }[] }
export interface BankReferenceCandidates extends ReviewBase { kind: "accounts-anz-reference-candidates"; originalDigest: string|null; rows: { sourceRow: number; rowId: string; decision: "assign"|"keep"|"hold"; propertyId: string|null; proposedReference: string|null; reason: string }[]; hostValidation: { required: true; batchId: string|null; batchRevision: number|null; originalDigest: string|null; applied: false } }
export type AccountsReview = InboxReview | InvoiceReview | BillExceptionReview | BankReferenceCandidates;
