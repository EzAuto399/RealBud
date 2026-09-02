/** Curated key providers for You → Attach model. Ids and env vars match the
 * pinned worker's models.dev registry. Ask never collects these keys. */
export interface WorkerProvider {
  id: string;
  label: string;
  envVar: string;
  /** Small, provider-verified fallback shown when Hermes has not refreshed
   * its models.dev cache yet. The live cache remains the source for newly
   * released models; custom IDs are always accepted separately. */
  recommendedModels: readonly string[];
}

/** Hermes can keep a provider login under a profile-specific id while its
 * model catalogue uses the public provider id. These aliases let RealBud show
 * the right catalogue without replacing an existing OAuth login with an API
 * key configuration. */
export const WORKER_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "xai-oauth": "xai",
  "openai-oauth": "openai-api",
  "google-oauth": "google",
};

export const WORKER_PROVIDERS: WorkerProvider[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    recommendedModels: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-haiku-4-5"],
  },
  {
    id: "openai-api",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    recommendedModels: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"],
  },
  {
    id: "google",
    label: "Google",
    envVar: "GOOGLE_API_KEY",
    recommendedModels: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    recommendedModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
  },
  {
    id: "moonshotai",
    label: "Kimi (Moonshot)",
    envVar: "MOONSHOT_API_KEY",
    recommendedModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"],
  },
  {
    id: "xai",
    label: "xAI",
    envVar: "XAI_API_KEY",
    recommendedModels: ["grok-4.6", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-4.3"],
  },
  {
    id: "groq",
    label: "Groq",
    envVar: "GROQ_API_KEY",
    recommendedModels: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "openai/gpt-oss-20b", "groq/compound"],
  },
  {
    id: "mistral",
    label: "Mistral",
    envVar: "MISTRAL_API_KEY",
    recommendedModels: ["mistral-medium-2604", "mistral-small-2603", "mistral-large-2512", "mistral-small-latest"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    recommendedModels: [
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.6-terra",
      "x-ai/grok-4.6",
      "google/gemini-3.6-flash",
      "deepseek/deepseek-v4-pro",
      "moonshotai/kimi-k3",
    ],
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    envVar: "OLLAMA_CLOUD_API_KEY",
    recommendedModels: ["kimi-k3", "deepseek-v4-pro", "glm-5.3", "mistral-large-3:675b"],
  },
];

export function workerProvider(providerId: string | null | undefined): WorkerProvider | null {
  if (!providerId) return null;
  const canonical = WORKER_PROVIDER_ALIASES[providerId] ?? providerId;
  return WORKER_PROVIDERS.find((provider) => provider.id === canonical) ?? null;
}
