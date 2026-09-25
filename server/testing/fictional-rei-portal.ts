// FICTIONAL REI-style portal behind the browser helper's command interface
// (the `bsk` CLI that BrowserRuntime runs). The real BrowserBroker drives it
// exactly as it drives a person's browser: tab list, borrow, observe (a VOM
// accessibility tree), navigate, click, fill, press, select, upload, download
// and request-help. No network, no browser, no REI account, no credentials.
// It is built from the pack's website map, so a pass proves the recipes run
// through RealBud's authority path and their guards hold, never that REI
// Cloud behaves this way. Dependency-free.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserJson } from "../browser-runtime.ts";
import { parsePortalRecipePack, type PortalRecipePack } from "../portal-recipe.ts";

/** The Austin pack's REI recipes, pointed at the fictional origins instead of REI Cloud. */
export function fictionalReiPack(): PortalRecipePack {
  const file = join(dirname(fileURLToPath(import.meta.url)), "../../pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json");
  const pack = parsePortalRecipePack(JSON.parse(readFileSync(file, "utf8")));
  // The fictional portal declares its own pager exactly (live REI's is unconfirmed, so its landmark is null).
  return { ...pack, origin: FICTIONAL_REI_ORIGIN, signIn: { ...pack.signIn, hosts: [new URL(FICTIONAL_REI_SIGNIN).host] },
    pagination: { ...pack.pagination, landmark: { role: "navigation", name: "Pagination" } } };
}

