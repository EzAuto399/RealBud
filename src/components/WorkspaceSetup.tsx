import { AskWorkspaceSheet } from "./AskWorkspaceSheet";
import { BudSetupCard } from "./BudSetupCard";
import { ConnectedAppsCard } from "./ConnectedAppsCard";
import { YouPage } from "./YouPage";
import type { WorkspaceSetupTarget } from "@/lib/workspace-setup";
import { useEffect, useState } from "react";
import { ActionNotice } from "./ActionNotice";

const labels: Record<WorkspaceSetupTarget, string> = { bud: "Set up Bud", apps: "Office connections", phone: "Phone connections", office: "Office details" };
export function WorkspaceSetup({ target, origin, onTarget, onClose, onSchedule, onAsk, error, onDismissError }: {
  target: WorkspaceSetupTarget; origin: string; onTarget: (target: WorkspaceSetupTarget) => void; onClose: () => void; onSchedule: () => void; onAsk: () => void;
  error?: string | null; onDismissError?: () => void;
}) {
  // Keep entered setup fields only for this open panel; never persist credentials.
  const [visited, setVisited] = useState<WorkspaceSetupTarget[]>([target]);
  useEffect(() => { setVisited(current => current.includes(target) ? current : [...current, target]); }, [target]);
  const sections = [...new Set([...visited, target])];
  return <AskWorkspaceSheet title={labels[target]} origin={origin} onClose={onClose}>
    <nav className="workspace-setup-nav" aria-label="Setup sections">
      {(["bud", "apps", "phone", "office"] as const).map(key => <button type="button" className="pm-control" key={key} aria-pressed={target === key} onClick={() => onTarget(key)}>{key === "bud" ? "Bud" : key === "apps" ? "Apps" : key === "phone" ? "Phone" : "Office"}</button>)}
    </nav>
    {error && <div className="px-4 pt-3"><ActionNotice message={error} onDismiss={onDismissError} /></div>}
    {sections.map(section => <div className="p-4" key={section} hidden={section !== target} inert={section !== target}>
      {section === "bud" ? <BudSetupCard id="workspace-bud" onShowAsk={onAsk} onSchedule={onSchedule} onServiceAdministration={onClose} /> : section === "apps" ? <ConnectedAppsCard onAsk={onAsk} /> : <YouPage section={section} />}
    </div>)}
  </AskWorkspaceSheet>;
}
