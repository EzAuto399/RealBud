/** A `<details>` used as a menu stays open until its summary is clicked again.
 * Close it on Escape (focus back on the summary) and on a press outside it.
 * Choosing an item closes it through `closeMenu`. Returns the cleanup. */

type MenuDetails = Pick<HTMLDetailsElement, "open" | "contains" | "querySelector">;
type ListenerTarget = Pick<Document, "addEventListener" | "removeEventListener">;

export function closeMenu(menu: MenuDetails | null, opts?: { focusSummary?: boolean }): void {
  if (!menu?.open) return;
  menu.open = false;
  if (opts?.focusSummary) menu.querySelector<HTMLElement>("summary")?.focus();
}

export function bindMenuDismiss(menu: MenuDetails, doc: ListenerTarget = document): () => void {
  const outside = (event: Event) => {
    if (menu.open && !menu.contains(event.target as Node | null)) closeMenu(menu);
  };
  const escape = (event: Event) => {
    if ((event as KeyboardEvent).key !== "Escape" || !menu.open) return;
    event.preventDefault();
    closeMenu(menu, { focusSummary: true });
  };
  doc.addEventListener("pointerdown", outside);
  doc.addEventListener("keydown", escape);
  return () => {
    doc.removeEventListener("pointerdown", outside);
    doc.removeEventListener("keydown", escape);
  };
}
