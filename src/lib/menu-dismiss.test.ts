import { describe, expect, it, vi } from "vitest";
import { bindMenuDismiss, closeMenu } from "./menu-dismiss";

function fixture() {
  const inside = { id: "inside" };
  const summary = { focus: vi.fn() };
  const menu = {
    open: true,
    contains: (node: unknown) => node === inside,
    querySelector: vi.fn(() => summary),
  };
  const listeners = new Map<string, (event: Event) => void>();
  const doc = {
    addEventListener: vi.fn((type: string, fn: (event: Event) => void) => listeners.set(type, fn)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
  };
  const cleanup = bindMenuDismiss(menu as never, doc as never);
  const fire = (type: string, event: Record<string, unknown>) => listeners.get(type)?.({ preventDefault: vi.fn(), ...event } as never);
  return { menu, summary, inside, listeners, fire, cleanup };
}

describe("menu dismissal", () => {
  it("closes on a press outside and stays open for a press inside", () => {
    const { menu, inside, fire } = fixture();
    fire("pointerdown", { target: inside });
    expect(menu.open).toBe(true);
    fire("pointerdown", { target: { id: "header" } });
    expect(menu.open).toBe(false);
  });

  it("closes on Escape and returns focus to the summary; other keys do nothing", () => {
    const { menu, summary, fire } = fixture();
    fire("keydown", { key: "Tab" });
    expect(menu.open).toBe(true);
    fire("keydown", { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(summary.focus).toHaveBeenCalledOnce();
    fire("keydown", { key: "Escape" });
    expect(summary.focus).toHaveBeenCalledOnce();
  });

  it("closes when an item is chosen, and unbinds on cleanup", () => {
    const { menu, listeners, cleanup } = fixture();
    closeMenu(menu as never);
    expect(menu.open).toBe(false);
    closeMenu(null);
    cleanup();
    expect(listeners.size).toBe(0);
  });
});
