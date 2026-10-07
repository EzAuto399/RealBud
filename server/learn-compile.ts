// Watch and learn compiler (docs/decisions/2026-10-07-watch-and-learn.md):
// turns a validated recording (server/learn-recorder.ts) into draft steps in
// the portal recipe grammar that server/portal-recipe-runner.ts replays.
// Pure and deterministic. It never decides publish: the flags and stopBefore
// labels it returns are what staff review (learnBlockers in the contract).
import { LEARN_ROW_VALUE, learnInputKey, type LearnEvent, type LearnFlag, type LearnStep } from "../shared/learned-recipes.ts";
import type { PortalRecipePack } from "./portal-recipe.ts";
import { learnLabelRisky, learnLabelSupported } from "./learned-recipes.ts";

/** The roles the runner's `click` step resolves inside main or a dialog. */
const CLICK_ROLES = new Set(["button", "link", "tab", "menuitem"]);
/** The roles a menu path is made of (the runner's menu clicks are links in the navigation landmark). */
const MENU_ROLES = new Set(["link", "menuitem"]);
const ACTS_IN = new Set(["main", "dialog"]);
/** A click label that reads like a table row's data (a code, a name with digits, an amount) or a long cell, not a control. */
const ROW_VALUE = (label: string) => label.length > 60 || /[\d$]|\bAUD\b/.test(label);

