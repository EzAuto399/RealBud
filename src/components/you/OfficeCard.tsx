import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { officeDrafts, officeDraftScope, type EndedOfficeDraftReview, type OfficeChanges, type OfficeDraftContext } from "@/lib/office-draft-journal";

import {
  AU_JURISDICTIONS, EXPORT_CADENCE_LABELS, EXPORT_CADENCES,
  EXPORT_IDENTITY_COLUMNS, EXPORT_IDENTITY_LABELS, OFFICE_OS, OFFICE_OS_LABELS,
  PMS_BRAND_LABELS, PMS_BRANDS, coerceOffice, readClosed, type OfficeInput,
} from "../../../shared/office";
import { cn } from "@/lib/cn";
import { officeSetup } from "@/lib/office-setup";
import { Card } from "../SettingsPrimitives";
import {
  defaultRentWorkflow, RENT_RECEIPT_CHANNELS, RENT_RECEIPT_CHANNEL_LABELS,
  RENT_VERIFICATION_METHODS, RENT_VERIFICATION_LABELS, RENT_WORKFLOW_STEPS_MAX,
  type RentWorkflow, type RentVerificationMethod,
} from "../../../shared/rent-workflow";

const inputClass = "mt-1 w-full rounded-lg border border-line bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-agency";
const detailClass = "rounded-lg border border-line";
const summaryClass = "cursor-pointer px-3 py-3 text-[13px] font-medium text-ink";
const fieldsClass = "flex flex-col gap-3 border-t border-line p-3";
const labelClass = "text-[12.5px] text-ink-secondary";
const verificationOptionLabels: Record<RentVerificationMethod, string> = {
  "pm-review": "Ask the PM",
  "pms-ledger": "PMS rent ledger",
  "bank-allocation": "Settled bank credit",
};

