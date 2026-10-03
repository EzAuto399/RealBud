/** The only models a RealBud office can run, all through its paired Modelvia grant.
 *
 * Owner decision 29 Sep 2026: RealBud desktop is managed-only. There is no
 * provider picker, no pasted key and no free-text model id. Each choice is one
 * gateway model plus one reasoning effort the gateway accepts for that model:
 * Modelvia answers `xhigh`/`max` on DeepSeek V4.1 Flash with 400
 * `unsupported_parameter:reasoning_effort`, so Flash only ever carries `high`.
 *
 * `supportsVision` marks a model that takes image input. The server writes it
 * into the worker profile as `model.supports_vision`, which is what lets Hermes
 * show its image tool for a custom gateway; Flash is text-only.
 *
 * Dependency-free: the server writes the worker profile from this table and
 * the renderer draws the three radio options from it.
 */

export const MANAGED_MODEL_CHOICES = [
  {
    id: "flash-high",
    model: "deepseek-v4.1-flash",
    effort: "high",
    supportsVision: false,
    label: "DeepSeek V4.1 Flash · High",
    detail: "Fast and economical for everyday office work.",
  },
  {
    id: "sonnet-high",
    model: "claude-sonnet-5.5",
    effort: "high",
    supportsVision: true,
    label: "Claude Sonnet 5.5 · High",
    detail: "Stronger reasoning for involved letters, comparisons and plans.",
  },
  {
    id: "sonnet-xhigh",
    model: "claude-sonnet-5.5",
    effort: "xhigh",
    supportsVision: true,
    label: "Claude Sonnet 5.5 · Extra high",
    detail: "Most careful reasoning. Slower, and uses more of the office's AI allowance.",
  },
] as const;

export type ManagedModelChoice = (typeof MANAGED_MODEL_CHOICES)[number];
export type ManagedModelChoiceId = ManagedModelChoice["id"];
export type ManagedReasoningEffort = ManagedModelChoice["effort"];

// Owner decision 30 Sep 2026: new and migrated offices start on Sonnet · High.
export const DEFAULT_MANAGED_MODEL_CHOICE: ManagedModelChoiceId = "sonnet-high";

export const MANAGED_MODEL_CHOICE_IDS = MANAGED_MODEL_CHOICES.map(choice => choice.id) as readonly ManagedModelChoiceId[];

export function isManagedModelChoice(value: unknown): value is ManagedModelChoiceId {
  return typeof value === "string" && (MANAGED_MODEL_CHOICE_IDS as readonly string[]).includes(value);
}

export function managedModelChoice(id: ManagedModelChoiceId): ManagedModelChoice;
export function managedModelChoice(id: unknown): ManagedModelChoice | null;
export function managedModelChoice(id: unknown): ManagedModelChoice | null {
  return MANAGED_MODEL_CHOICES.find(choice => choice.id === id) ?? null;
}

/** When a saved profile names a model RealBud offers but an effort it does not
 * pair with (e.g. Flash with `xhigh`), keep the office's model at `high`
 * rather than moving it to the default, which may be a costlier model. */
export function managedModelChoiceKeepingModel(model: unknown): ManagedModelChoiceId | null {
  return MANAGED_MODEL_CHOICES.find(choice => choice.model === model && choice.effort === "high")?.id ?? null;
}

/** The choice a saved (model, effort) pair represents, or null for anything
 * else — including `auto`, a retired model id, or Flash with `xhigh`. */
export function managedModelChoiceFor(model: unknown, effort: unknown): ManagedModelChoiceId | null {
  return MANAGED_MODEL_CHOICES.find(choice => choice.model === model && choice.effort === effort)?.id ?? null;
}

/** The one request body `POST /api/hermes/model` accepts: exactly `{ choice }`.
 * A provider, key, base URL or free-text model is refused, not ignored. */
export function normalizeManagedModelChoiceRequest(value: unknown): ManagedModelChoiceId {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Choose one of the three RealBud models.");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "choice") {
    throw new Error("RealBud uses this office's managed AI access. Choose one of the three RealBud models; a provider, key or model name cannot be set here.");
  }
  const choice = (value as { choice: unknown }).choice;
  if (!isManagedModelChoice(choice)) throw new Error("Choose one of the three RealBud models.");
  return choice;
}
