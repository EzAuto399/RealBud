import { KeyRound } from "lucide-react";

import { useStore } from "@/state/store";
import { VerifiedConnectionCard } from "./VerifiedConnectionCard";
import { ComposioSignInPanel } from "./ComposioSignInPanel";

export function ComposioAccountCard() {
  const { state } = useStore();
  const configured = Boolean(state.config?.composio.configured);
  return (
    <section id="composio-account-setup" tabIndex={-1} className="scroll-m-28 space-y-2 outline-none">
      <VerifiedConnectionCard
        icon={<KeyRound size={18} />}
        title="Your Composio account"
        description="Login to your own Composio account, or paste a Connect key. Ask never receives the key, and this is not a tool marketplace."
        meta="Human-owned link · this device only · no send or pay tools"
        state={configured ? "ready" : "off"}
        status={configured ? "Key on this device" : "Not linked"}
      />
      <div className="border border-line bg-sheet px-4 py-3">
        <ComposioSignInPanel />
      </div>
    </section>
  );
}
