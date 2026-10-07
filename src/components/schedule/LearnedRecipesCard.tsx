// Watch and learn: staff show Bud a portal task once in the work browser, then
// review the draft and publish it. Running one posts a normal Start card into
// Bud's conversation. Decision: docs/decisions/2026-10-07-watch-and-learn.md.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { learnBlockers, learnInputKey, type LearnedRecipe, type LearnFlag, type LearnListView, type LearnStep } from "@shared/learned-recipes";
import { resolveProductBud } from "@/lib/product-bud";
import { api, useStore } from "@/state/store";
import { Card } from "../SettingsPrimitives";
import { StatusLabel } from "../pm/primitives";

const button = "pm-control inline-flex select-none items-center gap-1.5 rounded-lg border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-40";
const primary = "pm-decision inline-flex select-none items-center gap-1.5 rounded-lg bg-agency px-3.5 text-[13px] font-medium text-white hover:bg-agency-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-40";
const input = "pm-control w-full rounded-lg border border-line bg-sheet px-3 text-[13px] text-ink";
// Inline step controls stay compact (24px hit target) so draft rows line up with published ones.
const inline = "inline-flex min-h-6 select-none items-center rounded px-1 text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-40";

const quoted = (label: string) => `“${label}”`;
const askedEachRun = (value: string) => /^\{[a-z][a-z0-9_]*\}$/.test(value);

/** One recipe step in plain words. Typed values the recorder turned into inputs read "asked each run". */
export function learnStepText(step: LearnStep): string {
  if ("nav" in step) return `Open ${step.nav.join(" › ")}`;
  if ("click" in step) return `Press ${step.click}`;
  if ("type" in step) return askedEachRun(step.type.value) ? `Type into ${step.type.field} (asked each run)` : `Type ${quoted(step.type.value)} into ${step.type.field}`;
  if ("select" in step) return `Choose ${step.select.option} in ${step.select.field}`;
  if ("radio" in step) return `Pick ${step.radio}`;
  if ("paginate" in step) return "Read every page";
  if ("wait" in step) return step.wait === "modal" ? "Wait for the window to open" : "Wait for the table";
  return step.read === "table" ? "Read the table" : "Read the page";
}

export function learnFlagText(flag: LearnFlag): string {
  switch (flag.code) {
    case "needs-confirm": return `Bud hasn't seen ${quoted(flag.label)} before. Tick “Only opens or shows something” on that step if that's all it does, or remove the step.`;
    case "outside-main": return `${quoted(flag.label)} sits outside the main page, so Bud can't repeat it.`;
    case "forbidden-area": return `${quoted(flag.label)} goes into an area Bud must stay out of.`;
    case "unsupported": return `${quoted(flag.label)} is a control Bud can't repeat yet, such as a tick box or file picker.`;
    case "off-portal": return `You left the portal at ${flag.label}.`;
  }
}

