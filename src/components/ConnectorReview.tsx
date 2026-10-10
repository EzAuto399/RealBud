import { useState } from "react";
import { Plug } from "lucide-react";
import { CONSEQUENTIAL_WARNING, MAX_TOOL_DESCRIPTION, type ConnectorEntryView, type ConnectorToolClass } from "@shared/mcp-connector";
import type { ConnectorRegistryControls, ConnectorReviewSelection } from "@/lib/mcp-connector-api";
import { useUnsavedGuard } from "@/lib/unsaved-work";

const control = "pm-control inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-sheet px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${control} !border-agency/30 !bg-agency !text-white hover:!bg-agency-hover`;
const field = "pm-control min-w-0 flex-1 rounded-lg border border-line bg-sheet px-3 text-[13px] text-ink";

/** What the service's own name and annotations suggest. It can only make a tool stricter. */
export const CLASS_LABEL: Record<ConnectorToolClass, string> = {
  read: "Looks read-only · asks you each time unless trusted",
  write: "Changes data · asks you each time",
  consequential: "Consequential action · may send, pay, delete or change access",
};

/** The owner's review of what an added service offers. Descriptions come from
 *  the service: shown as plain, shortened text, never as markup or instructions.
 *  Everything starts off. A turned-on tool asks every time; only a read-looking
 *  tool can be trusted to run without a card; a consequential tool needs the
 *  warning accepted first and always shows its own card. */
