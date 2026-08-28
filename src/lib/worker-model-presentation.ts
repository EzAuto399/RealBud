import { workerProvider } from "@shared/worker-providers";

export interface StoredWorkerModel {
  provider: string | null;
  model: string | null;
  keyPresent: boolean;
  keyHint?: string | null;
}

export function presentStoredWorkerModel(model: StoredWorkerModel | null | undefined): {
  ready: boolean;
  text: string;
} {
  if (!model?.provider || !model.model) return { ready: false, text: "not attached" };
  const provider = workerProvider(model.provider)?.label ?? model.provider;
  return {
    ready: model.keyPresent,
    text: `${provider} · ${model.model} · ${model.keyPresent ? "key stored securely" : "key required"}`,
  };
}
