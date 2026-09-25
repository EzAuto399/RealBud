// REI Cloud website-map v2 simulation.
//
// 1. Lints the Austin Realty add-on pack source reference
//    pack/workflows/austin-accounts/support/rei-cloud-navigation/references/website-map.md
//    (recipe grammar, labels, stop lists, tier honesty). The map is not
//    RealBud core and not part of the published pack.
// 2. Executes every recipe that claims tier S against a FICTIONAL local mock
//    of the REI screens (served by request interception on a .test origin;
//    no network, no REI account, no model). The mock reproduces the traps the
//    map records: agency context in the query string, async tables and
//    modal, a search box that ignores non-input assignment, Active-by-default
//    status, pagination, sign-in cancel page, version drift, independent URL
//    reicid and header business-code switches,
//    an unknown upload outcome and consequential buttons that count effects.
//
// Limits: the mock is derived from the map, so passing proves the recipes are
// executable and their guards work — not that REI Cloud behaves this way.
//
// Needs PLAYWRIGHT_MODULE and CHROME_EXECUTABLE. Writes receipt.json to a new
// directory (REALBUD_QA_OUTPUT, default outputs/rei-map-sim-<date>).
// REI_MAP_OVERRIDE points at another copy of the map for mutation testing
// only (for example, a stop-list entry removed must make this run fail).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_DEFAULT = "pack/workflows/austin-accounts/support/rei-cloud-navigation/references/website-map.md";
const MAP = process.env.REI_MAP_OVERRIDE ?? join(root, MAP_DEFAULT); // override = mutation testing only
const modulePath = process.env.PLAYWRIGHT_MODULE;
const executable = process.env.CHROME_EXECUTABLE;
if (!modulePath || !executable) throw new Error("Set PLAYWRIGHT_MODULE and CHROME_EXECUTABLE.");
const today = new Date().toISOString().slice(0, 10);
const output = resolve(process.env.REALBUD_QA_OUTPUT ?? join(root, `outputs/rei-map-sim-${today}`));
if (existsSync(output)) throw new Error(`Refusing to overwrite earlier evidence: ${output}`);

// ── 1. parse + lint the map ──────────────────────────────────────────────────
const mapText = await readFile(MAP, "utf8");
const blocks = [...mapText.matchAll(/```yaml\n([\s\S]*?)```/g)].map(m => parse(m[1]));
const screens = blocks.find(b => b?.screens)?.screens ?? [];
const recipes = Object.fromEntries(blocks.filter(b => b?.recipe).map(b => [b.recipe, b]));
const labels = blocks.find(b => b?.read_safe_labels);
const TOP = ["Dashboard", "Business", "Owners", "Pool of Owners", "Contacts", "Rentals", "Tenants", "Suppliers", "Communities", "Sales", "Listings", "Agents", "Booking Calendar", "Tasks", "Receipts", "Process", "Reports", "Settings", "Tools", "My Profile"];
const VERBS = new Set(["nav", "check", "type", "select", "radio", "click", "wait", "read", "paginate", "upload", "download", "run"]);
const lint = [];
const fail = msg => lint.push(msg);

if (screens.length < 15) fail(`expected ≥15 screens, got ${screens.length}`);
if (!labels) fail("labels block missing");
for (const s of screens) {
  if (!TOP.includes(s.menu[0])) fail(`screen ${s.id}: menu root ${s.menu[0]} not in top-level index`);
  if (/\?/.test(s.route)) fail(`screen ${s.id}: route keeps a query string`);
}
const safe = new Set(labels.read_safe_labels), conseq = new Set(labels.consequential_labels);
if (safe.has("Preview")) fail("report Preview cannot be read-safe without live qualification");
for (const l of safe) if (conseq.has(l)) fail(`label ${l} is both read-safe and consequential`);
for (const s of screens) for (const l of s.stop ?? []) if (!conseq.has(l)) fail(`screen ${s.id}: stop ${l} not consequential`);
const menuPaths = new Set(screens.map(s => s.menu.join(" › ")));
for (const [name, r] of Object.entries(recipes)) {
  if (!["read", "prepare", "study"].includes(r.kind)) fail(`${name}: bad kind`);
  if (!Array.isArray(r.tier) || !r.tier.length) fail(`${name}: tier missing`);
  if (r.kind !== "study" && !r.steps) fail(`${name}: no steps`);
  for (const step of r.steps ?? []) {
    const [verb, arg] = Object.entries(step)[0];
    if (!VERBS.has(verb)) fail(`${name}: unknown verb ${verb}`);
    if (verb === "nav" && !String(arg[0]).startsWith("{") && !TOP.includes(arg[0])) fail(`${name}: nav root ${arg[0]} unknown`);
    if (verb === "nav" && arg.length > 1 && !menuPaths.has(arg.join(" › "))) fail(`${name}: nav path ${arg.join(" › ")} not a mapped screen`);
    if (verb === "run" && !recipes[arg]) fail(`${name}: runs missing recipe ${arg}`);
    if (verb === "run") for (const need of recipes[arg]?.grant_needs ?? []) if (!(r.grant_needs ?? []).includes(need)) fail(`${name}: sub-recipe ${arg} requires ${need}`);
    if (verb === "upload" && r.kind === "read") fail(`${name}: read recipe uploads`);
    if (verb === "upload" && !(r.grant_needs ?? []).includes("upload")) fail(`${name}: upload without grant_needs`);
    if (verb === "download" && !(r.grant_needs ?? []).includes("download")) fail(`${name}: download without grant_needs`);
    if (verb === "download" && r.kind === "read") fail(`${name}: read recipe downloads`);
    if (verb === "click" && arg === "Preview") fail(`${name}: unverified report Preview cannot be read-safe`);
    if (verb === "click" && !safe.has(arg)) fail(`${name}: click ${arg} not read-safe`);
    if (verb === "click" && conseq.has(arg)) fail(`${name}: clicks consequential ${arg}`);
  }
  for (const l of r.stop_before ?? []) if (!conseq.has(l)) fail(`${name}: stop_before ${l} not in consequential_labels`);
  const steps = r.steps ?? [];
  steps.forEach((step, i) => {
    const [verb, arg] = Object.entries(step)[0];
    if (verb !== "nav") return;
    // Every navigation is followed by both account-marker checks (bare routes lose context).
    const nextStep = steps[i + 1]; if (!nextStep || nextStep.check !== "account") fail(`${name}: nav ${JSON.stringify(arg)} not followed by check: account`);
    // A recipe that reaches a screen must stop before that screen's own consequential buttons.
    const screen = screens.find(s => s.menu.join(" › ") === arg.join(" › "));
    for (const l of screen?.stop ?? []) if (!(r.stop_before ?? []).includes(l)) fail(`${name}: reaches ${screen.id} but stop_before lacks ${l}`);
  });
  if (r.kind === "prepare" && !r.on_unknown) fail(`${name}: prepare recipe without on_unknown`);
}
if (/\/Users\/|C:\\|password\s*[:=]|ak_[A-Za-z0-9]{8}/.test(mapText)) fail("map contains a machine path or credential-shaped text");
const noSteps = Object.entries(recipes).filter(([, r]) => r.tier.includes("S") && !r.steps);
for (const [n] of noSteps) fail(`${n}: claims S without steps`);
// The runner's machine-readable recipes (recipes.json) must be generated from this map.
{
  const { reiRecipesDrift } = await import("./rei-recipes.mjs");
  if ((await reiRecipesDrift(MAP)).drifted) fail("recipes.json drifted from the website map; run node scripts/rei-recipes.mjs --write and review");
}

