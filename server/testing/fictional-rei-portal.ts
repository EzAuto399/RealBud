// FICTIONAL REI-style portal behind the browser helper's command interface
// (the `bsk` CLI that BrowserRuntime runs). The real BrowserBroker drives it
// exactly as it drives a person's browser: tab list, borrow, observe (a VOM
// accessibility tree), navigate, click, fill, press, select, upload, download
// and request-help. No network, no browser, no REI account, no credentials.
// It is built from the pack's website map, so a pass proves the recipes run
// through RealBud's authority path and their guards hold, never that REI
// Cloud behaves this way. Dependency-free.
//
// Bulk receipting is stateful: an upload is parsed by the chosen File Format,
// becomes a pending import (it persists across pages until posted), the
// person's posting is simulated by `post()` (Bud never presses it) and turns
// matched rows into receipts with receipt ids, and the Receipt Register export
// is built from those receipts filtered by account and date. Historical
// receipts are seeded, including an older one with a reference and amount a
// new batch can repeat. The matching precedence and register layout are
// FICTIONAL; the ANZ and Custom contracts are PROVISIONAL guesses because REI's
// real parsers are unknown.
//
// Shaped after a read-only look at live REI (2 Oct 2026), all values fictional:
// File Format lists REI's options with ANZ(csv file) selected by default; after
// sign-in addresses carry no reicid and the business is the top-bar code; the
// tenants grid shows "No records to display" before it fills, then a
// "N records · 0 row(s) selected" footer and no pages; Pending Transactions is
// a separate payments page whose Process / Process Pending / Delete Pending
// Bud never presses; the Receipt Register opens a parameters popup first.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_PROTOCOL, BROWSER_VERSION, type BrowserJson } from "../browser-runtime.ts";
import { parsePortalRecipePack, type PortalRecipePack } from "../portal-recipe.ts";

/** FICTIONAL read-only recipe for REI's pending bank imports (Receipts › Bulk
 * receipting with nothing uploaded). The pack has no such recipe: how live REI
 * lists a pending import is an UNKNOWN that needs a read-only study of the real
 * screen before this can be added to the pack. */
export const FICTIONAL_PENDING_RECIPE = "bulk-receipting-pending";
const pendingRecipe = { kind: "read", tier: ["C", "S"], inputs: [], grantNeeds: [],
  steps: [{ nav: ["Receipts", "Bulk receipting"] }, { check: "account" }, { wait: "table" }, { read: "table" }, { paginate: true }],
  stopBefore: ["Process Receipts", "Receipt All", "Save", "Post", "Finalise"],
  success: "FICTIONAL: the pending bank file's rows listed, or none; nothing selected, uploaded or pressed" };

const RECIPES_FILE = join(dirname(fileURLToPath(import.meta.url)), "../../pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json");
/** The report a directory recipe opens, read from the pack (its names are placeholders until the real REI export is mapped). */
function exportReport(recipe: string): string {
  const steps = (JSON.parse(readFileSync(RECIPES_FILE, "utf8")) as { recipes: Record<string, { steps: Array<Record<string, unknown>> }> }).recipes[recipe]?.steps ?? [];
  const label = steps.find(step => typeof step.click === "string")?.click;
  return typeof label === "string" ? label : `${recipe} (not in the pack)`;
}

/** The Austin pack's REI recipes, pointed at the fictional origins instead of REI Cloud. */
export function fictionalReiPack(): PortalRecipePack {
  const raw = JSON.parse(readFileSync(RECIPES_FILE, "utf8"));
  const pack = parsePortalRecipePack({ ...raw, recipes: { ...raw.recipes, [FICTIONAL_PENDING_RECIPE]: pendingRecipe } });
  // The fictional portal declares its own pager exactly (live REI's is unconfirmed, so its landmark is null).
  return { ...pack, origin: FICTIONAL_REI_ORIGIN, signIn: { ...pack.signIn, hosts: [new URL(FICTIONAL_REI_SIGNIN).host] },
    pagination: { ...pack.pagination, landmark: { role: "navigation", name: "Pagination" } } };
}

export const FICTIONAL_REI_ORIGIN = "https://rei-mock.fictional.test";
export const FICTIONAL_REI_SIGNIN = "https://signin.rei-mock.fictional.test";
/** Kept for callers that still save a reicid; the portal's addresses never carry one after sign-in. */
export const FICTIONAL_REICID = "fictional-reicid-1";
export const FICTIONAL_BUSINESS = "FICT1";
const AGENCY = "Fictional Realty Office";
const TOP = ["Dashboard", "Business", "Owners", "Pool of Owners", "Contacts", "Rentals", "Tenants", "Suppliers", "Communities", "Sales", "Listings", "Agents", "Booking Calendar", "Tasks", "Receipts", "Process", "Reports", "Settings", "Tools", "My Profile"];
const ROUTES: Record<string, string> = { Dashboard: "/customers/dashboard", Owners: "/customers/owner", Rentals: "/customers/property", Tenants: "/customers/tenant", Tasks: "/customers/task", Reports: "/report/reportlist", Suppliers: "/customers/supplier", Contacts: "/customers/contact" };
const CHILDREN: Record<string, Array<[string, string]>> = {
  Tenants: [["Arrears", "/customers/arrears/"]],
  Receipts: [["Tenant receipts", "/customers/transaction/tenantreceipt"], ["Bulk receipting", "/customers/importbanklink/index"]],
  Process: [["Bank reconciliation", "/customers/reconciliation/bankreconciliation"], ["Pending transactions", "/customers/transaction/pendingtransactions"]],
  Settings: [["Integrations", "/RequesterIntegrations"]],
};
const TENANTS = [
  ["Fictional Tenant Alpha", "Active", "2026-09-20", "0.00", "0", "0.00"],
  ["Fictional Tenant Bravo", "Active", "2026-09-12", "0.00", "9", "540.00"],
  ["Fictional Tenant Charlie", "Active", "2026-09-15", "0.00", "6", "360.00"],
  ["Fictional Tenant Delta", "Inactive", "2026-06-01", "0.00", "0", "0.00"],
  ["Fictional Tenant Echo", "Active", "2026-09-10", "20.00", "11", "660.00"],
  ["Fictional Tenant Foxtrot", "Active", "2026-09-22", "0.00", "0", "0.00"],
  ["Fictional Tenant Golf", "Active", "2026-09-08", "0.00", "13", "780.00"],
  ["Fictional Tenant Hotel", "Active", "2026-09-05", "0.00", "16", "960.00"],
  ["Fictional Tenant India", "Vacated", "2026-08-30", "0.00", "22", "1320.00"],
  ["Fictional Tenant Juliet", "Active", "2026-09-11", "0.00", "10", "600.00"],
  ["Fictional Tenant Bravo-Two", "Active", "2026-09-21", "0.00", "0", "0.00"],
];
/** FICTIONAL linked identities: tenant → property → owner, with a REI tenant reference
 * and a distinct bank (BPay/Ref No.) reference. Golf and Hotel share one bank reference
 * (ambiguous); India's tenancy is vacated and Bravo-Two now holds that property. */
