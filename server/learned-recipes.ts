// Watch and learn drafts (docs/decisions/2026-10-07-watch-and-learn.md): the
// recipes a person showed Bud, kept in DATA_DIR/learned-recipes.json until
// staff review and publish them. A published recipe is merged into the
// shipped portal pack as a read recipe carrying its own confirmed labels, which
// are read-safe only in a task that runs it (server/portal-recipe-task.ts); the
// runner, broker and fence decide every step exactly as for a shipped recipe.
import { randomUUID } from "node:crypto";
import { PrivateStorageError, readPrivateJson, writePrivateJson } from "./private-json.ts";
import { parsePortalRecipePack, type PortalPackRecipe, type PortalRecipePack, type PortalRecipeStep } from "./portal-recipe.ts";
import { redactSecretsInText } from "./redact.ts";
import { accessibleName, AFFIRMATIVE, consequentialKind, CREDENTIAL_FIELD, DOWNLOAD_AFFORDANCE, SIGN_IN_CONTROL, SUBMIT_CONTROL } from "./browser-authority.ts";
import { LEARN_INPUT, LEARN_MAX_EVENTS, LEARN_MAX_TEXT, LEARN_NAME, learnBlockers, type LearnedRecipe, type LearnFlag, type LearnStep } from "../shared/learned-recipes.ts";

const MAX_BYTES = 2_000_000;
const PURPOSE = "realbud-learned-recipes";
const FLAG_CODES = ["needs-confirm", "outside-main", "forbidden-area", "unsupported", "off-portal"];
export const LEARNED_RECIPES_DAMAGED = "Learned recipes need recovery: the saved file is damaged. RealBud kept it and won't change it until it is repaired.";
const CHANGED = "This recipe changed elsewhere. Reload and try again.";
interface LearnedRecipeDocument { version: 1; purpose: typeof PURPOSE; revision: number; recipes: LearnedRecipe[] }

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= LEARN_MAX_TEXT;
const texts = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(text);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Exactly one LearnStep, nothing extra. Throws a plain sentence. */
function parseStep(value: unknown): LearnStep {
  const bad = () => fail(400, "A recipe step is not one RealBud can replay.");
  if (!object(value) || Object.keys(value).length !== 1) throw bad();
  const [verb] = Object.keys(value); const arg = value[verb];
  const ok =
    verb === "nav" ? texts(arg, 6) && arg.length >= 1 :
    verb === "click" || verb === "radio" ? text(arg) :
    verb === "type" ? object(arg) && exactKeys(arg, ["field", "value"]) && text(arg.field) && text(arg.value) :
    verb === "select" ? object(arg) && exactKeys(arg, ["field", "option"]) && text(arg.field) && text(arg.option) :
    verb === "wait" ? arg === "modal" || arg === "table" :
    verb === "read" ? arg === "table" || arg === "controls" :
    verb === "paginate" ? arg === true : false;
  if (!ok) throw bad();
  return structuredClone(value) as LearnStep;
}
function parseSteps(value: unknown): LearnStep[] {
  if (!Array.isArray(value) || value.length > LEARN_MAX_EVENTS) throw fail(400, "A recipe step is not one RealBud can replay.");
  return value.map(parseStep);
}
function parseFlags(value: unknown): LearnFlag[] {
  if (!Array.isArray(value) || value.length > LEARN_MAX_EVENTS || !value.every(flag => object(flag) && exactKeys(flag, ["code", "label"]) && FLAG_CODES.includes(String(flag.code)) && text(flag.label))) throw fail(400, "A recipe flag is not one RealBud knows.");
  return structuredClone(value) as LearnFlag[];
}
export function parseLearnTitle(value: unknown): string {
  const title = typeof value === "string" ? redactSecretsInText(value.trim()) : "";
  if (!title || title.length > 80) throw fail(400, "Give the recipe a name of 1 to 80 characters.");
  return title;
}
/** `{key}` placeholders the runner fills, in step order. */
function stepInputs(steps: LearnStep[]): string[] {
  const keys = steps.flatMap(step => JSON.stringify(step).match(/\{(\w+)\}/g) ?? []).map(match => match.slice(1, -1));
  if (keys.some(key => !LEARN_INPUT.test(key))) throw fail(400, "Input names use lowercase letters, digits and underscores, starting with a letter.");
  return [...new Set(keys)];
}
/** The one spelling of a learned label (recorder, compiler, store, risk check): the broker's own accessibleName
 * (NFKC, format characters dropped, spaces collapsed, trimmed, one trailing ":" dropped), so both read a label alike. */
