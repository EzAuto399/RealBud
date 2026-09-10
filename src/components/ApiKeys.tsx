// Paste-a-key rows for PUT /api/config. The server persists to
// ~/.realbud/config.json and hot-reloads the provider fleet; secrets
// are write-only — GET /api/config returns configured flags, never values.
import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";

export type ConfigSection = "composio" | "composioApi" | "box";

const SECTIONS: Record<
  ConfigSection,
  { body: (value: string) => unknown; flag: (config: ConfigStatus) => boolean }
> = {
  composio: { body: (v) => ({ composio: { key: v } }), flag: (c) => c.composio.configured },
  composioApi: {
    body: (v) => ({ composio: { apiKey: v } }),
    flag: (c) => c.composio.apiKeyConfigured ?? false,
  },
  box: { body: (v) => ({ box: { token: v } }), flag: (c) => c.box.configured },
};

const CREDENTIALS: Record<
  ConfigSection,
  {
    label: string;
    placeholder: string;
    description: string;
    href: string;
    linkLabel: string;
    optional: boolean;
    warning?: string;
  }
> = {
  composio: {
    label: "Connected apps key",
    placeholder: "ck_…",
    description: "Save your connection key here, then sign in to the office apps you want Bud to use.",
    href: "https://docs.composio.dev/docs/composio-connect",
    linkLabel: "Open Composio setup guide",
    optional: true,
  },
  composioApi: {
    label: "Composio API key",
    placeholder: "ak_…",
    description: "Unlock the full app catalog with official names and logos.",
    href: "https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions",
    linkLabel: "Open Composio API key guide",
    optional: true,
  },
  box: {
    label: "Box API key",
    placeholder: "Paste your Box API key",
    description: "Give bots an isolated remote Linux computer with a desktop and terminal.",
    href: "https://docs.ascii.dev/box/api-keys",
    linkLabel: "Open Box API key guide",
    optional: true,
    warning: "Box is a paid service after its trial. Usage may incur charges.",
  },
};

function CredentialHelp({ section }: { section: ConfigSection }) {
  const credential = CREDENTIALS[section];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`About ${credential.label}`}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
        className="flex size-6 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={popoverId}
          role="group"
          aria-label={`${credential.label} help`}
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[270px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl"
        >
          <div className="text-[12px] leading-[1.45] text-ink-secondary">{credential.description}</div>
          {credential.warning && (
            <div className="mt-2 flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2 py-1.5 text-[11px] leading-[1.4] text-warning">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>{credential.warning}</span>
            </div>
          )}
          <a
            href={credential.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
          >
            {credential.linkLabel}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}

export function ApiKeyRow({
  section,
  onSaved,
}: {
  section: ConfigSection;
  /** Called after a successful save with the section's new configured flag. */
  onSaved?: (configured: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = state.config ? SECTIONS[section].flag(state.config) : false;
  const clearing = !value.trim() && configured;
  const credential = CREDENTIALS[section];

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify(SECTIONS[section].body(value.trim())),
    }, { timeoutMs: section === "composio" ? 45_000 : 15_000 })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
        onSaved?.(SECTIONS[section].flag(status));
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>{credential.label}</span>
        {credential.optional && (
          <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
            Optional
          </span>
        )}
        {configured && <span className="text-[11px] text-success">{section === "composio" ? "Saved" : "Connected"}</span>}
        <CredentialHelp section={section} />
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={configured ? "••••••••  (paste to replace)" : credential.placeholder}
          aria-label={credential.label}
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline"
        />
        <button
          onClick={save}
          disabled={saving || (!value.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            clearing
              ? "bg-raised text-danger hover:bg-raised-hover"
              : "bg-raised text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={clearing ? "Remove the saved key" : "Save"}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? "Clear" : <><Check size={13} />Save</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

const QUICK_CONNECT = [
  { slug: "gmail", label: "Gmail" },
  { slug: "outlook", label: "Outlook" },
  { slug: "notion", label: "Notion" },
  { slug: "googlecalendar", label: "Google Calendar" },
] as const;

/** Connection shortcuts use the canonical Ask broker, including its error recovery.
 * They never poll the legacy connector routes, which product mode denies. */
export function ConnectedAppQuickConnect() {
  const { state, dispatch } = useStore();
  const busy = Boolean(state.bots.find(bot => bot.id === "bud")?.busy);
  if (!state.config?.composio?.configured) return null;
  return (
    <div className="mt-3">
      <div className="text-[12px] text-ink-secondary">Connect an app with Bud</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {QUICK_CONNECT.map(row => (
          <button key={row.slug} type="button" disabled={busy || !state.connected}
            onClick={() => {
              dispatch({ type: "showAsk" });
              dispatch({ type: "send", botId: "bud", text: `connect ${row.label}` });
            }}
            className="pm-control rounded-lg border border-line bg-sheet px-3 py-1.5 text-[12.5px] text-ink hover:border-agency/35 hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50">
            Connect {row.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
        {busy ? "Bud is finishing a task. Connect an app when it finishes." : "Bud checks the connection in Ask and guides you through sign-in. Your unsent draft stays saved."}
      </p>
    </div>
  );
}
