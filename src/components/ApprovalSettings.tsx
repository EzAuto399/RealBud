// Workspace → Approvals: how often Bud asks before using each connected app,
// website and office connector. Reads and saves `/api/approvals` (the store
// checks edit rights and the revision); saved site rules stay revocable here.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, useStore } from "@/state/store";
import { fmtDateTime } from "@/lib/au";
import { isPortalSiteRule, portalRuleLabel } from "@/lib/portal-job";
import { useOfficeSources } from "@/lib/connected-apps-refresh";
import { cn } from "@/lib/cn";
import { officeAppLabel } from "@shared/office-sources";
import { CONNECTORS_API, parseConnectorRegistry } from "@shared/mcp-connector";
import { approvalGroupKey, defaultApprovalSettings, normalizeApprovalSettings, PER_INSTANCE_CLASSES, READ_ONLY_APP_TOOLS, type ApprovalChoice, type ApprovalSettings } from "@shared/approval-settings";
import { StatusLabel } from "./pm";

export const APPROVALS_INTRO = "Bud always asks before it sends, pays, signs, files a notice, changes an account or deletes. Choose how often it asks about everything else.";
export const STALE_SAVE = "Someone changed these settings. Review the latest and save again.";
const UNREADABLE = "Approval settings could not be read. Try again.";
const UNCONFIRMED = "RealBud did not confirm this save. Check the settings below before saving again.";

export type RowKind = "managed" | "direct" | "site" | "connector" | "locked";
export interface ApprovalRow { key: string; label: string; kind: RowKind }
const RWA = "read-without-asking" as const;
/** A row's choice; null is nothing saved (a website's Recommended). */
type RowChoice = ApprovalChoice | null;
const OPTIONS: Record<RowKind, Array<[RowChoice, string]>> = {
  managed: [[RWA, "Recommended"], ["ask", "Ask every time"], ["deny", "Don't use"]],
  connector: [[RWA, "Recommended"], ["ask", "Ask every time"], ["deny", "Don't use"]],
  direct: [["ask", "Ask every time"], [RWA, "Read without asking"], ["deny", "Don't use"]],
  // Recommended (nothing saved) is today's behaviour: approved workflows and saved rules read; Bud asks otherwise.
  site: [[null, "Recommended"], [RWA, "Read without asking"], ["deny", "Don't use"]],
  locked: [["ask", "Ask"], ["deny", "Don't use"]],
};
/** What an unset row does; choosing it removes the saved entry. */
const DEFAULT: Record<RowKind, RowChoice> = { managed: RWA, connector: RWA, direct: "ask", site: null, locked: "ask" };
const CHOICE_WORDS: Record<ApprovalChoice, string> = { [RWA]: "Read without asking", ask: "Ask every time", deny: "Don't use" };
export const SITE_HINT = "Recommended: approved workflows read this site; Bud asks before reading anywhere else here.";
/** A row's choices. A website saved as Ask every time (Bud may propose it as stricter) shows that choice only while it is saved. */
export function rowOptions(kind: RowKind, saved: ApprovalChoice | undefined): Array<[RowChoice, string]> {
  return kind === "site" && saved === "ask" ? [...OPTIONS.site, ["ask", CHOICE_WORDS.ask]] : OPTIONS[kind];
}
const LOCKED: Record<string, string> = { send: "Sending messages", pay: "Payments", sign: "Signing", notice: "Notices", "account-change": "Account changes", trash: "Deleting",
  upload: "Uploading files", submit: "Submitting forms", memory: "Memory changes", settings: "Settings changes", script: "Scripts", consequential: "Other steps that can't be undone" };
export const LOCKED_ROWS: ApprovalRow[] = PER_INSTANCE_CLASSES.map(cls => ({ key: `class:${cls}`, label: LOCKED[cls] ?? cls, kind: "locked" }));

export interface DepartmentApprovals { id: string; name: string; canEdit: boolean; governs: boolean; revision: string; settings: ApprovalSettings }
export interface ApprovalsPayload { scope: "computer" | "office"; local: { revision: number; canEdit: boolean; settings: ApprovalSettings }; departments: DepartmentApprovals[] }
export interface ApprovalChange { at: number; by: string; before: ApprovalSettings; after: ApprovalSettings }
interface SavedRule { id: string; key: string; label: string; surface?: string; origin?: string }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const say = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message : fallback;

