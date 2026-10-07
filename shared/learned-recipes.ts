// Watch and learn: a person shows Bud a portal task once in the work browser,
// RealBud turns it into a DRAFT read recipe (realbud.portal-recipes.v1 steps),
// staff review and publish it, and the existing portal recipe runner replays it.
// Decision: docs/decisions/2026-10-07-watch-and-learn.md.
//
// Dependency-free. The recorder never keeps a typed value or a chosen option:
// every typed field and select becomes a `{key}` input the person fills when
// they run the recipe (review may pin fixed text instead).

/** One event the in-page listener reports. Page script is untrusted: the host validates every field. */
export type LearnLandmark = "navigation" | "main" | "dialog" | "other";
export type LearnEvent =
  | { kind: "click"; role: string; name: string; landmark: LearnLandmark }
  | { kind: "type"; field: string; landmark: LearnLandmark }
  /** A select changed: the field only, never the option chosen. */
  | { kind: "select"; field: string; landmark: LearnLandmark }
  | { kind: "radio"; name: string; landmark: LearnLandmark }
  /** A password or one-time-code field: recorded only as "the person signed in here". */
  | { kind: "secret"; landmark: LearnLandmark }
  /** A checkbox, file picker or other control the v1 recipe grammar cannot replay. */
  | { kind: "unsupported"; control: string; name: string; landmark: LearnLandmark }
  /** Host-observed (CDP Page.frameNavigated, main frame), never page-reported. */
  | { kind: "page"; url: string; table: boolean };

/** Why a draft cannot be published as recorded. Each blocks publish until edited away. */
export type LearnFlag =
  | { code: "needs-confirm"; label: string }        // click label not on the pack's read-safe list
  | { code: "outside-main"; label: string }         // control outside main/dialog/navigation: won't replay
  | { code: "forbidden-area"; label: string }       // menu path into an area the pack forbids
  | { code: "unsupported"; label: string }          // checkbox, file picker, …
  | { code: "off-portal"; label: string };          // the person left the portal's origin

export type LearnStep =
  | { nav: string[] }
  | { click: string }
  | { type: { field: string; value: string } }
  | { select: { field: string; option: string } }
  | { radio: string }
  | { wait: "modal" | "table" }
  | { read: "table" | "controls" }
  /** Read every further page with the pack's own pager control (after `read: "table"`). */
  | { paginate: true };

export interface LearnedRecipe {
  version: 1;
  purpose: "realbud-learned-recipe";
  id: string;                 // "lr_" + random
  portal: string;             // a key of PORTAL_RECIPE_PACKS
  name: string;               // recipe name in the merged pack: "learned-<slug>"
  title: string;              // what staff call it
  state: "draft" | "published";
  steps: LearnStep[];
  inputs: string[];           // `{key}` placeholders used by steps
  /** Consequential labels the person reached: Bud stops before them, never presses. */
  stopBefore: string[];
  /** Click labels a reviewer confirmed only open or show something. Never a consequential label. */
  confirmedLabels: string[];
  flags: LearnFlag[];
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface LearnSessionView {
  state: "idle" | "recording";
  portal: string | null;
  startedAt: number | null;
  events: number;
}

export interface LearnListView {
  session: LearnSessionView;
  recipes: LearnedRecipe[];
  portals: string[];
  /** Each portal's read-safe and consequential labels, so the review screen can show what still needs confirming. */
  labels: Record<string, { readSafe: string[]; consequential: string[] }>;
}

export const LEARN_MAX_EVENTS = 400;
export const LEARN_MAX_TEXT = 120;
export const LEARN_NAME = /^learned-[a-z0-9][a-z0-9-]{0,47}$/;
export const LEARN_INPUT = /^[a-z][a-z0-9_]{0,31}$/;
/** The `unsupported` flag label for a click on a table row's data; the data itself is never kept. */
export const LEARN_ROW_VALUE = "a value in a table row";

/** Field label → input key: "Date from" → "date_from". Never empty. */
export function learnInputKey(field: string): string {
  const key = field.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "").slice(0, 32);
  return key || "value";
}

/** Publish is blocked while any flag remains or any click label is neither read-safe nor confirmed. */
export function learnBlockers(recipe: Pick<LearnedRecipe, "steps" | "flags" | "confirmedLabels">, labels: { readSafe: string[]; consequential: string[] }): string[] {
  const out = recipe.flags.map(flag => `${flag.code}: ${flag.label}`);
  for (const label of recipe.confirmedLabels) if (labels.consequential.includes(label)) out.push(`consequential: ${label}`);
  for (const step of recipe.steps) {
    if ("click" in step && !labels.readSafe.includes(step.click) && !recipe.confirmedLabels.includes(step.click)) out.push(`needs-confirm: ${step.click}`);
  }
  return [...new Set(out)];
}
