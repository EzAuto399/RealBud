import { useEffect, useState } from "react";
import { User } from "lucide-react";

import { api, useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { HermesHandsCard, ProfileFields } from "./SettingsModal";

export function YouPage() {
  const { state, dispatch } = useStore();
  const [session, setSession] = useState<{ product?: boolean; nonProduction?: boolean } | null>(null);

  useEffect(() => {
    void api("/api/session")
      .then((body) => setSession(body))
      .catch(() => setSession(null));
    void api("/api/desk")
      .then((snapshot) => dispatch({ type: "deskSnapshot", snapshot }))
      .catch(() => {});
  }, [dispatch]);

  const desk = state.desk;
  const recovery = desk?.recovery?.active;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="px-5 pb-3 pt-4">
        <div className="flex items-center gap-2.5">
          <User size={21} className="text-accent" />
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">You</h1>
        </div>
        <p className="mt-1 max-w-[40rem] text-[12.5px] text-ink-secondary">
          Profile, model disclosure, source readiness, browser profile, and recovery. Desk still owns the book.
        </p>
      </header>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
        {session?.nonProduction && (
          <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-warning">
            Source-run key. This is not a production distribution. Agency data stays local.
          </div>
        )}
        {recovery && (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger">
            Desk is in recovery. Schedules and writes are paused. The book was not replaced with Demo data.
          </div>
        )}
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
        </Card>
      </div>
    </main>
  );
}
