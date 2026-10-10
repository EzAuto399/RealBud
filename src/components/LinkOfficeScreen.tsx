import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { OfficeLinkGate } from "@/lib/bud-setup";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { ConnectOfficeView, useConnectOffice } from "./ConnectOffice";
import { Card } from "./SettingsPrimitives";
import { WindowsTitlebar } from "./shell/DesktopShell";
import { WEBSITE_LINK_CHANGED } from "./you/browser-link";

/** How long Try again shows it is working when nothing changes. */
const RETRY_SHOWN_MS = 2_000;

const primary = "pm-decision flex w-full items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white transition-transform hover:bg-agency-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none";
const secondary = "pm-control w-full rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected";

/** Takes the shell's place until this computer is linked to its office: every
 * computer links before anything else opens, ahead of Bud's own setup. Update
 * and handoff banners stay above it. The only way past is recovery, offered
 * when the link can't be read; first run keeps its own backup and recovery
 * choices. While the link is still being read, App shows the same frame from
 * the main bundle (`OfficeLinkChecking`), so a linked computer never loads this. */
export function LinkOfficeScreen({ gate, onRetry, onOpenRecovery }: { gate: Exclude<OfficeLinkGate, "checking">; onRetry: () => void; onOpenRecovery: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [gate]);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => { setRetrying(false); }, [gate]);
  useEffect(() => {
    if (!retrying) return;
    const done = window.setTimeout(() => setRetrying(false), RETRY_SHOWN_MS);
    return () => window.clearTimeout(done);
  }, [retrying]);
  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    // Read the link again; App re-reads the book if that read never answered.
    window.dispatchEvent(new Event(WEBSITE_LINK_CHANGED));
    onRetry();
  };
  const unavailable = gate === "unavailable", revoked = gate === "revoked";
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper">
      <WindowsTitlebar />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <main className="mx-auto flex min-h-full w-full max-w-[34rem] flex-col justify-center gap-6 py-8">
          <header className="flex flex-col items-center gap-2 text-center">
            <MausAvatar color="green" state={gate === "not-linked" ? "idle" : "curious"} size={72} label="Bud" trackPointer={false} />
            <h1 ref={heading} tabIndex={-1} className="mt-2 text-2xl font-semibold text-ink outline-none">
              {unavailable ? "This computer’s office link couldn’t be checked" : revoked ? "This computer was disconnected from your office" : "Connect this computer to your office"}
            </h1>
            <p className="text-sm text-ink-secondary">
              {unavailable ? "RealBud’s local service didn’t answer. Everything saved here is kept."
                : revoked ? "Everything saved here is kept. Reconnect to use Bud and your workflows." : "Bud and your office’s workflows start once it’s connected."}
            </p>
          </header>
          {unavailable ? (
            <div className="flex flex-col gap-2">
              {/* Stays focusable while it works, so a keyboard user keeps their place. */}
              <button type="button" onClick={retry} aria-disabled={retrying || undefined} className={`${primary} aria-disabled:cursor-wait`}>
                {retrying ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                {retrying ? "Checking again…" : "Try again"}
              </button>
              <button type="button" onClick={onOpenRecovery} className={secondary}>Open recovery</button>
            </div>
          ) : <LinkCard revoked={revoked} />}
        </main>
      </div>
    </div>
  );
}

/** The link-code entry, read only once the screen asks for it. */
function LinkCard({ revoked }: { revoked: boolean }) {
  const { state } = useStore();
  const { view } = useConnectOffice(state.config?.profile?.name);
  return <Card><ConnectOfficeView {...view} revokedShown={revoked} /></Card>;
}
