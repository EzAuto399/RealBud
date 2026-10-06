import { useEffect, useMemo, useState } from "react";
import { CommandPalette, type PaletteItem } from "@/components/ui/CommandPalette";
import { useStore } from "@/state/store";
import { useWorkspaceTabs } from "@/lib/workspace-tabs";
import { openDeskProperty, openDeskTasks } from "@/lib/desk-view-state";

/** ⌘K / Ctrl+K "Find or do": places, properties and saved views. It only opens
 *  things; anything that pays, signs, sends or issues stays on its case. */
export function ShellPalette() {
  const { state, dispatch } = useStore();
  const tabs = useWorkspaceTabs();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") { event.preventDefault(); setOpen(true); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const items = useMemo<PaletteItem[]>(() => [
    { id: "go-desk", group: "Actions", label: "Open Desk tasks", onSelect: () => { dispatch({ type: "showDesk" }); openDeskTasks(); } },
    { id: "go-work", group: "Actions", label: "Ask Bud in Work", onSelect: () => dispatch({ type: "showAsk" }) },
    { id: "go-schedule", group: "Actions", label: "Open Schedule", onSelect: () => dispatch({ type: "showRoutines" }) },
    { id: "go-workspace", group: "Actions", label: "Open Workspace", onSelect: () => dispatch({ type: "showYou" }) },
    ...(state.desk?.properties ?? []).map((property): PaletteItem => ({
      id: `property-${property.id}`, group: "Properties", label: property.address,
      hint: property.tenantName || undefined, keywords: property.propertyCode,
      onSelect: () => { dispatch({ type: "showDesk" }); openDeskProperty(property.address); },
    })),
    ...(tabs.data?.state?.tabs ?? []).filter(tab => tab.visible).map((tab): PaletteItem => ({
      id: `view-${tab.id}`, group: "Saved views", label: tab.label, onSelect: () => dispatch({ type: "showWorkspaceTab", id: tab.id }),
    })),
  ], [dispatch, state.desk?.properties, tabs.data?.state?.tabs]);
  return <CommandPalette open={open} onClose={() => setOpen(false)} items={items} />;
}