export const FICTIONAL_REI_ORIGIN = "https://rei-mock.fictional.test";
export const FICTIONAL_REI_SIGNIN = "https://signin.rei-mock.fictional.test";
export const FICTIONAL_REICID = "fictional-reicid-1";
export const FICTIONAL_BUSINESS = "FICT1";
const AGENCY = "Fictional Realty Office";
const TOP = ["Dashboard", "Business", "Owners", "Pool of Owners", "Contacts", "Rentals", "Tenants", "Suppliers", "Communities", "Sales", "Listings", "Agents", "Booking Calendar", "Tasks", "Receipts", "Process", "Reports", "Settings", "Tools", "My Profile"];
const ROUTES: Record<string, string> = { Dashboard: "/customers/dashboard", Owners: "/customers/owner", Rentals: "/customers/property", Tenants: "/customers/tenant", Tasks: "/customers/task", Reports: "/report/reportlist", Suppliers: "/customers/supplier", Contacts: "/customers/contact" };
const CHILDREN: Record<string, Array<[string, string]>> = {
  Tenants: [["Arrears", "/customers/arrears/"]],
  Receipts: [["Tenant receipts", "/customers/transaction/tenantreceipt"], ["Bulk receipting", "/customers/importbanklink/index"]],
  Process: [["Bank reconciliation", "/customers/reconciliation/bankreconciliation"]],
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
const TABLES: Record<string, { cols: string[]; rows: string[][] }> = {
  tenants: { cols: ["Name", "Status", "Paid to", "Rent credit", "Days", "Amount owing"], rows: TENANTS },
  owners: { cols: ["Name", "Status", "Properties"], rows: [["Fictional Owner One", "Active", "2"], ["Fictional Owner Two", "Active", "1"]] },
  rentals: { cols: ["Property", "Status", "Lease expiry", "Smoke due"], rows: Array.from({ length: 7 }, (_, i) => [`${i + 1} Fictional St`, "Active", `2026-1${i % 3}-0${i + 1}`, `2026-10-1${i}`]) },
  tasks: { cols: ["Task", "Status", "Due date", "Priority", "Assigned to"], rows: [["Fictional inspection", "Open", "2026-09-25", "High", "Staff A"], ["Fictional lease renewal", "Open", "2026-09-26", "Normal", "Staff B"], ["Fictional closed task", "Closed", "2026-09-25", "Low", "Staff A"]] },
  reconciliation: { cols: ["Date", "Description", "Debit", "Credit", "Reconciled"], rows: [["2026-09-24", "Fictional deposit", "", "1200.00", "No"], ["2026-09-24", "Fictional fee", "15.00", "", "No"]] },
  empty: { cols: ["Name"], rows: [] },
};
type Field = { kind: "textbox" | "combobox" | "radio"; name: string; value: string; options?: string[] };
type Control = { role: string; name: string; action: string; disabled?: boolean; options?: string[]; value?: string };

export interface FictionalReiOptions {
  /** Signed out: every app page redirects to the fictional sign-in page. */
  signedOut?: boolean;
  /** What the person does on the sign-in page when asked. */
  helpOutcome?: "completed" | "cancelled";
  /** Header business shown when a URL carries only reicid (a direct route). */
  directBusiness?: string;
  /** After this many page-changing commands, the header business becomes FICT2 (someone switched business in another tab). */
  switchBusinessAfterSteps?: number;
  /** Next re-renders the same page instead of advancing. */
  stuckPagination?: boolean;
  /** The upload's reply is lost: its effect is unknown. */
  unknownUpload?: boolean;
  version?: string;
  /** Rows shown per page. */
  pageSize?: number;
}

export function fictionalReiPortal(options: FictionalReiOptions = {}) {
  const calls: string[][] = [];
  /** Effects a consequential control would have had. Tests expect none, apart from an approved upload. */
  const effects: string[] = [];
  const pageSize = options.pageSize ?? 5;
  let session = false; let scope = "user"; let signedIn = !options.signedOut; let steps = 0;
  let url = `${FICTIONAL_REI_ORIGIN}/customers/dashboard?reicid=${FICTIONAL_REICID}&b=${FICTIONAL_BUSINESS}`;
  let returnUrl = url;
  if (!signedIn) url = `${FICTIONAL_REI_SIGNIN}/b2c_1_signin/authorize`;
  // Per-page state, reset on each load.
  let fields: Field[] = []; let page = 0; let loading = 0; let modal = false; let reportsListed = false; let preview: string[][] | null = null;
  let refs = new Map<string, Control>();

  const business = () => {
    const at = new URL(url);
    if (options.switchBusinessAfterSteps !== undefined && steps > options.switchBusinessAfterSteps) return "FICT2";
    return at.searchParams.get("b") ?? options.directBusiness ?? FICTIONAL_BUSINESS;
  };
  const load = (next: string) => {
    const at = new URL(next);
    if (at.origin === FICTIONAL_REI_ORIGIN && !signedIn) { returnUrl = next; url = `${FICTIONAL_REI_SIGNIN}/b2c_1_signin/authorize`; }
    else url = next;
    page = 0; loading = 1; modal = false; reportsListed = false; preview = null;
    fields = initialFields(new URL(url).pathname);
  };
  const initialFields = (path: string): Field[] => {
    const status = (value: string): Field => ({ kind: "combobox", name: "Status", value, options: ["Active", "Inactive", "Open", "Closed", "All"] });
    const search: Field = { kind: "textbox", name: "Search", value: "" };
    if (path === "/customers/tenant" || path === "/customers/owner") return [search, status("Active")];
    if (path === "/customers/property") return [search, status("Active"), { kind: "combobox", name: "View", value: "Default", options: ["Default", "lease expiry", "smoke", "pool"] }];
    if (path === "/customers/task") return [status("All"), { kind: "textbox", name: "From", value: "" }, { kind: "textbox", name: "To", value: "" }];
    if (path === "/customers/arrears/") return [search, { kind: "textbox", name: "From day", value: "" }, { kind: "combobox", name: "Hide vacated tenants", value: "No", options: ["No", "Yes"] }];
    if (path === "/customers/reconciliation/bankreconciliation") return [{ kind: "textbox", name: "Statement balance", value: "" }];
    if (path === "/report/reportlist") return [search];
    if (path === "/customers/importbanklink/index") return [{ kind: "combobox", name: "File Format", value: "", options: ["ABA", "Custom CSV", "Fictional Bank CSV"] }];
    return [search];
  };
  const field = (name: string) => fields.find(item => item.name === name)?.value ?? "";
  const tableFor = (path: string): { cols: string[]; rows: string[][] } | null => {
    const filter = (key: string, keep: (row: string[]) => boolean, statusDefault = true) => {
      const base = TABLES[key]; const status = field("Status"); const query = field("Search").toLowerCase();
      return { cols: base.cols, rows: base.rows.filter(row => (!statusDefault || !status || status === "All" || row[1] === status) && (!query || row[0].toLowerCase().includes(query)) && keep(row)) };
    };
    if (path === "/customers/tenant") return filter("tenants", () => true);
    if (path === "/customers/owner") return filter("owners", () => true);
    if (path === "/customers/property") return filter("rentals", () => true);
    if (path === "/customers/task") return filter("tasks", row => (!field("From") || row[2] >= field("From")) && (!field("To") || row[2] <= field("To")));
    if (path === "/customers/arrears/") return filter("tenants", row => Number(row[4]) >= Number(field("From day") || 1) && !(field("Hide vacated tenants") === "Yes" && row[1] === "Vacated"), false);
    if (path === "/customers/reconciliation/bankreconciliation") return TABLES.reconciliation;
    if (path === "/customers/importbanklink/index") return preview ? { cols: ["Date", "Reference", "Amount", "Match"], rows: preview } : null;
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
    const path = at.pathname; const reicid = at.searchParams.get("reicid"); const b = business();
    const query = reicid ? `?reicid=${reicid}${at.searchParams.get("b") ? `&b=${at.searchParams.get("b")}` : ""}` : "";
    const title = path === "/customers/dashboard" ? "Dashboard" : Object.values(CHILDREN).flat().find(([, route]) => route === path)?.[0] ?? Object.entries(ROUTES).find(([, route]) => route === path)?.[0] ?? path.split("/").filter(Boolean).pop() ?? "Page";
    lines.push(`  RootWebArea ${q(`${title} - REI Cloud`)}`, "    banner");
    if (reicid) lines.push(`      StaticText ${q(AGENCY)}`, `      ${ref({ role: "button", name: b, action: "none" })} button ${q(b)}`);
    else lines.push('      StaticText "Select a business to continue"');
    lines.push('    navigation "Main"');
    const section = Object.entries(CHILDREN).find(([, kids]) => kids.some(([, route]) => route === path))?.[0] ?? Object.entries(ROUTES).find(([, route]) => route === path)?.[0];
    for (const label of TOP) {
      lines.push(`      ${ref({ role: "link", name: label, action: `go:${(ROUTES[label] ?? `/area/${encodeURIComponent(label)}`)}${query}` })} link ${q(label)}`);
      if (label === section) for (const [kid, route] of CHILDREN[label] ?? []) lines.push(`        ${ref({ role: "link", name: kid, action: `go:${route}${query}` })} link ${q(kid)}`);
    }
    lines.push("    main", `      heading ${q(title)}`);
    if (reicid) {
      for (const item of fields) {
        if (item.kind === "textbox") lines.push(`      ${ref({ role: "textbox", name: item.name, action: `field:${item.name}` })} textbox ${q(item.name)} value=${q(item.value)}`);
        else if (item.kind === "combobox") {
          lines.push(`      ${ref({ role: "combobox", name: item.name, action: `field:${item.name}`, options: item.options })} combobox ${q(item.name)} value=${q(item.value)}`);
          for (const option of item.options ?? []) lines.push(`        option ${q(option)}`);
        }
      }
      if (path === "/customers/importbanklink/index") lines.push(`      ${ref({ role: "button", name: "Load File", action: "file" })} button "Load File"`);
      const table = tableFor(path);
      if (path === "/report/reportlist") {
        lines.push('      table "Results"');
        if (loading > 0) lines.push("        row", '          cell "Loading…"');
        else for (const report of ["Receipt Register", "Receipt Register - Reversals", "Arrears Report", "Owner Statement"].filter(r => !field("Search") || r.toLowerCase().includes(field("Search").toLowerCase()))) {
          reportsListed = true; lines.push("        row", `          ${ref({ role: "link", name: report, action: "report" })} link ${q(report)}`);
        }
      } else if (table) {
        // The grid and its pager sit in their own region; the page's record-changing buttons are outside it.
        const grid = ['table "Results"'];
        if (loading > 0) grid.push("  row", '    cell "Loading…"');
        else {
          const shown = table.rows.slice(page * pageSize, page * pageSize + pageSize);
          grid.push("  row", ...table.cols.map(col => `    columnheader ${q(col)}`));
          if (!shown.length) grid.push("  row", '    cell "No records found"');
          for (const row of shown) grid.push("  row", ...row.map(cell => `    cell ${q(cell)}`));
        }
        const last = (page + 1) * pageSize >= table.rows.length;
        const pages = Math.max(1, Math.min(20, Math.ceil(table.rows.length / pageSize)));
        grid.push('navigation "Pagination"', `  ${ref({ role: "button", name: "Previous", action: "prev", disabled: page === 0 })} button "Previous"${page === 0 ? " [disabled]" : ""}`,
          ...Array.from({ length: pages }, (_, index) => `  ${ref({ role: "link", name: String(index + 1), action: "none" })} link ${q(String(index + 1))}`),
          `  ${ref({ role: "button", name: "Next", action: "next", disabled: last })} button "Next"${last ? " [disabled]" : ""}`);
        lines.push('      region "Results"', ...grid.map(line => `        ${line}`));
      }
      if (path === "/customers/arrears/") lines.push(`      ${ref({ role: "button", name: "Notice", action: "effect:notice" })} button "Notice"`);
      if (path === "/customers/reconciliation/bankreconciliation") lines.push(`      ${ref({ role: "button", name: "Reconcile", action: "effect:reconcile" })} button "Reconcile"`);
      if (path === "/customers/importbanklink/index") lines.push(`      ${ref({ role: "button", name: "Process Receipts", action: "effect:process-receipts" })} button "Process Receipts"`, `      ${ref({ role: "button", name: "Receipt All", action: "effect:receipt-all" })} button "Receipt All"`);
      if (modal) {
        lines.push('      dialog "Receipt Register"', '        heading "Receipt Register"',
          `        ${ref({ role: "radio", name: "Current Period", action: "radio" })} radio "Current Period"`,
          `        ${ref({ role: "radio", name: "Date Range", action: "radio" })} radio "Date Range"`,
          `        ${ref({ role: "textbox", name: "From Date", action: "field:From Date" })} textbox "From Date" value=${q(field("From Date"))}`,
          `        ${ref({ role: "textbox", name: "To Date", action: "field:To Date" })} textbox "To Date" value=${q(field("To Date"))}`,
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
    page = 0; loading = 1;
  };

  const command = async (args: string[]): Promise<BrowserJson> => {
    calls.push([...args]);
    if (["navigate", "click", "fill", "press", "select", "upload", "download"].includes(args[0])) steps += 1;
    const interaction = { borrow_confirmation: "always", request_help: "enabled" };
    if (args[0] === "status") return { daemon_version: "0.3.0", protocol_version: "1.3", browsers: [{ instance_id: "work", browser_name: "Chrome", extension_version: "0.3.0", extension_protocol_version: "1.3" }], sessions: session ? [{ session_id: "owned", browser_instance_id: "work", interaction }] : [] };
    if (args[0] === "session" && args[1] === "start") { session = true; return { session_id: "owned", browser_instance_id: "work", interaction }; }
    if (args[0] === "session" && args[1] === "stop") { session = false; return { stopped: ["owned"], failed: [], return_failures: [] }; }
    if (args[0] === "tab" && args[1] === "list") return { tabs: [{ tab_id: 1, url, title: "REI", scope }, { tab_id: 2, url: "https://unrelated.fictional.test/inbox", title: "Unrelated", scope: "user" }] };
    if (args[0] === "tab" && args[1] === "borrow") { scope = "agent"; return { ok: true }; }
    if (args[0] === "observe") { const text = render(); if (loading > 0) loading -= 1; return { text, tab_id: 1, truncated: false }; }
    if (args[0] === "request-help") {
      if (options.helpOutcome !== "cancelled") { signedIn = true; load(returnUrl); }
      return { ok: true, outcome: options.helpOutcome ?? "completed" };
    }
    if (args[0] === "navigate") { load(args[1]); return { ok: true }; }
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
      if (target.action.startsWith("go:")) { load(new URL(target.action.slice(3), FICTIONAL_REI_ORIGIN).href); return { ok: true }; }
      if (target.action === "next") { if (!options.stuckPagination) page += 1; loading = 1; return { ok: true }; }
      if (target.action === "prev") { page = Math.max(0, page - 1); loading = 1; return { ok: true }; }
      if (target.action === "report" && reportsListed) { modal = true; return { ok: true }; }
      if (target.action === "radio") { setField("Range", target.name); return { ok: true }; }
      if (target.action.startsWith("effect:")) { effects.push(target.action.slice(7)); return { ok: true }; }
      return { ok: true };
    }
    if (args[0] === "upload") {
      control(args); effects.push("upload");
      if (options.unknownUpload) throw new Error("Lost reply");
      preview = [["2026-09-25", "FT-BRAVO", "540.00", "Matched"], ["2026-09-25", "UNKNOWN REF", "75.00", "Unmatched"]]; loading = 1;
      return { ok: true };
    }
    if (args[0] === "download") {
      control(args);
      const csv = ["Scope,Value", `reicid,${new URL(url).searchParams.get("reicid")}`, `business,${business()}`, `from,${field("From Date")}`, `to,${field("To Date")}`, "Date,Reference,Amount", "2026-09-25,FT-BRAVO,540.00", "Total,,540.00"].join("\n");
      await writeFile(args[args.indexOf("--out") + 1], csv);
      return { ok: true, suggested_filename: "fictional-receipt-register.csv" };
    }
    return { ok: true };
  };
  return { command, calls, effects, url: () => url, signIn: () => { signedIn = true; } };
}
