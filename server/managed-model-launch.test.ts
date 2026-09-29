/** Managed model access at every worker launch: key custody, refusals,
 * the operator receipt, and the product Bud's selection after a profile move.
 * All values fictional. */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyManagedModelProfile, applyPropertyPack, managedModelProfile, propertyProfileDir } from "./hermes-pack.ts";
import {
  MANAGED_ACCESS_MISMATCH, MANAGED_ACCESS_UNPAIRED, MANAGED_ACCESS_WITHDRAWN, applyManagedModelLaunchEnv, managedModelLaunchRefusal,
} from "./hermes-runtime-env.ts";
import { setWorkerModelGrant } from "./worker-model-access.ts";
import { modelStatus, reconcileManagedModelProfile, setManagedModelChoice } from "./hermes-bridge.ts";
import { writePrivateJson } from "./private-json.ts";
import { productAskFailure } from "./ask-book.ts";
import { productSelectionApproved, rebindProductBud } from "./product-bud-selection.ts";
import { Store } from "./store.ts";
import { HermesAgentDriver } from "./drivers/acp/hermes.ts";
import { recordEvents } from "./testing/events.ts";
import { clearManagedAccess, FICTIONAL_GATEWAY, FICTIONAL_GRANTED_KEY, grantManagedAccess } from "./testing/managed-grant.ts";
import { privateFixtureRoot } from "./testing/private-profile-fixture.ts";