export interface FictionalTenancy { tenantId: string; name: string; propertyId: string; ownerId: string; status: "Active" | "Vacated"; tenantRef: string; bankRef: string }
export const FICTIONAL_TENANCIES: readonly FictionalTenancy[] = [
  { tenantId: "FTN-02", name: "Fictional Tenant Bravo", propertyId: "FP-02", ownerId: "FO-1", status: "Active", tenantRef: "FT-BRAVO", bankRef: "4470002" },
  { tenantId: "FTN-03", name: "Fictional Tenant Charlie", propertyId: "FP-03", ownerId: "FO-1", status: "Active", tenantRef: "FT-CHARLIE", bankRef: "4470003" },
  { tenantId: "FTN-05", name: "Fictional Tenant Echo", propertyId: "FP-05", ownerId: "FO-2", status: "Active", tenantRef: "FT-ECHO", bankRef: "4470005" },
  { tenantId: "FTN-07", name: "Fictional Tenant Golf", propertyId: "FP-06", ownerId: "FO-2", status: "Active", tenantRef: "FT-GOLF", bankRef: "4470067" },
  { tenantId: "FTN-08", name: "Fictional Tenant Hotel", propertyId: "FP-07", ownerId: "FO-2", status: "Active", tenantRef: "FT-HOTEL", bankRef: "4470067" },
  { tenantId: "FTN-09", name: "Fictional Tenant India", propertyId: "FP-04", ownerId: "FO-1", status: "Vacated", tenantRef: "FT-INDIA", bankRef: "4470009" },
  { tenantId: "FTN-11", name: "Fictional Tenant Bravo-Two", propertyId: "FP-04", ownerId: "FO-1", status: "Active", tenantRef: "FT-BRAVO2", bankRef: "4470011" },
];
/** FICTIONAL Tenants grid, in live REI's columns (seen 5 Oct 2026); `status` is the Status filter, not a column.
 * FT-KILO has no Property (an import rejects it); Golf and Hotel share one BPay reference. */
export const FICTIONAL_TENANT_COLUMNS = ["Reference", "Surname", "Firstname", "Property", "Rent", "Paid To", "Rent Credit", "Days +/-", "Amount Owing", "Lease Expiry", "Vacating", "Owner", "BPay/Ref No."] as const;
const tenantRow = (ref: string, surname: string, property: string, rent: string, paidTo: string, days: string, owing: string, owner: string, bpay: string, status = "Active") =>
  ({ status, cells: [ref, surname, "Fictional", property, rent, paidTo, "0.00", days, owing, "2027-03-31", "", owner, bpay] });
