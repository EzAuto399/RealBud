// Learned portal paths. In an attended Ask task Bud explores a mapped portal
// (REI Cloud) in the work browser; the broker records each step it dispatched
// (control role and name, URL path, outcome: never page text, field values or
// query strings). At the end Bud may propose the path it found for one known
// recipe slot (tenant-list, supplier-list) through portal_propose_path. The
// proposal is checked here against that task's own record (a step Bud did not
// actually take is refused), against the pack's consequential and forbidden
// labels, and against the recipe schema; the person allows it on an approval
// card; only then is it saved here as a private, versioned override with its
// provenance. Loading a pack (server/portal-recipe-task.ts) puts the current
// override over the repo recipe's export steps; the repo recipe stays the
// default and every earlier version can be restored. An override grants
// nothing: the broker still decides each step and the download still asks.
// A learned step never becomes read-safe: a click the repo map does not already
// call read-safe is saved as an "ask each run" step, so one Allow on a proposal
// is never standing permission for a control of unknown effect. A saved version
// is re-checked on every load (shape, slot, consequential and forbidden labels,
// and the exact origin it was learned on) and skipped if it fails.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { consequentialKind } from "./browser-authority.ts";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";
import { redactSecretsInText } from "./redact.ts";
import { parsePortalRecipePack, type PortalRecipePack, type PortalRecipeStep } from "./portal-recipe.ts";

/** Recipe slots a learned path may fill, per portal, with the words the approval card uses. */
export const LEARNABLE_SLOTS: Readonly<Record<string, Readonly<Record<string, { title: string; use: string }>>>> = {
  "rei-cloud": {
    "tenant-list": { title: "Tenants list", use: "Refresh from REI" },
    "supplier-list": { title: "Suppliers list", use: "Refresh from REI" },
  },
};
export const PORTAL_PROPOSE_TOOL = "portal_propose_path";
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A storage queue per store: one read-modify-write at a time. */
function queue() { let chain: Promise<unknown> = Promise.resolve(); return <T>(work: () => Promise<T>) => { const next = chain.then(work, work); chain = next.catch(() => {}); return next; }; }

// ── what the broker saw Bud do ───────────────────────────────────────────
export type PortalStepTool = "navigate" | "click" | "select" | "download" | "fill" | "press";
export interface PortalObservedStep {
  tool: PortalStepTool;
  /** The control's role and accessible name; empty for a navigation. Never a field's value. */
  role: string; label: string;
  /** Decoded path only, ids and tokens as ":id" (shownPath, server/browser-authority.ts): a query or a path segment can carry tokens. */
  path: string;
  /** For a dropdown choice: sha256 of the chosen option values, never the values. */
  valuesHash?: string;
  outcome: "succeeded" | "unknown";
  at: number;
}
/** Role and name of an observed control line (`link "Reports"`, `combobox "Output" value="…"`): the value is dropped. */
export function observedControl(line: string): { role: string; label: string } {
  const role = line.trim().split(/\s+/, 1)[0]?.toLowerCase().slice(0, 40) ?? "";
  const name = line.match(/"((?:[^"\\]|\\.){1,200})"/)?.[1]?.replace(/\\(.)/g, "$1") ?? "";
  return { role, label: redactSecretsInText(name).slice(0, 120) };
}
export const choiceHash = (values: readonly string[]) => sha256(JSON.stringify(values));

const MAX_TASKS = 50, MAX_STEPS = 200, EVIDENCE_BYTES = 2_000_000;
type EvidenceFile = { version: 1; purpose: "portal-path-evidence"; tasks: Array<{ grantId: string; steps: PortalObservedStep[] }> };
function parseEvidence(value: unknown): EvidenceFile {
  if (value === undefined) return { version: 1, purpose: "portal-path-evidence", tasks: [] };
  if (!object(value) || value.version !== 1 || value.purpose !== "portal-path-evidence" || !Array.isArray(value.tasks)) throw fail("Bud's browser step record needs recovery. Nothing was learned.", 503);
  return value as EvidenceFile;
}
/** Each Ask browser task's dispatched steps, bounded: the newest 50 tasks, 200 steps each. Private task evidence. */
export class PortalEvidenceStore {
  private readonly file: string;
  private readonly run = queue();
  constructor(options: { file?: string } = {}) { this.file = options.file ?? join(DATA_DIR, "portal-path-evidence.json"); }
  record(grantId: string, step: PortalObservedStep): Promise<void> {
    return this.run(async () => {
      const doc = parseEvidence(await readPrivateJson(this.file, EVIDENCE_BYTES));
      const found = doc.tasks.find(task => task.grantId === grantId);
      const tasks = [...doc.tasks.filter(task => task !== found), { grantId, steps: [...(found?.steps ?? []), step].slice(-MAX_STEPS) }].slice(-MAX_TASKS);
      await writePrivateJson(this.file, { ...doc, tasks }, { maxBytes: EVIDENCE_BYTES, validate: parseEvidence });
    });
  }
  steps(grantId: string): Promise<PortalObservedStep[]> {
    return this.run(async () => structuredClone(parseEvidence(await readPrivateJson(this.file, EVIDENCE_BYTES)).tasks.find(task => task.grantId === grantId)?.steps ?? []));
  }
}

