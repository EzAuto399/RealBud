import { Cable, ClipboardPaste, Database, Files } from "lucide-react";

import { cn } from "@/lib/cn";

type IntakeRoute = {
  id: "pms-export" | "selected-evidence" | "paste-manual" | "read-only-connection";
  title: string;
  status: "Available now" | "Pilot-gated";
  detail: string;
  action: string;
  icon: typeof Database;
};

const ROUTES: readonly IntakeRoute[] = [
  {
    id: "pms-export",
    title: "Current PMS export",
    status: "Available now",
    detail: "Best for the whole portfolio and current money facts. The verified live route currently accepts the structured CSV from your PMS.",
    action: "Import on Desk",
    icon: Database,
  },
  {
    id: "selected-evidence",
    title: "Files, screenshots or photos",
    status: "Available now",
    detail: "Best when the book is in Excel, a PDF, a document, an inspection report, screenshots or photos. Bud stages only fields it can read.",
    action: "Choose files",
    icon: Files,
  },
  {
    id: "paste-manual",
    title: "Paste or add a few",
    status: "Available now",
    detail: "Best for a small book, a copied table or gaps. Paste rows without a model, or add one property from Desk.",
    action: "Quick paste",
    icon: ClipboardPaste,
  },
  {
    id: "read-only-connection",
    title: "Read-only PMS connection",
    status: "Pilot-gated",
    detail: "Best for repeat refreshes. A named API, restricted connector or private browser recipe is enabled only after the office and account are tested.",
    action: "View connections",
    icon: Cable,
  },
] as const;

export function PropertyIntakeRoutePicker({
  onChoosePmsExport,
  onChooseFiles,
  onChoosePaste,
  onOpenConnections,
}: {
  onChoosePmsExport: () => void;
  onChooseFiles: () => void;
  onChoosePaste: () => void;
  onOpenConnections: () => void;
}) {
  const actions: Record<IntakeRoute["id"], () => void> = {
    "pms-export": onChoosePmsExport,
    "selected-evidence": onChooseFiles,
    "paste-manual": onChoosePaste,
    "read-only-connection": onOpenConnections,
  };

  return (
    <section aria-labelledby="property-intake-routes-heading" className="border-t border-line pt-2.5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="property-intake-routes-heading" className="text-[12px] font-semibold text-ink">Where is your portfolio today?</h3>
        <span className="text-[12px] text-ink-muted">Use the first available route that fits</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {ROUTES.map((route) => {
          const Icon = route.icon;
          const available = route.status === "Available now";
          return (
            <article key={route.id} className="flex min-w-0 flex-col border border-line bg-paper px-3 py-2.5">
              <div className="flex items-start gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded border border-line bg-sheet text-agency">
                  <Icon size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h4 className="text-[12.5px] font-semibold text-ink">{route.title}</h4>
                    <span className={cn(
                      "rounded-full border px-1.5 py-0.5 text-[12px] font-medium",
                      available ? "border-agency/30 bg-selected text-agency" : "border-line bg-sheet text-ink-muted",
                    )}>
                      {route.status}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] leading-[1.4] text-ink-muted">{route.detail}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={actions[route.id]}
                className="pm-control pm-tactile mt-2 self-start rounded border border-line bg-sheet px-2.5 text-[12px] font-semibold text-ink hover:border-agency/55 hover:bg-selected/45"
              >
                {route.action}
              </button>
            </article>
          );
        })}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
        Files and pasted records create reviewable Desk proposals. Only a matched current PMS export can verify live balances.
      </p>
    </section>
  );
}