export function learnLabel(value: string): string {
  return accessibleName(value);
}
/** Printable ASCII and common Latin-1 punctuation (REI is English): anything else, a Cyrillic "а" in "Ѕаvе" or
 * an accent, could hide a risk word, so Bud can't check it. */
const LEARN_LABEL_CHARS = /^[\x20-\x7e\u00a1-\u00bf]+$/;
/** Already in learnLabel's form and made only of characters Bud can check. A stored or recorded label that isn't is never confirmed or published. */
export const learnLabelSupported = (label: string): boolean => LEARN_LABEL_CHARS.test(label) && learnLabel(label) === label;
/** A learned recipe as merged into a pack: its own confirmed labels, never the pack's read-safe list. */
export type LearnedPackRecipe = PortalPackRecipe & { confirmed: string[] };
const wordIn = (word: string, label: string) => new RegExp(`(?<!\\w)${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "i").test(label);
/** A click label Bud must never press on a reviewer's say-so, judged on its learnLabel form: it has characters Bud
 * can't check, or it names (even inside a longer label, any case, or split by one space or mark: "S ave") one of the
 * shipped pack's consequential labels, or it would confirm, submit, pay, sign, send, delete, sign in or
 * download/export by the browser broker's own words. Once confirmed, a label is read-safe in a task that runs its
 * recipe, and pressControl lets read-safe labels through before its submit checks.
 * An exact shipped read-safe label (Next, Search) is already allowed and is not risky. */
export function learnLabelRisky(labels: { readSafe: string[]; consequential: string[] }, label: string): boolean {
  const name = learnLabel(label);
  if (!learnLabelSupported(name)) return true;
  if (labels.readSafe.some(safe => learnLabel(safe) === name)) return false;
  const joined = [...name.matchAll(/[^A-Za-z0-9]/g)].map(mark => name.slice(0, mark.index) + name.slice(mark.index + 1));
  return [name, ...joined].some(text => labels.consequential.some(word => wordIn(word, text)) || consequentialKind(text) !== null ||
    SUBMIT_CONTROL.test(text) || AFFIRMATIVE.test(text) || CREDENTIAL_FIELD.test(text) || SIGN_IN_CONTROL.test(text) || DOWNLOAD_AFFORDANCE.test(text));
}
/** Every label a recipe names: clicks, choices, fields, menu items, stop and confirmed labels. */
const recipeLabels = (recipe: Pick<LearnedRecipe, "steps" | "stopBefore" | "confirmedLabels">): string[] => [...recipe.stopBefore, ...recipe.confirmedLabels,
  ...recipe.steps.flatMap(step => "click" in step ? [step.click] : "radio" in step ? [step.radio] : "type" in step ? [step.type.field] : "select" in step ? [step.select.field] : "nav" in step ? step.nav : [])];
/** learnBlockers plus what only the server knows: a confirmed risky label, or a stop label the shipped pack doesn't list.
 * `labels` is always the SHIPPED pack's, never a merged pack whose read-safe list grew. */
function publishBlockers(recipe: LearnedRecipe, labels: { readSafe: string[]; consequential: string[] }): string[] {
  return [...learnBlockers(recipe, labels),
    // A tampered file, or a draft recorded before labels were normalised, never brings a hidden spelling in.
    ...recipeLabels(recipe).filter(label => !learnLabelSupported(label)).map(label => `unsupported label: ${label}`),
    ...recipe.confirmedLabels.filter(label => learnLabelRisky(labels, label)).map(label => `consequential: ${label}`),
    ...recipe.stopBefore.filter(label => !labels.consequential.includes(label)).map(label => `unknown stop: ${label}`)];
}
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "recipe";

function validRecipe(value: unknown): value is LearnedRecipe {
  if (!object(value) || value.version !== 1 || value.purpose !== "realbud-learned-recipe") return false;
  try {
    parseSteps(value.steps); parseFlags(value.flags);
    return typeof value.id === "string" && /^lr_[0-9a-f]{24}$/.test(value.id) && typeof value.portal === "string" && typeof value.name === "string" && LEARN_NAME.test(value.name) &&
      typeof value.title === "string" && (value.state === "draft" || value.state === "published") && texts(value.inputs, 64) && value.inputs.every(key => LEARN_INPUT.test(key)) &&
      texts(value.stopBefore, LEARN_MAX_EVENTS) && texts(value.confirmedLabels, LEARN_MAX_EVENTS) &&
      Number.isInteger(value.createdAt) && Number.isInteger(value.updatedAt) && Number.isInteger(value.revision);
  } catch { return false; }
}
function validateDocument(value: unknown): asserts value is LearnedRecipeDocument {
  if (!object(value) || value.version !== 1 || value.purpose !== PURPOSE || !Number.isInteger(value.revision) || !Array.isArray(value.recipes) || !value.recipes.every(validRecipe)) throw fail(409, LEARNED_RECIPES_DAMAGED);
}

export function createLearnedRecipeStore(file: string) {
  const admission = { maxBytes: MAX_BYTES, validate: validateDocument };
  const load = async (): Promise<LearnedRecipeDocument> => {
    let value: unknown;
    try { value = await readPrivateJson(file, MAX_BYTES); }
    catch (error) { throw error instanceof PrivateStorageError ? error : fail(409, LEARNED_RECIPES_DAMAGED); }
    if (value === undefined) return { version: 1, purpose: PURPOSE, revision: 0, recipes: [] };
    validateDocument(value);
    return value;
  };
  // One write at a time; a failed write never blocks the next.
  let queue: Promise<unknown> = Promise.resolve();
  const mutate = <T>(change: (doc: LearnedRecipeDocument) => T): Promise<T> => {
    const run = queue.then(async () => {
      const doc = await load();
      const result = change(doc);
      doc.revision += 1;
      await writePrivateJson(file, doc, admission);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  };
  const find = (doc: LearnedRecipeDocument, id: string, expectedRevision: unknown): LearnedRecipe => {
    if (!Number.isInteger(expectedRevision)) throw fail(400, "Reload the recipe and try again.");
    const recipe = doc.recipes.find(item => item.id === id);
    if (!recipe) throw fail(404, "That learned recipe no longer exists.");
    if (recipe.revision !== expectedRevision) throw fail(409, CHANGED);
    return recipe;
  };
  const touch = (recipe: LearnedRecipe) => { recipe.revision += 1; recipe.updatedAt = Date.now(); return structuredClone(recipe); };

  return {
    async list(): Promise<LearnedRecipe[]> { return (await load()).recipes; },

    /** A new draft from a recording. Inputs are recomputed from the steps' `{key}` placeholders. */
    async create(input: { portal: string; title: string; steps: LearnStep[]; inputs?: string[]; stopBefore: string[]; flags: LearnFlag[] }): Promise<LearnedRecipe> {
      const title = parseLearnTitle(input.title), steps = parseSteps(input.steps), flags = parseFlags(input.flags);
      if (!texts(input.stopBefore, LEARN_MAX_EVENTS)) throw fail(400, "A recipe stop label is not valid.");
      const inputs = stepInputs(steps);
      return mutate(doc => {
        const taken = new Set(doc.recipes.filter(item => item.portal === input.portal).map(item => item.name));
        const base = `learned-${slug(title)}`;
        let name = base;
        for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
        const now = Date.now();
        const recipe: LearnedRecipe = { version: 1, purpose: "realbud-learned-recipe", id: `lr_${randomUUID().replace(/-/g, "").slice(0, 24)}`, portal: input.portal, name, title, state: "draft",
          steps, inputs, stopBefore: [...new Set(input.stopBefore)], confirmedLabels: [], flags, createdAt: now, updatedAt: now, revision: 1 };
        doc.recipes.push(recipe);
        return structuredClone(recipe);
      });
    },

    /** Review edits: steps may only be removed or have a typed value or chosen option changed; other flags may only
     * be acknowledged; confirmed labels are any clicked label that is not consequential.
     * needs-confirm flags are derived from `labels` (the shipped pack's) whenever steps or confirmations change. */
    update(id: string, expectedRevision: unknown, patch: { title?: unknown; steps?: unknown; confirmedLabels?: unknown; flags?: unknown }, labels: { readSafe: string[]; consequential: string[] }): Promise<LearnedRecipe> {
      return mutate(doc => {
        const recipe = find(doc, id, expectedRevision);
        if (recipe.state !== "draft") throw fail(409, "Unpublish this recipe before editing it.");
        const title = patch.title === undefined ? recipe.title : parseLearnTitle(patch.title);
        let steps = recipe.steps;
        if (patch.steps !== undefined) {
          steps = parseSteps(patch.steps);
          // Each kept step must match the next unused recorded step by verb and target, in order.
          let at = 0;
          for (const step of steps) {
            const match = (old: LearnStep) => "type" in step && "type" in old ? step.type.field === old.type.field
              : "select" in step && "select" in old ? step.select.field === old.select.field : same(step, old);
            while (at < recipe.steps.length && !match(recipe.steps[at])) at++;
            if (at++ >= recipe.steps.length) throw fail(400, "Steps can only be removed or have a typed value or chosen option changed.");
            // A typed value or chosen option is an input ({key}) or fixed text a reviewer pinned (such as "All").
            const value = "type" in step ? step.type.value : "select" in step ? step.select.option : null;
            if (value !== null) {
              if (/[{}]/.test(value) && !/^\{[a-z][a-z0-9_]{0,31}\}$/.test(value)) throw fail(400, "A typed value is either an input like {date_from} or plain text.");
              if (redactSecretsInText(value) !== value) throw fail(400, "A typed value looks like a password or key. Use an input instead.");
            }
          }
        }
        const inputs = stepInputs(steps);
        let flags = recipe.flags;
        if (patch.flags !== undefined) {
          // needs-confirm flags are derived below, so a client may send or omit them.
          flags = parseFlags(patch.flags).filter(flag => flag.code !== "needs-confirm");
          if (flags.some(flag => !recipe.flags.some(old => same(old, flag)))) throw fail(400, "Flags can only be acknowledged, never added.");
          flags = [...flags, ...recipe.flags.filter(flag => flag.code === "needs-confirm")];
        }
        const clicks = [...new Set(steps.flatMap(step => "click" in step ? [step.click] : []))];
        let confirmedLabels = recipe.confirmedLabels;
        if (patch.confirmedLabels !== undefined) {
          if (!texts(patch.confirmedLabels, LEARN_MAX_EVENTS) || patch.confirmedLabels.some(label => !clicks.includes(label))) throw fail(400, "Confirm only labels the recipe clicks.");
          const unchecked = patch.confirmedLabels.find(label => !learnLabelSupported(label));
          if (unchecked) throw fail(400, `${unchecked} has characters Bud can't check, so it can't be confirmed.`);
          const consequential = patch.confirmedLabels.find(label => learnLabelRisky(labels, label));
          if (consequential) throw fail(400, `${consequential} changes records, so Bud stops before it and it can't be confirmed.`);
          confirmedLabels = [...new Set(patch.confirmedLabels)];
        }
        confirmedLabels = confirmedLabels.filter(label => clicks.includes(label));
        if (patch.steps !== undefined || patch.confirmedLabels !== undefined) {
          flags = [...flags.filter(flag => flag.code !== "needs-confirm"),
            ...clicks.filter(label => !labels.readSafe.includes(label) && !confirmedLabels.includes(label)).map(label => ({ code: "needs-confirm" as const, label }))];
        }
        Object.assign(recipe, { title, steps, inputs, flags, confirmedLabels });
        return touch(recipe);
      });
    },

    /** Publish only when nothing blocks it and the pack still parses with every published recipe.
     * `pack` is the portal's SHIPPED pack (loadShippedPortalRecipePack), never a merged one. */
    publish(id: string, expectedRevision: unknown, pack: PortalRecipePack): Promise<LearnedRecipe> {
      return mutate(doc => {
        const recipe = find(doc, id, expectedRevision);
        if (recipe.state === "published") return structuredClone(recipe);
        if (recipe.portal !== pack.portal) throw fail(409, "This recipe belongs to another portal.");
        if (!recipe.steps.length) throw fail(409, "This recipe has no steps to repeat.");
        const blockers = [...new Set(publishBlockers(recipe, pack.labels))];
        if (blockers.length) throw fail(409, `Bud can't publish this yet: ${blockers.slice(0, 5).join("; ")}${blockers.length > 5 ? ` and ${blockers.length - 5} more` : ""}.`);
        if (Object.hasOwn(pack.recipes, recipe.name)) throw fail(409, `This portal already has a recipe named ${recipe.name}.`);
        let fits = false;
        try { fits = Object.hasOwn(mergeLearnedRecipes(pack, [...doc.recipes.filter(item => item.state === "published"), { ...recipe, state: "published" }]).recipes, recipe.name); }
        catch { /* not fitting */ }
        if (!fits) throw fail(409, "This recipe doesn't fit the portal's recipes. Remove the steps it flags and try again.");
        recipe.state = "published";
        return touch(recipe);
      });
    },

    unpublish(id: string, expectedRevision: unknown): Promise<LearnedRecipe> {
      return mutate(doc => { const recipe = find(doc, id, expectedRevision); recipe.state = "draft"; return touch(recipe); });
    },

    remove(id: string, expectedRevision: unknown): Promise<void> {
      return mutate(doc => { const recipe = find(doc, id, expectedRevision); doc.recipes = doc.recipes.filter(item => item !== recipe); });
    },
  };
}
export type LearnedRecipeStore = ReturnType<typeof createLearnedRecipeStore>;

