import { useEffect, useRef } from "react";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { ConnectOfficeView, useConnectOffice } from "./ConnectOffice";
import { Card } from "./SettingsPrimitives";
import { WindowsTitlebar } from "./shell/DesktopShell";

/** Takes the shell's place on a computer that is not connected to its office,
 * before Bud's own setup: Bud and the office's workflows start from the link.
 * Update and handoff banners stay above it. Never a screen with no exit: the
 * person may explore the sample desk, or open saved work once disconnected,
 * for the rest of this app session. */
export function LinkOfficeScreen({ revoked, onLeave }: { revoked: boolean; onLeave: () => void }) {
  const { state } = useStore();
  const { view } = useConnectOffice(state.config?.profile?.name);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper">
      <WindowsTitlebar />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <main className="mx-auto flex min-h-full w-full max-w-[34rem] flex-col justify-center gap-6 py-8">
          <header className="flex flex-col items-center gap-2 text-center">
            <MausAvatar color="green" state={revoked ? "curious" : "idle"} size={72} label="Bud" trackPointer={false} />
            <h1 ref={heading} tabIndex={-1} className="mt-2 text-2xl font-semibold text-ink outline-none">
              {revoked ? "This computer was disconnected from your office" : "Connect this computer to your office"}
            </h1>
            <p className="text-sm text-ink-secondary">
              {revoked ? "Everything saved here is kept. Reconnect to use Bud and your workflows." : "Bud and your office’s workflows start once it’s connected."}
            </p>
          </header>
          <Card><ConnectOfficeView {...view} revokedShown={revoked} /></Card>
          <button type="button" onClick={onLeave} className="pm-control self-center rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected">
            {revoked ? "Open saved work without Bud" : "Explore the sample desk"}
          </button>
        </main>
      </div>
    </div>
  );
}
