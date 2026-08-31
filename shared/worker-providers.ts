/** Curated key providers for You → Attach model. Ids and env vars match the
 * pinned worker's models.dev registry. Ask never collects these keys. */
export interface WorkerProvider {
  id: string;
  label: string;
  envVar: string;
  exampleModel: string;
}

export const WORKER_PROVIDERS: WorkerProvider[] = [
  { id: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", exampleModel: "claude-sonnet-4-5" },
  { id: "openai-api", label: "OpenAI", envVar: "OPENAI_API_KEY", exampleModel: "gpt-5" },
  { id: "google", label: "Google", envVar: "GOOGLE_API_KEY", exampleModel: "gemini-2.5-pro" },
  { id: "deepseek", label: "DeepSeek", envVar: "DEEPSEEK_API_KEY", exampleModel: "deepseek-v4-pro" },
  { id: "moonshotai", label: "Kimi (Moonshot)", envVar: "MOONSHOT_API_KEY", exampleModel: "kimi-k3" },
  { id: "xai", label: "xAI", envVar: "XAI_API_KEY", exampleModel: "grok-4.5" },
  { id: "groq", label: "Groq", envVar: "GROQ_API_KEY", exampleModel: "llama-3.3-70b-versatile" },
  { id: "mistral", label: "Mistral", envVar: "MISTRAL_API_KEY", exampleModel: "mistral-small-latest" },
  { id: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", exampleModel: "anthropic/claude-sonnet-4.5" },
  { id: "ollama-cloud", label: "Ollama Cloud", envVar: "OLLAMA_CLOUD_API_KEY", exampleModel: "qwen3-coder:480b-cloud" },
];
