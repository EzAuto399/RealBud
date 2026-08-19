// App settings: who you are, and the pinned Hermes worker. Voice, local VM,
// and third-party key shop stay out of the licensee window.
import { useEffect, useRef, useState } from "react";
import { Hand, Loader2, RefreshCw, User, X } from "lucide-react";
import { api, useStore, type AppSettingsSection } from "@/state/store";
import { useUpdaterState } from "@/lib/updater";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

const SECTIONS: Array<{ id: AppSettingsSection; label: string; icon: typeof User }> = [
  { id: "general", label: "You", icon: User },
  { id: "connections", label: "Hands", icon: Hand },
];

/** Name + email, persisted to /api/config {profile} on blur. */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder="Your name" className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
    </div>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? `Downloading ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ready — restart to apply`
            : s?.status === "error"
              ? `Check failed: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <Card title="Updates" subtitle={label}>
      <button
        onClick={() => {
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={s?.status === "checking" || s?.status === "downloading"}
        className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
      >
        {s?.status === "available"
          ? "Download"
          : s?.status === "downloaded"
            ? "Restart and install"
            : "Check for updates"}
      </button>
    </Card>
  );
}

/** The pinned Hermes worker is the product's hands — headless only, never
 * Hermes Desktop. Install the pinned CLI, apply the `property` pack, attach
 * a model; Desk Recheck asks it for the morning ledger and falls back to
 * the training book on any miss. */
function HermesHandsCard() {
  const { state, dispatch, refreshHermes } = useStore();
  const [busy, setBusy] = useState<null | "install" | "pack" | "model" | "test" | "check">(null);
  const [error, setError] = useState("");
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const status = state.hermes;

  const act = async (key: "install" | "pack" | "model" | "test" | "check") => {
    setBusy(key);
    setError("");
    setTest(null);
    try {
      if (key === "install") {
        const res = await api("/api/hermes/install", { method: "POST", body: "{}" });
        if (res.ok === false) throw new Error("the terminal could not be opened");
      } else if (key === "model") {
        const res = await api("/api/hermes/model", { method: "POST", body: "{}" });
        if (res.ok === false) throw new Error("the terminal could not be opened");
      } else if (key === "test") {
        setTest(await api("/api/hermes/test", { method: "POST", body: "{}" }));
        return;
      } else if (key === "pack") {
        const fresh = await api("/api/hermes/apply-pack", { method: "POST", body: "{}" });
        dispatch({ type: "hermesStatus", status: fresh });
        return;
      }
      await refreshHermes();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const Row = ({ label, ok, text }: { label: string; ok: boolean; text: string }) => (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="text-ink-secondary">{label}</span>
      <span className={cn("min-w-0 truncate text-right", ok ? "text-ink" : "text-warning")}>{text}</span>
    </div>
  );

  return (
    <Card
      title="Hands — Hermes worker"
      subtitle={status ? status.detail : "Checking the pinned worker…"}
    >
      <div className="flex flex-col gap-2">
        <Row
          label="Worker"
          ok={Boolean(status?.cli.matchesPin)}
          text={
            status && status.cli.versionText
              ? `${status.cli.versionText.trim()} ${status.cli.matchesPin ? "· pinned" : "· pin is " + status.pin.product}`
              : "not installed"
          }
        />
        <Row
          label="Property pack"
          ok={Boolean(status?.pack.installed)}
          text={
            status?.pack.installed
              ? status.pack.approvalsManual
                ? "installed · approvals manual"
                : "installed · approvals NOT manual"
              : "missing"
          }
        />
        {test && (
          <div className={cn("rounded-lg border px-3 py-2 text-[12.5px]", test.ok ? "border-success/25 bg-success/10 text-success" : "border-danger/25 bg-danger/10 text-danger")}>
            {test.detail}
          </div>
        )}
        {error && <div className="text-[12.5px] text-danger">{error}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            onClick={() => act("install")}
            disabled={busy !== null || !status?.installCommand}
            title={
              status?.installCommand
                ? "Opens a terminal with the pinned installer. Close the app's eyes — this runs in Terminal."
                : "No one-line installer for this platform."
            }
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy === "install" ? <Loader2 size={13} className="animate-spin" /> : <Hand size={13} />}
            Install pinned worker
          </button>
          <button
            onClick={() => act("pack")}
            disabled={busy !== null}
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
          >
            {busy === "pack" ? <Loader2 size={13} className="animate-spin" /> : null}
            Apply property pack
          </button>
          <button
            onClick={() => act("model")}
            disabled={busy !== null}
            title="Opens a terminal to attach a model to the property profile"
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
          >
            {busy === "model" ? <Loader2 size={13} className="animate-spin" /> : null}
            Attach model
          </button>
          <button
            onClick={() => act("test")}
            disabled={busy !== null}
            title="Ask the pinned worker one headless question to prove it can answer"
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
          >
            {busy === "test" ? <Loader2 size={13} className="animate-spin" /> : null}
            Test hands
          </button>
          <button
            onClick={() => act("check")}
            disabled={busy !== null}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            {busy === "check" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Check again
          </button>
        </div>
        <p className="text-[12px] leading-relaxed text-ink-secondary/80">
          Headless only — {status?.signInCommand ?? "hermes -p property model"} attaches the model. Never launch Hermes Desktop from here.
        </p>
      </div>
    </Card>
  );
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="flex h-[560px] w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        {/* section nav */}
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3">
          <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink">
            Settings
          </div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                section === id ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label="Close settings"
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "general" && (
              <>
                <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
                  <ProfileFields />
                </Card>
                <UpdatesRow />
              </>
            )}

            {section === "connections" && <HermesHandsCard />}
          </div>
        </div>
      </div>
    </div>
  );
}
