// Child for the chaos harness: the real Ask model relay (server/ask-model-relay.ts)
// under a fictional managed grant whose gateway is a loopback fake (through the
// sever proxy). Reports { url, token } over IPC; the token is this process's
// own per-start relay token, never an office key.
// Env from the parent: REALBUD_DATA_DIR, REALBUD_HERMES_HOME, CHAOS_GATEWAY_URL, CHAOS_MODEL_KEY.
import { join } from "node:path";

const { applyPropertyPack } = await import("../../server/hermes-pack.ts");
const { grantManagedAccess } = await import("../../server/testing/managed-grant.ts");
const { startAskModelRelay, applyAskModelRelayEnv } = await import("../../server/ask-model-relay.ts");
const { MANAGED_MODEL_CHOICES } = await import("../../shared/managed-model-choices.ts");

const root = process.env.REALBUD_HERMES_HOME;
applyPropertyPack(root);
grantManagedAccess(root, { baseUrl: process.env.CHAOS_GATEWAY_URL, key: process.env.CHAOS_MODEL_KEY, choice: "flash-high" });
// serviceFailure: no signed entitlement exists in this fixture, so the
// per-request entitlement check is replaced; every other relay check is real.
const relay = await startAskModelRelay({ root, overlayDir: join(process.env.REALBUD_DATA_DIR, "ask-model-relay"), serviceFailure: () => null });
const env = {};
const refusal = applyAskModelRelayEnv(env, root);
const model = MANAGED_MODEL_CHOICES.find((c) => c.id === "flash-high").model;
process.send({ url: relay.url, token: env.REALBUD_MODEL_API_KEY, model, refusal });
const quit = async () => { await relay.close(); process.exit(0); };
process.on("SIGTERM", quit);
process.on("disconnect", quit);