// ── 2. fictional mock ────────────────────────────────────────────────────────
const ORIGIN = "https://rei-mock.fictional.test";
const AGENCY = "Fictional Realty Office";
const B = "FICT1";
const REICID = "fictional-reicid-1";
const CHILDREN = { Tenants: [["Arrears", "/customers/arrears/"]], Receipts: [["Tenant receipts", "/customers/transaction/tenantreceipt"], ["Bulk receipting", "/customers/importbanklink/index"]], Process: [["Bank reconciliation", "/customers/reconciliation/bankreconciliation"]], Settings: [["Integrations", "/RequesterIntegrations"]] };
const ROUTES = Object.fromEntries(screens.filter(s => s.menu.length === 1).map(s => [s.menu[0], s.route]));
ROUTES.Dashboard = "/dashboard";
const tenants = [
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
const data = {
  tenants: { cols: ["Name", "Status", "Paid to", "Rent credit", "Days", "Amount owing"], rows: tenants },
  owners: { cols: ["Name", "Status", "Properties"], rows: [["Fictional Owner One", "Active", "2"], ["Fictional Owner Two", "Active", "1"]] },
  rentals: { cols: ["Property", "Status", "Lease expiry", "Smoke due"], rows: Array.from({ length: 7 }, (_, i) => [`${i + 1} Fictional St`, "Active", `2026-1${i % 3}-0${i + 1}`, `2026-10-1${i}`]) },
  tasks: { cols: ["Task", "Status", "Due date", "Priority", "Assigned to"], rows: [["Fictional inspection", "Open", "2026-09-25", "High", "Staff A"], ["Fictional lease renewal", "Open", "2026-09-26", "Normal", "Staff B"], ["Fictional closed task", "Closed", "2026-09-25", "Low", "Staff A"]] },
  reconciliation: { cols: ["Date", "Description", "Debit", "Credit", "Reconciled"], rows: [["2026-09-24", "Fictional deposit", "", "1200.00", "No"], ["2026-09-24", "Fictional fee", "15.00", "", "No"]] },
  reports: { cols: ["Report"], rows: [["Receipt Register"], ["Receipt Register - Reversals"], ["Arrears Report"], ["Owner Statement"]] },
};

function shell({ title, body, b, reicid, version, agency, path, switchReicid, switchBusiness }) {
  const q = b && reicid ? `?reicid=${encodeURIComponent(reicid)}&b=${encodeURIComponent(b)}` : "";
  const nav = TOP.map(t => {
    const linkReicid = t === "Tenants" && switchReicid ? switchReicid : reicid;
    const linkBusiness = t === "Tenants" && switchBusiness ? switchBusiness : b;
    const linkQ = linkBusiness && linkReicid ? `?reicid=${encodeURIComponent(linkReicid)}&b=${encodeURIComponent(linkBusiness)}` : "";
    const href = (ROUTES[t] ?? `/area/${encodeURIComponent(t)}`) + linkQ;
    const kids = (CHILDREN[t] ?? []).map(([l, r]) => `<li><a href="${r}${q}">${l}</a></li>`).join("");
    return `<li><a href="${href}">${t}</a>${kids ? `<ul>${kids}</ul>` : ""}</li>`;
  }).join("");
  const marker = b ? `<span id="agency" data-agency>${agency}</span><span data-business>${b}</span>` : `<p id="no-business">Select a business to continue</p>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title} - REI Cloud</title>
<header>${marker}</header><nav aria-label="Main"><ul>${nav}</ul></nav>
<main data-path="${path}"><h1>${title}</h1>${b ? body : ""}</main>
<footer>2026 © Fictional mock · v ${version}</footer>
<script>
window.__effect = (name) => fetch('/__effect?n=' + encodeURIComponent(name), { method: 'POST' });
document.querySelectorAll('[data-effect]').forEach(el => el.addEventListener('click', () => window.__effect(el.dataset.effect)));
</script></html>`;
}

// Table widget: async load, Status (Active default), search on input event,
// optional filters, 5 rows per page.
function tableBody(key, { filters = "", statusDefault = "Active", search = true, extra = "", filterJs = "true", paid = [] } = {}) {
  const d = { ...data[key], rows: data[key].rows.map(r => paid.some(p => r[0].endsWith(" " + p)) ? [r[0], r[1], r[2], r[3], "0", "0.00"] : r) };
  return `${search ? `<label for="search">Search</label><input id="search" type="text">` : ""}
<label for="status">Status</label><select id="status"><option>Active</option><option>Inactive</option><option>Open</option><option>Closed</option><option>All</option></select>
${filters}${extra}
<table aria-label="Results"><thead><tr>${d.cols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody><tr class="loading"><td>Loading…</td></tr></tbody></table>
<button id="prev">Previous</button><button id="next">Next</button>
<script>
const ROWS = ${JSON.stringify(d.rows)}; let page = 0; let q = '';
document.getElementById('status').value = ${JSON.stringify(statusDefault)};
function visible() {
  const st = document.getElementById('status').value;
  return ROWS.filter(r => (st === 'All' || r[1] === st) && (!q || r[0].toLowerCase().includes(q.toLowerCase())) && (${filterJs}));
}
let tok = 0;
function render(delay) {
  const my = ++tok; const tb = document.querySelector('tbody'); tb.innerHTML = '<tr class="loading"><td>Loading…</td></tr>';
  setTimeout(() => { if (my !== tok) return;
    const v = visible(); const slice = v.slice(page * 5, page * 5 + 5);
    tb.innerHTML = slice.length ? slice.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') : '<tr class="empty"><td>No records found</td></tr>';
    document.getElementById('next').disabled = (page + 1) * 5 >= v.length;
    document.getElementById('prev').disabled = page === 0;
  }, delay);
}
${search ? `document.getElementById('search').addEventListener('input', e => { q = e.target.value; page = 0; render(150); });` : ""}
document.querySelectorAll('select, input:not(#search)').forEach(el => el.addEventListener('change', () => { page = 0; render(150); }));
document.querySelectorAll('input:not(#search)').forEach(el => el.addEventListener('input', () => { page = 0; render(150); }));
document.getElementById('next').onclick = () => { page++; render(100); };
document.getElementById('prev').onclick = () => { page--; render(100); };
render(350);
</script>`;
}

const PAGES = {
  "/dashboard": () => ["Dashboard", `<p>Fictional dashboard</p>`],
  "/customers/tenant": () => ["Tenants", tableBody("tenants")],
  "/customers/owner": () => ["Owners", tableBody("owners")],
  "/customers/property": () => ["Rentals", tableBody("rentals", { extra: `<label for="view">View</label><select id="view"><option>Default</option><option>lease expiry</option><option>smoke</option><option>pool</option></select>` })],
  "/customers/task": () => ["Tasks", tableBody("tasks", { search: false, statusDefault: "All", filters: `<label for="from">From</label><input id="from"><label for="to">To</label><input id="to">`, filterJs: "(!document.getElementById('from').value || r[2] >= document.getElementById('from').value) && (!document.getElementById('to').value || r[2] <= document.getElementById('to').value)" })],
  "/customers/arrears/": ({ paid = [] }) => ["Arrears", tableBody("tenants", { paid, search: true, statusDefault: "All", filters: `<label for="fromday">From day</label><input id="fromday"><label for="hidevac">Hide vacated tenants</label><select id="hidevac"><option>No</option><option>Yes</option></select><button data-effect="notice">Notice</button>`, filterJs: "Number(r[4]) >= Number(document.getElementById('fromday').value || 1) && !(document.getElementById('hidevac').value === 'Yes' && r[1] === 'Vacated')" })],
  "/customers/reconciliation/bankreconciliation": () => ["Bank reconciliation", tableBody("reconciliation", { search: false, statusDefault: "All", extra: `<label for="stmt">Statement balance</label><input id="stmt"><button data-effect="reconcile">Reconcile</button>` })],
  "/report/reportlist": () => ["Reports", `<label for="search">Search</label><input id="search" type="text">
<table aria-label="Results"><tbody><tr class="loading"><td>Loading…</td></tr></tbody></table>
<div id="modal" role="dialog" aria-label="Receipt Register" hidden>
 <h2>Receipt Register</h2>
 <input type="radio" name="RangeOfPeriod" id="r1"><label for="r1">Current Period</label>
 <input type="radio" name="RangeOfPeriod" id="r2"><label for="r2">Date Range</label>
 <label for="fd">From Date</label><input id="fd" disabled><label for="td">To Date</label><input id="td" disabled>
 <label for="output">Output</label><select id="output"><option>Export Only</option><option>Email Only</option><option>Export & Email</option></select>
 <button id="export">Export</button><button id="close">Close</button>
</div>
<script>
const REPORTS = ${JSON.stringify(data.reports.rows.map(r => r[0]))}; let q = ''; let tok = 0;
function list() { const my = ++tok; const tb = document.querySelector('table[aria-label=Results] tbody');
  tb.innerHTML = '<tr class="loading"><td>Loading…</td></tr>';
  setTimeout(() => { if (my !== tok) return; const v = REPORTS.filter(r => !q || r.toLowerCase().includes(q.toLowerCase()));
    tb.innerHTML = v.map(r => '<tr><td><a href="#" class="rep">' + r + '</a></td></tr>').join('');
    document.querySelectorAll('.rep').forEach(a => a.onclick = e => { e.preventDefault(); setTimeout(() => { document.getElementById('modal').hidden = false; }, 450); }); }, 200); }
document.getElementById('search').addEventListener('input', e => { q = e.target.value; list(); });
document.getElementById('r2').onchange = () => { fd.disabled = false; td.disabled = false; };
document.getElementById('r1').onchange = () => { fd.disabled = true; td.disabled = true; };
document.getElementById('close').onclick = () => { document.getElementById('modal').hidden = true; };
document.getElementById('export').onclick = () => {
  if (output.value !== 'Export Only') { window.__effect('send-report'); return; }
  const csv = window.__register(fd.value, td.value);
  const link = document.createElement('a'); link.download = 'fictional-receipt-register.csv';
  link.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  link.click(); };
window.__register = (f, t) => {
  const rows = (window.__receipts || []).filter(r => r[0] >= f && r[0] <= t);
  const total = rows.reduce((s, r) => s + Number(r[2]), 0).toFixed(2);
  const header = ['Scope', 'Value', '', ['reicid', new URL(location.href).searchParams.get('reicid'), ''].join(','), ['business', document.querySelector('[data-business]').textContent, ''].join(','), ['from', f, ''].join(','), ['to', t, ''].join(','), 'Date,Reference,Amount'];
  return [...header, ...rows.map(r => r.join(',')), ['Total', '', total].join(',')].join('\\n'); };
list();
</script>`],
  "/customers/importbanklink/index": ({ unknownUpload }) => ["Bulk receipting", `<label for="fmt">File Format</label><select id="fmt"><option value="">Select…</option><option>ABA</option><option>Custom CSV</option><option>Fictional Bank CSV</option></select>
<label for="file">Load File</label><input id="file" type="file">
<table aria-label="Results"><tbody></tbody></table>
<button data-effect="process-receipts">Process Receipts</button><button data-effect="receipt-all">Receipt All</button>
<script>
document.getElementById('file').addEventListener('change', async e => {
  fetch('/__effect?n=upload', { method: 'POST' });
  ${unknownUpload ? "setTimeout(() => location.reload(), 200); return;" : ""}
  const text = await e.target.files[0].text(); const tb = document.querySelector('tbody');
  tb.innerHTML = '<tr class="loading"><td>Loading…</td></tr>';
  setTimeout(() => { const rows = text.trim().split('\\n').slice(1).map(l => l.split(','));
    tb.innerHTML = rows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + (r[1].startsWith('FT') ? 'Matched' : 'Unmatched') + '</td></tr>').join(''); }, 400); });
</script>`],
};

// ── 3. recipe executor ───────────────────────────────────────────────────────
class Handover extends Error { constructor(reason) { super(reason); this.reason = reason; } }
class Blocked extends Error {}
const EXPECTED_VERSION = mapText.match(/mapped UI version \*\*([\d.]+)\*\*/)[1];

async function runRecipe(page, name, inputs, ctx) {
  const r = recipes[name];
  const fill = v => typeof v === "string" ? v.replace(/\{(\w+)\}/g, (_, k) => { if (!(k in inputs)) throw new Error(`${name}: missing input ${k}`); return inputs[k]; }) : v;
  const stops = new Set([...(r.stop_before ?? []), ...conseq]);
  ctx.trace.push(`run ${name}`);
  for (const step of r.steps) {
    const [verb, rawArg] = Object.entries(step)[0];
    const arg = Array.isArray(rawArg) ? rawArg.map(fill) : typeof rawArg === "object" ? Object.fromEntries(Object.entries(rawArg).map(([k, v]) => [k, fill(v)])) : fill(rawArg);
    ctx.trace.push(`${verb} ${JSON.stringify(arg)} rows=${ctx.result.rows.length}`);
    switch (verb) {
      case "check": await check(page, arg, ctx); break;
      case "nav": for (let i = 0; i < arg.length; i++) { const label = arg[i]; guardNav(arg.slice(0, i + 1), ctx); await page.getByRole("navigation").getByRole("link", { name: label, exact: true }).click(); await page.waitForLoadState(); } break;
      case "wait": if (arg === "modal") await page.getByRole("dialog").waitFor({ state: "visible" }); else await settle(page); break;
      case "select": await page.getByLabel(arg.field, { exact: true }).selectOption({ label: arg.option }); break;
      case "type": {
        const box = page.getByLabel(arg.field, { exact: true });
        await box.fill(""); await box.pressSequentially(String(arg.value)); await box.press("Tab"); // commit, see map §7
        if (arg.field === "Search") { await settle(page); const rows = await readTable(page); if (rows.length && !rows.some(row => row.join(" ").toLowerCase().includes(String(arg.value).toLowerCase()))) throw new Error("search-not-applied"); }
        break;
      }
      case "radio": await page.getByRole("radio", { name: arg, exact: true }).check(); break;
      case "click": guardClick(arg, stops, ctx); await page.locator("main").getByText(arg, { exact: true }).filter({ visible: true }).first().click(); break;
      case "read": if (arg === "controls") ctx.result.controls = await page.locator("main label").allInnerTexts(); else ctx.result.rows = await readTable(page); break;
      case "paginate": {
        const next = page.getByRole("button", { name: "Next", exact: true });
        // Pages must advance: a page identical to the previous one means the
        // click raced a re-render, and counting it would double rows.
        let prev = JSON.stringify(await readTable(page)); let guard = 0;
        while (await next.count() && await next.isEnabled()) {
          if (++guard > 200) throw new Error("pagination did not terminate");
          await next.click(); await settle(page);
          const rows = await readTable(page); const sig = JSON.stringify(rows);
          if (sig === prev) throw new Error("pagination-stalled");
          prev = sig; ctx.result.rows.push(...rows);
        }
        break;
      }
      case "upload": {
        if (!ctx.grant?.includes("upload")) throw new Handover("upload-not-granted");
        if (ctx.drift) throw new Handover("map-drift-blocks-upload");
        if (ctx.uploads >= 1) throw new Blocked("second upload refused; reconcile first");
        ctx.uploads++;
        await page.getByLabel(arg.field, { exact: true }).setInputFiles(arg.file);
        break;
      }
      case "download": {
        if (!ctx.grant?.includes("download")) throw new Handover("download-not-granted");
        if (ctx.drift) throw new Handover("map-drift-blocks-download");
        await check(page, "account", ctx);
        const outputMode = await page.getByLabel("Output", { exact: true }).inputValue();
        if (outputMode !== "Export Only") throw new Blocked("non-export-only report output refused");
        const [file] = await Promise.all([
          page.waitForEvent("download"),
          page.getByRole("button", { name: arg.label, exact: true }).click(),
        ]);
        const content = await readFile(await file.path(), "utf8");
        const lines = content.trim().split(/\r?\n/).map(line => line.split(","));
        const scope = Object.fromEntries(lines.slice(3, 7).map(([key, value]) => [key, value]));
        if (scope.reicid !== ctx.reicid || scope.business !== ctx.business) throw new Blocked("download-account-mismatch");
        if (scope.from !== inputs.date_from || scope.to !== inputs.date_to) throw new Blocked("download-period-mismatch");
        if (lines[7]?.join(",") !== "Date,Reference,Amount") throw new Blocked("download-format-unverified");
        ctx.result.rows = lines.slice(8);
        ctx.downloads++;
        await check(page, "account", ctx);
        break;
      }
      case "run": { // sub-recipe results are kept separately so they cannot mix
        const outer = ctx.result; ctx.result = { rows: [] };
        await runRecipe(page, arg, inputs, ctx);
        (ctx.sub ??= {})[arg] = ctx.result; ctx.result = outer; break;
      }
      default: throw new Error(`verb ${verb}`);
    }
  }
}
function guardClick(label, stops, ctx) {
  if (stops.has(label)) { ctx.blocked.push(label); throw new Blocked(`refused consequential ${label}`); }
  if (!safe.has(label)) { ctx.blocked.push(label); throw new Blocked(`refused non-read-safe ${label}`); }
}
function guardNav(path, ctx) {
  const joined = path.join(" › ");
  if (labels.forbidden_areas.includes(joined)) { ctx.blocked.push(joined); throw new Handover(`forbidden area ${joined}`); }
}
async function check(page, what, ctx) {
  const url = new URL(page.url());
  if (what === "origin" && url.origin !== ctx.origin) throw new Handover(`origin ${url.origin}`);
  if (what === "signin" && /Sign In Cancelled|Sign in/i.test(await page.title())) throw new Handover("sign-in");
  if (what === "account") {
    if (url.origin !== ctx.origin) throw new Handover(`origin ${url.origin}`);
    const reicid = url.searchParams.get("reicid");
    if (!reicid) throw new Handover("reicid-missing");
    if (reicid !== ctx.reicid) throw new Handover("reicid-changed");
    const business = await page.locator("[data-business]").textContent({ timeout: 1500 }).catch(() => null);
    if (!business) throw new Handover("business-code-missing");
    if (business.trim() !== ctx.business) throw new Handover("business-code-changed");
  }
  if (what === "version") {
    const v = (await page.locator("footer").textContent()).match(/v ([\d.]+)/)?.[1];
    if (v !== EXPECTED_VERSION) { ctx.drift = v; ctx.flags.push(`map-drift ${v}`); }
  }
}
async function settle(page) {
  await page.waitForFunction(() => { const t = document.querySelector('table[aria-label="Results"] tbody'); return t && t.children.length && !t.querySelector(".loading"); }, null, { timeout: 5000 });
}
async function readTable(page) {
  return page.locator('table[aria-label="Results"] tbody tr:not(.empty)').evaluateAll(trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim())));
}