/** The SHIPPED pack plus this portal's published learned recipes as read recipes.
 * A shipped recipe name is never overwritten and the publish gate is re-checked against the
 * shipped labels. The pack's read-safe list never grows: each recipe keeps its own confirmed
 * labels (`confirmed`), which only a task running it adds (server/portal-recipe-task.ts).
 * A recipe that fails any check, or makes the pack fail to parse, is skipped alone; the rest still join. */
export function mergeLearnedRecipes(pack: PortalRecipePack, recipes: LearnedRecipe[]): PortalRecipePack {
  const shipped = pack.labels;
  let out = parsePortalRecipePack(pack);
  // ponytail: one clone + parse per recipe; fine for a handful of learned recipes per portal.
  for (const recipe of recipes) {
    if (recipe.state !== "published" || recipe.portal !== pack.portal || !recipe.steps.length || Object.hasOwn(out.recipes, recipe.name)) continue;
    if (publishBlockers(recipe, shipped).length) continue;
    const next = structuredClone(out);
    const learned: LearnedPackRecipe = { kind: "read", tier: [], inputs: [...recipe.inputs], grantNeeds: [], steps: structuredClone(recipe.steps) as PortalRecipeStep[],
      stopBefore: [...recipe.stopBefore], confirmed: [...recipe.confirmedLabels] };
    next.recipes[recipe.name] = learned;
    try { out = parsePortalRecipePack(next); } catch { /* this recipe only */ }
  }
  return parsePortalRecipePack(out);
}