const roots: string[] = [];
function home(): string {
  const root = privateFixtureRoot(join(tmpdir(), "realbud-managed-launch-")); roots.push(root);
  applyPropertyPack(root);
  return root;
}
const configOf = (root: string) => join(propertyProfileDir(root), "config.yaml");
const tamper = (root: string, from: string, to: string) => writeFileSync(configOf(root), readFileSync(configOf(root), "utf8").replace(from, to));
afterEach(() => { clearManagedAccess(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("managed launch guard", () => {
  it("adds the key only while the profile names exactly the granted endpoint and wire", () => {
    const root = home();
    expect(managedModelLaunchRefusal(root)).toBe(MANAGED_ACCESS_UNPAIRED);
    setWorkerModelGrant({ state: "withdrawn" });
    expect(managedModelLaunchRefusal(root)).toBe(MANAGED_ACCESS_WITHDRAWN);
    grantManagedAccess(root);
    const env: NodeJS.ProcessEnv = {};
    expect(applyManagedModelLaunchEnv(env, root)).toBeNull();
    expect(env.REALBUD_MODEL_API_KEY).toBe(FICTIONAL_GRANTED_KEY);
    // A trailing slash is the same endpoint.
    setWorkerModelGrant({ state: "active", baseUrl: `${FICTIONAL_GATEWAY}/`, keyId: "fictional-key-id", spendCapLabel: "cap" });
    expect(managedModelLaunchRefusal(root)).toBeNull();
    for (const [from, to] of [
      [FICTIONAL_GATEWAY, "https://attacker.invalid/v1"],
      ["key_env: REALBUD_MODEL_API_KEY", "key_env: OPENAI_API_KEY"],
      ["provider: custom:realbud", "provider: custom"],
      ["api_mode: chat_completions", "api_mode: codex_responses"],
      ["reasoning_effort: high", "reasoning_effort: xhigh"],
    ] as const) {
      const before = readFileSync(configOf(root), "utf8");
      tamper(root, from, to);
      const tampered: NodeJS.ProcessEnv = {};
      expect(applyManagedModelLaunchEnv(tampered, root), `${from} → ${to}`).toBe(MANAGED_ACCESS_MISMATCH);
      expect(tampered).toEqual({});
      writeFileSync(configOf(root), before);
    }
    // A dotenv key would outrank the launch env, so it holds the launch too.
    writeFileSync(join(propertyProfileDir(root), ".env"), "REALBUD_MODEL_API_KEY=fictional-shadow\n");
    expect(managedModelLaunchRefusal(root)).toBe(MANAGED_ACCESS_MISMATCH);
    expect(productAskFailure(`Error: ${MANAGED_ACCESS_MISMATCH}`)).toBe(MANAGED_ACCESS_MISMATCH);
    expect(productAskFailure(MANAGED_ACCESS_UNPAIRED)).toMatch(/Pair this computer from realbud\.app/);
  });

  it("reads a damaged or duplicate-key config as no choice, and refuses to write over it", () => {
    const root = home();
    grantManagedAccess(root);
    const env = join(propertyProfileDir(root), ".env");
    writeFileSync(env, "OPENAI_API_KEY=fictional-stale\n");
    writeFileSync(configOf(root), `${readFileSync(configOf(root), "utf8")}model:\n  default: claude-sonnet-5.5\n`);
    expect(managedModelProfile(root)).toMatchObject({ provider: null, choice: null });
    expect(managedModelLaunchRefusal(root)).toBe(MANAGED_ACCESS_MISMATCH);
    const damaged = readFileSync(configOf(root));
    expect(() => applyManagedModelProfile(FICTIONAL_GATEWAY, { root })).toThrow(/unreadable or duplicate/);
    // Nothing changed: the .env is only touched once the new config is valid.
    expect(readFileSync(env, "utf8")).toBe("OPENAI_API_KEY=fictional-stale\n");
    expect(readFileSync(configOf(root))).toEqual(damaged);
  });

  it("refuses the RealBud-selected worker before any process starts, in office language", async () => {
    const root = home();
    const make = () => HermesAgentDriver.create({
      instanceId: "fictional-bud", displayName: "Bud", enabled: true,
      environment: { REALBUD_HERMES_HOME: root }, config: { cli: "hermes", fullAuto: false },
    });
    for (const [prepare, expected] of [
      [() => clearManagedAccess(), MANAGED_ACCESS_UNPAIRED],
      [() => { grantManagedAccess(root); tamper(root, FICTIONAL_GATEWAY, "https://attacker.invalid/v1"); }, MANAGED_ACCESS_MISMATCH],
    ] as const) {
      prepare();
      const instance = await make();
      const recorder = recordEvents(instance.adapter);
      try {
        const outcome = await instance.adapter.sendTurn({ threadId: `refused-${expected.length}`, text: "hi" }).then(() => null, (error: Error) => error.message);
        if (outcome === null) await recorder.until(event => event.type === "turn.completed" || event.type === "runtime.error");
        const seen = `${outcome ?? ""} ${JSON.stringify(recorder.events)}`;
        expect(seen).toContain(expected);
        expect(seen).not.toContain(FICTIONAL_GRANTED_KEY);
      } finally { recorder.stop(); await instance.dispose(); }
    }
  }, 30_000);
});

describe("after a managed profile write", () => {
  it("keeps the operator receipt in step with a choice and a reconcile", async () => {
    const root = home(), data = privateFixtureRoot(join(tmpdir(), "realbud-managed-receipt-")); roots.push(data);
    const record = { version: 1, state: "active", installationId: "fictional-installation", companyId: "fictional-office", hostInstallationId: "fictional-host",
      provider: "modelvia", projectId: "fictional-project", keyId: "fictional-key-id", baseUrl: FICTIONAL_GATEWAY, spendCapLabel: "cap", apps: ["gmail"],
      provisionedAt: "2026-09-29T00:00:00.000Z",
      modelProfile: { provider: "openai-api", apiMode: "chat_completions", baseUrl: FICTIONAL_GATEWAY, model: "auto", envKeyRemoved: false, appliedAt: "2026-09-28T00:00:00.000Z" } };
    await writePrivateJson(join(data, "service-provisioning.json"), record);
    writeFileSync(configOf(root), `${readFileSync(configOf(root), "utf8")}model:\n  default: auto\n  provider: openai-api\n  base_url: "${FICTIONAL_GATEWAY}"\n  api_mode: chat_completions\n`);
    setWorkerModelGrant({ state: "active", baseUrl: FICTIONAL_GATEWAY, keyId: "fictional-key-id", spendCapLabel: "cap" });
    const receipt = () => JSON.parse(readFileSync(join(data, "service-provisioning.json"), "utf8")).modelProfile;
    expect(await reconcileManagedModelProfile(root, { dataDir: data })).toBe(true);
    expect(receipt()).toMatchObject({ provider: "custom:realbud", model: "claude-sonnet-5.5", choice: "sonnet-high" });
    await setManagedModelChoice({ choice: "sonnet-xhigh" }, { root, dataDir: data });
    expect(receipt()).toMatchObject({ provider: "custom:realbud", model: "claude-sonnet-5.5", choice: "sonnet-xhigh" });
    expect(JSON.stringify(receipt())).not.toContain("fictional-granted-key");
  });

  it("rebinds a Bud saved on `auto` so the managed turn gate admits its next turn", async () => {
    const root = home();
    const store = new Store(() => ({ instanceId: "fictional-hermes", model: "auto" }));
    store.seedIfEmpty();
    const bud = store.adoptBud({ instanceId: "fictional-hermes", model: "auto" })!;
    writeFileSync(configOf(root), `${readFileSync(configOf(root), "utf8")}model:\n  default: auto\n  provider: openai-api\n  base_url: "${FICTIONAL_GATEWAY}"\n  api_mode: chat_completions\n`);
    setWorkerModelGrant({ state: "active", baseUrl: FICTIONAL_GATEWAY, keyId: "fictional-key-id", spendCapLabel: "cap" });
    const approved = () => ({ instanceId: "fictional-hermes", model: modelStatus(root).model || "default" });
    expect(productSelectionApproved(bud.modelSelection, approved())).toBe(true); // before the upgrade move
    expect(await reconcileManagedModelProfile(root)).toBe(true);
    // The profile moved to the default (Sonnet · High); the stale `auto` selection would now be refused.
    expect(productSelectionApproved(bud.modelSelection, approved())).toBe(false);
    rebindProductBud(store, approved());
    expect(store.bot(bud.id)!.modelSelection).toEqual({ instanceId: "fictional-hermes", model: "claude-sonnet-5.5" });
    expect(productSelectionApproved(store.bot(bud.id)!.modelSelection, approved())).toBe(true);
    // And the turn's worker launch is admitted with the granted key.
    grantManagedAccess(root);
    const env: NodeJS.ProcessEnv = {};
    expect(applyManagedModelLaunchEnv(env, root)).toBeNull();
    expect(env.REALBUD_MODEL_API_KEY).toBe(FICTIONAL_GRANTED_KEY);
  });
});
