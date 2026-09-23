import { useState } from "react";
import type { HermesStatus } from "@/state/store";
import { budAvailability } from "@/lib/bud-setup";
import { useStore } from "@/state/store";
import { scrollYouTarget } from "@/lib/you-navigation";
import { budFacingCopy } from "@/lib/bud-setup";

type ManagedBudStatusProps = {
  id: string;
  status: HermesStatus | null;
  connected: boolean;
  onRefresh: () => Promise<void>;
  onServiceAdministration?: () => void;
};

export function ManagedBudStatus({ id, status, connected, onRefresh, onServiceAdministration }: ManagedBudStatusProps) {
  const { dispatch } = useStore();
  const availability = budAvailability(status, connected);
  const needsAccountLink = availability.target === "attach-model" && !status?.modelAccess?.managed;
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState("");
  const lastCheck = status?.lastPing ?? (status?.lastTest?.kind === "ping" ? status.lastTest : null);

  async function checkAgain() {
    if (pending) return;
    setPending(true);
    setLive("");
    try {
      await onRefresh();
      setLive("Checked again.");
    } catch {
      setLive("Could not check status. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section id={id} className="rounded-lg border border-line bg-sheet p-5 text-ink">
      <h2 className="text-lg font-semibold">Bud on this computer</h2>
      <p className="mt-2 text-sm">{availability.label}</p>
      {availability.ready ? (
        <p className="mt-2 text-sm text-ink-secondary">{availability.detail}</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink-secondary">{availability.detail}</p>
          <p className="mt-2 text-sm text-ink-secondary">{needsAccountLink
            ? "Open Website account to link this computer or check its model access. Your account supplies access; the private readiness check still needs to pass before Bud can work."
            : "Ask your RealBud service administrator to finish setup on this computer. Keep preparing and saving plans in Schedule."}</p>
        </>
      )}
      {!availability.ready && lastCheck && !lastCheck.ok && (
        <p className="mt-2 text-sm text-danger" role="status">
          Last readiness check: {budFacingCopy(lastCheck.detail, "Bud could not finish the check. Ask your service administrator to check the connection.")}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {needsAccountLink && <button type="button" className="pm-decision rounded bg-agency px-4 text-sm font-medium text-white hover:bg-agency-hover"
          onClick={() => {
            onServiceAdministration?.();
            dispatch({ type: "toggleAppSettings", open: false });
            if (location.hash === "#you-website") scrollYouTarget("you-website");
            else location.hash = "you-website";
          }}>Open website account</button>}
        <button
          type="button"
          className="min-h-11 rounded-lg border border-line bg-sheet px-4 text-sm text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-50"
          disabled={pending}
          aria-busy={pending}
          onClick={() => {
            void checkAgain();
          }}
        >
          Check again
        </button>
        <p className="text-sm text-ink-secondary" role="status" aria-live="polite">
          {live}
        </p>
      </div>
      <p className="mt-4 text-sm text-ink-secondary">
        Company service settings are managed. Personal app connections stay under Apps.
      </p>
      <button type="button" className="mt-2 min-h-11 text-[13px] text-ink-secondary underline underline-offset-4"
        onClick={() => {
          onServiceAdministration?.();
          dispatch({ type: "toggleAppSettings", open: false });
          if (location.hash === "#you-service-admin") scrollYouTarget("you-service-admin");
          else location.hash = "you-service-admin";
        }}>
        Service administration
      </button>
    </section>
  );
}
