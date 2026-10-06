import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

import { accountLabel, BankReferenceReview, coverageLine, FirstPassReview, parseFirstPass, parseW1Status, W1RunStrip, W1Setup, w1View, type FirstPass, type W1Status } from "./BankReferenceReview";

// FICTIONAL run states; no bank, account or REI data.
const base: W1Status = { settings: { account: "acct_Fictional1", rei: { urlValue: "fictional-reicid-1", marker: "FICT1" }, bankFormat: "Fictional Bank CSV", revision: 1 },
  run: null, working: false, ask: null, note: null, readback: null, handoff: null };
const run = (patch: Partial<NonNullable<W1Status["run"]>>): W1Status => ({ ...base, run: { id: "w1run_fictional", revision: 3, step: "review", attention: null, outcome: null,
  fetch: { from: "2026-09-30", to: "2026-10-02", batchId: "bank:fictional", transactionIds: ["txn_a", "txn_b"] }, handoff: null, upload: null, confirm: null, ...patch } });
const strip = (status: W1Status, reviewReady = false) => renderToStaticMarkup(createElement(W1RunStrip, { status, reviewReady, busy: false, onAction: () => {} }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);

describe("W1 run strip", () => {
  it("shows every step, marks the current one and offers one primary action", () => {
    const html = strip(run({ step: "sign_in", attention: { reason: "sign_in", message: "Sign in to REI in the work browser, then continue." } }));
    expect(html).toContain('aria-label="Bank import steps"');
    expect(html).toMatch(/aria-current="step"[^>]*>3\. Sign in to REI/);
    expect(html).toContain("Waiting for you to sign in to REI");
    expect(buttons(html)).toEqual(["Continue"]);
  });

  it("asks before the review is saved, then continues", () => {
    expect(buttons(strip(run({})))).toEqual(["Open pulled transactions"]);
    expect(strip(run({}))).toContain("2 transactions from 30 Sept 2026 to 2 Oct 2026");
    expect(strip(run({ fetch: { from: "2026-09-30", to: "2026-10-02", batchId: "bank:fictional", transactionIds: ["txn_a"] } }))).toContain("1 transaction from 30 Sept 2026");
    expect(buttons(strip(run({}), true))).toEqual(["Continue"]);
  });

  it("hands posting to the person, lists preview differences and checks a previous upload first", () => {
    const ready = strip(run({ step: "handoff", handoff: { at: "2026-10-02T00:00:00.000Z" } }));
    expect(ready).toContain("Preview matches · Ready for you to process in REI");
    expect(buttons(ready)).toEqual(["I&#x27;ve processed it in REI", "I&#x27;m not sure it went through"]);
    const mismatch = strip(run({ step: "handoff", attention: { reason: "preview_mismatch", message: "x" }, upload: { preview: { warnings: ["FT-BRAVO 540.00: REI shows a different amount."] } } }));
    expect(mismatch).toContain('aria-label="Differences in REI&#x27;s preview"');
    expect(mismatch).toContain("FT-BRAVO 540.00: REI shows a different amount.");
    expect(buttons(mismatch)).toEqual(["Close this import"]);
    expect(strip(run({ step: "check_outcome" }))).toContain("Check previous upload first");
    expect(buttons(strip(run({ step: "check_outcome", attention: { reason: "nothing_found", message: "x" } })))).toEqual(["Upload again", "Close this import"]);
  });

  it("puts the person's approval first, shows readback results and says when the import is done", () => {
    const asking = strip({ ...run({ step: "upload" }), working: true, ask: { requestId: "recipe-1", tool: "browser_upload", summary: "Upload REI-reviewed-abc.csv" } });
    expect(asking).toContain("Allow Bud to upload the reviewed file to REI?");
    expect(buttons(asking)).toEqual(["Allow", "Don&#x27;t allow", "Stop"]);
    const read = strip({ ...run({ step: "readback", attention: { reason: "pending_rows", message: "Some payments are still pending in REI." } }), readback: { accepted: 1, rejected: 0, pending: 1, warnings: [] } });
    expect(read).toContain("REI&#x27;s result: 1 accepted · 0 rejected · 1 still pending");
    expect(w1View(run({ step: "done", outcome: "imported", confirm: { coveredThrough: "2026-10-02" } }), false)).toMatchObject({ detail: "Last import confirmed. Covered to 2 Oct 2026.", primary: ["start", "Start bank import"] });
  });

  it("offers Stop whenever Bud works or waits in REI, and not when nothing runs", () => {
    const download = strip({ ...run({ step: "readback" }), working: true, ask: { requestId: "recipe-2", tool: "browser_download", summary: "Download the receipt list" } });
    expect(download).toContain("Allow Bud to download REI&#x27;s receipt list to check the result?");
    expect(buttons(download)).toEqual(["Allow", "Don&#x27;t allow", "Stop"]);
    expect(buttons(strip({ ...run({ step: "upload" }), working: true }))).toEqual(["Stop"]);
    expect(buttons(strip({ ...run({ step: "sign_in" }), working: true, signIn: "thread-fictional" }))).toEqual(["Stop"]);
    expect(buttons(strip(run({ step: "readback" })))).not.toContain("Stop");
    expect(buttons(strip(base))).toEqual(["Start bank import"]);
  });

  it("refuses a malformed status and formats the masked account and coverage", () => {
    expect(() => parseW1Status({ ...base, run: { id: "x", revision: 1, step: "posted" } })).toThrow(/could not be checked/);
    expect(parseW1Status(base)).toEqual(base);
    expect(accountLabel({ id: "acct_x", name: "Fictional Trust", institution: "Fictional Bank", numberMasked: "····4321", category: "banking" })).toBe("Fictional Bank · Fictional Trust ····4321");
    expect(coverageLine({ coveredThrough: "2026-10-02", nextFrom: "2026-09-29" })).toBe("Covered to 2 Oct 2026 · next pull from 29 Sept 2026");
    expect(coverageLine({ coveredThrough: null, nextFrom: "2026-09-30" })).toBe("Nothing imported yet · first pull from 30 Sept 2026");
  });
});

// FICTIONAL first-pass rows; no bank or customer data.
const pass: FirstPass = { layout: "anz-export", summary: { rows: 4, matched: 1, invoice: 1, exception: 1, notRent: 1 },
  rows: [], exceptions: [
    { rowId: "r2", date: "03/09/2026", amount: "300.00", payer: "Jane C.", class: "exception", disposition: "hold", propertyId: "P-A42", reason: "Amount differs from the expected rent (late, overpaid or shared?): expected $480.00 per week, paid $300.00.", suggestion: "P-A42 (A42)" },
    { rowId: "r3", date: "04/09/2026", amount: "184.20", payer: "Acme F.", class: "invoice", disposition: "hold", propertyId: "Shop ACME", reason: "Invoice payment: check the invoice number.", suggestion: "Shop ACME (ACME) · ACME WATER" },
    { rowId: "r4", date: "06/09/2026", amount: "-1250.00", payer: "", class: "not-rent", disposition: "exclude", reason: "Outgoing payment: not tenant rent." },
  ] };
pass.rows = [{ rowId: "r1", date: "01/09/2026", amount: "550.00", payer: "Alex F.", class: "matched", disposition: "import", propertyId: "P-A2218", reason: "Reference matched A2218." }, ...pass.exceptions];

describe("first-pass review", () => {
  const render = (decisions = {}) => renderToStaticMarkup(createElement(FirstPassReview, { pass, decisions, busy: false, onUseAll: () => {}, onDecide: () => {} }));
  it("shows the counts, then exceptions first with their suggestion and Import/Hold/Exclude", () => {
    const html = render();
    expect(html).toContain("1 matched · 1 invoice · 1 exception · 1 not rent");
    expect(html).toContain('aria-label="First-pass exceptions"');
    expect(html.indexOf("Amount differs")).toBeLessThan(html.indexOf("Invoice payment"));
    expect(html).toContain("Suggestion: P-A42 (A42)");
    expect(html).toContain("Jane C.");
    expect(buttons(html)).toEqual(["Use first-pass suggestions", "Import for P-A42", "Hold", "Exclude", "Import for Shop ACME", "Hold", "Exclude", "Import", "Hold", "Exclude"]);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/);
  });
  it("marks the chosen decision", () => {
    expect(render({ r2: { rowId: "r2", action: "keep", reason: "x" } })).toMatch(/aria-pressed="true"[^>]*>Hold</);
  });
  it("rejects a malformed reply and an imported exception", () => {
    expect(parseFirstPass(undefined)).toBeNull();
    expect(parseFirstPass(pass)).toBe(pass);
    expect(() => parseFirstPass({ ...pass, summary: {} })).toThrow(/could not be checked/);
    expect(() => parseFirstPass({ ...pass, exceptions: [{ ...pass.exceptions[0], disposition: "import" }] })).toThrow(/could not be checked/);
  });
});

