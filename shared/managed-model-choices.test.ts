import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGED_MODEL_CHOICE, MANAGED_MODEL_CHOICES, isManagedModelChoice, managedModelChoice,
  managedModelChoiceKeepingModel, managedModelChoiceFor,
  normalizeManagedModelChoiceRequest,
} from "./managed-model-choices.ts";

describe("managed model choices", () => {
  it("offers exactly the three owner-approved choices, defaulting to Sonnet · High", () => {
    expect(MANAGED_MODEL_CHOICES.map(({ id, model, effort, label }) => ({ id, model, effort, label }))).toEqual([
      { id: "flash-high", model: "deepseek-v4.1-flash", effort: "high", label: "DeepSeek V4.1 Flash · High" },
      { id: "sonnet-high", model: "claude-sonnet-5.5", effort: "high", label: "Claude Sonnet 5.5 · High" },
      { id: "sonnet-xhigh", model: "claude-sonnet-5.5", effort: "xhigh", label: "Claude Sonnet 5.5 · Extra high" },
    ]);
    expect(DEFAULT_MANAGED_MODEL_CHOICE).toBe("sonnet-high");
    expect(managedModelChoice("sonnet-xhigh").effort).toBe("xhigh");
    expect(managedModelChoice("auto")).toBeNull();
    // A saved model RealBud offers keeps its model at `high`; anything else has no keep.
    expect(managedModelChoiceKeepingModel("deepseek-v4.1-flash")).toBe("flash-high");
    expect(managedModelChoiceKeepingModel("claude-sonnet-5.5")).toBe("sonnet-high");
    expect(managedModelChoiceKeepingModel("auto")).toBeNull();
  });

  it("never pairs Flash with a reasoning effort Modelvia refuses", () => {
    for (const choice of MANAGED_MODEL_CHOICES.filter(row => row.model === "deepseek-v4.1-flash")) expect(choice.effort).toBe("high");
    expect(managedModelChoiceFor("deepseek-v4.1-flash", "xhigh")).toBeNull();
    expect(managedModelChoiceFor("deepseek-v4.1-flash", "max")).toBeNull();
    expect(managedModelChoiceFor("claude-sonnet-5.5", "xhigh")).toBe("sonnet-xhigh");
    expect(managedModelChoiceFor("auto", "high")).toBeNull();
    expect(managedModelChoiceFor("claude-sonnet-5.5", null)).toBeNull();
  });

  it("accepts only an exact { choice } body", () => {
    expect(normalizeManagedModelChoiceRequest({ choice: "sonnet-high" })).toBe("sonnet-high");
    for (const body of [null, [], "flash-high", {}, { choice: "flash-xhigh" }, { choice: "auto" }, { choice: "flash-high", apiKey: "fictional" },
      { providerId: "xai", model: "grok-4" }, { model: "claude-sonnet-5.5" }]) {
      expect(() => normalizeManagedModelChoiceRequest(body)).toThrow(/three RealBud models/);
    }
    expect(isManagedModelChoice("flash-high")).toBe(true);
    expect(isManagedModelChoice("FLASH-HIGH")).toBe(false);
  });
});
