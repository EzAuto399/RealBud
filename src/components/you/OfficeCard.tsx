import { useEffect, useState } from "react";

import {
  AU_JURISDICTIONS,
  EXPORT_CADENCE_LABELS,
  EXPORT_CADENCES,
  EXPORT_IDENTITY_COLUMNS,
  EXPORT_IDENTITY_LABELS,
  OFFICE_OS,
  OFFICE_OS_LABELS,
  PMS_BRAND_LABELS,
  PMS_BRANDS,
  coerceOffice,
  officeFilledCount,
  officeTicks,
  readClosed,
  type Office,
  type OfficeInput,
} from "../../../shared/office";
import { cn } from "@/lib/cn";
import { Card } from "../SettingsPrimitives";

const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline";

export function OfficeCard({
  agencyName,
  timezone,
  jurisdictions,
  office,
  profileName,
  onSave,
}: {
  agencyName: string;
  timezone: string;
  jurisdictions: string[];
  office?: OfficeInput | null;
  profileName?: string;
  onSave: (input: { name: string; jurisdictions: string[]; office: Office }) => Promise<void> | void;
}) {
  const [name, setName] = useState(agencyName);
  const [states, setStates] = useState(jurisdictions);
  const [draft, setDraft] = useState<Office>(() => {
    const next = coerceOffice(office);
    return { ...next, pmUser: next.pmUser || (profileName ?? "") };
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const next = coerceOffice(office);
    setName(agencyName);
    setStates(jurisdictions);
    setDraft({
      ...next,
      pmUser: next.pmUser || (profileName ?? ""),
    });
  }, [agencyName, jurisdictions, office, profileName]);

  const ticks = officeTicks({ agencyName: name, jurisdictions: states, office: draft });
  const filled = officeFilledCount({ agencyName: name, jurisdictions: states, office: draft });

  const toggleState = (code: string) => {
    setStates((prev) => (prev.includes(code) ? prev.filter((item) => item !== code) : [...prev, code]));
  };

  const save = async () => {
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      await onSave({ name: name.trim(), jurisdictions: states, office: draft });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="This office"
      subtitle={
        filled === 0
          ? "Sample book works today. Fill these when you name a real shop — not before."
          : `${filled} of 8 visit fields. Training names do not count. Live portal stays off until a visit.`
      }
    >
      <div className="flex flex-col gap-3">
        <label className="text-[12.5px] text-ink-secondary">
          Agency
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Not the training book"
            className={cn(inputClass, "mt-1")}
          />
        </label>
        <label className="text-[12.5px] text-ink-secondary">
          Who runs Recheck
          <input
            value={draft.pmUser}
            onChange={(event) => setDraft({ ...draft, pmUser: event.target.value })}
            placeholder="Named PM"
            className={cn(inputClass, "mt-1")}
          />
        </label>
        <details className="rounded-lg border border-line bg-inset/40" open={filled > 0}>
          <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-medium text-ink">
            Needed before live portal · {filled}/8
          </summary>
          <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
        <label className="text-[12.5px] text-ink-secondary">
          PMS brand
          <select
            value={draft.pmsBrand}
            onChange={(event) => setDraft({ ...draft, pmsBrand: readClosed(event.target.value, PMS_BRANDS) })}
            className={cn(inputClass, "mt-1")}
          >
            <option value="">Not set</option>
            {PMS_BRANDS.map((brand) => (
              <option key={brand} value={brand}>
                {PMS_BRAND_LABELS[brand]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12.5px] text-ink-secondary">
          Who can pull the arrears export
          <input
            value={draft.namedExporter}
            onChange={(event) => setDraft({ ...draft, namedExporter: event.target.value })}
            placeholder="Usually a principal"
            className={cn(inputClass, "mt-1")}
          />
        </label>
        <label className="text-[12.5px] text-ink-secondary">
          Export cadence
          <select
            value={draft.exportCadence}
            onChange={(event) => setDraft({ ...draft, exportCadence: readClosed(event.target.value, EXPORT_CADENCES) })}
            className={cn(inputClass, "mt-1")}
          >
            <option value="">Not set</option>
            {EXPORT_CADENCES.map((cadence) => (
              <option key={cadence} value={cadence}>
                {EXPORT_CADENCE_LABELS[cadence]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12.5px] text-ink-secondary">
          How rows match the book
          <select
            value={draft.exportIdentity}
            onChange={(event) => setDraft({ ...draft, exportIdentity: readClosed(event.target.value, EXPORT_IDENTITY_COLUMNS) })}
            className={cn(inputClass, "mt-1")}
          >
            <option value="">Not set</option>
            {EXPORT_IDENTITY_COLUMNS.map((column) => (
              <option key={column} value={column}>
                {EXPORT_IDENTITY_LABELS[column]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12.5px] text-ink-secondary">
          Office computers
          <select
            value={draft.officeOs}
            onChange={(event) => setDraft({ ...draft, officeOs: readClosed(event.target.value, OFFICE_OS) })}
            className={cn(inputClass, "mt-1")}
          >
            <option value="">Not set</option>
            {OFFICE_OS.map((os) => (
              <option key={os} value={os}>
                {OFFICE_OS_LABELS[os]}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="text-[12.5px] text-ink-secondary">Book jurisdictions</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {AU_JURISDICTIONS.map((code) => {
              const on = states.includes(code);
              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleState(code)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[12px]",
                    on ? "border-agency bg-agency/10 text-agency" : "border-line text-ink-secondary hover:text-ink",
                  )}
                >
                  {code}
                </button>
              );
            })}
          </div>
        </fieldset>
        <label className="text-[12.5px] text-ink-secondary">
          Vendor test account
          <input
            value={draft.vendorTestAccount}
            onChange={(event) => setDraft({ ...draft, vendorTestAccount: event.target.value })}
            placeholder="Name of the test login — not a password"
            className={cn(inputClass, "mt-1")}
          />
        </label>
          </div>
        </details>
        <p className="text-[12px] text-ink-muted">Timezone {timezone}. Passwords stay out of this form.</p>
        <ol className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-ink-muted">
          {ticks.map((tick) => (
            <li key={tick.id}>
              <span className={tick.done ? "text-agency" : "text-hold"}>{tick.done ? "Done" : "Open"}</span>
              {" · "}
              {tick.label}
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void save()}
            className="rounded-lg bg-agency px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? "Saving" : "Save office"}
          </button>
          {saved ? <span className="text-[12px] text-agency">Saved</span> : null}
          {error ? <span className="text-[12.5px] text-danger">{error}</span> : null}
        </div>
      </div>
    </Card>
  );
}