// ── a proposal, checked against the record ───────────────────────────────
export type PortalPathVerb = "nav" | "click" | "select" | "download";
export interface PortalPathStep { verb: PortalPathVerb; label: string; option?: string }
/** `readSafe`: the clicks the repo map already calls read-safe; every other click asks the person on each run. */
export interface PortalPathProposal { slot: string; steps: PortalPathStep[]; readSafe: string[]; urls: string[]; summary: string }
const VERBS: readonly PortalPathVerb[] = ["nav", "click", "select", "download"];
const LABEL = /^[^\u0000-\u001f\u007f"]{1,120}$/;
/** A pack or global consequential label, as a whole phrase anywhere in the text. */
function consequential(pack: PortalRecipePack, text: string): boolean {
  return consequentialKind(text) !== null || pack.labels.consequential.some(label =>
    new RegExp(`(?:^|[^\\p{L}\\p{N}])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text));
}
const shown = (step: PortalPathStep) => step.verb === "select" ? step.option! : step.label;

/** A path's steps, by shape: verbs and labels only, none consequential or in a forbidden area, ending with its one download.
 * Checked when Bud proposes it and again every time a saved version is loaded. */
function pathSteps(pack: PortalRecipePack, raws: unknown): PortalPathStep[] {
  if (!Array.isArray(raws) || raws.length < 1 || raws.length > 12) throw fail("Propose one to twelve steps.");
  const steps = raws.map((raw): PortalPathStep => {
    const keys = object(raw) ? Object.keys(raw).sort().join() : "";
    if (!object(raw) || !VERBS.includes(raw.verb as PortalPathVerb) || typeof raw.label !== "string" || !LABEL.test(raw.label) ||
      keys !== (raw.verb === "select" ? "label,option,verb" : "label,verb") || (raw.verb === "select" && (typeof raw.option !== "string" || !LABEL.test(raw.option)))) {
      throw fail("Each step is {verb: nav, click, select or download, label}, and a select also names its option.");
    }
    return { verb: raw.verb as PortalPathVerb, label: raw.label, ...(raw.verb === "select" ? { option: raw.option as string } : {}) };
  });
  const downloads = steps.filter(step => step.verb === "download").length;
  if (downloads !== 1 || steps.at(-1)!.verb !== "download") throw fail("The path ends with its one download (the export button).");
  for (const step of steps) {
    const texts = [step.label, ...(step.option ? [step.option] : [])];
    if (texts.some(text => consequential(pack, text))) throw fail(`'${shown(step)}' can change records in this portal, so it cannot be part of a saved read-only path.`);
    const menu = step.verb === "nav" ? step.label.split(" › ") : [step.label];
    for (let i = 1; i <= menu.length; i++) if (pack.labels.forbiddenAreas.includes(menu.slice(0, i).join(" › "))) throw fail(`'${menu.slice(0, i).join(" › ")}' is an area Bud stays out of.`);
  }
  return steps;
}
const learnableSlot = (pack: PortalRecipePack, slot: unknown): slot is string =>
  typeof slot === "string" && Object.hasOwn(LEARNABLE_SLOTS[pack.portal] ?? {}, slot) && Object.hasOwn(pack.recipes, slot);

/** Bud's proposed path, accepted only when every step is one this task really took (and it succeeded), none is
 * consequential or in a forbidden area, it ends with exactly one download, and the merged pack still parses. */
export function checkPortalPathProposal(pack: PortalRecipePack, input: { slot: unknown; steps: unknown }, observed: readonly PortalObservedStep[]): PortalPathProposal {
  const slots = LEARNABLE_SLOTS[pack.portal] ?? {};
  if (!learnableSlot(pack, input.slot)) throw fail(`Bud can only propose a path for: ${Object.keys(slots).join(", ") || "nothing on this portal"}.`);
  const steps = pathSteps(pack, input.steps);
  const done = observed.filter(step => step.outcome === "succeeded");
  const urls = new Set<string>();
  const saw = (match: (step: PortalObservedStep) => boolean) => { const hit = done.find(match); if (hit) urls.add(hit.path); return Boolean(hit); };
  for (const step of steps) {
    const menu = step.verb === "nav" ? step.label.split(" › ") : [step.label];
    const ok = step.verb === "nav"
      ? saw(seen => seen.tool === "navigate" && Object.hasOwn(pack.routes, step.label) && seen.path === pack.routes[step.label]) || menu.every(label => saw(seen => seen.tool === "click" && (seen.role === "link" || seen.role === "menuitem") && seen.label === label))
      : step.verb === "click" ? saw(seen => seen.tool === "click" && seen.label === step.label)
        : step.verb === "select" ? saw(seen => seen.tool === "select" && seen.label === step.label && seen.valuesHash === choiceHash([step.option!]))
          : saw(seen => seen.tool === "download" && seen.label === step.label);
    if (!ok) throw fail(`Bud did not ${step.verb === "nav" ? "open" : step.verb === "select" ? "choose" : step.verb === "download" ? "download from" : "use"} '${shown(step)}' in this task, so it cannot be part of the path. Propose only steps Bud actually took.`);
  }
  // A click runs without asking only if the repo map already calls it read-safe; any other click asks on every run.
  const clicks = [...new Set(steps.filter(step => step.verb === "click").map(step => step.label))];
  const readSafe = clicks.filter(label => pack.labels.readSafe.includes(label));
  const asks = clicks.filter(label => !readSafe.includes(label));
  const { title, use } = slots[input.slot];
  const proposal = { slot: input.slot, steps, readSafe, urls: [...urls].slice(0, 20),
    summary: `Bud found how to export the ${title}: ${steps.map(shown).join(" → ")}. Use this for ${use}? Bud still asks before each download${asks.length ? ` and before ${asks.map(label => `'${label}'`).join(", ")} every time` : ""}.` };
  applyPath(pack, proposal); // throws if the merged pack does not parse
  return proposal;
}

/** The recipe steps a learned path becomes, in the pack's own list → report → popup shape:
 * every screen opened is account-checked and waited for; a control that leads to a choice or a download opens a popup.
 * ponytail: fixed shape; let a proposal carry explicit waits when a portal needs another one. */
function recipeSteps(steps: readonly PortalPathStep[], readSafe: readonly string[]): PortalRecipeStep[] {
  return steps.flatMap((step, index): PortalRecipeStep[] => {
    const next = steps[index + 1]?.verb;
    if (step.verb === "nav") return [{ nav: step.label.split(" › ") }, { check: "account" }, { wait: "table" }];
    // A control the repo map does not call read-safe is asked about on every run (server/portal-recipe-runner.ts).
    if (step.verb === "click") return [{ click: readSafe.includes(step.label) ? step.label : { label: step.label, ask: "each-run" } },
      ...(next === "select" || next === "download" ? [{ wait: "modal" }] : [])];
    if (step.verb === "select") return [{ select: { field: step.label, option: step.option } }];
    return [{ download: { label: step.label } }];
  });
}
/** The slot's own list read stays from the repo (its "N records" footer is the row-count check); the export path is replaced.
 * The pack's labels are never widened: only the repo's read-safe names run without asking. */
function applyPath(pack: PortalRecipePack, path: Pick<PortalPathProposal, "slot" | "steps">): PortalRecipePack {
  const recipe = pack.recipes[path.slot];
  const read = recipe.steps.findIndex(step => Object.hasOwn(step, "read"));
  const merged = { ...pack,
    recipes: { ...pack.recipes, [path.slot]: { ...recipe, steps: [...recipe.steps.slice(0, read + 1), ...recipeSteps(path.steps, pack.labels.readSafe), { check: "account" }] } } };
  return parsePortalRecipePack(merged);
}

// ── saved versions ───────────────────────────────────────────────────────
export interface PortalPathVersion {
  revision: number;
  portal: string; slot: string;
  steps: PortalPathStep[]; readSafe: string[];
  /** `origin`: the exact portal origin it was learned on; it applies only to a pack with that origin. */
  provenance: { grantId: string; runId: string; threadId: string; origin: string; savedAt: string; urls: string[] };
}
type PathsFile = { version: 1; purpose: "portal-path-overrides"; slots: Record<string, { current: number | null; versions: PortalPathVersion[] }> };
const PATHS_BYTES = 500_000, MAX_VERSIONS = 10;
function parsePaths(value: unknown): PathsFile {
  if (value === undefined) return { version: 1, purpose: "portal-path-overrides", slots: {} };
  if (!object(value) || value.version !== 1 || value.purpose !== "portal-path-overrides" || !object(value.slots)) throw fail("Saved portal paths need recovery. The packs' own paths are used until then.", 503);
  return value as PathsFile;
}
const slotKey = (portal: string, slot: string) => `${portal}/${slot}`;
/** Private, versioned learned paths. Saving keeps the previous versions; restore picks any of them, or null for the repo path. */
export class PortalPathStore {
  private readonly file: string;
  private readonly run = queue();
  constructor(options: { file?: string } = {}) { this.file = options.file ?? join(DATA_DIR, "portal-path-overrides.json"); }
  private read() { return readPrivateJson(this.file, PATHS_BYTES).then(parsePaths); }
  private write(doc: PathsFile) { return writePrivateJson(this.file, doc, { maxBytes: PATHS_BYTES, validate: parsePaths }); }
  save(portal: string, proposal: PortalPathProposal, provenance: Omit<PortalPathVersion["provenance"], "savedAt" | "urls">, now = Date.now()): Promise<PortalPathVersion> {
    return this.run(async () => {
      const doc = await this.read(); const key = slotKey(portal, proposal.slot);
      const entry = doc.slots[key] ?? { current: null, versions: [] };
      const version: PortalPathVersion = { revision: Math.max(0, ...entry.versions.map(v => v.revision)) + 1, portal, slot: proposal.slot,
        steps: structuredClone(proposal.steps), readSafe: [...proposal.readSafe], provenance: { ...provenance, savedAt: new Date(now).toISOString(), urls: [...proposal.urls] } };
      await this.write({ ...doc, slots: { ...doc.slots, [key]: { current: version.revision, versions: [...entry.versions, version].slice(-MAX_VERSIONS) } } });
      return structuredClone(version);
    });
  }
  restore(portal: string, slot: string, revision: number | null): Promise<void> {
    return this.run(async () => {
      const doc = await this.read(); const key = slotKey(portal, slot); const entry = doc.slots[key];
      if (revision !== null && !entry?.versions.some(v => v.revision === revision)) throw fail("That saved path is not on record.", 404);
      await this.write({ ...doc, slots: { ...doc.slots, [key]: { current: revision, versions: entry?.versions ?? [] } } });
    });
  }
  list(portal: string, slot: string): Promise<{ current: number | null; versions: PortalPathVersion[] }> {
    return this.run(async () => structuredClone((await this.read()).slots[slotKey(portal, slot)] ?? { current: null, versions: [] }));
  }
  /** The pack with each current learned path over its repo recipe. A saved path is re-checked here: one for another
   * portal, slot or origin, or one the pack no longer accepts (shape, consequential or forbidden labels), is skipped. */
  apply(pack: PortalRecipePack): Promise<PortalRecipePack> {
    return this.run(async () => {
      const doc = await this.read(); let merged = pack;
      for (const slot of Object.keys(LEARNABLE_SLOTS[pack.portal] ?? {})) {
        const entry = doc.slots[slotKey(pack.portal, slot)];
        const version = Array.isArray(entry?.versions) ? entry.versions.find(v => object(v) && v.revision === entry.current) : undefined;
        if (!version || version.portal !== pack.portal || version.slot !== slot || !learnableSlot(merged, slot) || !object(version.provenance) || version.provenance.origin !== pack.origin) continue;
        try { merged = applyPath(merged, { slot, steps: pathSteps(merged, version.steps) }); } catch { /* the repo path stays */ }
      }
      return merged;
    });
  }
}
let defaults: { paths: PortalPathStore; evidence: PortalEvidenceStore } | null = null;
export const portalPaths = () => (defaults ??= { paths: new PortalPathStore(), evidence: new PortalEvidenceStore() }).paths;
export const portalEvidence = () => (defaults ??= { paths: new PortalPathStore(), evidence: new PortalEvidenceStore() }).evidence;