export const FICTIONAL_TENANT_LIST = [
  tenantRow("FT-ALPHA", "Alpha", "FP-01", "$500.00 per week", "2026-09-20", "0", "0.00", "Fictional Owner One", "4470001"),
  tenantRow("FT-BRAVO", "Bravo", "FP-02", "$540.00 per week", "2026-09-12", "-9", "540.00", "Fictional Owner One", "4470002"),
  tenantRow("FT-CHARLIE", "Charlie", "FP-03", "$360.00 per week", "2026-09-15", "-6", "360.00", "Fictional Owner One", "4470003"),
  tenantRow("FT-DELTA", "Delta", "FP-08", "$450.00 per week", "2026-06-01", "0", "0.00", "Fictional Owner Two", "4470008", "Inactive"),
  tenantRow("FT-ECHO", "Echo", "FP-05", "$660.00 per fortnight", "2026-09-10", "-11", "660.00", "Fictional Owner Two", "4470005"),
  tenantRow("FT-FOXTROT", "Foxtrot", "FP-09", "$480.00 per week", "2026-09-22", "0", "0.00", "Fictional Owner Two", "4470010"),
  tenantRow("FT-GOLF", "Golf", "FP-06", "$500.00 per week", "2026-09-08", "-13", "780.00", "Fictional Owner Two", "4470067"),
  tenantRow("FT-HOTEL", "Hotel", "FP-07", "$520.00 per week", "2026-09-05", "-16", "960.00", "Fictional Owner Two", "4470067"),
  tenantRow("FT-INDIA", "India", "FP-04", "$600.00 per week", "2026-08-30", "-22", "1320.00", "Fictional Owner One", "4470009", "Vacated"),
  tenantRow("FT-JULIET", "Juliet", "FP-10", "$2,400.00 per month", "2026-09-11", "-10", "600.00", "Fictional Owner One", "4470012"),
  tenantRow("FT-BRAVO2", "Bravo-Two", "FP-04", "$600.00 per week", "2026-09-21", "0", "0.00", "Fictional Owner One", "4470011"),
  tenantRow("FT-KILO", "Kilo", "", "$400.00 per week", "", "0", "0.00", "", ""),
];
/** FICTIONAL Suppliers grid, in live REI's columns. FS-LOCK's email is not an address; FS-GARDEN has none. */
export const FICTIONAL_SUPPLIER_COLUMNS = ["Reference", "Description", "Phone", "Phone A/H", "Mobile", "Fax", "Email", "Address", "Category"] as const;
export const FICTIONAL_SUPPLIER_LIST = [
  { status: "Active", cells: ["FS-PLUMB", "Fictional Plumbing Co", "07 0000 0001", "", "0400 000 001", "", "accounts@fictional-plumbing.test", "1 Fictional St, Brisbane", "Plumber"] },
  { status: "Active", cells: ["FS-ELEC", "Fictional Electrical", "07 0000 0002", "", "", "", "jobs@fictional-electrical.test; invoices@fictional-electrical.test", "2 Fictional St, Brisbane", "Electrician"] },
  { status: "Active", cells: ["FS-GARDEN", "Fictional Gardens", "", "", "0400 000 003", "", "", "", "Gardener"] },
  { status: "Active", cells: ["FS-LOCK", "Fictional Locksmiths", "07 0000 0004", "", "", "", "not-an-email", "4 Fictional St, Brisbane", "Locksmith"] },
  { status: "Active", cells: ["FS-ROOF", "Fictional Roofing", "07 0000 0005", "07 0000 0055", "", "", "roof@fictional-roofing.test", "5 Fictional St, Brisbane", "Roofer"] },
];
/** Quoted only where needed, as a spreadsheet export writes it. */
const csvLine = (cells: readonly string[]) => cells.map(cell => /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(",");

/** A receipt's account is its business code (`reicid` is kept on seeded history only). */
export interface FictionalAccount { reicid?: string; business: string }
export interface FictionalReceipt { receiptId: string; account: FictionalAccount; date: string; reference: string; tenantId: string; tenant: string; propertyId: string; ownerId: string; amountCents: number; status: string }
/** Seeded history: an older FT-BRAVO 540.00 receipt inside a typical readback window, and receipts of another business. */
export const FICTIONAL_HISTORY: readonly FictionalReceipt[] = [
  { receiptId: "FR-0001", account: { reicid: FICTIONAL_REICID, business: "FICT1" }, date: "2026-09-18", reference: "FT-BRAVO", tenantId: "FTN-02", tenant: "Fictional Tenant Bravo", propertyId: "FP-02", ownerId: "FO-1", amountCents: 54000, status: "Receipted" },
  { receiptId: "FR-0002", account: { reicid: FICTIONAL_REICID, business: "FICT1" }, date: "2026-09-26", reference: "FT-BRAVO", tenantId: "FTN-02", tenant: "Fictional Tenant Bravo", propertyId: "FP-02", ownerId: "FO-1", amountCents: 54000, status: "Receipted" },
  { receiptId: "FR-0003", account: { reicid: FICTIONAL_REICID, business: "FICT2" }, date: "2026-09-27", reference: "FT-CHARLIE", tenantId: "FTN-03", tenant: "Fictional Tenant Charlie", propertyId: "FP-03", ownerId: "FO-1", amountCents: 36000, status: "Receipted" },
];

/** File Format options exactly as REI's Bulk Receipting lists them (seen 2 Oct 2026); ANZ(csv file) is the default.
 * The fictional portal reads only ANZ(csv file) and Custom(csv file), each by a FICTIONAL contract. */
export const FICTIONAL_FILE_FORMATS = ["(*.ABA) File", "(*.BRF) File", "(*.ERP) File", "(*.TXN) File", "ANZ(csv file)", "Bank of Queensland(csv file)", "BankWest(csv file)",
  "Bendigo(csv file)", "Commonwealth(csv file)", "Commonwealth - New(csv file)", "Corum", "HANDeRENT Secure Payments", "IP Payments", "NAB Easy Rent", "NAB Reverse Format(csv file)",
  "NAB(csv file)", "Paycorp - RentPay", "Rental Rewards", "StrataPay", "Suncorp(csv file)", "Westpac(csv file)", "Custom(csv file)"] as const;
export const FICTIONAL_DEFAULT_FILE_FORMAT = "ANZ(csv file)";
type BankLine = { date: string; amountCents: number; reference: string };
/** Quoted CSV (RFC 4180 style: "" escapes, commas and newlines inside quotes). Null when malformed. */
export function fictionalCsv(text: string): string[][] | null {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  const body = text.replace(/^\uFEFF/, "");
  const end = () => { row.push(cell); cell = ""; closed = false; };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) { if (c !== '"') cell += c; else if (body[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } continue; }
    if (c === ",") { end(); continue; }
    if (c === "\r" || c === "\n") { if (c === "\r" && body[i + 1] === "\n") i++; end(); rows.push(row); row = []; continue; }
    if (closed) return null;
    if (c === '"') { if (cell) return null; quoted = true; continue; }
    cell += c;
  }
  if (quoted) return null;
  if (cell || closed || row.length) { end(); rows.push(row); }
  return rows.filter(cells => cells.some(value => value.trim()));
}
const ymd = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text.trim()) ? text.trim() : null;
const dmy = (text: string) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const cents = (text: string) => /^-?\d+(\.\d{1,2})?$/.test(text.trim()) ? Math.round(Number(text.trim()) * 100) : null;
/** The chosen File Format governs parsing. A file that does not fit its format is refused whole. */
function parseBankFile(format: string, text: string): BankLine[] | string {
  const rows = fictionalCsv(text);
  if (!rows) return "The file could not be read: a quoted field is not closed.";
  const lines: BankLine[] = [];
  const take = (date: string | null, amount: string, reference: string) => { const value = cents(amount); if (!date || value === null) return false; lines.push({ date, amountCents: value, reference: reference.trim() }); return true; };
  if (format === "Custom(csv file)") {
    // PROVISIONAL: REI's Custom CSV columns and mapping rules are unknown. Fictional contract: RealBud's Redbark layout.
    const [head = [], ...data] = rows;
    if (head.map(cell => cell.trim().toLowerCase()).join(",") !== "date,amount,narrative,reference" || !data.length) return "The file does not match the selected File Format.";
    for (const cells of data) if (cells.length !== 4 || !take(ymd(cells[0]), cells[1], cells[3])) return "The file does not match the selected File Format.";
  } else if (format === "ANZ(csv file)") {
    // PROVISIONAL: ANZ's own export layout, as RealBud's ANZ fixture has it: no header, 8 columns,
    // DD/MM/YYYY, signed amount, narrative, payer, payee, blank, a second reference and the reference REI reads (col 8).
    if (!rows.length) return "The file does not match the selected File Format.";
    for (const cells of rows) if (cells.length !== 8 || !take(dmy(cells[0]), cells[1], cells[7])) return "The file does not match the selected File Format.";
  } else return FICTIONAL_FILE_FORMATS.includes(format as never) ? "The fictional portal does not read this File Format." : "Choose a File Format.";
  return lines;
}
const CLEAN = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
/** FICTIONAL matching precedence (REI's is unknown): bank reference, then tenant reference; only one active tenancy matches. */
function fictionalMatch(reference: string, amountCents: number): { tenancy: FictionalTenancy | null; match: string } {
  if (amountCents <= 0) return { tenancy: null, match: "Not a receipt" };
  const ref = CLEAN(reference);
  const found = FICTIONAL_TENANCIES.filter(item => item.bankRef === ref || item.tenantRef === ref);
  const active = found.filter(item => item.status === "Active");
  if (active.length === 1) return { tenancy: active[0], match: "Matched" };
  if (active.length > 1) return { tenancy: null, match: "Ambiguous" };
  return { tenancy: null, match: found.length ? "Vacated" : "Unmatched" };
}
type PendingRow = { date: string; reference: string; amountCents: number; tenancy: FictionalTenancy | null; match: string };
interface PendingUpload { uploadId: string; account: FictionalAccount; format: string; rows: PendingRow[] }
const money = (value: number) => (value / 100).toFixed(2);
const dd = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const TABLES: Record<string, { cols: string[]; rows: string[][] }> = {
  /** The arrears page (filters on Status and Days). */
  arrears: { cols: ["Name", "Status", "Paid to", "Rent credit", "Days", "Amount owing"], rows: TENANTS },
  owners: { cols: ["Name", "Status", "Properties"], rows: [["Fictional Owner One", "Active", "2"], ["Fictional Owner Two", "Active", "1"]] },
  rentals: { cols: ["Property", "Status", "Lease expiry", "Smoke due"], rows: Array.from({ length: 7 }, (_, i) => [`${i + 1} Fictional St`, "Active", `2026-1${i % 3}-0${i + 1}`, `2026-10-1${i}`]) },
  tasks: { cols: ["Task", "Status", "Due date", "Priority", "Assigned to"], rows: [["Fictional inspection", "Open", "2026-09-25", "High", "Staff A"], ["Fictional lease renewal", "Open", "2026-09-26", "Normal", "Staff B"], ["Fictional closed task", "Closed", "2026-09-25", "Low", "Staff A"]] },
  reconciliation: { cols: ["Date", "Description", "Debit", "Credit", "Reconciled"], rows: [["2026-09-24", "Fictional deposit", "", "1200.00", "No"], ["2026-09-24", "Fictional fee", "15.00", "", "No"]] },
  /** Pending payments/levies/invoices: not bank imports. */
  pendingPayments: { cols: ["Owner/Business", "Description", "Amount", "Sufficient Funds"], rows: [["Fictional Owner One", "Fictional levy", "120.00", "Yes"], ["Fictional Owner Two", "Fictional invoice", "80.00", "No"]] },
  empty: { cols: ["Name"], rows: [] },
};
type Field = { kind: "textbox" | "combobox" | "radio"; name: string; value: string; options?: string[] };
type Control = { role: string; name: string; action: string; disabled?: boolean; options?: string[]; value?: string };

