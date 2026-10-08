import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { budAutoSetupView } from "@/lib/bud-setup";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { BudSetupCard } from "./BudSetupCard";
import { WindowsTitlebar } from "./shell/DesktopShell";

/** Takes the shell's place during Bud's first setup on this computer, so nobody
 * starts work that cannot run yet. Update and handoff banners stay above it.
 * Never a screen with no exit: while setup runs staff may look around the
 * sample desk; once it waits, stops or can't be confirmed, they may use the
 * rest of RealBud meanwhile. */
export function BudSetupScreen({ running, onLeave }: { running: boolean; onLeave: () => void }) {
  const { state } = useStore();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper">
      <WindowsTitlebar />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <main className="mx-auto flex min-h-full w-full max-w-[34rem] flex-col justify-center gap-6 py-8">
          <header className="flex flex-col items-center gap-2 text-center">
            <MausAvatar color="green" state={running ? "idle" : "curious"} size={72} label="Bud" trackPointer={false} />
            <h1 ref={heading} tabIndex={-1} className="mt-2 text-2xl font-semibold text-ink outline-none">{budAutoSetupView(state.hermes)?.label ?? "Setting up Bud"}</h1>
            <p className="flex items-center gap-2 text-sm text-ink-secondary">
              {running && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />}
              {running ? "RealBud opens as soon as Bud is ready." : "Bud isn’t ready yet. You can use the rest of RealBud meanwhile."}
            </p>
          </header>
          <BudSetupCard id="bud-setup-screen" onBack={running ? undefined : onLeave} backLabel="Use RealBud without Bud for now" />
          {running ? (
            <button type="button" onClick={onLeave} className="pm-control self-center rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected">
              Explore the sample desk
            </button>
          ) : null}
        </main>
      </div>
    </div>
  );
}