export function compileLearnedSteps(events: LearnEvent[], pack: PortalRecipePack): { steps: LearnStep[]; inputs: string[]; stopBefore: string[]; flags: LearnFlag[] } {
  const steps: LearnStep[] = []; const flags: LearnFlag[] = []; const stopBefore: string[] = []; const inputs: string[] = [];
  const readSafe = new Set(pack.labels.readSafe); const consequential = new Set(pack.labels.consequential); const forbidden = new Set(pack.labels.forbiddenAreas);
  const pager = new Set([pack.pagination.next, pack.pagination.previous].filter((label): label is string => !!label));
  const portalOrigins = new Set([new URL(pack.origin).origin, ...pack.signIn.hosts.map(host => `https://${host}`)]);
  const keys = new Map<string, string>();
  const flag = (code: LearnFlag["code"], label: string) => { if (!flags.some(item => item.code === code && item.label === label)) flags.push({ code, label }); };
  const keyFor = (field: string): string => {
    const known = keys.get(field); if (known) return known;
    const base = learnInputKey(field); const taken = new Set(keys.values());
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 31 - String(n).length)}_${n}`;
    keys.set(field, key); inputs.push(key); return key;
  };

  let menu: string[] = [];   // menu clicks not yet flushed
  let tableWait = false;     // the last page showed a table and no step has followed yet
  let lastTable = false;     // the last page event's table
  let inDialog = false;      // a modal wait already precedes the current run of dialog steps
  let paged = false;         // the person paged through the current page's table
  let lastUrl: string | null = null;
  // A paged table page ends like REI's arrears-review: wait, read, then page through every page.
  const closePage = () => {
    if (!paged) return;
    paged = false;
    if (!lastTable) return;
    const last = steps.at(-1);
    if (!(last && "wait" in last && last.wait === "table")) steps.push({ wait: "table" });
    steps.push({ read: "table" }, { paginate: true });
    tableWait = false; lastTable = false;
  };
  const flushMenu = () => {
    if (!menu.length) return;
    const path = menu; menu = [];
    // Same comparison as the runner: every prefix joined with " › " against forbiddenAreas.
    for (let i = 1; i <= path.length; i++) {
      const area = path.slice(0, i).join(" › ");
      if (forbidden.has(area)) { flag("forbidden-area", area); return; }
    }
    // A menu path goes to another screen: the previous page's table is not waited for or read (unless it was paged).
    closePage();
    tableWait = false; lastTable = false; inDialog = false;
    steps.push({ nav: path });
  };
  const push = (step: LearnStep, landmark: string) => {
    if (tableWait) { steps.push({ wait: "table" }); tableWait = false; }
    if (landmark === "dialog" && !inDialog) { steps.push({ wait: "modal" }); inDialog = true; }
    steps.push(step);
  };

  for (const event of events) {
    if (event.kind === "page") {
      flushMenu();
      let origin: string | null = null;
      try { origin = new URL(event.url).origin; } catch { /* flagged below */ }
      if (!origin || !portalOrigins.has(origin)) flag("off-portal", origin ?? event.url);
      // A pager that reloads the same listing (the recorder drops the query) stays on that page.
      if (event.url !== lastUrl) closePage();
      lastUrl = event.url;
      tableWait = event.table; lastTable = event.table; inDialog = false;
      continue;
    }
    // A pager click (Next, Previous or a page number) in any landmark is no step: the table is paged at replay.
    if (event.kind === "click" && (pager.has(event.name) || /^\d{1,4}$/.test(event.name))) { paged = true; continue; }
    // A click on a row's data adds no step and its text is never kept, not even as a flag label. Menu links, pack
    // labels and risky controls (Form 9, Pay $10) keep their own handling, so Bud still stops before them.
    // A row value with characters Bud can't check (a name with an accent) is still row data, never kept.
    if (event.kind === "click" && ROW_VALUE(event.name) && !(event.landmark === "navigation" && MENU_ROLES.has(event.role)) &&
      !readSafe.has(event.name) && !consequential.has(event.name) && (!learnLabelSupported(event.name) || !learnLabelRisky(pack.labels, event.name))) { flushMenu(); flag("unsupported", LEARN_ROW_VALUE); continue; }
    // The runner fills {word} placeholders in labels too, so a label with braces can't replay.
    if (Object.values(event).some(value => typeof value === "string" && /[{}]/.test(value))) { flushMenu(); flag("unsupported", "name" in event ? event.name : "field" in event ? event.field : event.kind); continue; }
    // A label Bud can't check against its risk words ("Ѕаvе" in Cyrillic) could be anything: nothing after it is compiled.
    const named = "name" in event ? event.name : "field" in event ? event.field : "";
    if (named && !learnLabelSupported(named)) { flushMenu(); flag("unsupported", named); return finish(); }
    if (event.kind === "click" && event.landmark === "navigation" && MENU_ROLES.has(event.role)) { menu.push(event.name); continue; }
    flushMenu();
    if (event.landmark !== "dialog") inDialog = false;
    if (event.kind === "secret") continue; // sign-in is the runner's handover, never a step
    if (event.kind === "unsupported") { flag("unsupported", event.name || event.control); continue; }
    const label = event.kind === "click" || event.kind === "radio" ? event.name : event.field;
    if (!ACTS_IN.has(event.landmark)) { flag("outside-main", label); continue; }
    switch (event.kind) {
      case "click":
        // Bud stops before a consequential control: nothing after it is compiled.
        if (consequential.has(event.name)) { stopBefore.push(event.name); return finish(); }
        // Risky but not a shipped consequential label (Save changes, OK, Confirm, Sign in): stopBefore
        // must stay within the pack's list, so the recipe ends here and review sees why.
        if (learnLabelRisky(pack.labels, event.name)) { flag("unsupported", event.name); return finish(); }
        if (!CLICK_ROLES.has(event.role)) { flag("unsupported", event.name); break; }
        push({ click: event.name }, event.landmark);
        if (!readSafe.has(event.name)) flag("needs-confirm", event.name);
        break;
      case "type": {
        const last = steps.at(-1);
        if (last && "type" in last && last.type.field === event.field) break; // consecutive typing in one field
        push({ type: { field: event.field, value: `{${keyFor(event.field)}}` } }, event.landmark);
        break;
      }
      // The chosen option is a value too: it becomes an input (review can pin a harmless one such as "All").
      case "select": {
        const last = steps.at(-1);
        if (last && "select" in last && last.select.field === event.field) break; // changed again in one field
        push({ select: { field: event.field, option: `{${keyFor(event.field)}}` } }, event.landmark);
        break;
      }
      case "radio": push({ radio: event.name }, event.landmark); break;
    }
  }
  return finish();

  function finish() {
    flushMenu();
    if (paged && lastTable) closePage();
    else if (lastTable) {
      const last = steps.at(-1);
      if (!(last && "wait" in last && last.wait === "table")) steps.push({ wait: "table" });
      steps.push({ read: "table" });
    } else steps.push({ read: "controls" });
    return { steps, inputs, stopBefore, flags };
  }
}