describe("W1 settings form", () => {
  it("asks for the REI business code, keeps the account id optional and prefills ANZ(csv file)", () => {
    const html = renderToStaticMarkup(createElement(W1Setup, { accounts: [{ id: "acct_Fictional1", name: "Fictional Trust", institution: "Fictional Bank", numberMasked: null, category: "banking" }],
      error: "", onLoad: () => {}, onSaved: () => {} }));
    expect(html).toContain('aria-label="REI business code (top bar, e.g. YOUR-OFFICE)"');
    expect(html).toContain('aria-label="REI account id (optional)"');
    expect(html).not.toContain("REI account code");
    expect(html).toMatch(/aria-label="REI file format"[^>]*value="ANZ\(csv file\)"/);
    // Nothing saves until the business code is filled in.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save bank import settings/);
  });

  it("reads saved settings with or without an REI account id", () => {
    const { urlValue: _, ...marker } = base.settings!.rei;
    expect(parseW1Status({ ...base, settings: { ...base.settings, rei: marker } }).settings!.rei).toEqual({ marker: "FICT1" });
    expect(() => parseW1Status({ ...base, settings: { ...base.settings, rei: { urlValue: 7, marker: "FICT1" } } })).toThrow(/could not be checked/);
  });
});

describe("prepare a new export", () => {
  it("offers an optional REI tenant list beside the property directory", () => {
    const html = renderToStaticMarkup(createElement(BankReferenceReview));
    expect(html).toContain("REI tenant list (optional)");
    expect(html).toContain("Export Tenants from REI to put each tenant&#x27;s REI reference in the last column");
    expect(html).toMatch(/aria-label="Property reference directory"/);
  });
});