// ── 4. scenarios ─────────────────────────────────────────────────────────────
const { chromium } = await import(modulePath);
const temp = await mkdtemp(join(tmpdir(), "rei-map-sim-"));
const browser = await chromium.launch({ executablePath: executable, headless: true });
const results = [];
const exercised = new Set();

async function scenario(id, opts, fn) {
  const state = { effects: [], ...opts };
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN && url.origin !== state.lookalike) return route.abort();
    if (url.pathname === "/__effect") { state.effects.push(url.searchParams.get("n")); return route.fulfill({ status: 204 }); }
    if (state.signin) return route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Sign In Cancelled - REI Cloud</title><p>You cancelled the previous sign-in or there was a sign-in issue (MFA).</p>` });
    const page = PAGES[url.pathname];
    const [title, body] = page ? page(state) : [decodeURIComponent(url.pathname.split("/").pop()), `<label for="search">Search</label><input id="search"><table aria-label="Results"><tbody><tr class="empty"><td>No records found</td></tr></tbody></table><button id="next" disabled>Next</button>`];
    route.fulfill({ contentType: "text/html", body: shell({ title, body, b: url.searchParams.get("b"), reicid: url.searchParams.get("reicid"), version: state.version ?? EXPECTED_VERSION, agency: state.agency ?? AGENCY, path: url.pathname, switchReicid: state.switchReicid, switchBusiness: state.switchBusiness }) });
  });
  const page = await context.newPage();
  if (state.receipts) await page.addInitScript(r => { window.__receipts = r; }, state.receipts);
  const ctx = { origin: ORIGIN, reicid: REICID, business: B, trace: [], result: { rows: [] }, blocked: [], flags: [], uploads: 0, downloads: 0, grant: state.grant };
  let outcome = "completed", error;
  const t0 = Date.now();
  try {
    const query = state.noContext ? "" : `?${state.noReicid ? "" : `reicid=${encodeURIComponent(REICID)}&`}${state.noBusiness ? "" : `b=${encodeURIComponent(B)}`}`;
    await page.goto(`${state.lookalike ?? ORIGIN}${state.start ?? "/dashboard"}${query}`);
    await fn(page, ctx, state);
  } catch (e) {
    if (e instanceof Handover) outcome = `handover:${e.reason}`; else if (e instanceof Blocked) outcome = `blocked:${e.message}`; else { outcome = "error"; error = e.message; }
  }
  const verdict = state.expect(outcome, ctx, state);
  if (process.env.SIM_DEBUG && verdict !== true) console.log(id, ctx.trace, error);
  if (state.shot) await page.screenshot({ path: join(temp, `${id}.png`), fullPage: true }).catch(() => {});
  await context.close();
  const writes = state.effects.filter(e => e !== "upload");
  const ok = verdict === true && writes.length === 0;
  results.push({ id, ok, outcome, ms: Date.now() - t0, rows: ctx.result.rows.length, downloads: ctx.downloads, flags: ctx.flags, blocked: ctx.blocked, effects: state.effects, ...(error ? { error } : {}), ...(verdict !== true ? { why: verdict } : {}) });
  if (state.covers) for (const c of state.covers) if (ok) exercised.add(c);
}
const is = (cond, why) => cond ? true : why;
const open = (page, ctx) => runRecipe(page, "open-session", {}, ctx);

// Happy paths — one per S recipe.
await scenario("open-session", { covers: ["open-session"], expect: o => is(o === "completed", o) }, open);
await scenario("find-record/one", { covers: ["find-record"], expect: (o, c) => is(o === "completed" && c.result.rows.length === 1 && c.result.rows[0][0] === "Fictional Tenant Delta", `${o} ${JSON.stringify(c.result.rows)}`) },
  async (p, c) => { await open(p, c); await runRecipe(p, "find-record", { list: "Tenants", query: "Delta" }, c); });
await scenario("find-record/many", { expect: (o, c) => is(o === "completed" && c.result.rows.length === 2, `many should surface 2 candidates, got ${c.result.rows.length}`) },
  async (p, c) => { await open(p, c); await runRecipe(p, "find-record", { list: "Tenants", query: "Bravo" }, c); });
await scenario("find-record/empty", { expect: (o, c) => is(o === "completed" && c.result.rows.length === 0, o) },
  async (p, c) => { await open(p, c); await runRecipe(p, "find-record", { list: "Owners", query: "Zulu" }, c); });
await scenario("arrears-review", { covers: ["arrears-review"], shot: true, expect: (o, c) => is(o === "completed" && c.result.rows.length === 6 && !c.result.rows.some(r => r[1] === "Vacated"), `${o} rows=${c.result.rows.length}`) },
  async (p, c) => { await open(p, c); await runRecipe(p, "arrears-review", { min_days: "1" }, c); });
const receipts = [["2026-09-25", "FT-BRAVO", "540.00"], ["2026-09-25", "FT-ECHO", "660.00"], ["2026-09-24", "FT-OLD", "100.00"]];
await scenario("receipt-register-approved-fictional-export", { covers: ["receipt-register"], grant: ["download"], receipts, shot: true, expect: (o, c) => is(o === "completed" && c.downloads === 1 && c.result.rows.at(-1)?.[2] === "1200.00", `${o} ${JSON.stringify(c.result.rows.at(-1))}`) },
  async (p, c) => { await open(p, c); await runRecipe(p, "receipt-register", { date_from: "2026-09-25", date_to: "2026-09-25" }, c); });
await scenario("receipt-register/no-download-approval", { receipts, expect: (o, c) => is(o === "handover:download-not-granted" && c.downloads === 0, o) },
  async (p, c) => { await open(p, c); await runRecipe(p, "receipt-register", { date_from: "2026-09-25", date_to: "2026-09-25" }, c); });
const csv = join(temp, "fictional-bank.csv");
await writeFile(csv, "date,reference,amount\n2026-09-25,FT-BRAVO,540.00\n2026-09-25,FT-ECHO,660.00\n2026-09-25,UNKNOWN REF,75.00\n");
const previewCheck = (exp) => (o, c) => { if (o !== "completed") return o; const total = c.result.rows.reduce((s, r) => s + Number(r[2]), 0).toFixed(2); const unmatched = c.result.rows.filter(r => r[3] === "Unmatched").length; c.flags.push(`preview rows=${c.result.rows.length} total=${total} unmatched=${unmatched}`); return exp(c.result.rows.length, total, unmatched); };
await scenario("bulk-receipting-preview/match", { covers: ["bulk-receipting-preview"], grant: ["upload"], shot: true, expect: previewCheck((n, t, u) => is(n === 3 && t === "1275.00" && u === 1, `n=${n} t=${t} u=${u}`)) },
  async (p, c) => { await open(p, c); await runRecipe(p, "bulk-receipting-preview", { bank_format: "Fictional Bank CSV", approved_file: csv, expected_rows: 3, expected_total: "1275.00" }, c); });
await scenario("bulk-receipting-preview/mismatch→hold", { grant: ["upload"], expect: previewCheck((n, t) => is(t !== "1200.00", "mismatch must be detected (expected 1200.00)")) },
  async (p, c) => { await open(p, c); await runRecipe(p, "bulk-receipting-preview", { bank_format: "Fictional Bank CSV", approved_file: csv, expected_rows: 2, expected_total: "1200.00" }, c); });
await scenario("bulk-receipting-preview/no-grant", { expect: o => is(o === "handover:upload-not-granted", o) },
  async (p, c) => { await open(p, c); await runRecipe(p, "bulk-receipting-preview", { bank_format: "Fictional Bank CSV", approved_file: csv, expected_rows: 3, expected_total: "1275.00" }, c); });
await scenario("bulk-receipting-preview/unknown→approved-export-no-retry", { grant: ["upload", "download"], unknownUpload: true, receipts, expect: (o, c, s) => is(o.startsWith("blocked:second upload") && s.effects.filter(e => e === "upload").length === 1 && c.downloads === 1 && c.trace.includes("run receipt-register"), `${o} uploads=${s.effects.filter(e => e === "upload").length} downloads=${c.downloads}`) },
  async (p, c) => {
    await open(p, c);
    try { await runRecipe(p, "bulk-receipting-preview", { bank_format: "Fictional Bank CSV", approved_file: csv, expected_rows: 3, expected_total: "1275.00" }, c); }
    catch (e) { c.flags.push(`unknown: ${e.message.split("\n")[0]}`); }
    await runRecipe(p, "receipt-register", { date_from: "2026-09-25", date_to: "2026-09-25" }, c); // on_unknown
    await runRecipe(p, "bulk-receipting-preview", { bank_format: "Fictional Bank CSV", approved_file: csv, expected_rows: 3, expected_total: "1275.00" }, c); // a naive retry must be refused
  });
await scenario("bulk-receipting-preview/unknown-no-export-approval→hold", { grant: ["upload"], unknownUpload: true, receipts, expect: (o, c, s) => is(o === "handover:download-not-granted" && s.effects.filter(e => e === "upload").length === 1 && c.downloads === 0, `${o} uploads=${s.effects.filter(e => e === "upload").length} downloads=${c.downloads}`) },
  async (p, c) => {
    await open(p, c);
    try { await runRecipe(p, "bulk-receipting-preview", { bank_format: "Fictional Bank CSV", approved_file: csv, expected_rows: 3, expected_total: "1275.00" }, c); }
    catch (e) { c.flags.push(`unknown: ${e.message.split("\n")[0]}`); }
    await runRecipe(p, "receipt-register", { date_from: "2026-09-25", date_to: "2026-09-25" }, c);
  });
// post-import-readback: Bud's success rule applied to the sub-recipe results.
const readbackVerdict = (c, total, tenantsCsv) => {
  const reg = c.sub?.["receipt-register"]?.rows ?? []; const arrears = c.sub?.["arrears-review"]?.rows ?? [];
  const regTotal = reg.find(r => r[0] === "Total")?.[2];
  const still = tenantsCsv.split(",").filter(t => arrears.some(r => r[0].endsWith(" " + t)));
  c.flags.push(`register=${regTotal} batch=${total} stillInArrears=${still.join("|") || "none"}`);
  return regTotal === total && still.length === 0 ? "confirmed" : "hold";
};
const pir = { date_from: "2026-09-25", date_to: "2026-09-25", min_days: "1", batch_total: "1200.00", batch_tenants: "Bravo,Echo" };
await scenario("post-import-readback/fictional-export-match", { covers: ["post-import-readback"], grant: ["download"], receipts, paid: ["Bravo", "Echo"], expect: (o, c) => is(o === "completed" && c.downloads === 1 && readbackVerdict(c, pir.batch_total, pir.batch_tenants) === "confirmed", `${o} ${c.flags}`) },
  async (p, c) => { await open(p, c); await runRecipe(p, "post-import-readback", pir, c); });
await scenario("post-import-readback/partial→hold", { grant: ["download"], receipts: receipts.slice(1), paid: ["Echo"], expect: (o, c) => is(o === "completed" && readbackVerdict(c, pir.batch_total, pir.batch_tenants) === "hold", `${o} ${c.flags}`) },
  async (p, c) => { await open(p, c); await runRecipe(p, "post-import-readback", pir, c); });
await scenario("post-import-readback/no-export-approval→hold", { receipts, expect: (o, c) => is(o === "handover:download-not-granted" && c.downloads === 0, o) },
  async (p, c) => { await open(p, c); await runRecipe(p, "post-import-readback", pir, c); });
await scenario("bank-reconciliation-read", { covers: ["bank-reconciliation-read"], expect: (o, c) => is(o === "completed" && c.result.rows.length === 2, o) },
  async (p, c) => { await open(p, c); await runRecipe(p, "bank-reconciliation-read", {}, c); });
await scenario("tasks-due", { covers: ["tasks-due"], expect: (o, c) => is(o === "completed" && c.result.rows.length === 2 && c.result.rows.every(r => r[1] === "Open"), `${o} ${c.result.rows.length}`) },
  async (p, c) => { await open(p, c); await runRecipe(p, "tasks-due", { date_from: "2026-09-25", date_to: "2026-09-30" }, c); });
await scenario("compliance-expiry", { covers: ["compliance-expiry"], expect: (o, c) => is(o === "completed" && c.result.rows.length === 7, `${o} ${c.result.rows.length}`) },
  async (p, c) => { await open(p, c); await runRecipe(p, "compliance-expiry", { view: "lease expiry" }, c); });
await scenario("unknown-screen-study", { covers: ["unknown-screen-study"], expect: (o, c) => is(o === "completed" && c.result.controls?.includes("Search"), `${o} ${c.result.controls}`) },
  async (p, c) => { await open(p, c); await runRecipe(p, "unknown-screen-study", { top_label: "Communities" }, c); });

// Guards and traps.
await scenario("trap/sign-in-cancelled", { signin: true, expect: o => is(o === "handover:sign-in", o) }, open);
await scenario("trap/reicid-missing-business-present", { noReicid: true, expect: o => is(o === "handover:reicid-missing", o) }, open);
await scenario("trap/business-missing-reicid-present", { noBusiness: true, expect: o => is(o === "handover:business-code-missing", o) }, open);
await scenario("trap/reicid-switch-business-constant", { switchReicid: "fictional-reicid-2", expect: o => is(o === "handover:reicid-changed", o) },
  async (p, c) => { await open(p, c); await runRecipe(p, "find-record", { list: "Tenants", query: "Delta" }, c); });
await scenario("trap/business-switch-reicid-constant", { switchBusiness: "FICT2", expect: o => is(o === "handover:business-code-changed", o) },
  async (p, c) => { await open(p, c); await runRecipe(p, "find-record", { list: "Tenants", query: "Delta" }, c); });
await scenario("trap/lookalike-origin", { lookalike: "https://rei-mock.fictional.test.evil.test", expect: o => is(o.startsWith("handover:origin"), o) }, open);
await scenario("trap/version-drift", { version: "26.1001.0", grant: ["upload"], expect: (o, c) => is(o === "handover:map-drift-blocks-upload" && c.flags.some(f => f.startsWith("map-drift")), o) },
  async (p, c) => { await open(p, c); await runRecipe(p, "bulk-receipting-preview", { bank_format: "Fictional Bank CSV", approved_file: csv, expected_rows: 3, expected_total: "1275.00" }, c); });
await scenario("trap/bare-route-loses-context", { noContext: true, start: "/customers/arrears/", expect: o => is(o === "handover:reicid-missing", o) },
  async (p, c) => { await check(p, "origin", c); await check(p, "account", c); });
await scenario("trap/search-without-input-event", { expect: o => is(o === "error", `naive assignment must be caught, got ${o}`) },
  async (p, c) => {
    await open(p, c); await p.getByRole("navigation").getByRole("link", { name: "Tenants", exact: true }).click(); await settle(p);
    await p.locator("#search").evaluate(el => { el.value = "Delta"; }); await p.keyboard.press("Enter"); await settle(p);
    const rows = await readTable(p); if (rows.some(r => !r[0].includes("Delta"))) throw new Error("search-not-applied (trap reproduced)");
  });
await scenario("trap/status-default-hides-inactive", { expect: (o, c) => is(o === "completed" && c.result.rows.length === 0, "Active default must hide Delta") },
  async (p, c) => { await open(p, c); await p.getByRole("navigation").getByRole("link", { name: "Tenants", exact: true }).click(); await settle(p); await p.getByLabel("Search", { exact: true }).pressSequentially("Delta"); await settle(p); c.result.rows = await readTable(p); });
await scenario("guard/consequential-click", { expect: (o, c) => is(o.startsWith("blocked:refused consequential Process Receipts"), o) },
  async (p, c) => { await open(p, c); guardClick("Process Receipts", new Set(conseq), c); });
await scenario("guard/notice-on-arrears", { expect: o => is(o.startsWith("blocked:refused consequential Notice"), o) },
  async (p, c) => { await open(p, c); await runRecipe(p, "arrears-review", { min_days: "1" }, c); guardClick("Notice", new Set(recipes["arrears-review"].stop_before), c); });
await scenario("guard/forbidden-settings", { expect: o => is(o === "handover:forbidden area Settings", o) },
  async (p, c) => { await open(p, c); guardNav(["Settings"], c); });

await browser.close();

// ── 5. tier honesty + receipt ────────────────────────────────────────────────
for (const [n, r] of Object.entries(recipes)) {
  if (r.tier.includes("S") && !exercised.has(n)) fail(`${n}: claims tier S but no passing scenario exercised it`);
}
const passed = results.filter(r => r.ok).length;
await mkdir(output, { recursive: true });
const { readdir, copyFile } = await import("node:fs/promises");
for (const f of await readdir(temp)) if (f.endsWith(".png")) await copyFile(join(temp, f), join(output, f));
await rm(temp, { recursive: true, force: true });
const receipt = {
  at: new Date().toISOString(),
  layer: "Map lint + recipe execution against a fictional local REI-style mock (Chromium, request interception, no network)",
  result: lint.length === 0 && passed === results.length ? "passed" : "failed",
  map: { path: process.env.REI_MAP_OVERRIDE ? "REI_MAP_OVERRIDE (mutation copy)" : MAP_DEFAULT, sha256: createHash("sha256").update(mapText).digest("hex"), screens: screens.length, recipes: Object.keys(recipes).length, uiVersion: EXPECTED_VERSION },
  lint: lint.length ? lint : "clean",
  scenarios: { passed, total: results.length, results },
  exercisedRecipes: [...exercised].sort(),
  limits: [
    "Fictional mock derived from the map itself; not REI Cloud and not evidence of REI behaviour",
    "Deterministic executor over the map's recipe grammar; no Hermes model turn, no RealBud broker, no ACP",
    "No live account, credentials, uploads to REI, receipting, payments, notices or sends",
    "The Export Only button and CSV file are fictional mock controls; actual REI report generation, file format and register contents remain unverified",
    "Unobserved (tier U) recipes and unconfirmed parent menus are not exercised",
    "Headless Chromium on macOS only; no Windows or packaged-app execution",
  ],
};
await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(48)} ${r.outcome}${r.why ? `  ← ${r.why}` : ""}${r.error ? `  (${r.error.split("\n")[0]})` : ""}  ${r.ms}ms`);
console.log(`\nlint: ${lint.length ? lint.join("\n  ") : "clean"}`);
console.log(`scenarios: ${passed}/${results.length}  → ${join(output, "receipt.json")}`);
assert.equal(receipt.result, "passed");
