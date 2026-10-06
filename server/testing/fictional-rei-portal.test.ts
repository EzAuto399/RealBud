// The FICTIONAL portal's own behaviour: its CSV reader, and the shape it copies
// from a read-only look at live REI (2 Oct 2026). Values are all fictional.
import { describe, expect, it } from "vitest";
import { FICTIONAL_BUSINESS, FICTIONAL_FILE_FORMATS, FICTIONAL_REI_ORIGIN, FICTIONAL_SUPPLIER_COLUMNS, FICTIONAL_TENANT_COLUMNS, fictionalCsv, fictionalReiPortal } from "./fictional-rei-portal.ts";

describe("fictional bank file parsing", () => {
  it("reads quoted cells with commas, escaped quotes and newlines, and refuses malformed quoting", () => {
    expect(fictionalCsv('﻿a,"b, c"\r\n"d ""e""","f\ng"\n,\n')).toEqual([["a", "b, c"], ['d "e"', "f\ng"]]);
    expect(fictionalCsv('a,"b\n')).toBeNull();
    expect(fictionalCsv('a,"b"x\n')).toBeNull();
    expect(fictionalCsv('a,b"c"\n')).toBeNull();
  });
});

describe("fictional portal shaped like live REI", () => {
  const observe = async (mock: ReturnType<typeof fictionalReiPortal>) => String((await mock.command(["observe"]) as { text: string }).text);
  it("signs in to an address with no reicid; the business is the top-bar code", async () => {
    const mock = fictionalReiPortal({ signedOut: true });
    await mock.command(["request-help"]);
    expect(new URL(mock.url()).searchParams.has("reicid")).toBe(false);
    expect(mock.url()).toBe(`${FICTIONAL_REI_ORIGIN}/customers/dashboard`);
    expect(await observe(mock)).toMatch(new RegExp(`list[\\s\\S]*button "${FICTIONAL_BUSINESS}"`));
    mock.setBusiness("FICT2");
    expect(await observe(mock)).toContain('button "FICT2"');
  });
  it("Bulk Receipting lists REI's File Formats with ANZ(csv file) selected", async () => {
    const mock = fictionalReiPortal();
    await mock.command(["navigate", `${FICTIONAL_REI_ORIGIN}/customers/importbanklink/index`]);
    const page = await observe(mock);
    expect(page).toContain('combobox "File Format" value="ANZ(csv file)"');
    expect(FICTIONAL_FILE_FORMATS).toHaveLength(22);
    for (const option of FICTIONAL_FILE_FORMATS) expect(page).toContain(`option ${JSON.stringify(option)}`);
    expect(page).toContain('button "Load File"');
  });
  it("the tenants grid shows \"No records to display\" first, then every row and a records footer with no pages", async () => {
    const mock = fictionalReiPortal();
    await mock.command(["navigate", `${FICTIONAL_REI_ORIGIN}/customers/tenant`]);
    const first = await observe(mock), filled = await observe(mock);
    expect(first).toContain('cell "No records to display"');
    expect(first).not.toMatch(/records · 0 row\(s\) selected/);
    expect(filled).toMatch(/StaticText "\d+ records · 0 row\(s\) selected"/);
    expect(filled).not.toContain('navigation "Pagination"');
  });
  it("Tenants renders its first rows until the grid's own content scrolls; Suppliers renders every row; both carry live REI's columns", async () => {
    const mock = fictionalReiPortal({ gridBlock: 3 });
    const rows = (page: string) => page.split("\n").filter(line => /^\s*row\b/.test(line)).length - 1; // less the header row
    await mock.command(["navigate", `${FICTIONAL_REI_ORIGIN}/customers/tenant`]);
    await observe(mock);
    let page = await observe(mock);
    for (const column of FICTIONAL_TENANT_COLUMNS) expect(page).toContain(`columnheader ${JSON.stringify(column)}`);
    expect(FICTIONAL_TENANT_COLUMNS).toEqual(expect.arrayContaining(["Reference", "Surname", "Firstname", "Property", "Rent", "BPay/Ref No.", "Email", "Mobile", "Home Phone", "Work Phone", "Fax"]));
    expect(page).toContain('StaticText "10 records · 0 row(s) selected"');
    expect(rows(page)).toBe(3);
    // Another container, or a list without one, is not there to scroll.
    await expect(mock.command(["scroll", "down", "100000", "--selector", ".e-content"])).rejects.toThrow(/No such element/);
    expect(rows(await observe(mock))).toBe(3);
    for (const expected of [6, 9, 10, 10]) {
      await mock.command(["scroll", "down", "100000", "--selector", ".e-gridcontent .e-content"]);
      page = await observe(mock);
      expect(rows(page)).toBe(expected);
    }
    expect(page).toContain('cell "FT-KILO"');
    // A new load renders the first rows again.
    await mock.command(["navigate", `${FICTIONAL_REI_ORIGIN}/customers/tenant`]); await observe(mock);
    expect(rows(await observe(mock))).toBe(3);
    await mock.command(["navigate", `${FICTIONAL_REI_ORIGIN}/customers/supplier`]); await observe(mock);
    page = await observe(mock);
    for (const column of FICTIONAL_SUPPLIER_COLUMNS) expect(page).toContain(`columnheader ${JSON.stringify(column)}`);
    expect(rows(page)).toBe(5);
    await mock.command(["navigate", `${FICTIONAL_REI_ORIGIN}/customers/arrears/`]);
    await expect(mock.command(["scroll", "down", "100000", "--selector", ".e-gridcontent .e-content"])).rejects.toThrow(/No such element/);
    expect(mock.effects).toEqual([]);
  });
  it("a short grid (directoryRows) still counts every row in its footer", async () => {
    const mock = fictionalReiPortal({ directoryRows: rows => rows.slice(1) });
    await mock.command(["navigate", `${FICTIONAL_REI_ORIGIN}/customers/supplier`]); await observe(mock);
    const page = await observe(mock);
    expect(page).toContain('StaticText "5 records · 0 row(s) selected"');
    expect(page).not.toContain('cell "FS-PLUMB"');
    expect(page).toContain('cell "FS-ELEC"');
  });
  it("Pending Transactions is a separate payments page whose Process controls Bud never presses", async () => {
    const mock = fictionalReiPortal();
    await mock.command(["navigate", `${FICTIONAL_REI_ORIGIN}/customers/transaction/pendingtransactions`]);
    await observe(mock);
    const page = await observe(mock);
    for (const label of ["Process Pending", "Delete Pending", "Process"]) expect(page).toContain(`button "${label}"`);
    expect(page).toContain('columnheader "Sufficient Funds"');
    expect(page).not.toContain('combobox "File Format"');
    expect(mock.effects).toEqual([]);
  });
});
