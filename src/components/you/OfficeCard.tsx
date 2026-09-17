import { useRef, useState } from "react";

import {
  AU_JURISDICTIONS, EXPORT_CADENCE_LABELS, EXPORT_CADENCES,
  EXPORT_IDENTITY_COLUMNS, EXPORT_IDENTITY_LABELS, OFFICE_OS, OFFICE_OS_LABELS,
  PMS_BRAND_LABELS, PMS_BRANDS, coerceOffice, readClosed, type OfficeInput,
} from "../../../shared/office";
import { cn } from "@/lib/cn";
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

type OfficeChanges = { name?: string; jurisdictions?: string[]; office?: OfficeInput; expectedRevision?: number };

export function OfficeCard({ agencyName, timezone, jurisdictions, office, profileName, revision, onSave, onReload }: {
  agencyName: string;
  timezone: string;
  jurisdictions: string[];
  office?: OfficeInput | null;
  profileName?: string;
  revision: number;
  onSave: (input: OfficeChanges) => Promise<void> | void;
  onReload: () => Promise<void>;
}) {
  // Overlay only user edits. Snapshot refreshes update untouched fields without
  // erasing a draft; saving never resubmits hidden, unchanged office metadata.
  const [changes, setChanges] = useState<OfficeChanges>({});
  const name = changes.name ?? agencyName;
  const states = changes.jurisdictions ?? jurisdictions;
  const draft = { ...coerceOffice(office), ...changes.office };
  const rentWorkflow = draft.rentWorkflow ?? defaultRentWorkflow();
  const editRevision = useRef<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const changed = Object.keys(changes).length > 0;
  const edit = (patch: OfficeChanges) => {
    editRevision.current ??= revision;
    setChanges(current => ({ ...current, ...patch, ...(patch.office ? { office: { ...current.office, ...patch.office } } : {}) }));
    setSaved(false); setError("");
  };
  const editRent = (patch: Partial<RentWorkflow>) => edit({ office: { rentWorkflow: { ...rentWorkflow, ...patch } } });
  const discard = () => {
    setChanges({}); editRevision.current = undefined; setError(""); setSaved(false); setConflict(false);
  };
  const reload = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try { await onReload(); discard(); }
    catch { setError("Saved settings could not be reloaded. Your edits are still here."); }
    finally { saving.current = false; setBusy(false); }
  };
  const save = async () => {
    if (saving.current || !changed || conflict) return;
    saving.current = true; setBusy(true); setSaved(false); setError("");
    try {
      await onSave({ ...changes, expectedRevision: editRevision.current, ...(changes.name !== undefined ? { name: changes.name.trim() } : {}) });
      setChanges({}); editRevision.current = undefined; setSaved(true);
    } catch (cause) {
      setConflict((cause as { status?: number })?.status === 409);
      setError(cause instanceof Error ? cause.message : "Office details could not be saved. Your edits are still here.");
    } finally { saving.current = false; setBusy(false); }
  };

  return <Card title="This office" subtitle="Set the basics for your book. Software and technical details can wait.">
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
        <label className={labelClass}>Agency name
          <input aria-label="Agency name" value={name} maxLength={80} onChange={event => edit({ name: event.target.value })} placeholder="Your agency" className={inputClass} />
        </label>
        <fieldset>
          <legend className={labelClass}>Where are your properties?</legend>
          <p className="mt-1 text-[12px] text-ink-muted">Choose the states and territories in your book. RealBud uses these for location-specific workflows.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {AU_JURISDICTIONS.map(code => <button key={code} type="button" aria-pressed={states.includes(code)} onClick={() => edit({ jurisdictions: states.includes(code) ? states.filter(item => item !== code) : [...states, code] })} className={cn("rounded-md border px-3 py-2 text-[12px] focus-visible:outline-2 focus-visible:outline-agency", states.includes(code) ? "border-agency bg-selected text-agency" : "border-line text-ink-secondary hover:text-ink")}>{code}</button>)}
          </div>
        </fieldset>
        <p className="text-[12px] text-ink-muted">Book timezone: {timezone}</p>

        <details className={detailClass}>
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
            <p className="text-[12px] text-ink-muted">After saving, open Ask → More task examples → Review rent payment evidence.</p>
          </div>
        </details>

        <details className={detailClass}>
          <summary className={summaryClass}>Software & office contact <span className="font-normal text-ink-muted">· optional</span></summary>
          <div className={fieldsClass}>
            <label className={labelClass}>Property management software
              <select aria-label="Property management software" value={draft.pmsBrand} onChange={event => edit({ office: { pmsBrand: readClosed(event.target.value, PMS_BRANDS) } })} className={inputClass}>
                <option value="">Choose later / not sure</option>
                {PMS_BRANDS.map(brand => <option key={brand} value={brand}>{PMS_BRAND_LABELS[brand]}</option>)}
              </select>
              <span className="mt-1.5 block text-[12px] text-ink-muted">A reference for your office. Choosing software does not connect it or import data. You can use Desk and import CSV files without choosing one.</span>
            </label>
            <label className={labelClass}>Office contact for RealBud
              <input aria-label="Office contact for RealBud" value={draft.pmUser} maxLength={80} onChange={event => edit({ office: { pmUser: event.target.value } })} placeholder={profileName || "Optional name"} className={inputClass} />
            </label>
          </div>
        </details>

        <details className={detailClass}>
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

        <details className={detailClass}>
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
          <button type="submit" disabled={!changed || conflict || (changes.name !== undefined && !name.trim())} className="rounded-lg bg-agency px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40">{busy ? "Saving…" : "Save changes"}</button>
          {changed && <button type="button" onClick={() => conflict ? void reload() : discard()} className="text-[13px] text-ink-muted">{conflict ? "Discard edits and reload saved settings" : "Discard changes"}</button>}
          <span role="status" className="text-[12px] text-agency">{saved ? "Changes saved" : changed ? "Unsaved changes" : ""}</span>
        </div>
      </fieldset>
      {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}{!conflict && " Your edits are kept; try saving again."}</p>}
    </form>
  </Card>;
}
