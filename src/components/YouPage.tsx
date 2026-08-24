import { useEffect, useState } from "react";
import { User } from "lucide-react";

import { cn } from "@/lib/cn";
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
        <RecoveryKeyCard recoveryActive={Boolean(recovery)} />
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

function RecoveryKeyCard({ recoveryActive }: { recoveryActive: boolean }) {
  const [hex, setHex] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(() => localStorage.getItem("realbud.recovery-key-saved") === "1");
  const [unlockKey, setUnlockKey] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockMsg, setUnlockMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");

  const reveal = async () => {
    setError("");
    try {
      const res = await api("/api/desk/recovery-key");
      setHex(res.hex ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const unlock = async () => {
    setUnlockBusy(true);
    setUnlockMsg(null);
    setError("");
    try {
      const res = await api("/api/desk/recovery/unlock", { method: "POST", body: JSON.stringify({ key: unlockKey }) });
      setUnlockMsg({ ok: true, text: res.message ?? "Book restored." });
    } catch (cause) {
      setUnlockMsg({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setUnlockBusy(false);
    }
  };

  return (
    <Card
      title="Recovery key"
      subtitle="Your book is encrypted. This key is the only way to open it if the key file is ever lost. Save it somewhere safe."
    >
      {saved && !hex ? (
        <div className="text-[13px] text-ink-secondary">
          Saved ✓{" "}
          <button className="text-accent hover:underline" onClick={() => { setSaved(false); localStorage.removeItem("realbud.recovery-key-saved"); }}>
            Show it again
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {hex ? (
            <>
              <code className="break-all rounded-lg border border-line bg-sheet px-3 py-2 font-mono text-[12px] text-ink">{hex}</code>
              <div className="flex gap-2">
                <button
                  onClick={() => { void navigator.clipboard.writeText(hex); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised"
                >
                  {copied ? "Copied" : "Copy key"}
                </button>
                <button
                  onClick={() => { localStorage.setItem("realbud.recovery-key-saved", "1"); setSaved(true); setHex(null); }}
                  className="rounded-lg bg-agency px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110"
                >
                  I've saved it
                </button>
              </div>
            </>
          ) : (
            <button onClick={() => void reveal()} className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised">
              Reveal recovery key
            </button>
          )}
        </div>
      )}
      {recoveryActive && (
        <div className="mt-3 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5">
          <div className="text-[13px] font-medium text-ink">Book locked</div>
          <p className="mt-0.5 text-[12px] text-ink-muted">Paste your recovery key to restore the quarantined book. RealBud restarts afterwards.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={unlockKey}
              onChange={(e) => setUnlockKey(e.target.value)}
              placeholder="64-character recovery key"
              className="min-w-[16rem] flex-1 rounded-lg border border-hairline/40 bg-panel px-2 py-1.5 font-mono text-[12px] text-ink"
            />
            <button
              onClick={() => void unlock()}
              disabled={unlockBusy || unlockKey.trim().length === 0}
              className="rounded-lg bg-agency px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              {unlockBusy ? "Unlocking…" : "Unlock book"}
            </button>
          </div>
          {unlockMsg && (
            <div className={cn("mt-2 text-[12.5px]", unlockMsg.ok ? "text-success" : "text-danger")}>{unlockMsg.text}</div>
          )}
        </div>
      )}
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
    </Card>
  );
}
