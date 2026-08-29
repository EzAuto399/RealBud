import { Cable } from "lucide-react";

import { useStore } from "@/state/store";
import { VerifiedConnectionCard } from "./VerifiedConnectionCard";

export function LinkedToolsPanel({ query = "" }: { query?: string }) {
  const { state } = useStore();
  const tools = (state.config?.linkedTools ?? []).filter((tool) => {
    if (!query.trim()) return true;
    const haystack = `${tool.label} ${tool.slug}`.toLowerCase();
    return query.toLowerCase().split(/\s+/).every((term) => haystack.includes(term));
  });
  if (!tools.length) return null;
  return (
    <section aria-labelledby="linked-tools-heading" className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h3 id="linked-tools-heading" className="text-[12px] font-medium uppercase tracking-[0.12em] text-ink-secondary">
          Linked tools
        </h3>
        <span className="text-[12px] text-ink-muted">Key on this device</span>
      </div>
      <div className="space-y-2">
        {tools.map((tool) => (
          <VerifiedConnectionCard
            key={tool.slug}
            icon={<Cable size={18} />}
            title={tool.label}
            description={tool.account && tool.account !== "Key on this device"
              ? `${tool.account} is on this device. RealBud still cannot send.`
              : "Connected from Ask or You. RealBud still cannot send from this account."}
            meta={tool.method === "composio" ? "Signed in through Composio" : "Direct API key"}
            state={tool.connected ? "ready" : "off"}
            status={tool.connected ? "Connected" : "Not connected"}
          />
        ))}
      </div>
    </section>
  );
}
