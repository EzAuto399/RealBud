import { useEffect, useState } from "react";
import { User } from "lucide-react";

import { api, useStore } from "@/state/store";
import { AdvancedDiagnostics, RecoveryNotice } from "./pm";
import { Card } from "./SettingsPrimitives";
import { HermesHandsCard, ProfileFields } from "./SettingsModal";

type HermesStatus = {
  pin: { product: string; tag: string; commit: string; profile: string };
  pack: { installed: boolean; approvalsManual: boolean };
  detail: string;
  ready: boolean;
};

export function YouPage() {
  const { state, dispatch } = useStore();
  const [session, setSession] = useState<{ product?: boolean; nonProduction?: boolean } | null>(null);
  const [hermes, setHermes] = useState<HermesStatus | null>(null);

  useEffect(() => {
    void api("/api/session")
      .then((body) => setSession(body))
      .catch(() => setSession(null));
    void api("/api/desk")
      .then((snapshot) => dispatch({ type: "deskSnapshot", snapshot }))
      .catch(() => {});
    void api("/api/hermes")
      .then((body) => setHermes(body))
      .catch(() => setHermes(null));
  }, [dispatch]);

  const desk = state.desk;
  const recovery = desk?.recovery?.active;
  const agency = desk?.book?.agency;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="px-5 pb-3 pt-4">
        <div className="flex items-center gap-2.5">
          <User size={21} className="text-accent" />
          <h1 className="pm-screen-title text-ink">You</h1>
        </div>
        <p className="mt-1 max-w-[40rem] text-[12.5px] text-ink-secondary">
          Agency, source readiness, browser profile, and recovery. Engine internals stay under Advanced diagnostics.
        </p>
      </header>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
        {session?.nonProduction && (
          <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-warning">
            Source-run key. This is not a production distribution. Agency data stays local.
          </div>
        )}
        {recovery && (
          <RecoveryNotice>
            Desk is in recovery. Writes, schedules and browser work are paused. The book was not replaced with Demo data.
          </RecoveryNotice>
        )}
        <Card title="Agency" subtitle={agency ? `${agency.name || "Unnamed"} · ${agency.timezone}` : "Open Desk once to load the book."}>
          <div className="text-[13px] text-ink-secondary">
            Jurisdictions: {agency?.jurisdictions.length ? agency.jurisdictions.join(", ") : "Not set"}
          </div>
        </Card>
        <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
          <ProfileFields />
        </Card>
        <HermesHandsCard />
        <Card
          title="Sources"
          subtitle={
            desk
              ? `${desk.mode === "demo" ? "Demo book" : "Live book"} · revision ${desk.revision} · ${desk.timezone}`
              : "Open Desk once to load the book."
          }
        >
          <ul className="text-[13px] text-ink-secondary">
            {(desk?.sources ?? []).map((source) => (
              <li key={source.id}>
                {source.label} · {source.kind}
              </li>
            ))}
            {!desk?.sources?.length && <li>No sources yet.</li>}
          </ul>
        </Card>
        <Card title="Browser profile" subtitle="Dedicated ~/.realbud/chrome-profile. You sign in. Passwords and cookies never enter config, recipes, or Ask.">
          <div className="text-[13px] text-ink-secondary">
            Retention: {desk?.retentionDays ?? "not set"} days. Full captures stay off the event stream.
          </div>
          {recovery ? (
            <p className="mt-2 text-[13px] text-hold">Browser work is paused in recovery. Prepare is refused until you resume.</p>
          ) : (
            <p className="mt-2 text-[13px] text-ink-secondary">Handoffs stay case-scoped. You submit in the PMS.</p>
          )}
        </Card>
        <AdvancedDiagnostics>
          {hermes ? (
            <>
              <div>pin {hermes.pin.product} / {hermes.pin.tag}</div>
              <div>profile {hermes.pin.profile}</div>
              <div>pack {hermes.pack.installed ? "installed" : "missing"} · approvals {hermes.pack.approvalsManual ? "manual" : "not manual"}</div>
              <div>{hermes.detail}</div>
            </>
          ) : (
            <div>Engine status is not available yet.</div>
          )}
        </AdvancedDiagnostics>
      </div>
    </main>
  );
}
