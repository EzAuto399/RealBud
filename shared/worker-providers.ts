/**
 * The small BYOK catalog RealBud can configure without opening a provider's
 * interactive login flow. IDs and environment variables mirror the pinned
 * worker registry; keeping the renderer and server on one list prevents a
 * provider from appearing in the UI without an authoritative server mapping.
 */
export interface WorkerProviderOption {
  id: string;
  label: string;
  family: string;
  envVar: string;
  alternateEnvVars: readonly string[];
  exampleModel: string;
  /** A short compatibility floor carried by RealBud itself. The worker's
   * cached discovery results are merged into these in the renderer, so an
   * empty or offline cache never leaves a PM typing a model id from memory. */
  recommendedModels: readonly WorkerModelRecommendation[];
}

export interface WorkerModelRecommendation {
  id: string;
  label: string;
  note: string;
}

export const WORKER_PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    family: "Claude",
    envVar: "ANTHROPIC_API_KEY",
    alternateEnvVars: ["ANTHROPIC_TOKEN"],
    exampleModel: "claude-sonnet-5",
    recommendedModels: [
      { id: "claude-sonnet-5", label: "Sonnet 5", note: "Balanced · recommended" },
      { id: "claude-fable-5", label: "Fable 5", note: "Latest · long-running agents" },
      { id: "claude-opus-5", label: "Opus 5", note: "Most capable" },
      { id: "claude-opus-4-8", label: "Opus 4.8", note: "Agentic coding" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", note: "Fast and economical" },
    ],
  },
  {
    id: "openai-api",
    label: "OpenAI",
    family: "GPT",
    envVar: "OPENAI_API_KEY",
    alternateEnvVars: [],
    exampleModel: "gpt-5.6-terra",
    recommendedModels: [
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", note: "Balanced · recommended" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", note: "Latest flagship" },
      { id: "gpt-5.6", label: "GPT-5.6", note: "Latest alias · currently Sol" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", note: "Fast and economical" },
    ],
  },
  {
    id: "gemini",
    label: "Google",
    family: "Gemini",
    envVar: "GOOGLE_API_KEY",
    alternateEnvVars: ["GEMINI_API_KEY"],
    exampleModel: "gemini-3.7-flash",
    recommendedModels: [
      { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", note: "Latest · recommended" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", note: "Stable frontier" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "Fast and economical" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", note: "Complex work · preview" },
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", note: "Compatible fallback" },
    ],
  },
  {
    id: "xai",
    label: "xAI",
    family: "Grok",
    envVar: "XAI_API_KEY",
    alternateEnvVars: [],
    exampleModel: "grok-4.6",
    recommendedModels: [
      { id: "grok-4.6", label: "Grok 4.6", note: "Latest · recommended" },
      { id: "grok-4.5", label: "Grok 4.5", note: "Coding and agents" },
      { id: "grok-4.5-latest", label: "Grok 4.5 Latest", note: "Moving alias" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    family: "Many model families",
    envVar: "OPENROUTER_API_KEY",
    alternateEnvVars: [],
    exampleModel: "anthropic/claude-sonnet-5",
    recommendedModels: [
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", note: "Balanced · recommended" },
      { id: "anthropic/claude-fable-5", label: "Claude Fable 5", note: "Latest Claude" },
      { id: "anthropic/claude-opus-5", label: "Claude Opus 5", note: "Most capable Opus" },
      { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", note: "Latest GPT flagship" },
      { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", note: "Balanced GPT" },
      { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", note: "Latest Gemini" },
      { id: "x-ai/grok-4.6", label: "Grok 4.6", note: "Latest Grok" },
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", note: "Capable reasoning" },
      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", note: "Economical reasoning" },
      { id: "moonshotai/kimi-k3", label: "Kimi K3", note: "Latest Kimi" },
      { id: "moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code", note: "Coding" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    family: "DeepSeek V4",
    envVar: "DEEPSEEK_API_KEY",
    alternateEnvVars: [],
    exampleModel: "deepseek-v4-flash",
    recommendedModels: [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", note: "Fast · recommended" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", note: "Latest flagship" },
    ],
  },
  {
    id: "kimi-coding",
    label: "Kimi",
    family: "Moonshot",
    envVar: "KIMI_API_KEY",
    alternateEnvVars: ["KIMI_CODING_API_KEY"],
    exampleModel: "kimi-k3",
    recommendedModels: [
      { id: "kimi-k3", label: "Kimi K3", note: "Latest · recommended" },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", note: "Coding" },
      { id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code Highspeed", note: "Faster coding" },
      { id: "kimi-k2.6", label: "Kimi K2.6", note: "Compatible fallback" },
      { id: "kimi-k2.5", label: "Kimi K2.5", note: "Works with existing Moonshot keys" },
    ],
  },
  {
    id: "zai",
    label: "Z.AI",
    family: "GLM",
    envVar: "GLM_API_KEY",
    alternateEnvVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    exampleModel: "glm-5.2",
    recommendedModels: [
      { id: "glm-5.2", label: "GLM-5.2", note: "Latest · recommended" },
      { id: "glm-5.1", label: "GLM-5.1", note: "Compatible fallback" },
      { id: "glm-5", label: "GLM-5", note: "Compatible fallback" },
    ],
  },
  {
    id: "minimax",
    label: "MiniMax",
    family: "MiniMax",
    envVar: "MINIMAX_API_KEY",
    alternateEnvVars: [],
    exampleModel: "MiniMax-M3",
    recommendedModels: [
      { id: "MiniMax-M3", label: "MiniMax M3", note: "Latest · recommended" },
      { id: "MiniMax-M2.7", label: "MiniMax M2.7", note: "Compatible fallback" },
    ],
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    family: "Hosted open models",
    envVar: "OLLAMA_API_KEY",
    alternateEnvVars: ["OLLAMA_CLOUD_API_KEY"],
    exampleModel: "qwen3.5:397b",
    recommendedModels: [
      { id: "qwen3.5:397b", label: "Qwen 3.5 397B", note: "Common tool-capable model" },
      { id: "deepseek-v4-pro:cloud", label: "DeepSeek V4 Pro", note: "Latest reasoning" },
      { id: "kimi-k3:cloud", label: "Kimi K3", note: "Latest Kimi" },
      { id: "kimi-k2.7-code:cloud", label: "Kimi K2.7 Code", note: "Coding" },
      { id: "glm-5.2:cloud", label: "GLM-5.2", note: "Latest GLM" },
      { id: "minimax-m3:cloud", label: "MiniMax M3", note: "Latest MiniMax" },
    ],
  },
] as const satisfies readonly WorkerProviderOption[];

export function workerProvider(providerId: string): WorkerProviderOption | null {
  return WORKER_PROVIDERS.find((provider) => provider.id === providerId) ?? null;
}
