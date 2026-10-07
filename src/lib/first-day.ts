// Get started's first day (owner, 8 Oct 2026): each role's workflows in plain words, one
// "Try it with Bud" each, plus the setup steps the person skipped for now. Kevin's role pack
// sets the bank import, weekly bills and morning priorities; Sherry's sets maintenance checks
// and the inspection draft. Which ones show follows the role packs on this computer
// (/api/austin-pack installed.loopIds). Tried, skipped and dismissed are per-computer
// conveniences in this browser's storage; nothing here is a setup or readiness fact.
import type { AustinPackView } from "@shared/austin-pack";
import type { AskWorkContext } from "./work-continuation";

export interface FirstDayItem {
  loopId: string;
  name: string;
  /** What Bud will do, what it reads, what needs the person's approval: one line each. */
  does: string;
  reads: string;
  asks: string;
  /** An editable request for Work; the person sends it. */
  prompt: string;
}

/** The five Austin workflows, in the order a first day meets them. Names match Schedule. */
export const FIRST_DAY_ITEMS: readonly FirstDayItem[] = [
  { loopId: "bank-references", name: "Bank reference review",
    does: "Matches new ANZ payments to REI tenant references and prepares the file for REI.",
    reads: "The ANZ rows from Redbark (or the CSV you add) and the saved REI tenant list.",
    asks: "Uploading the exact file to REI. Processing the receipts stays with you in REI.",
    prompt: "Help me with today's bank payments for REI: read the new ANZ rows from the bank feed, match each payment to its REI tenant reference, and list the rows you couldn't match for my review. Don't upload anything to REI until I approve the exact file." },
  { loopId: "weekly-bills", name: "Weekly bills review",
    does: "Finds this week's bills in the office Gmail and checks the expected ones arrived.",
    reads: "Bill emails and PDFs in the reviewed Gmail scope, and the saved rates and levies.",
    asks: "Accepting each bill. Nothing is paid or sent.",
    prompt: "Go through this week's bill emails in the office Gmail: list each new invoice with its property, supplier, amount and due date, and tell me which expected bills haven't arrived. Don't pay, accept or send anything." },
  { loopId: "inbound-triage", name: "Morning priorities",
    does: "Turns new office email into a short list of what needs you first.",
    reads: "New and unresolved mail in the reviewed Gmail scope.",
    asks: "Nothing. Bud never sends, archives or relabels mail.",
    prompt: "Prepare my morning priorities from the office Gmail: group new and unresolved emails by property, put what's urgent first, and draft replies for me to review. Don't send, archive or relabel anything." },
  { loopId: "maintenance-review", name: "Maintenance checks",
    does: "Checks maintenance invoices against your supplier list and flags anything unusual.",
    reads: "Reviewed maintenance bills and the saved REI supplier list.",
    asks: "Marking each finding seen or dismissing it. Nothing is paid or changed.",
    prompt: "Check this month's maintenance invoices against our REI supplier list: flag senders Gmail couldn't verify and any property with several invoices this month, and explain each one. Don't pay or change anything." },
  { loopId: "inspection-draft", name: "Inspection draft",
    does: "Drafts the next six months of routine inspections from your rules.",
    reads: "Your inspection rules, the inspection history and the properties on Desk.",
    asks: "Accepting or moving each visit. Nothing is booked.",
    prompt: "Draft the next six months of routine inspections from our inspection rules and history, and show me which properties are due first. Don't book anything or contact tenants." },
];

/** The workflows the role packs set on this computer; none until a role pack is installed or while it can't be read. */
export function firstDayItems(pack: AustinPackView | "unavailable" | undefined): FirstDayItem[] {
  if (!pack || pack === "unavailable" || !pack.installed) return [];
  const set = pack.installed.loopIds;
  return FIRST_DAY_ITEMS.filter(item => !set || set.includes(item.loopId));
}

/** The request goes into Work's composer for the person to send; the three lines ride along as reference. */
export function firstDayContext(item: FirstDayItem, id: string): AskWorkContext {
  return { id, sourceKey: `first-day-${item.loopId}`, title: item.name, instruction: item.prompt,
    text: `${item.name}\nBud will: ${item.does}\nReads: ${item.reads}\nNeeds your approval: ${item.asks}\nA first try: nothing is sent, paid, uploaded or booked without your approval.` };
}

/** Get started's finished line, dismissed on this computer (GoLiveCard). */
export const SET_UP_DISMISSED = "realbud.get-started-done-dismissed.v1";
const KEY = "realbud.get-started.v2";
export interface GetStartedLocal { skipped: string[]; tried: string[]; guideDismissed: boolean }
const EMPTY: GetStartedLocal = { skipped: [], tried: [], guideDismissed: false };
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];

export function readGetStartedLocal(): GetStartedLocal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    return raw && typeof raw === "object" ? { skipped: strings(raw.skipped), tried: strings(raw.tried), guideDismissed: raw.guideDismissed === true } : { ...EMPTY };
  } catch { return { ...EMPTY }; }
}
export function saveGetStartedLocal(next: GetStartedLocal): void {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* kept for this session only */ }
}
/** Workspace's reset: Get started shows again with no step skipped and the first-day guide back. */
export function resetGetStartedLocal(): void {
  try { localStorage.removeItem(KEY); localStorage.removeItem(SET_UP_DISMISSED); } catch { /* nothing was saved */ }
}