export function OfficeCard({ agencyName, timezone, jurisdictions, office, profileName, revision, draftContext, currentSessionVersion, getCurrentSessionVersion, identityError, identityChecking, onRetryIdentity, onSave, onReload }: {
  agencyName: string;
  /** The zone the book recorded, or null when it has none. Never a fixture. */
  timezone: string | null;
  jurisdictions: string[];
  office?: OfficeInput | null;
  profileName?: string;
  revision: number;
  draftContext?: OfficeDraftContext | null;
  currentSessionVersion?: number;
  getCurrentSessionVersion?: () => number;
  identityError?: string;
  identityChecking?: boolean;
  onRetryIdentity?: () => void;
  onSave: (input: OfficeChanges) => Promise<void> | void;
  onReload: () => Promise<void>;
}) {
  // Overlay only user edits. Snapshot refreshes update untouched fields without
  // erasing a draft; saving never resubmits hidden, unchanged office metadata.
  useSyncExternalStore(officeDrafts.subscribe, officeDrafts.snapshot, officeDrafts.snapshot);
  const retained = draftContext ? officeDrafts.read(draftContext) : null;
  const changes = retained?.changes ?? {};
  const name = changes.name ?? agencyName;
  const states = changes.jurisdictions ?? jurisdictions;
  const draft = { ...coerceOffice(office), ...changes.office };
  const rentWorkflow = draft.rentWorkflow ?? defaultRentWorkflow();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [clearEnded, setClearEnded] = useState<EndedOfficeDraftReview | null>(null);
  const changed = Object.keys(changes).length > 0;
  const scope = draftContext ? officeDraftScope(draftContext) : null;
  const currentScope = useRef(scope); currentScope.current = scope;
  const identityHeld = !draftContext || Boolean(identityError) || Boolean(identityChecking);
  const revisionHeld = retained !== null && retained.startingRevision !== revision;
  const replyHeld = Boolean(retained?.needsReconciliation);
  const liveEpoch = currentSessionVersion ?? draftContext?.sessionVersion;
  const ended = liveEpoch === undefined ? null : officeDrafts.reviewEnded(liveEpoch);
  const savingDraft = Boolean(retained?.saving);
  useEffect(() => { setError(""); setSaved(false); setConflict(false); setClearEnded(null); }, [scope, liveEpoch]);
  const edit = (patch: OfficeChanges) => {
    if (identityHeld || !draftContext) return;
    try { officeDrafts.write(draftContext, revision, patch, retained?.sequence ?? null); setSaved(false); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The office draft could not be updated. Your typing is kept."); }
  };
  const editRent = (patch: Partial<RentWorkflow>) => edit({ office: { rentWorkflow: { ...rentWorkflow, ...patch } } });
  const discard = () => {
    if (draftContext && retained) officeDrafts.discard(draftContext, retained.sequence);
    setError(""); setSaved(false); setConflict(false);
  };
  const reload = async () => {
    if (saving.current || savingDraft || identityHeld) return;
    saving.current = true; setBusy(true);
    try { await onReload(); if (currentScope.current === scope) discard(); }
    catch { setError("Saved settings could not be reloaded. Your edits are still here."); }
    finally { saving.current = false; setBusy(false); }
  };
  const save = async () => {
    if (saving.current || savingDraft || !changed || conflict || revisionHeld || replyHeld || identityHeld || !draftContext || !retained) return;
    let sent;
    try { sent = officeDrafts.beginSave(draftContext, revision, retained.sequence); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The retained office draft changed. Review it before saving."); return; }
    saving.current = true; setBusy(true); setSaved(false); setError("");
    try {
      await onSave({ ...sent.changes, expectedRevision: sent.startingRevision, ...(sent.changes.name !== undefined ? { name: sent.changes.name.trim() } : {}) });
      officeDrafts.finishSave(sent.context, sent.sequence, true);
      if (currentScope.current === scope) setSaved(true);
    } catch (cause) {
      officeDrafts.finishSave(sent.context, sent.sequence, false, Boolean((cause as { officeOutcomeUnknown?: boolean })?.officeOutcomeUnknown));
      if (currentScope.current === scope) {
        setConflict((cause as { status?: number })?.status === 409);
        setError(cause instanceof Error ? cause.message : "Office details could not be saved. Your edits are still here.");
      }
    } finally { saving.current = false; setBusy(false); }
  };

  return <Card title="This office" subtitle="Set the basics for your book. Software and technical details can wait.">
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      {identityHeld && <div className="mb-3 space-y-2"><p role={identityError ? "alert" : "status"} className="text-[12.5px] text-ink-secondary">{identityError || "Checking the private workspace and office session before editing…"} Your retained drafts stay in their original workspace and session.</p>{identityError && onRetryIdentity && <button type="button" className="pm-control text-[13px] text-ink" disabled={identityChecking} onClick={onRetryIdentity}>Check office identity again</button>}</div>}
      {revisionHeld && <p role="status" className="mb-3 text-[12.5px] text-ink-secondary">The saved book changed. Your typing is kept. Discard edits and reload saved settings before saving.</p>}
      {replyHeld && <p role="status" className="mb-3 text-[12.5px] text-ink-secondary">The previous save reply could not be admitted. Your original typing is kept. Check saved settings before deciding whether to discard and reload; do not repeat the save.</p>}
      {(saved || changed) && <p role="status" className="mb-3 text-[12px] text-agency">{saved ? "Changes saved" : "Unsaved changes · kept in this window"}</p>}
      {ended && ended.endedCount > 0 && <div className="mb-3 space-y-2 text-[12.5px] text-ink-secondary">
        <p>{ended.endedCount} unsaved office {ended.endedCount === 1 ? 'draft is' : 'drafts are'} kept from ended sign-in sessions in this window. Their text stays private. {ended.savingCount > 0 && `${ended.savingCount} still being saved will be kept.`}</p>
        <button type="button" className="pm-control text-[13px] text-ink" disabled={!ended.discardableCount} onClick={() => { setClearEnded(officeDrafts.reviewEnded(getCurrentSessionVersion?.() ?? liveEpoch!)); setError(''); }}>Review clearing ended-session office drafts</button>
        {clearEnded && <div role="group" aria-label="Confirm permanent removal of ended-session office typing" className="rounded-lg border border-line p-3 space-y-2">
          <p>Clear {clearEnded.discardableCount} unsaved office {clearEnded.discardableCount === 1 ? 'draft' : 'drafts'} from ended sign-in sessions? This permanently removes that typing from this window’s memory. Saved office details and current-session drafts are unchanged. Drafts still being saved are kept.</p>
          <div className="flex flex-wrap gap-2"><button type="button" className="pm-control text-[13px] text-danger" onClick={() => {
            try { officeDrafts.discardEnded(clearEnded, getCurrentSessionVersion ?? (() => liveEpoch!)); setClearEnded(null); }
            catch (cause) { setClearEnded(null); setError(cause instanceof Error ? cause.message : 'Drafts changed. Review again; no typing was removed.'); }
          }}>Permanently clear {clearEnded.discardableCount} ended-session {clearEnded.discardableCount === 1 ? 'draft' : 'drafts'}</button><button type="button" className="pm-control text-[13px] text-ink" onClick={() => setClearEnded(null)}>Keep ended-session drafts</button></div>
        </div>}
      </div>}
      <fieldset disabled={busy || savingDraft || identityHeld} className="flex min-w-0 flex-col gap-4">
        {/* The strip tracks the draft, not the saved book: it must clear as the
            fields above are filled, without waiting for a save. */}
        <OfficeSetupStrip agencyName={name} jurisdictions={states} office={draft} />
        {/* Ids here are the walkthrough's scroll targets. Renaming one without
            updating src/lib/office-setup.ts sends the strip to nowhere. */}
        <div id="office-group-identity" className="flex scroll-mt-6 flex-col gap-4">
          <label className={labelClass}>Agency name
            <input aria-label="Agency name" value={name} maxLength={80} onChange={event => edit({ name: event.target.value })} placeholder="Your agency" className={inputClass} />
          </label>
          <label className={labelClass}>Office contact for RealBud
            <input aria-label="Office contact for RealBud" value={draft.pmUser} maxLength={80} onChange={event => edit({ office: { pmUser: event.target.value } })} placeholder={profileName || "Name of the office contact"} className={inputClass} />
          </label>
          <fieldset>
            <legend className={labelClass}>Where are your properties?</legend>
            <p className="mt-1 text-[12px] text-ink-muted">Choose the states and territories in your book. RealBud uses these for location-specific workflows.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {AU_JURISDICTIONS.map(code => <button key={code} type="button" aria-pressed={states.includes(code)} onClick={() => edit({ jurisdictions: states.includes(code) ? states.filter(item => item !== code) : [...states, code] })} className={cn("rounded-md border px-3 py-2 text-[12px] focus-visible:outline-2 focus-visible:outline-agency", states.includes(code) ? "border-agency bg-selected text-agency" : "border-line text-ink-secondary hover:text-ink")}>{code}</button>)}
            </div>
          </fieldset>
          {/* A book with no recorded zone has no zone to show. Naming the
              computer's own zone keeps the working assumption visible instead of
              dressing a fixture up as the office's setting. */}
          <p className="text-[12px] text-ink-muted">
            {timezone
              ? `Book timezone: ${timezone}`
              : `Book timezone: not recorded yet. RealBud uses this computer’s timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}) until the book records one.`}
          </p>
        </div>

        <details id="office-group-rent" className={cn(detailClass, "scroll-mt-6")}>
          <summary className={summaryClass}>How we check rent <span className="font-normal text-ink-muted">· your office’s workflow</span></summary>
          <div className={fieldsClass}>
            <p className="text-[13px] text-ink-secondary">Tell Bud how your office handles payment evidence. You can explain exceptions for a particular property in Ask.</p>
            <fieldset>
              <legend className={labelClass}>Where do tenants share payment evidence?</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {RENT_RECEIPT_CHANNELS.map(channel => <label key={channel} className="flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] text-ink">
                  <input type="checkbox" checked={rentWorkflow.receiptChannels.includes(channel)} onChange={event => editRent({ receiptChannels: event.target.checked ? [...rentWorkflow.receiptChannels, channel] : rentWorkflow.receiptChannels.filter(value => value !== channel) })} className="accent-agency" />
                  {RENT_RECEIPT_CHANNEL_LABELS[channel]}
                </label>)}
              </div>
              <p className="mt-2 text-[12px] text-ink-muted">Choose any that apply. This does not connect an app. You can attach receipts or paste messages into Ask.</p>
            </fieldset>
            <label className={labelClass}>How does your office confirm rent was received?
              <select aria-label="How does your office confirm rent was received?" value={rentWorkflow.verificationMethod} onChange={event => editRent({ verificationMethod: event.target.value as RentVerificationMethod })} className={inputClass}>
                {RENT_VERIFICATION_METHODS.map(method => <option key={method} value={method}>{verificationOptionLabels[method]}</option>)}
              </select>
              <span className="mt-1.5 block text-[12px] text-ink-muted">{RENT_VERIFICATION_LABELS[rentWorkflow.verificationMethod]}.</span>
            </label>
            <label className={labelClass}>Your checking steps <span className="text-ink-muted">· optional</span>
              <textarea aria-label="Your checking steps" value={rentWorkflow.checkingSteps} maxLength={RENT_WORKFLOW_STEPS_MAX} rows={4} onChange={event => editRent({ checkingSteps: event.target.value })} placeholder="For example: check the trust account each morning, match the unit and rental week, and ask the accounts team about unclear references." className={inputClass} />
              <span className="mt-1.5 block text-[12px] text-ink-muted">General process only—no passwords, account numbers or tenant details. These steps are shared with Bud when you ask for work.</span>
            </label>
            <p className="rounded-lg bg-inset p-3 text-[12.5px] leading-relaxed text-ink-secondary">A receipt is a claim until checked. Bud will flag partial, pending, duplicate or conflicting payments for review. These settings do not mark rent paid or change reminder rules.</p>
            <p className="text-[12px] text-ink-muted">After saving, open Work → More task examples → Review rent payment evidence.</p>
          </div>
        </details>

        <details id="office-group-software" className={cn(detailClass, "scroll-mt-6")}>
          <summary className={summaryClass}>Property software <span className="font-normal text-ink-muted">· optional</span></summary>
          <div className={fieldsClass}>
            <label className={labelClass}>Property management software
              <select aria-label="Property management software" value={draft.pmsBrand} onChange={event => edit({ office: { pmsBrand: readClosed(event.target.value, PMS_BRANDS) } })} className={inputClass}>
                <option value="">Choose later / not sure</option>
                {PMS_BRANDS.map(brand => <option key={brand} value={brand}>{PMS_BRAND_LABELS[brand]}</option>)}
              </select>
              <span className="mt-1.5 block text-[12px] text-ink-muted">A reference for your office. Choosing software does not connect it or import data. You can use Desk and import CSV files without choosing one.</span>
            </label>
          </div>
        </details>

        <details id="office-group-csv" className={cn(detailClass, "scroll-mt-6")}>
          <summary className={summaryClass}>CSV handover notes <span className="font-normal text-ink-muted">· optional</span></summary>
          <div className={fieldsClass}>
            <p className="text-[12px] text-ink-muted">For offices sharing responsibility for exports. Import and matching are reviewed when you upload a CSV in Properties; these notes do not configure an import or schedule.</p>
            <label className={labelClass}>Who supplies the export?
              <input aria-label="Who supplies the export?" value={draft.namedExporter} maxLength={80} onChange={event => edit({ office: { namedExporter: event.target.value } })} placeholder="Optional name or role" className={inputClass} />
            </label>
            <label className={labelClass}>How often do they supply it?
              <select aria-label="How often do they supply it?" value={draft.exportCadence} onChange={event => edit({ office: { exportCadence: readClosed(event.target.value, EXPORT_CADENCES) } })} className={inputClass}>
                <option value="">Choose later / not sure</option>{EXPORT_CADENCES.map(value => <option key={value} value={value}>{EXPORT_CADENCE_LABELS[value]}</option>)}
              </select>
            </label>
            <label className={labelClass}>Usual property reference in the file
              <select aria-label="Usual property reference in the file" value={draft.exportIdentity} onChange={event => edit({ office: { exportIdentity: readClosed(event.target.value, EXPORT_IDENTITY_COLUMNS) } })} className={inputClass}>
                <option value="">Choose when importing</option>{EXPORT_IDENTITY_COLUMNS.map(value => <option key={value} value={value}>{EXPORT_IDENTITY_LABELS[value]}</option>)}
              </select>
            </label>
          </div>
        </details>

        <details id="office-group-portal" className={cn(detailClass, "scroll-mt-6")}>
          <summary className={summaryClass}>Assisted portal setup <span className="font-normal text-ink-muted">· technical details</span></summary>
          <div className={fieldsClass}>
            <p className="text-[12px] text-ink-muted">Only fill these during an assisted portal trial. They record setup details; they do not sign in, connect a portal or give Bud permission to act.</p>
            <label className={labelClass}>Computer used for the portal trial
              <select aria-label="Computer used for the portal trial" value={draft.officeOs} onChange={event => edit({ office: { officeOs: readClosed(event.target.value, OFFICE_OS) } })} className={inputClass}>
                <option value="">Choose during setup</option>{OFFICE_OS.map(value => <option key={value} value={value}>{OFFICE_OS_LABELS[value]}</option>)}
              </select>
            </label>
            <label className={labelClass}>Test account label
              <input aria-label="Test account label" value={draft.vendorTestAccount} maxLength={80} onChange={event => edit({ office: { vendorTestAccount: event.target.value } })} placeholder="A label only, such as Office training account" className={inputClass} />
              <span className="mt-1.5 block text-[12px] text-ink-muted">No passwords or access tokens.</span>
            </label>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!changed || conflict || revisionHeld || replyHeld || (changes.name !== undefined && !name.trim())} className="pm-control rounded-lg bg-agency px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40">{busy || savingDraft ? "Saving…" : "Save changes"}</button>
          {changed && <button type="button" onClick={() => conflict || revisionHeld || replyHeld ? void reload() : discard()} className="pm-control text-[13px] text-ink-muted">{conflict || revisionHeld || replyHeld ? "Discard edits and reload saved settings" : "Discard changes"}</button>}
        </div>
      </fieldset>
      {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}{!conflict && !replyHeld && " Your edits are kept."}</p>}
    </form>
  </Card>;
}