export interface FictionalReiOptions {
  /** Signed out: every app page redirects to the fictional sign-in page. */
  signedOut?: boolean;
  /** What the person does on the sign-in page when asked. */
  helpOutcome?: "completed" | "cancelled";
  /** The business code in the top bar for this session (default FICT1). */
  business?: string;
  /** Header business shown after a direct route (an address typed or opened, not a menu click). */
  directBusiness?: string;
  /** After this many page-changing commands, the header business becomes FICT2 (someone switched business in another tab). */
  switchBusinessAfterSteps?: number;
  /** Next re-renders the same page instead of advancing. */
  stuckPagination?: boolean;
  /** The upload's reply is lost. "before": the portal never accepted the file. "after" (or true): it did, and the pending import persists. */
  unknownUpload?: boolean | "before" | "after";
  version?: string;
  /** Rows shown per page. */
  pageSize?: number;
  /** Alters the displayed preview rows (Date, Reference, Tenant, Tenant ID, Amount, Match) to rehearse what a page could show. */
  previewEdit?: (rows: string[][]) => string[][];
  /** Alters the rows of the next tenant or supplier list export (to rehearse an export that disagrees with its grid). */
  directoryRows?: (rows: string[][]) => string[][];
  /** Receipts already in REI before this run; defaults to FICTIONAL_HISTORY. */
  receipts?: FictionalReceipt[];
}

