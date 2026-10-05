import { describe, expect, it } from "vitest";
import { nativeBrowserObservation } from "./native-browser-observation.ts";
import { browserAccountMarkerShown, browserReadOnlyAction, authorizeBrowserAction, classifyBrowserAction, isVomObservation, observationRefs, shownPath, withoutLinkDestinations, type BrowserPortalControls } from "./browser-authority.ts";
import { parseBrowserTaskGrant } from "../shared/browser-task.ts";
import { createHash } from "node:crypto";

const source = `- banner:
  - button "MOCK-OFFICE" [ref=e1]
- main:
  - heading "Invoices" [ref=e2] [level=1]
  - search:
    - textbox "Search" [ref=e3]: mock invoice
    - button "Search" [ref=e4]
  - region "Results":
    - table "Invoices":
      - row:
        - cell "MOCK-INV-1"
    - navigation "Pagination":
      - link "1" [ref=e5]
      - button "Next" [ref=e6]`;
const portal: BrowserPortalControls = { origin: "https://fictional.example", readSafe: ["Search"], menu: [], pagination: ["Next"], pager: { role: "navigation", name: "Pagination" }, consequential: ["Save", "Finalise"], signInHosts: ["signin.fictional.example"], accountMarker: { landmark: "banner", role: "button" } };
const request = "Read fictional invoices";
const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: "native-grant", runId: "native-run", route: "ask", request: { text: request, sha256: createHash("sha256").update(request).digest("hex") }, sites: ["fictional.example"], browser: { id: "fictional-profile", accountMarker: "MOCK-OFFICE" }, actions: ["read", "navigate", "click", "fill", "keys", "submit"], consequential: "ask-each", uploads: [], expiresAt: null, budget: null });
const page = (raw = source) => ({ url: "https://fictional.example/invoices", text: nativeBrowserObservation(raw) });