/** "date_from" → "Date from". */
export function learnInputLabel(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

export type LearnLabels = LearnListView["labels"][string];
const NO_LABELS: LearnLabels = { readSafe: [], consequential: [] };

/** Why Publish is blocked, in plain words; empty when it may be tried. The server still decides. */
export function learnPublishReason(recipe: LearnedRecipe, labels: LearnLabels): string {
  const blockers = learnBlockers(recipe, labels);
  if (!blockers.length) return "";
  if (recipe.flags.some(flag => flag.code !== "needs-confirm")) return "Sort out the warnings first.";
  const pending = learnBlockers({ ...recipe, flags: [] }, labels).filter(item => item.startsWith("needs-confirm: ")).map(item => item.slice(15));
  if (pending.length) return `Tick or remove: ${pending.join(", ")}.`;
  return "Remove the steps that press something Bud must never press.";
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const isLabels = (value: unknown): value is LearnListView["labels"] => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.values(value as object).every(entry => entry && strings(entry.readSafe) && strings(entry.consequential));
function isRecipe(value: unknown): value is LearnedRecipe {
  const r = value as Partial<LearnedRecipe> | null;
  return Boolean(r) && typeof r!.id === "string" && typeof r!.portal === "string" && typeof r!.name === "string" && typeof r!.title === "string"
    && (r!.state === "draft" || r!.state === "published") && Array.isArray(r!.steps) && strings(r!.inputs) && strings(r!.stopBefore)
    && strings(r!.confirmedLabels) && Array.isArray(r!.flags) && Number.isInteger(r!.revision);
}

/** A malformed 200 is an error, never a partial list. */
export function parseLearnList(body: unknown): LearnListView {
  const b = body as Partial<LearnListView> | null;
  const s = b?.session;
  if (!b || !s || (s.state !== "idle" && s.state !== "recording") || typeof s.events !== "number" || !Array.isArray(b.recipes) || !b.recipes.every(isRecipe) || !strings(b.portals) || !isLabels(b.labels)) {
    throw new Error("RealBud sent a list it couldn't read. Try again.");
  }
  return {
    session: { state: s.state, portal: typeof s.portal === "string" ? s.portal : null, startedAt: typeof s.startedAt === "number" ? s.startedAt : null, events: s.events },
    recipes: b.recipes,
    portals: b.portals,
    labels: b.labels,
  };
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

const SUBTITLE = "Do the task in the work browser. Bud records which buttons, menus and fields you use. It never keeps what you type into fields.";

/** `bare` drops the Card frame and title for hosts (the Schedule drawer) that already show one. */
export function LearnedRecipesCard({ bare = false }: { bare?: boolean }) {
  const { state, dispatch } = useStore();
  const [view, setView] = useState<LearnListView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [portal, setPortal] = useState("");
  const [title, setTitle] = useState("");

  const load = useCallback(async () => setView(parseLearnList(await api("/api/learn", undefined, { timeoutMs: 15_000 }))), []);
  useEffect(() => { void load().catch(cause => setError(message(cause))); }, [load]);
  const recording = view?.session.state === "recording";
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => { void load().catch(() => {}); }, 2_000);
    return () => clearInterval(timer);
  }, [recording, load]);

  // Every change reloads the list. A 409 shows the server's reason; a transport failure may hide a committed write.
  const run = async (key: string, task: () => Promise<unknown>, done: string) => {
    if (busy) return false;
    setBusy(key); setError(""); setNotice("");
    let ok = false;
    try { await task(); ok = true; setNotice(done); }
    catch (cause) { setError((cause as { status?: number }).status ? message(cause) : "RealBud couldn't confirm that change. Check the list below before trying again."); }
    finally { await load().catch(() => {}); setBusy(null); }
    return ok;
  };
  const post = (path: string, body: Record<string, unknown> = {}) => api(path, { method: "POST", body: JSON.stringify(body) }, { timeoutMs: 20_000 });
  const change = (recipe: LearnedRecipe, action: string, body: Record<string, unknown>, done: string) =>
    run(`${recipe.id}:${action}`, () => post(`/api/learn/recipes/${encodeURIComponent(recipe.id)}${action === "update" ? "" : `/${action}`}`, { expectedRevision: recipe.revision, ...body }), done);

  const portals = view?.portals ?? [];
  const chosen = portal || portals[0] || "";
  const start = () => run("start", () => post("/api/learn/start", { portal: chosen }), "Recording. Do the task in the work browser.");
  const finish = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) { setError("Give the task a name first."); return; }
    if (await run("stop", () => post("/api/learn/stop", { title: title.trim() }), "Saved as a draft. Check the steps below.")) setTitle("");
  };
  const propose = async (recipe: LearnedRecipe, inputs: Record<string, string>, marker: string) => {
    const threadId = resolveProductBud(state.bots)?.threadId;
    if (!threadId) { setError("Bud isn't ready yet. Try again in a moment."); return false; }
    const ok = await run(`${recipe.id}:run`, () => post("/api/browser/tasks/recipe", { threadId, portal: recipe.portal, target: recipe.name, inputs, account: { marker } }), "Start card is waiting in Work.");
    if (ok) dispatch({ type: "showAsk" });
    return ok;
  };

  const body = (
    <>
      {view == null && !error ? <p className="text-[13px] text-ink-muted">Loading…</p> : null}
      {view && !recording ? (
        portals.length ? (
          <div className="flex flex-wrap items-end gap-2">
            {portals.length > 1 ? (
              <label className="text-[13px] text-ink-secondary">
                Portal
                <select className={`${input} mt-1`} value={chosen} disabled={busy != null} onChange={event => setPortal(event.target.value)}>
                  {portals.map(item => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
            ) : null}
            <button type="button" className={primary} disabled={busy != null || !chosen} onClick={() => void start()}>
              {busy === "start" ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              Start showing
            </button>
          </div>
        ) : <p className="text-[13px] text-ink-muted">No portal is set up for showing yet.</p>
      ) : null}
      {view && recording ? (
        <form className="space-y-2 rounded-lg border border-line bg-inset/40 px-3 py-2.5" onSubmit={event => void finish(event)}>
          <p className="flex items-center gap-2 text-[13px] text-ink">
            <span className="size-2 rounded-full bg-danger motion-safe:animate-pulse" aria-hidden />
            Recording{view.session.portal ? ` in ${view.session.portal}` : ""} · {view.session.events} {view.session.events === 1 ? "step" : "steps"} so far
          </p>
          <label className="block text-[13px] text-ink-secondary">
            Name this task
            <input className={`${input} mt-1`} value={title} maxLength={120} required disabled={busy != null} onChange={event => setTitle(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primary} disabled={busy != null || !title.trim()}>Finish</button>
            <button type="button" className={button} disabled={busy != null} onClick={() => void run("cancel", () => post("/api/learn/cancel"), "Discarded. Nothing was saved.")}>Discard</button>
          </div>
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-[12.5px] text-hold">{error}</p> : null}
      <p role="status" aria-live="polite" className="mt-2 text-[12.5px] text-ink-secondary empty:hidden">{notice}</p>
      {view?.recipes.length ? (
        <ul className="mt-3 space-y-3">
          {view.recipes.map(recipe => <LearnedRecipeItem key={recipe.id} recipe={recipe} labels={view.labels[recipe.portal] ?? NO_LABELS} busy={busy != null} onChange={change} onRun={propose} />)}
        </ul>
      ) : null}
    </>
  );
  return bare ? (
    <div>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{SUBTITLE}</p>
      <div className="mt-4">{body}</div>
    </div>
  ) : <Card title="Show Bud a task" subtitle={SUBTITLE}>{body}</Card>;
}

type ItemProps = {
  recipe: LearnedRecipe;
  labels: LearnLabels;
  busy: boolean;
  onChange: (recipe: LearnedRecipe, action: string, body: Record<string, unknown>, done: string) => Promise<boolean>;
  onRun: (recipe: LearnedRecipe, inputs: Record<string, string>, marker: string) => Promise<boolean>;
};

export function LearnedRecipeItem({ recipe, labels, busy, onChange, onRun }: ItemProps) {
  const [runOpen, setRunOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [marker, setMarker] = useState("");
  const [fixed, setFixed] = useState<{ index: number; text: string } | null>(null);
  const draft = recipe.state === "draft";
  // The server recomputes "needs confirming" flags from steps, read-safe labels and confirmedLabels on every update.
  const confirmable = (label: string) => !labels.readSafe.includes(label) && !labels.consequential.includes(label);
  const confirm = (label: string, on: boolean) => on
    ? onChange(recipe, "update", { confirmedLabels: [...recipe.confirmedLabels, label] }, `${quoted(label)} marked as only opening or showing something.`)
    : onChange(recipe, "update", { confirmedLabels: recipe.confirmedLabels.filter(item => item !== label) }, `${quoted(label)} is no longer confirmed.`);
  const setTypeValue = (index: number, value: string, done: string) =>
    onChange(recipe, "update", { steps: recipe.steps.map((step, at) => at === index && "type" in step ? { type: { ...step.type, value } } : step) }, done);
  const warnings = recipe.flags.filter(flag => flag.code !== "needs-confirm");
  const publishReason = learnPublishReason(recipe, labels);
  const ready = recipe.inputs.every(key => values[key]?.trim()) && marker.trim();
  const submitRun = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    if (await onRun(recipe, Object.fromEntries(recipe.inputs.map(key => [key, values[key].trim()])), marker.trim())) setRunOpen(false);
  };

  return (
    <li className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[14px] font-medium text-ink">{recipe.title}</h4>
        <StatusLabel tone={draft ? "muted" : "agency"}>{draft ? "Draft" : "Published"}</StatusLabel>
        <span className="text-[12px] text-ink-muted">{recipe.portal}</span>
      </div>
      <ol className="mt-2 space-y-1 text-[13px] text-ink-secondary">
        {recipe.steps.map((step, index) => (
          <li key={index} className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
            <span>{index + 1}. {learnStepText(step)}</span>
            {draft && "click" in step && confirmable(step.click) ? (
              <label className="inline-flex min-h-6 select-none items-center gap-1.5 text-[12.5px] text-ink">
                <input type="checkbox" aria-label={`${step.click} only opens or shows something`} checked={recipe.confirmedLabels.includes(step.click)} disabled={busy} onChange={event => void confirm(step.click, event.target.checked)} />
                Only opens or shows something
              </label>
            ) : null}
            {draft && "type" in step ? (
              askedEachRun(step.type.value) ? (
                fixed?.index === index ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <input className={`${input} w-48`} aria-label={`Fixed text for ${step.type.field}`} value={fixed.text} maxLength={120} disabled={busy} onChange={event => setFixed({ index, text: event.target.value })} />
                    <button type="button" className={button} aria-label={`Save fixed text for ${step.type.field}`} disabled={busy || !fixed.text.trim()} onClick={() => void setTypeValue(index, fixed.text.trim(), `${step.type.field} now uses fixed text.`).then(ok => ok && setFixed(null))}>Save</button>
                    <button type="button" className={button} aria-label={`Cancel fixed text for ${step.type.field}`} disabled={busy} onClick={() => setFixed(null)}>Cancel</button>
                  </span>
                ) : <button type="button" className={inline} aria-label={`Use fixed text for ${step.type.field}`} disabled={busy} onClick={() => setFixed({ index, text: "" })}>Use fixed text</button>
              ) : <button type="button" className={inline} aria-label={`Ask for ${step.type.field} each run`} disabled={busy} onClick={() => void setTypeValue(index, `{${learnInputKey(step.type.field)}}`, `${step.type.field} is asked each run.`)}>Ask each run</button>
            ) : null}
            {draft ? (
              <button type="button" className={inline} disabled={busy}
                aria-label={`Remove step ${index + 1}: ${learnStepText(step)}`}
                onClick={() => void onChange(recipe, "update", { steps: recipe.steps.filter((_, at) => at !== index) }, `Step ${index + 1} removed.`)}>
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {recipe.stopBefore.length ? <p className="mt-2 text-[12.5px] text-ink-secondary">Stops before: {recipe.stopBefore.join(", ")}</p> : null}
      {warnings.length ? (
        <ul className="mt-2 space-y-1.5" aria-label={`Warnings for ${recipe.title}`}>
          {warnings.map(flag => (
            <li key={`${flag.code}:${flag.label}`} className="flex flex-wrap items-center gap-2 rounded border border-hold/30 bg-hold/10 px-2.5 py-1.5 text-[12.5px] text-hold">
              <span>{learnFlagText(flag)}</span>
              <button type="button" className={button} disabled={busy} aria-label={`OK, skip this: ${flag.label}`}
                onClick={() => void onChange(recipe, "update", { flags: recipe.flags.filter(item => item !== flag) }, "Warning cleared.")}>
                OK, skip this
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {draft ? (
          <>
            <button type="button" className={primary} aria-label={`Publish ${recipe.title}`} disabled={busy || Boolean(publishReason)} onClick={() => void onChange(recipe, "publish", {}, `${recipe.title} is published.`)}>Publish</button>
            {publishReason ? <span className="text-[12.5px] text-ink-muted">{publishReason}</span> : null}
          </>
        ) : (
          <>
            <button type="button" className={primary} aria-label={`Run ${recipe.title}`} disabled={busy} aria-expanded={runOpen} onClick={() => setRunOpen(!runOpen)}>Run</button>
            <button type="button" className={button} aria-label={`Unpublish ${recipe.title}`} disabled={busy} onClick={() => void onChange(recipe, "unpublish", {}, `${recipe.title} is back to a draft.`)}>Unpublish</button>
          </>
        )}
        <button type="button" className={button} aria-label={`Delete ${recipe.title}`} disabled={busy}
          onClick={() => { if (window.confirm(`Delete ${recipe.title}? This can't be undone.`)) void onChange(recipe, "delete", {}, `${recipe.title} deleted.`); }}>
          Delete
        </button>
      </div>
      {!draft && runOpen ? (
        <form className="mt-3 space-y-2 rounded-lg border border-line bg-inset/40 px-3 py-2.5" onSubmit={event => void submitRun(event)}>
          {recipe.inputs.map(key => (
            <label key={key} className="block text-[13px] text-ink-secondary">
              {learnInputLabel(key)}
              <input className={`${input} mt-1`} value={values[key] ?? ""} required disabled={busy} onChange={event => setValues({ ...values, [key]: event.target.value })} />
            </label>
          ))}
          <label className="block text-[13px] text-ink-secondary">
            Account business code
            <input className={`${input} mt-1`} value={marker} required disabled={busy} onChange={event => setMarker(event.target.value)} />
            <span className="mt-1 block text-[12px] text-ink-muted">The business code shown in the portal header.</span>
          </label>
          <button type="submit" className={primary} disabled={busy || !ready}>Send to Work</button>
        </form>
      ) : null}
    </li>
  );
}