export function fictionalReiPortal(options: FictionalReiOptions = {}) {
  const calls: string[][] = [];
  /** Effects a consequential control would have had. Tests expect none, apart from an approved upload. */
  const effects: string[] = [];
  const pageSize = options.pageSize ?? 5;
  let session = false; let scope = "user"; let signedIn = !options.signedOut; let steps = 0;
  let url = `${FICTIONAL_REI_ORIGIN}/customers/dashboard`;
  /** The page was opened by address rather than a menu click. */
  let direct = false;
  let returnUrl = url;
  if (!signedIn) url = `${FICTIONAL_REI_SIGNIN}/b2c_1_signin/authorize`;
  // Per-page state, reset on each load.
  let fields: Field[] = []; let page = 0; let loading = 0; let modal = false; let reportsListed = false; let uploadError: string | null = null;
  /** The report whose parameters popup is open. */
  let report = "";
  const TENANT_REPORT = exportReport("tenant-list"), SUPPLIER_REPORT = exportReport("supplier-list");
  // Portal-side state that survives page loads: the pending import and the receipt ledger.
  let pending: PendingUpload | null = null; let uploads = 0;
  const receipts: FictionalReceipt[] = structuredClone([...(options.receipts ?? FICTIONAL_HISTORY)]);
  const here = (): FictionalAccount => ({ business: business() });
  const sameAccount = (a: FictionalAccount, b: FictionalAccount) => a.business === b.business;
  const previewTable = (upload: PendingUpload) => {
    const rows = upload.rows.map(row => [dd(row.date), row.reference, row.tenancy?.name ?? "", row.tenancy?.tenantId ?? "", money(row.amountCents), row.match]);
    return options.previewEdit ? options.previewEdit(rows) : rows;
  };
  let refs = new Map<string, Control>();

  const business = () => {
    if (options.switchBusinessAfterSteps !== undefined && steps > options.switchBusinessAfterSteps) return "FICT2";
    return (direct ? options.directBusiness : undefined) ?? options.business ?? FICTIONAL_BUSINESS;
  };
  const load = (next: string) => {
    const at = new URL(next);
    if (at.origin === FICTIONAL_REI_ORIGIN && !signedIn) { returnUrl = next; url = `${FICTIONAL_REI_SIGNIN}/b2c_1_signin/authorize`; }
    else url = next;
    page = 0; loading = 1; modal = false; reportsListed = false; uploadError = null; report = "";
    fields = initialFields(new URL(url).pathname);
  };
  const initialFields = (path: string): Field[] => {
    const status = (value: string): Field => ({ kind: "combobox", name: "Status", value, options: ["Active", "Inactive", "Open", "Closed", "All"] });
    const search: Field = { kind: "textbox", name: "Search", value: "" };
    if (path === "/customers/tenant" || path === "/customers/owner" || path === "/customers/supplier") return [search, status("Active")];
    if (path === "/customers/property") return [search, status("Active"), { kind: "combobox", name: "View", value: "Default", options: ["Default", "lease expiry", "smoke", "pool"] }];
    if (path === "/customers/task") return [status("All"), { kind: "textbox", name: "From", value: "" }, { kind: "textbox", name: "To", value: "" }];
    if (path === "/customers/arrears/") return [search, { kind: "textbox", name: "From day", value: "" }, { kind: "combobox", name: "Hide vacated tenants", value: "No", options: ["No", "Yes"] }];
    if (path === "/customers/reconciliation/bankreconciliation") return [{ kind: "textbox", name: "Statement balance", value: "" }];
    if (path === "/report/reportlist") return [search];
    if (path === "/customers/importbanklink/index") return [{ kind: "combobox", name: "File Format", value: FICTIONAL_DEFAULT_FILE_FORMAT, options: [...FICTIONAL_FILE_FORMATS] }];
    return [search];
  };
  const field = (name: string) => fields.find(item => item.name === name)?.value ?? "";
  const tableFor = (path: string): { cols: string[]; rows: string[][] } | null => {
    const filter = (key: string, keep: (row: string[]) => boolean, statusDefault = true) => {
      const base = TABLES[key]; const status = field("Status"); const query = field("Search").toLowerCase();
      return { cols: base.cols, rows: base.rows.filter(row => (!statusDefault || !status || status === "All" || row[1] === status) && (!query || row[0].toLowerCase().includes(query)) && keep(row)) };
    };
    // Tenants and Suppliers: Status filters a field that is not a column; Search matches the name columns.
    const list = (cols: readonly string[], rows: Array<{ status: string; cells: string[] }>, names: number[]) => {
      const status = field("Status"), query = field("Search").toLowerCase();
      return { cols: [...cols], rows: rows.filter(row => (!status || status === "All" || row.status === status) && (!query || names.some(i => row.cells[i].toLowerCase().includes(query)))).map(row => row.cells) };
    };
    if (path === "/customers/tenant") return list(FICTIONAL_TENANT_COLUMNS, FICTIONAL_TENANT_LIST, [0, 1, 2]);
    if (path === "/customers/supplier") return list(FICTIONAL_SUPPLIER_COLUMNS, FICTIONAL_SUPPLIER_LIST, [0, 1]);
    if (path === "/customers/owner") return filter("owners", () => true);
    if (path === "/customers/property") return filter("rentals", () => true);
    if (path === "/customers/task") return filter("tasks", row => (!field("From") || row[2] >= field("From")) && (!field("To") || row[2] <= field("To")));
    if (path === "/customers/arrears/") return filter("arrears", row => Number(row[4]) >= Number(field("From day") || 1) && !(field("Hide vacated tenants") === "Yes" && row[1] === "Vacated"), false);
    if (path === "/customers/reconciliation/bankreconciliation") return TABLES.reconciliation;
    if (path === "/customers/transaction/pendingtransactions") return TABLES.pendingPayments;
    if (path === "/customers/importbanklink/index") {
      // The grid lists this account's pending bank file, or is empty ("No records found").
      const shown = pending && sameAccount(pending.account, here()) ? previewTable(pending) : [];
      return { cols: ["Date", "Reference", "Tenant", "Tenant ID", "Amount", "Match"], rows: shown };
    }
    if (path === "/report/reportlist") return null;
    return TABLES.empty;
  };

  const render = (): string => {
    const at = new URL(url); refs = new Map(); let n = 0;
    const ref = (control: Control) => { const id = `@e${++n}`; refs.set(id, control); return id; };
    const q = (s: string) => JSON.stringify(s);
    const lines = ["@vom 1", "@view 1280x900", "@layers 1 focus=L1", "L1 page"];
    if (at.origin === FICTIONAL_REI_SIGNIN) {
      if (options.helpOutcome === "cancelled" && !signedIn && calls.some(args => args[0] === "request-help")) {
        lines.push('  RootWebArea "Sign In Cancelled - REI Cloud"', '    heading "Sign In Cancelled"', '    StaticText "You cancelled the previous sign-in or there was a sign-in issue (MFA)."');
      } else {
        lines.push('  RootWebArea "Sign in with your email address"', '    heading "Sign in with your email address"',
          `    ${ref({ role: "textbox", name: "Email Address", action: "none" })} textbox "Email Address"`,
          `    ${ref({ role: "textbox", name: "Password", action: "none" })} textbox "Password"`,
          `    ${ref({ role: "button", name: "Sign in", action: "none" })} button "Sign in"`);
      }
      return lines.join("\n");
    }
    const path = at.pathname; const b = business();
    const title = path === "/customers/dashboard" ? "Dashboard" : Object.values(CHILDREN).flat().find(([, route]) => route === path)?.[0] ?? Object.entries(ROUTES).find(([, route]) => route === path)?.[0] ?? path.split("/").filter(Boolean).pop() ?? "Page";
    lines.push(`  RootWebArea ${q(`${title} - REI Cloud`)}`, "    banner");
    lines.push(`      StaticText ${q(AGENCY)}`, `      ${ref({ role: "button", name: b, action: "none" })} button ${q(b)}`);
    lines.push('    navigation "Main"');
    const section = Object.entries(CHILDREN).find(([, kids]) => kids.some(([, route]) => route === path))?.[0] ?? Object.entries(ROUTES).find(([, route]) => route === path)?.[0];
    for (const label of TOP) {
      lines.push(`      ${ref({ role: "link", name: label, action: `go:${ROUTES[label] ?? `/area/${encodeURIComponent(label)}`}` })} link ${q(label)}`);
      if (label === section) for (const [kid, route] of CHILDREN[label] ?? []) lines.push(`        ${ref({ role: "link", name: kid, action: `go:${route}` })} link ${q(kid)}`);
    }
    lines.push("    main", `      heading ${q(title)}`);
    {
      for (const item of fields) {
        if (item.kind === "textbox") lines.push(`      ${ref({ role: "textbox", name: item.name, action: `field:${item.name}` })} textbox ${q(item.name)} value=${q(item.value)}`);
        else if (item.kind === "combobox") {
          lines.push(`      ${ref({ role: "combobox", name: item.name, action: `field:${item.name}`, options: item.options })} combobox ${q(item.name)} value=${q(item.value)}`);
          for (const option of item.options ?? []) lines.push(`        option ${q(option)}`);
        }
      }
      if (path === "/customers/importbanklink/index") lines.push(`      ${ref({ role: "button", name: "Load File", action: "file" })} button "Load File"`, ...(uploadError ? [`      alert ${q(uploadError)}`] : []));
      const table = tableFor(path);
      if (path === "/report/reportlist") {
        lines.push('      table "Results"');
        if (loading > 0) lines.push("        row", '          cell "Loading…"');
        else for (const name of ["Receipt Register", "Receipt Register - Reversals", "Arrears Report", "Owner Statement", TENANT_REPORT, SUPPLIER_REPORT].filter(r => !field("Search") || r.toLowerCase().includes(field("Search").toLowerCase()))) {
          reportsListed = true; lines.push("        row", `          ${ref({ role: "link", name, action: "report" })} link ${q(name)}`);
        }
      } else if (table) {
        // The grid, its footer and pager sit in their own region; the page's record-changing buttons are outside it.
        // The tenants grid scrolls (no pages) and shows "No records to display" before it fills, as live REI does.
        const scrolls = path === "/customers/tenant" || path === "/customers/supplier";
        const grid = ['table "Results"'];
        if (loading > 0 && scrolls) grid.push("  row", ...table.cols.map(col => `    columnheader ${q(col)}`), "  row", '    cell "No records to display"');
        else if (loading > 0) grid.push("  row", '    cell "Loading…"');
        else {
          const shown = scrolls ? table.rows : table.rows.slice(page * pageSize, page * pageSize + pageSize);
          grid.push("  row", ...table.cols.map(col => `    columnheader ${q(col)}`));
          if (!shown.length) grid.push("  row", `    cell ${q(scrolls ? "No records to display" : "No records found")}`);
          for (const row of shown) grid.push("  row", ...row.map(cell => `    cell ${q(cell)}`));
        }
        if (loading === 0) grid.push(`StaticText ${q(`${table.rows.length} records · 0 row(s) selected`)}`);
        if (!scrolls) {
          const last = (page + 1) * pageSize >= table.rows.length;
          const pages = Math.max(1, Math.min(20, Math.ceil(table.rows.length / pageSize)));
          grid.push('navigation "Pagination"', `  ${ref({ role: "button", name: "Previous", action: "prev", disabled: page === 0 })} button "Previous"${page === 0 ? " [disabled]" : ""}`,
            ...Array.from({ length: pages }, (_, index) => `  ${ref({ role: "link", name: String(index + 1), action: "none" })} link ${q(String(index + 1))}`),
            `  ${ref({ role: "button", name: "Next", action: "next", disabled: last })} button "Next"${last ? " [disabled]" : ""}`);
        }
        lines.push('      region "Results"', ...grid.map(line => `        ${line}`));
      }
      if (path === "/customers/arrears/") lines.push(`      ${ref({ role: "button", name: "Notice", action: "effect:notice" })} button "Notice"`);
      if (path === "/customers/reconciliation/bankreconciliation") lines.push(`      ${ref({ role: "button", name: "Reconcile", action: "effect:reconcile" })} button "Reconcile"`);
      if (path === "/customers/importbanklink/index") lines.push(`      ${ref({ role: "button", name: "Process Receipts", action: "effect:process-receipts" })} button "Process Receipts"`, `      ${ref({ role: "button", name: "Receipt All", action: "effect:receipt-all" })} button "Receipt All"`);
      // Pending payments: Bud never presses these.
      if (path === "/customers/transaction/pendingtransactions") lines.push(...[["Process Pending", "process-pending"], ["Delete Pending", "delete-pending"], ["Process", "process-payments"]]
        .map(([name, effect]) => `      ${ref({ role: "button", name, action: `effect:${effect}` })} button ${q(name)}`));
      if (modal) {
        // Live REI opens a parameters popup (#reportParameterOwnerList_popup) before any output.
        lines.push('      dialog "Report parameters"', `        heading ${q(report || "Receipt Register")}`, ...(report === TENANT_REPORT || report === SUPPLIER_REPORT ? [] : [
          `        ${ref({ role: "radio", name: "Current Period", action: "radio" })} radio "Current Period"`,
          `        ${ref({ role: "radio", name: "Date Range", action: "radio" })} radio "Date Range"`,
          `        ${ref({ role: "textbox", name: "From Date", action: "field:From Date" })} textbox "From Date" value=${q(field("From Date"))}`,
          `        ${ref({ role: "textbox", name: "To Date", action: "field:To Date" })} textbox "To Date" value=${q(field("To Date"))}`]),
          `        ${ref({ role: "combobox", name: "Output", action: "field:Output", options: ["Export Only", "Email Only"] })} combobox "Output" value=${q(field("Output") || "Export Only")}`,
          '          option "Export Only"', '          option "Email Only"',
          `        ${ref({ role: "button", name: "Export", action: "export" })} button "Export"`);
      }
    }
    lines.push("    contentinfo", `      StaticText ${q(`2026 © Fictional mock · v ${options.version ?? "26.0922.0"}`)}`);
    return lines.join("\n");
  };
  /** Refs are assigned by rendering; the helper resolves them against the page as it stands. */
  const control = (args: string[]) => { render(); const found = refs.get(args[args.indexOf("--ref") + 1]); if (!found) throw new Error("Stale reference"); return found; };
  const setField = (name: string, value: string) => {
    const item = fields.find(entry => entry.name === name);
    if (item) item.value = value; else fields.push({ kind: "textbox", name, value });
    // A field in the open Receipt Register dialog does not reload the grid behind it.
    if (modal) return;
    page = 0; loading = 1;
  };

  const command = async (args: string[]): Promise<BrowserJson> => {
    calls.push([...args]);
    if (["navigate", "click", "fill", "press", "select", "upload", "download"].includes(args[0])) steps += 1;
    const interaction = { borrow_confirmation: "always", request_help: "enabled" };
    if (args[0] === "status") return { daemon_version: BROWSER_VERSION, protocol_version: BROWSER_PROTOCOL, browsers: [{ instance_id: "work", browser_name: "Chrome", extension_version: BROWSER_VERSION, extension_protocol_version: BROWSER_PROTOCOL }], sessions: session ? [{ session_id: "owned", browser_instance_id: "work", interaction }] : [] };
    if (args[0] === "session" && args[1] === "start") { session = true; return { session_id: "owned", browser_instance_id: "work", interaction }; }
    if (args[0] === "session" && args[1] === "stop") { session = false; return { stopped: ["owned"], failed: [], return_failures: [] }; }
    if (args[0] === "tab" && args[1] === "list") return { tabs: [{ tab_id: 1, url, title: "REI", scope }, { tab_id: 2, url: "https://unrelated.fictional.test/inbox", title: "Unrelated", scope: "user" }] };
    if (args[0] === "tab" && args[1] === "borrow") { scope = "agent"; return { ok: true }; }
    if (args[0] === "observe") { const text = render(); if (loading > 0) loading -= 1; return { text, tab_id: 1, truncated: false }; }
    if (args[0] === "request-help") {
      if (options.helpOutcome !== "cancelled") { signedIn = true; load(returnUrl); }
      return { ok: true, outcome: options.helpOutcome ?? "completed" };
    }
    if (args[0] === "navigate") { direct = true; load(args[1]); return { ok: true }; }
    if (args[0] === "fill") { const target = control(args); if (!target.action.startsWith("field:")) throw new Error("Not a field"); setField(target.name, args[args.indexOf("--value") + 1]); return { ok: true }; }
    if (args[0] === "press") { control(args); return { ok: true }; }
    if (args[0] === "select") {
      const target = control(args); const value = args.find(arg => arg.startsWith("--value="))!.slice("--value=".length);
      if (!target.options?.includes(value)) throw new Error("No such option");
      setField(target.name, value); return { ok: true };
    }
    if (args[0] === "click") {
      const target = control(args);
      if (target.disabled) return { ok: true };
      if (target.action.startsWith("go:")) { direct = false; load(new URL(target.action.slice(3), FICTIONAL_REI_ORIGIN).href); return { ok: true }; }
      if (target.action === "next") { if (!options.stuckPagination) page += 1; loading = 1; return { ok: true }; }
      if (target.action === "prev") { page = Math.max(0, page - 1); loading = 1; return { ok: true }; }
      if (target.action === "report" && reportsListed) { modal = true; report = target.name; return { ok: true }; }
      if (target.action === "radio") { setField("Range", target.name); return { ok: true }; }
      if (target.action.startsWith("effect:")) { effects.push(target.action.slice(7)); return { ok: true }; }
      return { ok: true };
    }
    if (args[0] === "upload") {
      control(args); effects.push("upload");
      if (options.unknownUpload === "before") throw new Error("Lost reply");
      if (!pending) {
        const parsed = parseBankFile(field("File Format"), readFileSync(args[args.indexOf("--file") + 1], "utf8"));
        if (typeof parsed === "string") uploadError = parsed;
        else pending = { uploadId: `FU-${String(++uploads).padStart(4, "0")}`, account: here(), format: field("File Format"),
          rows: parsed.map(line => ({ ...line, ...fictionalMatch(line.reference, line.amountCents) })) };
      } else uploadError = "A bank file is already pending. Process or discard it first.";
      loading = 1;
      if (options.unknownUpload) throw new Error("Lost reply");
      return { ok: true };
    }
    if (args[0] === "download") {
      control(args);
      // A directory export: the list's Active rows (what its grid shows by default), every column.
      const directory = report === TENANT_REPORT ? { cols: FICTIONAL_TENANT_COLUMNS, rows: FICTIONAL_TENANT_LIST, file: "fictional-tenant-list.csv" }
        : report === SUPPLIER_REPORT ? { cols: FICTIONAL_SUPPLIER_COLUMNS, rows: FICTIONAL_SUPPLIER_LIST, file: "fictional-supplier-list.csv" } : null;
      if (directory) {
        const rows = (options.directoryRows ?? (rows => rows))(directory.rows.filter(row => row.status === "Active").map(row => [...row.cells]));
        await writeFile(args[args.indexOf("--out") + 1], [directory.cols, ...rows].map(csvLine).join("\r\n") + "\r\n");
        return { ok: true, suggested_filename: directory.file };
      }
      // The register is built from the receipt ledger, filtered by this page's account and the dialog's dates.
      const account = here(), from = field("From Date"), to = field("To Date");
      const rows = receipts.filter(item => sameAccount(item.account, account) && (!from || item.date >= from) && (!to || item.date <= to)).sort((a, b) => a.date.localeCompare(b.date) || a.receiptId.localeCompare(b.receiptId));
      const total = rows.reduce((sum, row) => sum + row.amountCents, 0);
      const csv = ["Scope,Value", `business,${account.business}`, `from,${from}`, `to,${to}`, "Receipt ID,Date,Reference,Tenant,Tenant ID,Amount,Status",
        ...rows.map(row => [row.receiptId, row.date, row.reference, row.tenant, row.tenantId, money(row.amountCents), row.status].join(",")), `Total,,,,,${money(total)}`].join("\n");
      await writeFile(args[args.indexOf("--out") + 1], csv);
      return { ok: true, suggested_filename: "fictional-receipt-register.csv" };
    }
    return { ok: true };
  };
  /** The person's posting in REI, simulated (Bud never presses it): matched pending rows become receipts; the rest are not receipted. */
  const post = (input: { date?: string; status?: (row: PendingRow) => string } = {}) => {
    if (!pending) throw new Error("No bank file is pending.");
    const created: FictionalReceipt[] = [];
    for (const row of pending.rows) {
      if (!row.tenancy) continue;
      const receipt: FictionalReceipt = { receiptId: `FR-${String(receipts.length + 1).padStart(4, "0")}`, account: { ...pending.account }, date: input.date ?? row.date, reference: row.reference,
        tenantId: row.tenancy.tenantId, tenant: row.tenancy.name, propertyId: row.tenancy.propertyId, ownerId: row.tenancy.ownerId, amountCents: row.amountCents, status: input.status?.(row) ?? "Receipted" };
      receipts.push(receipt); created.push(receipt);
    }
    pending = null;
    return created;
  };
  return { command, calls, effects, url: () => url, signIn: () => { signedIn = true; }, post, pendingUpload: () => pending && structuredClone(pending), receipts: () => structuredClone(receipts),
    /** The person switches the top-bar business (undefined: back to FICT1). */
    setBusiness: (code?: string) => { if (code === undefined) delete options.business; else options.business = code; } };
}