export function ConnectorReview({ entry, busy, onApprove, onCancel }: {
  entry: ConnectorEntryView; busy: boolean; onApprove: (selection: ConnectorReviewSelection) => void; onCancel: () => void;
}) {
  const initial = (pick: (tool: ConnectorEntryView["tools"][number]) => boolean) => new Set(entry.tools.filter(pick).map(tool => tool.name));
  const [enabled, setEnabled] = useState(() => initial(tool => tool.enabled && tool.toolClass !== "consequential"));
  const [trusted, setTrusted] = useState(() => initial(tool => tool.trusted));
  const [consequential, setConsequential] = useState(() => initial(tool => tool.enabled && tool.toolClass === "consequential"));
  const [warned, setWarned] = useState(false);
  // Choices that differ from the saved review hold beforeunload and the update restart until approved or closed.
  const same = (now: Set<string>, saved: Set<string>) => now.size === saved.size && [...now].every(name => saved.has(name));
  useUnsavedGuard(!same(enabled, initial(tool => tool.enabled && tool.toolClass !== "consequential")) || !same(trusted, initial(tool => tool.trusted))
    || !same(consequential, initial(tool => tool.enabled && tool.toolClass === "consequential")));
  const flip = (set: (update: (current: Set<string>) => Set<string>) => void, name: string) =>
    set(current => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const toggle = (name: string, toolClass: ConnectorToolClass) => {
    if (toolClass === "consequential") { flip(setConsequential, name); return; }
    flip(setEnabled, name);
    setTrusted(current => { const next = new Set(current); next.delete(name); return next; });
  };
  const hasConsequential = consequential.size > 0;
  return (
    <section aria-label={`Review tools for ${entry.label}`} className="mt-3 rounded-lg border border-line p-3">
      <h5 className="text-[13px] font-medium text-ink">Review what Bud may use</h5>
      <p className="mt-1 text-[12px] text-ink-secondary">Descriptions are the service's own words. Turn on only what the office needs.</p>
      {entry.tools.length ? (
        <ul className="mt-2 space-y-2">
          {entry.tools.map(tool => (
            <li key={tool.name} className="flex items-start gap-2">
              <input type="checkbox" className="mt-1 size-4" aria-label={`Allow ${tool.name}`} checked={tool.toolClass === "consequential" ? consequential.has(tool.name) : enabled.has(tool.name)}
                disabled={busy} onChange={() => toggle(tool.name, tool.toolClass)} />
              <div className="min-w-0 flex-1">
                <p className="break-words text-[12.5px] font-medium text-ink"><code>{tool.name}</code> <span className={tool.toolClass === "consequential" ? "text-hold" : "text-ink-secondary"}>· {CLASS_LABEL[tool.toolClass]}</span></p>
                {tool.description ? <p className="break-words text-[12px] text-ink-muted">{tool.description.slice(0, MAX_TOOL_DESCRIPTION)}</p> : null}
                {tool.toolClass === "read" && enabled.has(tool.name) ? (
                  <label className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-secondary">
                    <input type="checkbox" className="size-4" aria-label={`Trust ${tool.name} to read without asking`} checked={trusted.has(tool.name)} disabled={busy} onChange={() => flip(setTrusted, tool.name)} />
                    Trusted read · runs without a card
                  </label>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : <p role="status" className="mt-2 text-[12px] text-ink-secondary">No tools listed yet. Connect the service, then check it.</p>}
      {entry.oversized ? <p role="alert" className="mt-2 text-[12px] text-hold">This service lists more tool detail than RealBud can keep for review. Ask the provider for a smaller tool set.</p> : null}
      {hasConsequential ? (
        <label className="mt-3 flex items-start gap-2 rounded-lg bg-agency-soft p-2 text-[12px] text-ink">
          <input type="checkbox" className="mt-0.5 size-4" aria-label="Accept the consequential action warning" checked={warned} disabled={busy} onChange={event => setWarned(event.target.checked)} />
          <span>{CONSEQUENTIAL_WARNING} Every call will show a Consequential action card, and only while you are in Ask.</span>
        </label>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={busy || !entry.proposalDigest || entry.oversized || (hasConsequential && !warned)}
          onClick={() => onApprove({ enabled: [...enabled], trusted: [...trusted].filter(name => enabled.has(name)), consequential: [...consequential], ...(hasConsequential ? { warning: CONSEQUENTIAL_WARNING } : {}) })}>Approve and turn on</button>
        <button type="button" className={control} disabled={busy} onClick={onCancel}>Not now</button>
      </div>
    </section>
  );
}

function stateLine(entry: ConnectorEntryView): { text: string; problem: boolean } {
  if (entry.state === "quarantined") return { text: "Needs review · the service changed its tools, so Bud can't use it", problem: true };
  if (entry.state === "pending_review") return { text: entry.proposalDigest ? "Needs review before Bud can use it" : "Connect it to list its tools", problem: true };
  const on = entry.tools.filter(tool => tool.enabled);
  return { text: `Reviewed · ${on.length} tools on, ${on.filter(tool => tool.trusted).length} without a card`, problem: false };
}
function healthLine(entry: ConnectorEntryView): string {
  const c = entry.connection;
  if (c.status === "connected") return c.account ? `Connected · ${c.account.label}` : "Connected";
  if (c.status === "connecting") return "Finish signing in in your browser";
  if (c.status === "not_connected") return "Not connected";
  return c.reason ?? "Not available right now";
}

function ConnectorRow({ entry, controls, canManage }: { entry: ConnectorEntryView; controls: ConnectorRegistryControls; canManage: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const [confirm, setConfirm] = useState<"disconnect" | "remove" | null>(null);
  const [token, setToken] = useState("");
  const busy = controls.state.busy !== null;
  const sr = <span className="sr-only"> for {entry.label}</span>;
  const connected = entry.connection.status === "connected";
  const tokenForm = canManage && !connected && entry.auth === "header";
  // A typed access token holds beforeunload and the update restart until it is saved.
  useUnsavedGuard(tokenForm && Boolean(token.trim()));
  const state = stateLine(entry);
  return (
    <li className="rounded-xl border border-line bg-sheet p-3" data-connector-id={entry.id}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary"><Plug size={18} /></span>
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-[13px] font-medium text-ink">{entry.label}</h4>
          <p className="break-all text-[11.5px] text-ink-muted">{entry.serverUrl}</p>
        </div>
      </div>
      <p role="status" className={`mt-2 text-[12px] font-medium ${state.problem ? "text-hold" : "text-agency"}`}>{state.text}</p>
      <p className="mt-1 text-[12px] text-ink-secondary">{healthLine(entry)}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canManage && !connected && entry.auth === "oauth" ? <button type="button" className={primary} disabled={busy} onClick={() => void controls.connect(entry.id)}>Connect{sr}</button> : null}
        {tokenForm ? (
          <form className="flex min-w-0 flex-1 flex-wrap gap-2" onSubmit={event => { event.preventDefault(); const value = token; setToken(""); void controls.setToken(entry.id, value); }}>
            <input type="password" autoComplete="off" aria-label={`Access token for ${entry.label}`} placeholder="Access token" className={field} value={token} maxLength={4096} onChange={event => setToken(event.target.value)} />
            <button type="submit" className={primary} disabled={busy || !token.trim()}>Save token{sr}</button>
          </form>
        ) : null}
        {connected ? <button type="button" className={control} disabled={busy} onClick={() => void controls.check(entry.id)}>Check{sr}</button> : null}
        {canManage && entry.proposalDigest ? <button type="button" className={control} disabled={busy} aria-expanded={reviewing} onClick={() => setReviewing(value => !value)}>Review tools{sr}</button> : null}
        {canManage && connected ? (confirm === "disconnect"
          ? <><button type="button" className={`${control} !text-danger`} disabled={busy} onClick={() => { setConfirm(null); void controls.disconnect(entry.id); }}>Confirm disconnect{sr}</button>
              <button type="button" className={control} onClick={() => setConfirm(null)}>Keep connected</button></>
          : <button type="button" className={control} disabled={busy} onClick={() => setConfirm("disconnect")}>Disconnect{sr}</button>) : null}
        {canManage ? (confirm === "remove"
          ? <><button type="button" className={`${control} !text-danger`} disabled={busy} onClick={() => { setConfirm(null); void controls.remove(entry.id); }}>Confirm remove{sr}</button>
              <button type="button" className={control} onClick={() => setConfirm(null)}>Keep it</button></>
          : <button type="button" className={control} disabled={busy} onClick={() => setConfirm("remove")}>Remove{sr}</button>) : null}
      </div>
      {reviewing && entry.proposalDigest ? <ConnectorReview entry={entry} busy={busy} onCancel={() => setReviewing(false)}
        onApprove={selection => { void controls.review(entry.id, entry.proposalDigest!, selection).then(ok => { if (ok) setReviewing(false); }); }} /> : null}
    </li>
  );
}

/** Services the office added by address, under the app catalogue. Only the
 *  owner or an administrator adds, reviews, disconnects or removes them. */
export function OfficeConnectors({ controls }: { controls: ConnectorRegistryControls }) {
  const { view, loading, readError, notice, busy } = controls.state;
  const [serverUrl, setServerUrl] = useState("");
  const [label, setLabel] = useState("");
  const [tokenAuth, setTokenAuth] = useState(false);
  const canManage = view?.canManage === true;
  // A typed server address or name holds beforeunload and the update restart until the connector is added.
  useUnsavedGuard(canManage && Boolean(serverUrl.trim() || label.trim()));
  const added = view?.connectors.filter(entry => !entry.builtIn) ?? [];
  return (
    <section aria-label="Added services" className="mt-4 border-t border-line pt-3">
      <h3 className="text-[13px] font-medium text-ink">Add a connector</h3>
      <p className="mt-1 text-[12.5px] text-ink-secondary">Connect another service by its server address. You review what Bud may use before it can use anything.</p>
      {!view && loading ? <p role="status" className="mt-2 text-[12px] text-ink-secondary">Checking added services…</p> : null}
      {readError ? <p role="alert" className="mt-2 text-[12px] text-hold">{readError}</p> : null}
      {view && canManage ? (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={event => {
          event.preventDefault();
          void controls.add({ serverUrl: serverUrl.trim(), label: label.trim(), auth: tokenAuth ? "header" : "oauth" }).then(ok => { if (ok) { setServerUrl(""); setLabel(""); setTokenAuth(false); } });
        }}>
          <input type="url" aria-label="Server address" placeholder="https://…" className={field} value={serverUrl} maxLength={2048} onChange={event => setServerUrl(event.target.value)} />
          <input type="text" aria-label="Connector name" placeholder="Name" className={field} value={label} maxLength={60} onChange={event => setLabel(event.target.value)} />
          <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary"><input type="checkbox" className="size-4" checked={tokenAuth} onChange={event => setTokenAuth(event.target.checked)} />Uses an access token</label>
          <button type="submit" className={primary} disabled={busy !== null || !serverUrl.trim() || !label.trim()}>Add connector</button>
        </form>
      ) : view ? <p className="mt-2 text-[12px] text-ink-muted">The office owner can add services here.</p> : null}
      {notice ? <p role={notice.problem ? "alert" : "status"} className={`mt-2 text-[12px] ${notice.problem ? "text-hold" : "text-ink-secondary"}`}>{notice.text}</p> : null}
      {added.length ? <ul className="mt-3 grid grid-cols-1 gap-3">{added.map(entry => <ConnectorRow key={entry.id} entry={entry} controls={controls} canManage={canManage} />)}</ul> : null}
    </section>
  );
}
