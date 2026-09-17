/** Examples describe useful outcomes, not extra agents or claims of live access.
 * They are editable requests and never start work or change permissions. */
export const PM_TASK_STARTERS = [
  {
    id: "rent-evidence",
    title: "Review rent payment evidence",
    detail: "Compare receipts, messages and payment records using our office’s checking steps.",
    text: "Review the rent payment evidence I attach or paste, following our office workflow in DESK-CONTEXT.md. Receipts may come from WhatsApp, email, SMS or another channel; these are evidence sources, not a request to search those apps. Compare the claim with supplied bank or PMS records. Match property, tenancy, payer, amount, currency, date, masked receiving account, reference and rental period. Keep each property's extract as-of time separate: do not borrow Oak or Birch timestamps onto Pine or any other property, and say extract time unknown when it was not supplied. Group by property, identify partial/split, pending, duplicate, reversed or conflicting payments, and do not double-count forwarded receipts. Show what each source supports, what is still unverified and the next check for the PM. If evidence is missing, ask me for the relevant records; do not inspect an account or inbox. A receipt alone does not confirm rent paid. Do not change a ledger, mark rent paid, suppress reminders or send anything.",
  },
  {
    id: "inbox-triage",
    title: "Triage my inbox",
    detail: "Group property threads, find urgent items and prepare replies.",
    text: "Triage the emails I attach or the inbox I have connected and permitted you to read. Confirm the account and date range if unclear. Group related threads by property, flag ambiguous matches and urgent issues, and prepare replies for review. Use source dates and message references. If inbox access is unavailable, work with attached emails and explain what is missing. Do not send or change messages.",
  },
  {
    id: "maintenance-follow-ups",
    title: "Prepare maintenance follow-ups",
    detail: "Find who we are waiting on and draft the next steps.",
    text: "Prepare maintenance follow-ups across the properties I select, using current book notes, work orders and correspondence I provide or permit you to read. Group by property, identify who owes the next response, and prepare a useful draft for each. Separate missing access, quotes and owner decisions. Recheck for newer replies before proposing a follow-up. Do not dispatch contractors, approve spending or send anything.",
  },
  {
    id: "owner-update",
    title: "Prepare an owner update",
    detail: "Bring property facts and outstanding work together.",
    text: "Prepare an owner update using the property book and notes. Ask which property I mean if it is unclear. Include current facts, outstanding work, source dates and anything that needs checking. Keep it as a draft for my review.",
  },
  {
    id: "compare-documents",
    title: "Compare quotes or documents",
    detail: "Find differences, missing details and questions to ask.",
    text: "Compare the quotes or documents I attach. Show the differences in scope, amounts and dates, identify missing information, and list questions I should ask. Cite the relevant file for each finding and ask for the files if they are missing.",
  },
  {
    id: "prepare-day",
    title: "Prepare my day",
    detail: "Bring priorities, waiting items and decisions into view.",
    text: "Use the current property book and available notes to prepare my day. Separate work needing my decision, items waiting on someone, and the next preparation steps. Show source dates and flag missing facts. Do not assume access to my inbox or calendar.",
  },
  {
    id: "research",
    title: "Research a question",
    detail: "Check public sources and prepare a cited comparison.",
    text: "Help me research a property-management question using current public sources. Ask for the question and comparison criteria first. Link each finding to its source, distinguish facts from assumptions, and flag anything that needs a qualified person's judgment.",
  },
] as const;

/** A starter may fill an empty composer, never replace a PM's unsent work. */
export function canUseTaskStarter(text: string, attachmentCount = 0): boolean {
  return text.trim().length === 0 && attachmentCount === 0;
}
