// A non-Hermes ACP driver for acp/core.ts tests only, never registered. It
// rides the generic runtime with the options the retired subscription CLIs
// used (fail-closed auth, cross-process resume, persona-prefixed prompt) so
// core's shared paths and its Hermes-only gates keep their coverage.
import { createAcpDriver } from "../drivers/acp/core.ts";

export const FakeAcpDriver = createAcpDriver({
  driverKind: "fakeAcp",
  displayName: "Fake ACP",
  models: { default: "fake-model", options: [{ id: "fake-model", label: "Fake model" }] },
  defaultCli: "fake-acp",
  nativeSource: "fake.acp",
  loginNote: "Fake ACP CLI is not signed in",
  spawnArgs: (_config, turn) => [...(turn.model ? ["-m", turn.model] : []), "agent", "stdio"],
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: () => true,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
});
