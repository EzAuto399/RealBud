import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { activatePaletteItem, CommandPalette, filterPaletteItems, movePaletteIndex, type PaletteItem } from "./CommandPalette";
import { addToast, MAX_TOASTS, ToastStack } from "./ToastStack";
import { MetricCard, meterPercent } from "./MetricCard";
import { EmptyState, Skeleton } from "./EmptyState";

const noop = () => {};
const items: PaletteItem[] = [
  { id: "a", group: "Actions", label: "Start morning money check", onSelect: noop },
  { id: "p", group: "Properties", label: "12 Rose St", hint: "Owner: Lee", onSelect: noop },
  { id: "t", group: "Desk tasks", label: "Chase rent for 12 Rose St", onSelect: noop },
  { id: "pay", group: "Desk tasks", kind: "pay", label: "Pay plumber invoice", onOpenCase: noop },
];

describe("CommandPalette", () => {
  it("filters on every word and groups in fixed order", () => {
    expect(filterPaletteItems(items, "rose").map(s => [s.group, s.items.map(i => i.id)])).toEqual([["Desk tasks", ["t"]], ["Properties", ["p"]]]);
    expect(filterPaletteItems(items, "rose lee").flatMap(s => s.items.map(i => i.id))).toEqual(["p"]);
    expect(filterPaletteItems(items, "zzz")).toEqual([]);
  });

  it("moves with arrows, wraps, and handles Home/End and empty lists", () => {
    expect(movePaletteIndex(0, "ArrowDown", 3)).toBe(1);
    expect(movePaletteIndex(2, "ArrowDown", 3)).toBe(0);
    expect(movePaletteIndex(0, "ArrowUp", 3)).toBe(2);
    expect(movePaletteIndex(1, "Home", 3)).toBe(0);
    expect(movePaletteIndex(0, "End", 3)).toBe(2);
    expect(movePaletteIndex(0, "ArrowDown", 0)).toBe(-1);
  });

  it("only opens the case for pay/sign/send/notice, never executes", () => {
    const onOpenCase = vi.fn(), onSelect = vi.fn();
    activatePaletteItem({ id: "s", group: "Actions", kind: "send", label: "Send owner letter", onOpenCase });
    expect(onOpenCase).toHaveBeenCalledOnce();
    activatePaletteItem({ id: "g", group: "Actions", label: "Open Schedule", onSelect });
    expect(onSelect).toHaveBeenCalledOnce();
    // @ts-expect-error guarded kinds have no execute callback
    const bad: PaletteItem = { id: "x", group: "Actions", kind: "pay", label: "Pay", onSelect };
    expect(bad).toBeTruthy();
  });

  it("renders the combobox/listbox pattern and marks guarded rows", () => {
    expect(renderToStaticMarkup(createElement(CommandPalette, { open: false, onClose: noop, items }))).toBe("");
    const html = renderToStaticMarkup(createElement(CommandPalette, { open: true, onClose: noop, items }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Find or do"');
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(4);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain("Open case to review");
    expect(html).not.toMatch(/Hermes|MCP|broker/i);
  });
});

describe("ToastStack", () => {
  it("keeps at most three, newest last, and dedupes by id", () => {
    let list = [1, 2, 3, 4].reduce((acc, n) => addToast(acc, { id: `t${n}`, message: `m${n}` }), [] as ReturnType<typeof addToast>);
    expect(list.map(t => t.id)).toEqual(["t2", "t3", "t4"]);
    list = addToast(list, { id: "t3", message: "again" });
    expect(list.map(t => t.id)).toEqual(["t2", "t4", "t3"]);
    expect(MAX_TOASTS).toBe(3);
  });

  it("is a polite live region with a named dismiss per toast", () => {
    const empty = renderToStaticMarkup(createElement(ToastStack, { toasts: [], onDismiss: noop }));
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain('role="status"');
    const toasts = [1, 2, 3, 4].map(n => ({ id: `t${n}`, message: `Saved ${n}` }));
    const html = renderToStaticMarkup(createElement(ToastStack, { toasts, onDismiss: noop }));
    expect(html.match(/aria-label="Dismiss: /g)).toHaveLength(3);
    expect(html).not.toContain("Saved 1");
    expect(html).toContain("motion-reduce:transition-none");
  });

  it("shows a toast's action as its own named button beside dismiss", () => {
    const html = renderToStaticMarkup(createElement(ToastStack, { toasts: [{ id: "bud", message: "Bud arranged Desk: hid Activity.", action: { label: "Undo", run: noop } }], onDismiss: noop }));
    expect(html).toMatch(/Bud arranged Desk: hid Activity\.<\/span><button type="button" class="pm-control[^"]*">Undo<\/button><button[^>]*aria-label="Dismiss: Bud arranged Desk: hid Activity\."/);
  });
});

describe("MetricCard", () => {
  it("clamps the meter and never reads full without a limit", () => {
    expect(meterPercent(50, 200)).toBe(25);
    expect(meterPercent(500, 200)).toBe(100);
    expect(meterPercent(-5, 200)).toBe(0);
    expect(meterPercent(10, 0)).toBe(0);
    expect(meterPercent(Number.NaN, 100)).toBe(0);
  });

  it("renders an over-budget meter clamped with spoken value", () => {
    const html = renderToStaticMarkup(createElement(MetricCard, { label: "Spend this month", value: "A$450", meter: { used: 450, limit: 400, valueText: "A$450 of A$400" } }));
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('aria-valuetext="A$450 of A$400"');
    expect(html).toContain("bg-danger");
  });
});

describe("EmptyState and Skeleton", () => {
  it("render calm, named states", () => {
    expect(renderToStaticMarkup(createElement(EmptyState, { title: "Nothing waiting", body: "Bud will add tasks here." }))).toContain("Nothing waiting");
    const html = renderToStaticMarkup(createElement(Skeleton, { lines: 2, label: "Loading Desk" }));
    expect(html).toContain('aria-label="Loading Desk"');
    expect(html).toContain("motion-reduce:animate-none");
  });
});
