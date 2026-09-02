// App settings keep the ordinary office-facing choices small. Bud's engine,
// pin, and property pack stay behind the guided connection experience.
import { useEffect, useId, useRef, useState } from "react";
import { Hand, User, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { useUpdaterState } from "@/lib/updater";
import { api, useStore, type AppSettingsSection } from "@/state/store";
import { BudSetupCard } from "./BudSetupCard";
import { Card } from "./SettingsPrimitives";

const SECTIONS: Array<{ id: AppSettingsSection; label: string; icon: typeof User }> = [
  { id: "general", label: "You", icon: User },
  { id: "connections", label: "Bud", icon: Hand },
];

type ProfileSaveState = "idle" | "saving" | "saved" | "invalid" | "error";

/** Name and email are persisted in order so quick consecutive blurs cannot
 * leave an older profile write as the final value. */
export function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  const [saveState, setSaveState] = useState<ProfileSaveState>("idle");
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const latestSave = useRef(0);
  const inputId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    if (document.activeElement !== nameRef.current) setName(state.config?.profile?.name ?? "");
    if (document.activeElement !== emailRef.current) setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    const normalizedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
      setSaveState("invalid");
      return;
    }

    const saveId = ++latestSave.current;
    setSaveState("saving");
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const config = await api(
            "/api/config",
            { method: "PUT", body: JSON.stringify({ profile: { name: normalizedName, email: normalizedEmail } }) },
            { timeoutMs: 15_000 },
          );
          dispatch({ type: "configStatus", config });
          if (mounted.current && saveId === latestSave.current) setSaveState("saved");
        } catch {
          if (mounted.current && saveId === latestSave.current) setSaveState("error");
        }
      });
  };

  const fieldClass =
    "pm-control mt-1.5 w-full rounded border border-line bg-inset px-3 text-[14px] text-ink placeholder:text-ink-muted focus:border-agency";

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={`${inputId}-name`} className="text-[12.5px] font-medium text-ink-secondary">
        Name
        <input
          ref={nameRef}
          id={`${inputId}-name`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaveState("idle");
          }}
          onBlur={save}
          autoComplete="name"
          placeholder="How the office knows you"
          className={fieldClass}
        />
      </label>
      <label htmlFor={`${inputId}-email`} className="text-[12.5px] font-medium text-ink-secondary">
        Office email
        <input
          ref={emailRef}
          id={`${inputId}-email`}
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setSaveState("idle");
          }}
          onBlur={save}
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={saveState === "invalid" ? true : undefined}
          className={fieldClass}
        />
      </label>
      <div
        aria-live="polite"
        className={cn(
          "min-h-4 text-[11.5px]",
          saveState === "error" || saveState === "invalid" ? "text-danger" : "text-ink-muted",
        )}
      >
        {saveState === "saving"
          ? "Saving…"
          : saveState === "saved"
            ? "Saved"
            : saveState === "invalid"
              ? "Enter a complete email address, or leave it blank."
              : saveState === "error"
                ? "Could not save. Your changes are still here; leave the field to try again."
                : "Saved on this Mac as you go."}
      </div>
    </div>
  );
}

function UpdatesRow() {
  const updaterState = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    updaterState?.status === "checking"
      ? "Checking…"
      : updaterState?.status === "available"
        ? `${updaterState.version} available`
        : updaterState?.status === "downloading"
          ? `Downloading ${Math.round(updaterState.percent ?? 0)}%`
          : updaterState?.status === "downloaded"
            ? `${updaterState.version} is ready. Restart to apply it.`
            : updaterState?.status === "error"
              ? `Check failed: ${updaterState.message ?? "unknown error"}`
              : "You are on the latest version we know of.";

  return (
    <Card title="Updates" subtitle={label}>
      <button
        type="button"
        onClick={() => {
          if (updaterState?.status === "available") return void updater.download();
          if (updaterState?.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={updaterState?.status === "checking" || updaterState?.status === "downloading"}
        className="pm-control rounded border border-line px-3 text-[13px] text-ink transition-transform hover:bg-raised active:scale-[0.98] disabled:opacity-40"
      >
        {updaterState?.status === "available"
          ? "Download"
          : updaterState?.status === "downloaded"
            ? "Restart and install"
            : "Check for updates"}
      </button>
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
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
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

  const close = () => dispatch({ type: "toggleAppSettings", open: false });
  const currentLabel = SECTIONS.find((item) => item.id === section)?.label ?? "Settings";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/55 p-4"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="flex h-[min(560px,calc(100dvh-2rem))] w-full max-w-[900px] flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-2xl outline-none md:flex-row"
      >
        <nav
          aria-label="Settings sections"
          className="flex shrink-0 items-center gap-1 border-b border-line bg-sheet p-2.5 md:w-[184px] md:flex-col md:items-stretch md:border-b-0 md:border-r md:p-3"
        >
          <div id="app-settings-title" className="mr-auto px-2 text-[15px] font-semibold text-ink md:mb-1 md:mr-0 md:py-1">
            Settings
          </div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "pm-control flex items-center gap-2 rounded px-2.5 text-left text-[13.5px] transition-transform active:scale-[0.98]",
                section === id ? "bg-selected text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={close}
            aria-label="Close settings"
            className="rounded p-2 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
          >
            <X size={18} />
          </button>
        </nav>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-line px-5 py-3">
            <span className="text-[14px] font-semibold text-ink">{currentLabel}</span>
            <button
              type="button"
              onClick={close}
              aria-label="Close settings"
              className="hidden rounded p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:block"
            >
              <X size={18} />
            </button>
          </header>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-5">
            {section === "general" ? (
              <>
                <Card title="Profile" subtitle="How RealBud addresses you.">
                  <ProfileFields />
                </Card>
                <UpdatesRow />
              </>
            ) : null}
            {section === "connections" ? <BudSetupCard id="settings-bud" /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
