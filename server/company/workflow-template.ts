import { validateRecipe } from "../recipes.ts";
import type { Recipe } from "../../shared/contracts.ts";

const MAX_RECIPES = 100;
const MAX_BYTES = 24000;
const ID_RE = /^wf-[a-zA-Z0-9_-]{1,100}$/;

type TemplateRecipe = Pick<
  Recipe,
  | "id"
  | "title"
  | "description"
  | "steps"
  | "evidence"
  | "capabilities"
  | "allowedOrigins"
  | "limits"
  | "schedule"
>;

function bad(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

export function normalizeCompanyWorkflowTemplate(payload: unknown): {
  version: 1;
  recipes: TemplateRecipe[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    bad("That is not a workflow pack export.");
  }
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  } catch {
    bad("The template contains data that cannot be stored.");
  }
  if (row.version !== 1) bad("Unsupported workflow pack export version.");
  if (!Array.isArray(row.recipes) || row.recipes.length > MAX_RECIPES) {
    bad("A pack snapshot must contain a recipes list with at most 100 jobs.");
  }
  if (row.recipes.length < 1) bad("A company template needs at least one job.");
  const ids = new Set<string>();
  const recipes: TemplateRecipe[] = [];
  for (const raw of row.recipes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      bad("Each imported job must be a job card.");
    }
    const recipe = raw as Record<string, unknown>;
    if (typeof recipe.id !== "string" || !ID_RE.test(recipe.id)) {
      bad("Imported office jobs need a valid wf- identifier.");
    }
    if (ids.has(recipe.id)) bad("The snapshot contains duplicate job identifiers.");
    ids.add(recipe.id);
    let fields: ReturnType<typeof validateRecipe>;
    try {
      fields = validateRecipe(recipe);
    } catch (err) {
      bad(err instanceof Error ? err.message : "Each imported job must be a job card.");
    }
    if (recipe.schedule != null && fields.schedule == null) {
      bad("An imported schedule is invalid. Correct its time and weekdays.");
    }
    recipes.push({
      id: recipe.id,
      title: fields.title,
      description: fields.description,
      steps: fields.steps,
      evidence: fields.evidence,
      capabilities: fields.capabilities,
      allowedOrigins: fields.allowedOrigins,
      limits: fields.limits,
      schedule: null,
    });
  }
  const json = JSON.stringify({ version: 1, recipes });
  if (Buffer.byteLength(json, "utf8") > MAX_BYTES) bad("The template is too large to store.");
  return JSON.parse(json) as { version: 1; recipes: TemplateRecipe[] };
}
