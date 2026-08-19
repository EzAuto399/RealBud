// Legacy driver fleet for e2e tests ONLY — the child server registers these
// when spawned with OMB_TEST_FLEET=1. They are not agents in RealBud: the
// product fleet is the pinned Hermes worker alone (server/drivers/builtIn.ts).
import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "../drivers/antigravity.ts";
import { BoxAgentDriver } from "../drivers/boxagent.ts";
import { ClaudeDriver } from "../drivers/claude.ts";
import { CodexDriver } from "../drivers/codex.ts";
import { GrokDriver } from "../drivers/grok.ts";
import { GrokAgentDriver } from "../drivers/acp/grok.ts";
import { GeminiAgentDriver } from "../drivers/acp/gemini.ts";
import { KimiAgentDriver } from "../drivers/acp/kimi.ts";
import { HermesAgentDriver } from "../drivers/acp/hermes.ts";

export const TEST_DRIVERS: readonly AnyProviderDriver[] = [
  GrokDriver,
  GrokAgentDriver,
  GeminiAgentDriver,
  KimiAgentDriver,
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  BoxAgentDriver,
  HermesAgentDriver,
];
