import { AntigravityDriver } from "../drivers/antigravity.js";
import { BoxAgentDriver } from "../drivers/boxagent.js";
import { ClaudeDriver } from "../drivers/claude.js";
import { CodexDriver } from "../drivers/codex.js";
import { GrokDriver } from "../drivers/grok.js";
import { GrokAgentDriver } from "../drivers/acp/grok.js";
import { GeminiAgentDriver } from "../drivers/acp/gemini.js";
import { KimiAgentDriver } from "../drivers/acp/kimi.js";
import { HermesAgentDriver } from "../drivers/acp/hermes.js";
export const TEST_DRIVERS = [
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