/** GET /api/approvals, re-validated; a malformed reply throws. */
export function readApprovalsPayload(body: unknown): ApprovalsPayload {
  try {
    if (!object(body) || (body.scope !== "computer" && body.scope !== "office") || !object(body.local) || !Array.isArray(body.departments)) throw new Error();
    const local = body.local;
    if (!Number.isSafeInteger(local.revision) || typeof local.canEdit !== "boolean") throw new Error();
    const departments = body.departments.map((row: unknown) => {
      if (!object(row) || !text(row.id, 64) || !text(row.name, 120) || typeof row.canEdit !== "boolean" || typeof row.governs !== "boolean" || typeof row.revision !== "string") throw new Error();
      return { id: row.id, name: row.name, canEdit: row.canEdit, governs: row.governs, revision: row.revision, settings: normalizeApprovalSettings(row.settings) };
    });
    return { scope: body.scope, local: { revision: Number(local.revision), canEdit: local.canEdit, settings: normalizeApprovalSettings(local.settings) }, departments };
  } catch { throw new Error(UNREADABLE); }
}
/** GET /api/approvals/history: this computer's receipts or a department's revisions, newest first. */
export function readApprovalHistory(body: unknown): ApprovalChange[] {
  if (!object(body) || !Array.isArray(body.entries)) throw new Error("Changes could not be read.");
  return body.entries.slice(0, 10).map((row: unknown) => {
    const by = object(row) ? (object(row.by) ? row.by.displayName : row.by) : undefined, at = object(row) ? Date.parse(String(row.at)) : NaN;
    if (!object(row) || !text(by, 120) || !Number.isFinite(at)) throw new Error("Changes could not be read.");
    return { at, by, before: normalizeApprovalSettings(row.before), after: normalizeApprovalSettings(row.after) };
  });
}

/** One row per connected app, website and office connector, plus anything already saved. */
export function approvalRows(input: { apps: string[]; managed: boolean; sites: string[]; connectors: Array<{ id: string; label: string }>; saved: string[] }): ApprovalRow[] {
  const rows = new Map<string, ApprovalRow>();
  const add = (key: string, label: string, kind: RowKind) => { if (approvalGroupKey(key) && !rows.has(key)) rows.set(key, { key, label, kind }); };
  const appKind: RowKind = input.managed ? "managed" : "direct";
  for (const slug of input.apps) add(`app:${slug}`, officeAppLabel(slug), appKind);
  for (const host of input.sites) add(`site:${host}`, host, "site");
  for (const row of input.connectors) add(`connector:${row.id}`, row.label, "connector");
  for (const key of input.saved) {
    const rest = key.slice(key.indexOf(":") + 1);
    if (key.startsWith("app:")) add(key, officeAppLabel(rest), appKind);
    else if (key.startsWith("site:")) add(key, rest, "site");
    else if (key.startsWith("connector:")) add(key, rest, "connector");
  }
  const order: RowKind[] = ["managed", "direct", "site", "connector"];
  return [...rows.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.label.localeCompare(b.label));
}
const choiceWord = (row: ApprovalRow | undefined, choice: ApprovalChoice | undefined) =>
  choice === undefined ? "Recommended" : OPTIONS[row?.kind ?? "site"].find(([value]) => value === choice)?.[1] ?? CHOICE_WORDS[choice] ?? choice;