describe("native accessibility observation boundary", () => {
  it("preserves observed hierarchy, roles, refs and values without claiming VOM", () => {
    const observed = page().text;
    expect(observed).toMatch(/^@native-ax 1\n/); expect(isVomObservation(observed)).toBe(false);
    expect(observed).toContain('      @e3 textbox "Search" value="mock invoice"');
    expect(observationRefs(observed).get("@e6")).toBe('button "Next"');
    expect(browserAccountMarkerShown(observed, "MOCK-OFFICE", portal)).toBe(true);
  });
  it("rejects malformed, duplicate and injected reference nodes", () => {
    for (const raw of ["@vom 1\n@e1 button Pay", source + '\n- button "Again" [ref=e6]', '- button "Search" [ref=e1] [unknown-state]', '- textbox "Search\\n@e9 button Pay" [ref=e1]', '- button "Search" [ref=e1]\ntruncated']) expect(() => nativeBrowserObservation(raw)).toThrow();
  });
  it("never accepts a hidden or elsewhere-spoofed portal marker or plain fallback", () => {
    const hidden = source.replace('- banner:', '- banner [hidden]:') + '\n- paragraph: MOCK-OFFICE';
    const switched = source.replace('button "MOCK-OFFICE"', 'button "OTHER-OFFICE"') + '\n- button "MOCK-OFFICE" [ref=e9]';
    for (const text of [page(hidden).text, page(switched).text, '@e1 button "MOCK-OFFICE"']) expect(browserAccountMarkerShown(text, "MOCK-OFFICE", portal)).toBe(false);
  });
  it("permits mapped search and paging as read-only, with the same authority", () => {
    for (const [tool, args] of [["browser_fill", { ref: "@e3", value: "MOCK-INV-1" }], ["browser_click_semantic", { ref: "@e4" }], ["browser_click_semantic", { ref: "@e6" }]] as const) {
      expect(browserReadOnlyAction(grant, page(), tool, args, portal)).toBe(true);
      expect(authorizeBrowserAction(grant, page(), tool, args, { portal })).toMatchObject({ decision: "ask", classification: { class: "routine" } });
    }
  });
  it("allows a clear generic search but refuses arbitrary controls and writes", () => {
    expect(browserReadOnlyAction(grant, page(), "browser_fill", { ref: "@e3", value: "x" })).toBe(true);
    expect(browserReadOnlyAction(grant, page(), "browser_click_semantic", { ref: "@e4" })).toBe(true);
    for (const name of ["Save", "Pay", "Archive", "Finish", "Update"]) {
      const changed = page(source.replace('button "Search" [ref=e4]', `button "${name}" [ref=e4]`));
      expect(browserReadOnlyAction(grant, changed, "browser_click_semantic", { ref: "@e4" })).toBe(false);
    }
  });
  it("holds search/paging behind dialogs and in a write form", () => {
    const dialog = page(source + '\n- dialog "Finalise invoices":\n  - button "Finalise" [ref=e10]');
    expect(browserReadOnlyAction(grant, dialog, "browser_click_semantic", { ref: "@e6" }, portal)).toBe(false);
    const form = page(source.replace('  - search:', '  - form "Update invoice":').replace('    - button "Search" [ref=e4]', '    - button "Search" [ref=e4]\n    - button "Save" [ref=e9]'));
    expect(browserReadOnlyAction(grant, form, "browser_fill", { ref: "@e3", value: "x" }, portal)).toBe(false);
    const wizard = page(source.replace('navigation "Pagination"', 'group "Steps"'));
    expect(browserReadOnlyAction(grant, wizard, "browser_click_semantic", { ref: "@e6" }, portal)).toBe(false);
  });
  it("rejects mutation-shaped navigation while retaining search and pagination URLs", () => {
    for (const path of ["/records/123/update?status=settled", "/records/create", "/save", "/records?operation=submit", "/records/%75pdate", "/api/invoices", "/records?approve=true", "/records/delete/123"]) {
      expect(browserReadOnlyAction(grant, page(), "browser_navigate", { url: `https://fictional.example${path}` }, portal), path).toBe(false);
    }
    for (const path of ["/invoices", "/invoices?search=MOCK-001", "/invoices?page=2&status=open", "/invoices?filter=overdue", "/records/123/details"]) {
      expect(browserReadOnlyAction(grant, page(), "browser_navigate", { url: `https://fictional.example${path}` }, portal), path).toBe(true);
    }
  });
  it("accepts the engine's comma-separated flags and field values without inventing refs", () => {
    const text = nativeBrowserObservation('- main\n  - heading "Invoices" [level=1, ref=e1]\n  - combobox "Status" [expanded=false, ref=e2]: Open\n    - MenuListPopup\n      - option "Open" [selected, ref=e3]\n      - option "Paid" [ref=e4]');
    expect(text).toContain('@e1 heading "Invoices" [level=1]');
    expect(text).toContain('@e2 combobox "Status" [expanded=false] value="Open"');
    expect(observationRefs(text).size).toBe(4);
  });
  it("keeps each link's address on its own link for the authority, never in its label or in what the model reads", () => {
    const raw = `- banner:\n  - button "MOCK-OFFICE" [ref=e9]\n- main:\n  - link "Tenant 123" [ref=e1]:\n    - /url: /tenants/123/delete\n  - link "Tenant 124" [ref=e2]:\n    - img "Avatar"\n    - /url: "/tenants/124"\n  - button "Open" [ref=e3]:\n    - /url: /tenants/125\n  - link "Tenant 126" [ref=e4]\n  - list:\n    - listitem:\n      - link "Tenant 127" [ref=e5]\n  - /url: /stray`;
    const observed = page(raw);
    expect(observed.text).toContain('@e1 link "Tenant 123" url="/tenants/123/delete"');
    expect(observed.text).toContain('@e2 link "Tenant 124" url="/tenants/124"');
    expect(observed.text).toContain('@e3 button "Open"\n'); // only a link carries an address
    expect(observed.text).not.toMatch(/stray|Tenant 12[67]" url=/); // an address with no open link above it is dropped
    expect(observationRefs(observed.text).get("@e1")).toBe('link "Tenant 123"');
    expect(withoutLinkDestinations(observed.text)).not.toContain("url=");
    const click = (ref: string) => browserReadOnlyAction(grant, observed, "browser_click_semantic", { ref });
    // A harmless label does not make a deleting address read-only; a reading address of the same site does.
    expect(click("@e1")).toBe(false); expect(click("@e2")).toBe(true);
    for (const ref of ["@e3", "@e4", "@e5"]) expect(click(ref), ref).toBe(false);
  });
  it("never lets a pack's read-safe name override the consequential classifier", () => {
    // A damaged or careless map that names pay, sign, send, notice, delete and process as read-safe still asks for each.
    const names = ["Pay rent", "Sign lease", "Send statement", "Issue notice", "Delete tenant", "Process"];
    // "Process" is not in the global table: the pack's list (REI's has it) and the record-changing verbs both keep it out.
    const careless: BrowserPortalControls = { ...portal, readSafe: names, menu: names, consequential: [] };
    const name = (ref: string) => names[(Number(ref.slice(2)) - 1) % 10];
    const raw = `- banner:\n  - button "MOCK-OFFICE" [ref=e20]\n- main:\n${names.map((name, i) => `  - button "${name}" [ref=e${i + 1}]\n  - link "${name}" [ref=e${i + 11}]:\n    - /url: /invoices`).join("\n")}`;
    for (const ref of names.flatMap((_, i) => [`@e${i + 1}`, `@e${i + 11}`])) {
      expect(browserReadOnlyAction(grant, page(raw), "browser_click_semantic", { ref }, careless), ref).toBe(false);
      if (name(ref) !== "Process") expect(classifyBrowserAction(grant, page(raw), "browser_click_semantic", { ref }, careless).class, ref).toBe("consequential");
    }
    // Alone on a page (nothing else there that changes records), "Process" is still not read-safe.
    for (const control of ['button "Process" [ref=e1]', 'link "Process" [ref=e1]:\n    - /url: /invoices', 'button "Reconcile" [ref=e1]']) {
      const alone = page(`- banner:\n  - button "MOCK-OFFICE" [ref=e20]\n- main:\n  - ${control}`);
      expect(browserReadOnlyAction(grant, alone, "browser_click_semantic", { ref: "@e1" }, { ...careless, readSafe: ["Process", "Reconcile"] }), control).toBe(false);
    }
    for (const ref of ["@e6", "@e16"]) expect(classifyBrowserAction(grant, page(raw), "browser_click_semantic", { ref }, { ...careless, consequential: ["Process"] }).class, ref).toBe("unknown");
  });
});

// Security review of a9b55fa8: the address RealBud judges must be the one the browser follows. Each case below is a
// link with a harmless label; the engine's /url line is written as the engine writes it (a YAML-quoted value when needed).
describe("a link's address is judged where the browser will send it", () => {
  const link = (url: string) => page(`- banner:\n  - button "MOCK-OFFICE" [ref=e9]\n- main:\n  - link "Tenant 123" [ref=e1]:\n    - /url: ${url}`);
  const typed = (line: string) => ({ url: "https://fictional.example/invoices", text: `@native-ax 1\nrootwebarea\n  @e9 button "MOCK-OFFICE"\n  @e1 ${line}` });
  const click = (observed: { url: string; text: string }) => browserReadOnlyAction(grant, observed, "browser_click_semantic", { ref: "@e1" });
  const navigate = (path: string) => browserReadOnlyAction(grant, page(), "browser_navigate", { url: `https://fictional.example${path}` });

  it("follows a reading address of this site, resolved with WHATWG URL against the tab's address as the browser does", () => {
    for (const url of ["/tenants/123", "tenants/123", "https:tenants", "https://FICTIONAL.example/tenants", "https://ｆｉｃｔｉｏｎａｌ.example/tenants",
      "/reports/%2e%2e/tenants", String.raw`"/tenants/1\" url=\"/reports"`]) expect(click(link(url)), url).toBe(true);
  });

  it.each([
    ["a C0 control the browser strips, escaped by the engine as \\x0b (it lands on another site)", String.raw`"\x0b//evil.example/tenants"`],
    ["a C0 control before an absolute address to another site", String.raw`"\x01https://evil.example/"`],
    ["a double-encoded write word", "/tenants/1/%2564elete"],
    ["a triple-encoded write word", "/tenants/1/%252570rocess"],
    ["malformed percent-encoding", "/tenants/1/%E0%A4%A"],
    ["a write word with a letter the server case-folds (long s)", "/invoices/1/ſubmit"],
    ["a camelCase write route", "/Tenants/DeleteTenant?id=1"],
    ["a camelCase write query key", "/tenants?doArchive=1"],
    ["a capitalised query key and value", "/tenants/1?Action=Delete"],
    ["a matrix (path) parameter", "/tenants/1;action=delete"],
    ["an encoded slash and dot segments", "/reports/%2e%2e%2fdelete"],
    ["backslashes after the scheme", String.raw`https:\\evil.example/tenants`],
    ["a slash and backslash", String.raw`/\evil.example/tenants`],
    ["a scheme-relative address", "//evil.example/tenants"],
    ["userinfo before another host", "https://rei@evil.example/tenants"],
    ["userinfo on this host", "https://evil.example@fictional.example/tenants"],
    ["a trailing-dot host", "https://fictional.example./tenants"],
    ["a look-alike internationalised host", "https://fıctional.example/tenants"],
    ["a fragment", "/tenants/1#delete"],
    ["a tab inside the scheme", String.raw`"ht\ttps://fictional.example/tenants"`],
    ["a tab inside a write word", String.raw`"/tenants/de\tlete"`],
    ["an overlong address", `/reports/${"a".repeat(3000)}`],
    ["an address that becomes overlong once encoded", `/reports/${"é".repeat(400)}`],
    ["a quote that cannot start a second address", String.raw`"/tenants/1/delete\" url=\"/reports"`],
  ])("asks before a link with %s", (_, url) => expect(click(link(url))).toBe(false));

  it.each([
    ["two address attributes", 'link "Tenant 123" url="/tenants/1/delete" url="/reports"'],
    ["an escaped tab the browser strips", String.raw`link "Tenant 123" url="/tenants/de\tlete"`],
    ["a JSON unicode escape", 'link "Tenant 123" url="/tenants/\\u0064elete"'],
    ["an address that is not last on its line", 'link "Tenant 123" url="/reports" [hidden]'],
    ["an address inside the name", String.raw`link "Tenant url=\"/reports\""`],
  ])("reads the observation strictly: %s gives no shortcut", (_, line) => {
    expect(click(typed('link "Tenant 123" url="/reports"'))).toBe(true);
    expect(click(typed(line))).toBe(false);
    expect(withoutLinkDestinations(typed(line).text)).not.toMatch(/\surl="/);
  });

  it("browser_navigate is judged on the same reading of an address", () => {
    expect(navigate("/tenants/123")).toBe(true);
    for (const path of ["/tenants/1/%2564elete", "/Tenants/DeleteTenant", "/invoices/1/ſubmit", "/tenants/1/%E0%A4%A", "/tenants?doArchive=1"]) expect(navigate(path), path).toBe(false);
    expect(classifyBrowserAction(grant, page(), "browser_navigate", { url: "https://fictional.example/account/%256Cogout" }).class).toBe("consequential");
  });
});

// Security review of 8ce3e6c9: the model's text and the control labels dropped url="…" across the whole line while the
// authority read it after the name, so a link named `foo url=` showed its address (and its token) to the model, in its
// label, and from there on cards and in task evidence. Both now come from one reading (browser-authority.ts linkTail);
// whatever that reading does not accept as the one address is dropped, never left as text.
describe("a link's address never reaches the model or a label", () => {
  const SECRET = /SYNTHETIC-(?:TOKEN|SESSION)/;
  const href = "/tenants?token=SYNTHETIC-TOKEN&session=SYNTHETIC-SESSION";
  const typed = (line: string) => ({ url: "https://fictional.example/invoices", text: `@native-ax 1\nrootwebarea\n  @e9 button "MOCK-OFFICE"\n  @e1 ${line}` });
  const click = (line: string) => browserReadOnlyAction(grant, typed(line), "browser_click_semantic", { ref: "@e1" });
  const shown = (line: string) => withoutLinkDestinations(typed(line).text).split("\n").at(-1)!.slice("  @e1 ".length);
  const label = (line: string) => observationRefs(typed(line).text).get("@e1");

  it("keeps a link named like an attribute whole, and its address with the authority only", () => {
    const observed = page(`- banner:\n  - button "MOCK-OFFICE" [ref=e9]\n- main:\n  - link "foo url=" [ref=e1]:\n    - /url: ${href}`);
    expect(observed.text).toContain(`@e1 link "foo url=" url=${JSON.stringify(href)}`);
    expect(withoutLinkDestinations(observed.text)).not.toMatch(SECRET);
    expect(withoutLinkDestinations(observed.text).split("\n").at(-1)).toBe('    @e1 link "foo url="');
    expect(observationRefs(observed.text).get("@e1")).toBe('link "foo url="');
    expect(browserReadOnlyAction(grant, observed, "browser_click_semantic", { ref: "@e1" })).toBe(true); // the authority still reads it
  });

  it.each([
    ["an unbalanced quote", `link "Tenant" url="${href}`],
    ["two address attributes", `link "Tenant" url="/reports" url="${href}"`],
    ["an address before a flag", `link "Tenant" url="${href}" [hidden]`],
    ["escaped quotes", `link "Tenant" url=\\"${href}\\"`],
    ["an unquoted address", `link "Tenant" url=${href}`],
    ["an upper-case attribute", `link "Tenant" URL="${href}"`],
    ["another url-named attribute", `link "Tenant" data-url="${href}"`],
    ["an address inside a flag", `link "Tenant" [url=${href}]`],
    ["no space before the attribute", `link "Tenant"url="${href}"`],
    ["a name the engine escaped wrongly", `link "a\\" url="${href}"`],
    ["a bare address after the name", `link "Tenant" ${href}`],
  ])("drops %s entirely from the model's text and the label, and gives no shortcut", (_, line) => {
    expect(shown(line)).not.toMatch(SECRET); expect(label(line)).not.toMatch(SECRET);
    expect(line.startsWith(shown(line))).toBe(true);
    expect(click(line)).toBe(false);
  });

  it("the authority and the stripper agree on every name and tail", () => {
    const names = ["", ' "Tenant"', ' "foo url="', ' "a\\\\"', ' "x\\" url=\\"y"', ' "a\\" url="'];
    const tails = ["", " [hidden]", ' value="v"', ` url="${href}"`, ` [focused] url="${href}"`, ` url="${href}" url="/reports"`, ` url="/reports" url="${href}"`,
      ` url="${href}`, ` url=${href}`, ` url="${href}" [hidden]`, ` url="${href.replace("?", "\\u003f")}"`, ` URL="${href}"`, ` url="${href}" `, ` ${href}`, ` url="${href}"x`];
    let accepted = 0;
    for (const name of names) for (const tail of tails) {
      const line = `link${name}${tail}`; const kept = shown(line);
      expect(kept, line).not.toMatch(SECRET);
      expect(line.startsWith(kept), line).toBe(true); // only the end of a line is ever removed
      expect(label(line), line).toBe(kept); // the model and the label read the same text
      // The authority takes an address only when what was removed is exactly one url="…" attribute.
      if (click(line)) { accepted++; expect(line.slice(kept.length), line).toMatch(/^\s+url="(?:[^"\\]|\\.)*"\s*$/); }
    }
    expect(click(`link "Tenant" url="${href}"`)).toBe(true); expect(click(`link "foo url=" url="${href}"`)).toBe(true);
    expect(accepted).toBeGreaterThan(5);
  });

  it("cuts plain text at its first url=, and leaves other text alone", () => {
    expect(withoutLinkDestinations(`Welcome\nOpen url="${href}" now\nPage 2`)).toBe("Welcome\nOpen\nPage 2");
    expect(withoutLinkDestinations("Tenants (12)\nPage 2 of 3")).toBe("Tenants (12)\nPage 2 of 3");
  });

  it("keeps a page address for evidence and cards as its decoded path, with ids and tokens as :id and no query", () => {
    expect(shownPath("https://user:pass@fictional.example/tenants/0f8fad5b-d9cb-469f-a165-70867728950e/a%40b.example/deadbeefcafebabe/SYNTHETICb64Token123/x;jsessionid=AB12?token=SYNTHETIC-TOKEN#frag"))
      .toBe("/tenants/:id/:id/:id/:id/:id");
    expect(shownPath("https://fictional.example/customers/reconciliation/bankreconciliation")).toBe("/customers/reconciliation/bankreconciliation");
    expect(shownPath("https://fictional.example/Reports/Tenant%20List/123?page=2")).toBe("/Reports/Tenant List/123");
    expect(shownPath("https://fictional.example/r/%3Ftoken%3D1/%E0%A4%A/%2541")).toBe("/r/:id/:id/:id");
  });
});