/**
 * The walkthrough for this form. It reads the same office contract the fields
 * below write, so it can only ever ask for something this card can satisfy.
 * It disappears once the essentials are done — an office that is set up should
 * not keep being told it is set up.
 */
function OfficeSetupStrip({
  agencyName,
  jurisdictions,
  office,
}: {
  agencyName: string;
  jurisdictions: readonly string[];
  office: OfficeInput;
}) {
  const stripRef = useRef<HTMLElement>(null);
  const setup = officeSetup({ agencyName, jurisdictions, office: coerceOffice(office) });
  if (setup.complete) return null;

  const jump = (id: string) => {
    const target = stripRef.current?.closest("form")?.querySelector<HTMLElement>(`[id="${id}"]`);
    if (!target) return;
    // A collapsed <details> hides its fields; open it so the jump lands on
    // something visible rather than a closed summary.
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    target.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
  };

  return (
    <section
      ref={stripRef}
      className="border-l-2 border-agency bg-selected/30 px-3 py-2"
      aria-label="Finish setting up this office"
    >
      <p className="text-[12.5px] text-ink-secondary">
        {setup.essential.filter(item => item.done).length} of {setup.essential.length} essentials filled. Optional details can wait.
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-4">
        {setup.remaining.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => jump(item.groupId)}
              className="min-h-11 text-left text-[13px] text-agency underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-agency"
            >
              <span>{item.label}</span>

            </button>
          </li>
        ))}
      </ul>

    </section>
  );
}
