import { AskWorkspaceSheet } from "./AskWorkspaceSheet";
import { BudSetupCard } from "./BudSetupCard";
import { ConnectedAppsCard } from "./ConnectedAppsCard";
import { YouPage } from "./YouPage";
import type { WorkspaceSetupTarget } from "@/lib/workspace-setup";
import { useEffect, useState } from "react";
import { ActionNotice } from "./ActionNotice";
import { BrowserCard } from "./you/BrowserCard";
import { Building2, Bot, Plug, Smartphone } from "lucide-react";

const labels: Record<WorkspaceSetupTarget, string> = { bud: "Bud status", apps: "Office connections", phone: "Phone connections", office: "Office details" };
const sectionsInfo = [
  { key: "bud", label: "Bud", detail: "Readiness & model", icon: Bot },
  { key: "apps", label: "Apps", detail: "Accounts & websites", icon: Plug },
  { key: "phone", label: "Phone", detail: "Continue on the go", icon: Smartphone },
  { key: "office", label: "Office", detail: "People & preferences", icon: Building2 },
] as const;
export function WorkspaceSetup({ target, origin, onTarget, onClose, onSchedule, onAsk, onServiceAdministration, error, onDismissError }: {
  target: WorkspaceSetupTarget; origin: string; onTarget: (target: WorkspaceSetupTarget) => void; onClose: () => void; onSchedule: () => void; onAsk: () => void;
  error?: string | null; onDismissError?: () => void;
  onServiceAdministration: () => void;
}) {
  // Keep credential fields only for this open panel. Office wording has its own
  // memory-only, identity-bound journal so closing setup cannot erase typing.
  const [visited, setVisited] = useState<WorkspaceSetupTarget[]>([target]);
  useEffect(() => { setVisited(current => current.includes(target) ? current : [...current, target]); }, [target]);
  const sections = [...new Set([...visited, target])];
  const showBrowser = () => {
    const browser = document.getElementById("apps-work-browser");
    if (browser instanceof HTMLDetailsElement) {
      browser.open = true;
      browser.scrollIntoView({ block: "start" });
      browser.querySelector("summary")?.focus({ preventScroll: true });
    }
  };
  const navigation = <nav className="workspace-setup-nav" aria-label="Setup sections">
    {sectionsInfo.map(({ key, label, detail, icon: Icon }) => <button type="button" className="pm-control" key={key} aria-label={label} aria-pressed={target === key} onClick={() => onTarget(key)}>
      <Icon size={18} aria-hidden /><span><strong>{label}</strong><small>{detail}</small></span>
    </button>)}
  </nav>;
  return <AskWorkspaceSheet title={labels[target]} origin={origin} onClose={onClose} navigation={navigation}>
    {error && <div className="px-4 pt-3"><ActionNotice message={error} onDismiss={onDismissError} /></div>}
    {sections.map(section => <div className="workspace-setup-content" key={section} hidden={section !== target} inert={section !== target}>
      {section === "bud" ? <>
        <BudSetupCard administration active={target === "bud"} id="workspace-bud" onShowAsk={onAsk} onSchedule={onSchedule} onServiceAdministration={onClose}
          onBack={origin === "Work" ? onAsk : onClose} backLabel={`Back to ${origin}`} />
        <div className="workspace-setup-next"><p>Choose what Bud can work with.</p><button className="pm-control" type="button" onClick={() => onTarget("apps")}>Connect apps & websites</button><button className="pm-control" type="button" onClick={() => onTarget("office")}>Office & department access</button></div>
      </> : section === "apps" ? <><ConnectedAppsCard onAsk={onAsk} onBrowser={showBrowser} /><BrowserCard id="apps-work-browser" onAsk={onAsk} /></> : <YouPage section={section} onServiceAdministration={onServiceAdministration} />}
    </div>)}
  </AskWorkspaceSheet>;
}
