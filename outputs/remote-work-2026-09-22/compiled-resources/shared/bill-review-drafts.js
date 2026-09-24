export const BILL_REVIEW_DRAFT_LIMITS = {
    propertyId: 200, kind: 80, vendor: 160, amount: 80,
    invoiceDate: 32, dueDate: 32, note: 8000,
    reason: 4000, seriesId: 180, arrivalDate: 32,
};
/** Both UTF-8 plaintext and its encrypted stored envelope obey this ceiling. */
export const BILL_REVIEW_DRAFT_MAX_BYTES = 64 * 1024;