const toolWords = (tool: string) => { const words = tool.replace(/^[A-Z0-9]+_/, "").toLowerCase().replace(/_/g, " "); return words.charAt(0).toUpperCase() + words.slice(1); };
const rowLabel = (rows: ApprovalRow[], key: string) => rows.find(row => row.key === key)?.label ?? key.slice(key.indexOf(":") + 1);
/** "Sam · Gmail: Recommended → Ask every time · 8 Oct, 2:14 pm" for each difference. */
export function changeLines(change: ApprovalChange, rows: ApprovalRow[]): string[] {
  const when = fmtDateTime(change.at), lines: string[] = [];
  for (const key of [...new Set([...Object.keys(change.before.groups), ...Object.keys(change.after.groups)])].sort()) {
    const before = change.before.groups[key], after = change.after.groups[key];
    if (before === after) continue;
    const row = rows.find(item => item.key === key);
    lines.push(`${change.by} · ${rowLabel(rows, key)}: ${choiceWord(row, before)} → ${choiceWord(row, after)} · ${when}`);
  }
  for (const tool of change.after.reviewedReads.filter(item => !change.before.reviewedReads.includes(item))) lines.push(`${change.by} · Marked ${toolWords(tool)} as only reading · ${when}`);
  for (const tool of change.before.reviewedReads.filter(item => !change.after.reviewedReads.includes(item))) lines.push(`${change.by} · Unmarked ${toolWords(tool)} · ${when}`);
  return lines.length ? lines : [`${change.by} · Saved with no changes · ${when}`];
}
const fingerprint = (settings: ApprovalSettings) => JSON.stringify([Object.entries(settings.groups).sort(), [...settings.reviewedReads].sort()]);
/** The operator's own edits, kept on top of the latest saved settings. */
function rebase(latest: ApprovalSettings, base: ApprovalSettings, draft: ApprovalSettings): ApprovalSettings {
  const groups = { ...latest.groups };
  for (const key of new Set([...Object.keys(base.groups), ...Object.keys(draft.groups)])) {
    if (base.groups[key] === draft.groups[key]) continue;
    if (draft.groups[key] === undefined) delete groups[key]; else groups[key] = draft.groups[key];
  }
  const reviewed = new Set(latest.reviewedReads);
  for (const tool of draft.reviewedReads) if (!base.reviewedReads.includes(tool)) reviewed.add(tool);
  for (const tool of base.reviewedReads) if (!draft.reviewedReads.includes(tool)) reviewed.delete(tool);
  return { ...latest, groups, reviewedReads: [...reviewed].sort() };
}
const settingsFor = (payload: ApprovalsPayload, target: string | null) => payload.departments.find(row => row.id === target)?.settings ?? payload.local.settings;
/** The settings that govern this desktop: its first governing department, else this computer's own. */
const firstTarget = (payload: ApprovalsPayload) => payload.departments.find(row => row.governs)?.id ?? null;
const hostOf = (origin: string) => { try { return new URL(origin.includes("://") ? origin : `https://${origin}`).hostname.toLowerCase(); } catch { return ""; } };

