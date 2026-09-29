/** The product Bud's saved model selection versus the worker profile.
 *
 * Every managed-profile write (a model choice, reconciling an upgraded
 * profile at boot, apply-pack or repair) must rebind Bud to the profile's
 * current model, or the managed turn gate below refuses every turn. */
export interface ProductSelection { instanceId: string; model: string }

/** The managed turn gate: Bud's saved selection must be the approved one. */
export function productSelectionApproved(selection: ProductSelection, approved: ProductSelection | undefined): boolean {
  return Boolean(approved && selection.instanceId === approved.instanceId &&
    (selection.model === approved.model || selection.model === "default"));
}

/** Rebind the product Bud onto the approved selection. `adoptBud` is
 * idempotent: an unchanged selection writes nothing and keeps its cursors. */
export function rebindProductBud<T>(store: { adoptBud(selection?: ProductSelection): T | null }, approved: ProductSelection | undefined): T | null {
  return approved ? store.adoptBud(approved) : null;
}