export function ApprovalSettings() {
  const { state } = useStore();
  const { snapshot: officeApps } = useOfficeSources();
  const managed = state.config?.composio?.managed === true;
  const [payload, setPayload] = useState<ApprovalsPayload | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState<ApprovalSettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState<{ tone: "ok" | "hold" | "danger"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [history, setHistory] = useState<ApprovalChange[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [rules, setRules] = useState<SavedRule[] | null>(null);
  const [rulesError, setRulesError] = useState("");
  const [sites, setSites] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<Array<{ id: string; label: string }>>([]);
  const [listNote, setListNote] = useState("");
  const [owner, setOwner] = useState(false);

  const loadHistory = useCallback((department: string | null) => {
    setHistoryError("");
    void api(`/api/approvals/history${department ? `?departmentId=${encodeURIComponent(department)}` : ""}`)
      .then(body => setHistory(readApprovalHistory(body)))
      .catch(cause => setHistoryError(say(cause, "Changes could not be read.")));
  }, []);
  /** Reloads the settings; `wanted` keeps the chosen department, `keep` carries the operator's edits over. */
  const load = useCallback(async (wanted?: string | null, keep?: { base: ApprovalSettings; draft: ApprovalSettings }) => {
    setLoadError("");
    try {
      const next = readApprovalsPayload(await api("/api/approvals", undefined, { timeoutMs: 20_000 }));
      const chosen = wanted !== undefined && (wanted === null || next.departments.some(row => row.id === wanted)) ? wanted : firstTarget(next);
      const latest = settingsFor(next, chosen);
      setPayload(next); setTarget(chosen);
      setDraft(keep ? rebase(latest, keep.base, keep.draft) : latest);
      loadHistory(chosen);
      if (next.scope === "computer") setOwner(true);
      // Only the owner marks tools as only reading; the store refuses anyone else, so this only hides the links.
      else void import("@/lib/company-api").then(module => module.companyApi.status()).then(company => setOwner(company.member?.role === "owner"), () => setOwner(false));
    } catch (cause) { setLoadError(say(cause, UNREADABLE)); }
  }, [loadHistory]);
  const loadRules = useCallback(() => {
    setRulesError("");
    void api("/api/rules").then(body => {
      if (!Array.isArray(body.rules)) throw new Error("Saved rules could not be read.");
      setRules(body.rules.filter((rule: unknown): rule is SavedRule => object(rule) && text(rule.id, 80) && typeof rule.key === "string" && typeof rule.label === "string"));
    }).catch(cause => setRulesError(say(cause, "Saved rules could not be read.")));
  }, []);

  useEffect(() => {
    void load();
    loadRules();
    // Websites Bud works in (saved jobs and site rules) and the office's connectors give the rows.
    void Promise.allSettled([api("/api/recipes"), api(CONNECTORS_API, undefined, { timeoutMs: 20_000 })]).then(([recipes, registry]) => {
      const notes: string[] = [];
      if (recipes.status === "fulfilled" && Array.isArray(recipes.value?.recipes)) {
        setSites(recipes.value.recipes.flatMap((recipe: { allowedOrigins?: unknown }) => Array.isArray(recipe.allowedOrigins) ? recipe.allowedOrigins.map(String).map(hostOf) : []));
      } else notes.push("websites from saved jobs");
      const parsed = registry.status === "fulfilled" ? parseConnectorRegistry(registry.value) : null;
      if (parsed) setConnectors(parsed.connectors.filter(row => row.state === "active" && row.connection.status === "connected").map(row => ({ id: row.id, label: row.label })));
      else notes.push("office connectors");
      setListNote(notes.length ? `Some rows may be missing: ${notes.join(" and ")} could not be listed.` : "");
    });
  }, [load, loadRules]);

  const department = payload?.departments.find(row => row.id === target) ?? null;
  const saved = payload ? settingsFor(payload, target) : null;
  const revision = department ? department.revision : payload?.local.revision;
  const canEdit = department ? department.canEdit : payload?.local.canEdit === true;
  const editors = department?.name ?? payload?.departments.find(row => row.governs && !row.canEdit)?.name ?? "this office's settings";
  const ruleSites = (rules ?? []).flatMap(rule => isPortalSiteRule(rule) && rule.origin ? [hostOf(rule.origin)] : []);
  const rows = draft ? approvalRows({
    apps: Object.entries(officeApps?.services ?? {}).filter(([, service]) => service.connected).map(([slug]) => slug),
    managed, sites: [...sites, ...ruleSites], connectors, saved: Object.keys({ ...saved?.groups, ...draft.groups }),
  }) : [];
  const dirty = !!draft && !!saved && fingerprint(draft) !== fingerprint(saved);

  const choose = (row: ApprovalRow, choice: RowChoice) => setDraft(current => {
    if (!current) return current;
    const groups = { ...current.groups };
    if (choice === null || choice === DEFAULT[row.kind]) delete groups[row.key]; else groups[row.key] = choice;
    return { ...current, groups };
  });
  const toggleReviewed = (tool: string) => setDraft(current => current && ({ ...current,
    reviewedReads: current.reviewedReads.includes(tool) ? current.reviewedReads.filter(item => item !== tool) : [...current.reviewedReads, tool].sort() }));
  const save = async (settings: ApprovalSettings, done: string) => {
    if (!saved || saving || revision === undefined) return;
    setSaving(true); setStatus(null); setConfirmReset(false);
    try {
      await api("/api/approvals", { method: "PUT", body: JSON.stringify({ ...(department ? { departmentId: department.id } : {}), expectedRevision: revision, settings }) }, { timeoutMs: 20_000 });
      setStatus({ tone: "ok", text: done });
      await load(target);
    } catch (cause) {
      const code = (cause as { status?: unknown }).status;
      if (typeof code === "number" && code < 500 && code !== 409) setStatus({ tone: "danger", text: say(cause, "These settings were not saved.") });
      else {
        // A conflict or a lost reply: show the latest, keeping this person's own edits to review.
        setStatus({ tone: "hold", text: code === 409 ? STALE_SAVE : typeof code === "number" ? say(cause, UNCONFIRMED) : UNCONFIRMED });
        await load(target, { base: saved, draft: settings });
      }
    } finally { setSaving(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (draft && dirty && canEdit) void save(draft, "Saved. Bud uses these from its next request."); };
  const revoke = (rule: SavedRule) => {
    setRulesError("");
    void api(`/api/rules/${rule.id}`, { method: "DELETE" }).then(() => loadRules()).catch(cause => setRulesError(say(cause, "This rule was not revoked.")));
  };

  const source = (key: string) => !draft || !saved ? "" : draft.groups[key] !== saved.groups[key] ? "Not saved yet"
    : Object.hasOwn(saved.groups, key) ? (department ? `Set by ${department.name}` : "Saved on this computer") : "Recommended";
  const renderRow = (row: ApprovalRow) => {
    const current = draft?.groups[row.key] ?? DEFAULT[row.kind];
    const prefix = `${row.key.slice(4).toUpperCase()}_`;
    const tools = row.kind === "direct" ? [...READ_ONLY_APP_TOOLS].filter(tool => tool.startsWith(prefix)).sort() : [];
    const reviewed = tools.some(tool => draft?.reviewedReads.includes(tool));
    return (
      <li key={row.key} className="border-b border-line py-3 last:border-b-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-[14px] font-medium text-ink">{row.label}</span>
          <span className="text-[12px] text-ink-muted">{source(row.key)}</span>
        </div>
        <div role="radiogroup" aria-label={row.label} className="mt-2 flex flex-wrap gap-1.5">
          {rowOptions(row.kind, saved?.groups[row.key]).map(([value, words]) => {
            // A direct connection reads without asking only the tools the owner marked.
            const unavailable = row.kind === "direct" && value === RWA && !reviewed && current !== RWA;
            return (
              <label key={value ?? "recommended"} className={cn("pm-control inline-flex cursor-pointer items-center rounded border px-3 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-agency",
                current === value ? "border-agency bg-selected font-medium text-ink" : "border-field-border bg-sheet text-ink-secondary hover:bg-raised",
                (!canEdit || unavailable) && "cursor-not-allowed opacity-60")}>
                <input type="radio" className="sr-only" name={`approval-${row.key}`} value={value ?? "recommended"} checked={current === value} disabled={!canEdit || unavailable} onChange={() => choose(row, value)} />
                {words}
              </label>
            );
          })}
        </div>
        {row.kind === "direct" && !reviewed ? <p className="mt-1 text-[12px] text-ink-muted">Read without asking needs the owner to mark which tools only read.</p> : null}
        {row.kind === "site" ? <p className="mt-1 text-[12px] text-ink-muted">{SITE_HINT}</p> : null}
        {row.kind === "direct" && owner && tools.length ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-[13px] text-agency">Tools that only read</summary>
            <p className="mt-1 text-[12px] text-hold">Only mark this if it never changes anything in {row.label}.</p>
            <ul className="mt-1">
              {tools.map(tool => {
                const marked = draft?.reviewedReads.includes(tool) === true;
                return (
                  <li key={tool} className="flex flex-wrap items-center justify-between gap-2 py-0.5 text-[13px] text-ink">
                    <span>{toolWords(tool)}</span>
                    <button type="button" disabled={!canEdit} aria-pressed={marked} aria-label={`${toolWords(tool)}: this only reads`}
                      className="pm-control text-[12.5px] text-agency underline-offset-2 hover:underline disabled:opacity-60" onClick={() => toggleReviewed(tool)}>
                      {marked ? "Marked as only reading" : "This only reads"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </li>
    );
  };

  return (
    <section aria-label="Approval settings" className="flex min-w-0 flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink">{APPROVALS_INTRO}</p>
      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
          <span>{loadError}</span>
          <button type="button" className="pm-control text-agency hover:underline" onClick={() => void load(target)}>Retry</button>
        </div>
      ) : !payload || !draft ? (
        <div className="space-y-2" role="status" aria-label="Loading approval settings">
          <div className="h-3 w-[75%] max-w-[16rem] animate-pulse rounded bg-raised motion-reduce:animate-none" />
          <div className="h-3 w-[50%] max-w-[10rem] animate-pulse rounded bg-raised motion-reduce:animate-none" />
        </div>
      ) : (
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          {payload.departments.length ? (
            <label className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
              Settings for
              <select className="pm-control min-w-0 max-w-full rounded border border-field-border bg-sheet px-2 text-[14px]" value={target ?? ""}
                onChange={event => { setStatus(null); void load(event.target.value || null); }}>
                {payload.departments.some(row => row.governs) ? null : <option value="">This computer</option>}
                {payload.departments.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </label>
          ) : null}
          {!canEdit ? <p className="text-[13px] text-hold">Only people who can edit {editors} can change these.</p> : null}
          {rows.length ? (
            <div>
              <p className="text-[12.5px] leading-relaxed text-ink-muted">
                {[rows.some(row => row.kind === "managed" || row.kind === "connector") ? "Recommended: Bud reads and drafts without asking; sends and changes ask." : "",
                  rows.some(row => row.kind === "direct" || row.kind === "site") ? "Read without asking: Bud reads, and asks before changing anything." : ""].filter(Boolean).join(" ")}
              </p>
              <ul className="mt-1">{rows.map(renderRow)}</ul>
            </div>
          ) : (
            <p className="text-[13px] leading-relaxed text-ink-secondary">No apps, websites or office connectors are connected yet. Each one appears here once you connect it.</p>
          )}
          {listNote ? <p className="text-[12px] text-hold">{listNote}</p> : null}
          <details className="settings-section">
            <summary><span>Always asks, every time</span><span className="settings-section-hint">Sending, paying, signing, notices, account changes, deleting and more</span></summary>
            <div className="settings-section-body"><ul>{LOCKED_ROWS.map(renderRow)}</ul></div>
          </details>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button type="submit" disabled={!dirty || saving || !canEdit} className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? "Saving…" : "Save changes"}
            </button>
            {canEdit && !confirmReset ? <button type="button" className="pm-control text-[13px] text-agency underline-offset-2 hover:underline" onClick={() => setConfirmReset(true)}>Reset to recommended</button> : null}
          </div>
          {confirmReset ? (
            <div role="group" aria-label="Reset to recommended" className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
              <span>Reset every row to recommended? Saved site rules stay.</span>
              <button type="button" disabled={saving} className="pm-control rounded border border-line px-3 hover:bg-raised" onClick={() => void save({ ...defaultApprovalSettings(), reviewedReads: saved?.reviewedReads ?? [] }, "Reset to recommended.")}>Reset</button>
              <button type="button" className="pm-control rounded px-3 text-ink-muted hover:bg-raised" onClick={() => setConfirmReset(false)}>Cancel</button>
            </div>
          ) : null}
          <p role={status?.tone === "danger" ? "alert" : "status"} aria-live="polite" className={cn("text-[13px]", status?.tone === "ok" ? "text-agency" : status?.tone === "hold" ? "text-hold" : "text-danger")}>{status?.text}</p>
        </form>
      )}

      <div>
        <h4 className="text-[14px] font-medium text-ink">Saved on this computer</h4>
        {rulesError ? (
          <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-danger">
            <span>{rulesError}</span>
            <button type="button" className="pm-control text-agency hover:underline" onClick={loadRules}>Retry</button>
          </div>
        ) : null}
        {rules === null && !rulesError ? <p className="mt-1 text-[13px] text-ink-muted">Loading saved rules…</p> : null}
        {rules && !rules.length ? <p className="mt-1 text-[13px] text-ink-secondary">No saved rules.</p> : null}
        {rules?.length ? (
          <ul className="mt-1 text-[13px] text-ink">
            {rules.map(rule => (
              <li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 py-0.5">
                <span className="flex flex-wrap items-baseline gap-2">{portalRuleLabel(rule)}{isPortalSiteRule(rule) ? <StatusLabel tone="agency">Site rule</StatusLabel> : null}</span>
                {/* Revoking needs the same edit rights as saving; the server checks again. */}
                {payload?.local.canEdit === false ? null : (
                  <button type="button" aria-label={`Revoke ${portalRuleLabel(rule)}`} className="pm-control text-[12.5px] text-ink-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => revoke(rule)}>Revoke</button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div>
        <h4 className="text-[14px] font-medium text-ink">Changes</h4>
        {historyError ? <p role="alert" className="mt-1 text-[13px] text-danger">{historyError}</p> : null}
        {history && !history.length ? <p className="mt-1 text-[13px] text-ink-secondary">No changes yet.</p> : null}
        {history?.length ? <ul className="mt-1 space-y-0.5 text-[13px] text-ink-secondary">{history.flatMap((change, index) => changeLines(change, [...rows, ...LOCKED_ROWS]).map((line, row) => <li key={`${index}-${row}`}>{line}</li>))}</ul> : null}
      </div>
    </section>
  );
}
