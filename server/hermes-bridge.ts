// Zero-terminal worker bridge: RealBud takes the PM's input and delivers it
// to the pinned Hermes worker programmatically. The user never sees a
// terminal and never runs the hermes CLI.
//
// Model attach recipe (proven against the pinned worker's own source):
//   - API keys live in the profile's `.env` as PROVIDER_API_KEY=…
//     (hermes resolves key-provider secrets from that dotenv first).
//   - The default model lives in the profile `config.yaml` model block:
//       model:
//         default: <model-id>
//         provider: <provider-id>
//         base_url: ''
// Install runs the pinned installer as a spawned child with streamed
// output — same command the terminal used to run, no terminal.
import { serviceSafeChildEnv } from "./service-child-env.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { WORKER_PROVIDERS, workerProvider, type WorkerProvider } from "../shared/worker-providers.ts";
import { writeFileAtomic } from "./atomic.ts";
import { augmentedPath, resetPathCache } from "./env-path.ts";
import { execCli } from "./procs.ts";
import { HERMES_PIN, hermesCli, hermesMatchesPin } from "./hermes-pin.ts";
import { hermesHome, propertyProfileDir, withYamlBlock, yamlBlock } from "./hermes-pack.ts";
import { clearHermesVersionCache, probeHermesVersion } from "./hermes-status.ts";
import { BootstrapError, finishWorkerBootstrap, runWorkerBootstrap } from "./worker-bootstrap.ts";
import { authHasProvider } from "./hermes-oauth.ts";
import { HERMES_RECOMMENDED, type HermesRelease } from "./hermes-releases.ts";
import { parseHermesVersion } from "./hermes-pin.ts";

export type ProviderOption = WorkerProvider;
export const PROVIDER_OPTIONS = WORKER_PROVIDERS;

export interface PreflightEntry {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  deps: PreflightEntry[];
}

function whichOne(bin: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execCli(bin, ["--version"], { timeout: 8_000, env: serviceSafeChildEnv({ PATH: augmentedPath() }) }, (err, stdout) => {
      resolve({ ok: !err, detail: err ? "not found" : String(stdout).trim().split("\n")[0]?.slice(0, 80) ?? "" });
    });
  });
}

export async function preflight(): Promise<PreflightResult> {
  const [curl, git, py] = await Promise.all([whichOne("curl"), whichOne("git"), whichOne("python3")]);
  const deps: PreflightEntry[] = [
    { name: "curl", ok: curl.ok, detail: curl.detail },
    { name: "git", ok: git.ok, detail: git.detail },
    { name: "python3", ok: py.ok, detail: py.detail },
  ];
  return { ok: deps.every((d) => d.ok), deps };
}

// ── install job (singleton: one worker install at a time) ────────────────

export interface InstallJob {
  state: "idle" | "preflight" | "running" | "verifying" | "done" | "failed";
  lines: string[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  progress?: { detail: string; step: number; total: number };
}

const installJob: InstallJob = { state: "idle", lines: [], startedAt: null, finishedAt: null, error: null };
let installProc: ChildProcess | null = null;
let bootstrapAbort: AbortController | null = null;
let bootstrapCompletion: Promise<void> = Promise.resolve();
export function waitForBootstrapStop() { return bootstrapCompletion; }

export function startBootstrapInstall(opts?: { timeoutMs?: number; onSuccess?: () => void | Promise<void>; commit?: () => void; release?: HermesRelease; run?: typeof runWorkerBootstrap; verify?: () => Promise<string | null> }): InstallJob {
  if (installInFlight()) return installStatus();
  // Resolve once, here. Previously an omitted `release` fell through to
  // `runWorkerBootstrap`'s default (the 0.20.3 compatibility floor) while
  // verification fell back to `hermesMatchesPin` (also 0.20.3) — so a caller
  // that forgot the argument installed the rollback build. The recommended
  // release is now the default for both the install and its verification.
  const release = opts?.release ?? HERMES_RECOMMENDED;
  const controller = new AbortController();
  bootstrapAbort = controller;
  Object.assign(installJob, { state: "preflight", lines: [], startedAt: Date.now(), finishedAt: null, error: null, progress: undefined });
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30 * 60_000);
  bootstrapCompletion = (async () => {
    let finalized = false;
    try {
      await (opts?.run ?? runWorkerBootstrap)({ release, home: hermesHome(), signal: controller.signal, progress: (detail, step, total) => {
        installJob.state = "running";
        installJob.progress = { detail, step, total };
        installJob.lines = [...installJob.lines.slice(-39), detail];
      }, finalize: async () => {
        controller.signal.throwIfAborted();
        installJob.state = "verifying";
        resetPathCache(); clearHermesVersionCache();
        const version = await (opts?.verify ?? (() => probeHermesVersion(hermesCli())))();
        controller.signal.throwIfAborted();
        const parsed = parseHermesVersion(version ?? "");
        const matches = parsed.product === release.product && parsed.calendar === release.tag.slice(1);
        if (!matches) throw new BootstrapError("Bud was downloaded but could not verify its installed version. Retry setup before starting work.");
        try { await opts?.onSuccess?.(); }
        catch { throw new BootstrapError("Bud is installed, but its private property setup could not be saved. Check available space and try setup again."); }
        controller.signal.throwIfAborted();
        if (!opts?.run) finishWorkerBootstrap(hermesHome());
        // Promote while the installer still holds its cross-process lock.
        // No await separates the last cancellation check and selection write.
        opts?.commit?.();
        finalized = true;
      } });
      if (!finalized) {
        controller.signal.throwIfAborted();
        throw new BootstrapError("Agent setup ended before verification. Your current agent is kept; retry setup.");
      }
      installJob.state = "done";
    } catch (error) {
      installJob.state = "failed";
      installJob.error = controller.signal.aborted ? "Setup stopped before it finished. Your property data is kept. Try again when you’re ready." : error instanceof BootstrapError ? error.message : "Bud setup could not finish. Check your connection, available space and folder permissions, then try again.";
    } finally {
      clearTimeout(timer); bootstrapAbort = null; installJob.finishedAt = Date.now();
    }
  })();
  return installStatus();
}

export function cancelBootstrapInstall(): InstallJob {
  bootstrapAbort?.abort();
  return installStatus();
}

export function installStatus(): InstallJob {
  return { ...installJob, lines: installJob.lines.slice(-40) };
}

export function installInFlight(): boolean {
  return installJob.state === "running" || installJob.state === "verifying" || installJob.state === "preflight";
}

export function startInstall(command: string, opts?: { timeoutMs?: number; onSuccess?: () => void | Promise<void> }): InstallJob {
  if (installInFlight()) {
    return installStatus();
  }
  installJob.state = "running";
  installJob.lines = [];
  installJob.startedAt = Date.now();
  installJob.finishedAt = null;
  installJob.error = null;

  const push = (line: string) => {
    for (const part of String(line).split(/\r?\n/)) {
      const trimmed = part.trim();
      if (trimmed) installJob.lines.push(trimmed.slice(0, 200));
    }
    if (installJob.lines.length > 400) installJob.lines.splice(0, installJob.lines.length - 400);
  };

  const child = spawn("/bin/bash", ["-c", command], {
    env: serviceSafeChildEnv({ PATH: augmentedPath() }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  installProc = child;
  child.stdout?.on("data", (c) => push(String(c)));
  child.stderr?.on("data", (c) => push(String(c)));
  const timeout = setTimeout(() => {
    if (installProc === child) child.kill("SIGKILL");
  }, opts?.timeoutMs ?? 10 * 60_000);

  child.on("close", async (code) => {
    clearTimeout(timeout);
    if (installProc !== child) return;
    installProc = null;
    if (code !== 0) {
      installJob.state = "failed";
      installJob.error = `installer exited ${code}`;
      installJob.finishedAt = Date.now();
      return;
    }
    installJob.state = "verifying";
    clearHermesVersionCache();
    let version: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      version = await probeHermesVersion("hermes");
      if (version && hermesMatchesPin(version)) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      clearHermesVersionCache();
    }
    if (version && hermesMatchesPin(version)) {
      if (opts?.onSuccess) {
        try {
          await opts.onSuccess();
        } catch (err) {
          installJob.state = "failed";
          installJob.error = err instanceof Error ? err.message : String(err);
          installJob.finishedAt = Date.now();
          return;
        }
      }
      installJob.state = "done";
      installJob.lines.push(`verified ${version.trim().slice(0, 60)}`);
    } else {
      installJob.state = "failed";
      installJob.error = version
        ? `installed ${version.trim()}, pin is v${HERMES_PIN.product} (${HERMES_PIN.tag})`
        : "worker not found on PATH after install";
    }
    installJob.finishedAt = Date.now();
  });
  child.on("error", (err) => {
    clearTimeout(timeout);
    if (installProc !== child) return;
    installProc = null;
    installJob.state = "failed";
    installJob.error = err.message;
    installJob.finishedAt = Date.now();
  });
  return installStatus();
}

// ── model attach ─────────────────────────────────────────────────────────

export function providerOption(providerId: string): ProviderOption | null {
  return workerProvider(providerId);
}

function upsertEnvLine(envPath: string, key: string, value: string): void {
  let body = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = body.length ? body.replace(/\s+$/, "").split("\n") : [];
  const pattern = new RegExp(`^${key}=`);
  const idx = lines.findIndex((line) => pattern.test(line));
  const next = `${key}=${value}`;
  if (idx >= 0) lines[idx] = next;
  else lines.push(next);
  body = lines.join("\n") + "\n";
  writeFileAtomic(envPath, body, 0o600);
  try { chmodSync(envPath, 0o600); } catch { /* best effort */ }
}

function validatedModelId(value: unknown): string {
  const model = String(value ?? "").trim();
  if (!model) throw Object.assign(new Error("model id is required"), { status: 400 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model)) {
    throw Object.assign(new Error("model id contains unsupported characters"), { status: 400 });
  }
  return model;
}

function validatedApiKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (key.length > 4_096 || /[\r\n\0]/.test(key)) {
    throw Object.assign(new Error("api key format is not supported"), { status: 400 });
  }
  return key;
}

function validatedBaseUrl(value: unknown): string {
  const baseUrl = String(value ?? "").trim();
  if (!baseUrl) return "";
  if (baseUrl.length > 2_048) throw Object.assign(new Error("base URL is too long"), { status: 400 });
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw Object.assign(new Error("base URL must be a complete http or https URL"), { status: 400 });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error("base URL must be an http or https URL without embedded credentials"), { status: 400 });
  }
  return baseUrl;
}

export interface AttachModelInput {
  providerId: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface ModelStatus {
  provider: string | null;
  model: string | null;
  keyPresent: boolean;
  /** masked credential hint, e.g. "sk-a…9f2" — never the key itself */
  keyHint: string | null;
}

export interface WorkerModelOption {
  id: string;
  name: string;
  releaseDate: string | null;
  recommended: boolean;
}

/** Model ids for a provider, from the worker's own cache (same data the
 * interactive picker shows). Empty when the cache has nothing — the UI keeps
 * free-text entry as the fallback. */
const CACHE_ALIASES: Record<string, string> = { "openai-api": "openai" };

type CachedWorkerModel = {
  id?: unknown;
  name?: unknown;
  release_date?: unknown;
  last_updated?: unknown;
  tool_call?: unknown;
  modalities?: { output?: unknown };
};

function providerCacheKeys(providerId: string): string[] {
  const canonical = providerOption(providerId)?.id ?? providerId;
  return [providerId, canonical, CACHE_ALIASES[canonical]].filter(
    (id, index, all): id is string => Boolean(id) && all.indexOf(id) === index,
  );
}

/** Hermes live `/v1/models` cache written by the worker after login/refresh. */
function liveProviderModelIds(providerId: string, root?: string): string[] {
  const keys = providerCacheKeys(providerId);
  const paths = [
    join(propertyProfileDir(root), "provider_models_cache.json"),
    join(hermesHome(root), "provider_models_cache.json"),
  ];
  for (const path of paths) {
    try {
      const cache = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        { models?: unknown } | undefined
      >;
      for (const key of keys) {
        const models = cache[key]?.models;
        if (!Array.isArray(models) || models.length === 0) continue;
        return models
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id) => id.trim());
      }
    } catch {
      /* try the next cache path */
    }
  }
  return [];
}

function cachedModels(providerId: string, root?: string): Record<string, CachedWorkerModel> {
  const keys = providerCacheKeys(providerId);
  const paths = [join(hermesHome(root), "models_dev_cache.json"), join(propertyProfileDir(root), "models_dev_cache.json")];
  for (const path of paths) {
    try {
      const cache = JSON.parse(readFileSync(path, "utf8")) as Record<string, { models?: Record<string, CachedWorkerModel> } | undefined>;
      for (const key of keys) {
        const entry = cache[key]?.models;
        if (entry && typeof entry === "object") return entry;
      }
    } catch {
      /* try the next cache path */
    }
  }
  return {};
}

function isTextWorkerModel(id: string, model?: CachedWorkerModel): boolean {
  if (model) {
    const output = model.modalities?.output;
    if (Array.isArray(output) && !output.includes("text")) return false;
    if (model.tool_call === false) return false;
  }
  return !/(?:^|[-/:])(audio|embed|embedding|guard|image|imagine|moderation|music|ocr|speech|tts|video|veo|whisper)(?:$|[-/:.])/i.test(id);
}

function modelName(id: string, model?: CachedWorkerModel): string {
  const named = typeof model?.name === "string" ? model.name.trim() : "";
  return named || id;
}

function modelDate(model?: CachedWorkerModel): string | null {
  const value = typeof model?.release_date === "string"
    ? model.release_date
    : typeof model?.last_updated === "string"
      ? model.last_updated
      : "";
  return /^\d{4}-\d{2}(?:-\d{2})?$/.test(value) ? value : null;
}

/** Prefer Hermes' live provider model list. Fall back to models.dev + curated
 * recommended ids only when that cache is empty. */
export function listModelOptions(providerId: string, root?: string): WorkerModelOption[] {
  const provider = providerOption(providerId);
  if (!provider) return [];
  const meta = cachedModels(providerId, root);
  const live = liveProviderModelIds(providerId, root).filter((id) => isTextWorkerModel(id, meta[id]));
  if (live.length > 0) {
    return live.map((id) => ({
      id,
      name: modelName(id, meta[id]),
      releaseDate: modelDate(meta[id]),
      recommended: false,
    }));
  }

  const out: WorkerModelOption[] = [];
  const seen = new Set<string>();
  for (const id of provider.recommendedModels) {
    const model = meta[id];
    out.push({ id, name: modelName(id, model), releaseDate: modelDate(model), recommended: true });
    seen.add(id);
  }
  const recent = Object.entries(meta)
    .filter(([id, model]) => !seen.has(id) && isTextWorkerModel(id, model))
    .sort(([leftId, left], [rightId, right]) => {
      const byDate = String(modelDate(right) ?? "").localeCompare(String(modelDate(left) ?? ""));
      return byDate || leftId.localeCompare(rightId, undefined, { numeric: true });
    })
    .slice(0, 12);
  for (const [id, model] of recent) {
    out.push({ id, name: modelName(id, model), releaseDate: modelDate(model), recommended: false });
  }
  return out;
}

export function listModels(providerId: string, root?: string): string[] {
  const live = liveProviderModelIds(providerId, root).filter((id) => isTextWorkerModel(id));
  if (live.length > 0) {
    return [...live].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  return Object.keys(cachedModels(providerId, root))
    .filter((id) => !/imagine|video|image/i.test(id))
    .sort((a, b) => a.localeCompare(b));
}

export function modelStatus(root?: string): ModelStatus {
  const configPath = join(propertyProfileDir(root), "config.yaml");
  const mask = (value: string): string =>
    value.length <= 8 ? `${value.slice(0, 2)}…` : `${value.slice(0, 4)}…${value.slice(-4)}`;
  let provider: string | null = null;
  let model: string | null = null;
  try {
    const block = yamlBlock(readFileSync(configPath, "utf8"), "model");
    provider = block ? /^[ \t]+provider:\s*(\S+)/m.exec(block)?.[1] ?? null : null;
    model = block ? /^[ \t]+default:\s*(\S+)/m.exec(block)?.[1] ?? null : null;
  } catch { /* no config yet */ }
  let keyPresent = false;
  let keyHint: string | null = null;
  // Only direct key-provider ids read the profile .env. Aliased ids such as
  // xai-oauth must keep using Hermes' opaque auth store.
  const providerConfig = provider ? PROVIDER_OPTIONS.find((option) => option.id === provider) ?? null : null;
  if (providerConfig) {
    try {
      const envPath = join(propertyProfileDir(root), ".env");
      if (existsSync(envPath)) {
        const envBody = readFileSync(envPath, "utf8");
        const match = new RegExp(`^${providerConfig.envVar}=(.+)$`, "m").exec(envBody);
        if (match?.[1]?.trim()) {
          keyPresent = true;
          keyHint = `${providerConfig.envVar} ${mask(match[1].trim())}`;
        }
      }
    } catch { /* unreadable credentials stay disconnected */ }
  } else if (provider && authHasProvider(provider, root)) {
    keyPresent = true;
    keyHint = `${provider} profile login`;
  }
  return { provider, model, keyPresent, keyHint };
}

export function attachModel(input: AttachModelInput, opts?: { root?: string }): ModelStatus {
  const option = providerOption(input.providerId);
  if (!option) throw Object.assign(new Error("unknown provider"), { status: 400 });
  const model = validatedModelId(input.model);
  const key = validatedApiKey(input.apiKey);
  const baseUrl = validatedBaseUrl(input.baseUrl);
  const currentStatus = modelStatus(opts?.root);
  const profileLogin = input.providerId !== option.id;
  const oauthReady = profileLogin && authHasProvider(input.providerId, opts?.root);
  const keepsProfileLogin =
    profileLogin
    && ((currentStatus.provider === input.providerId && currentStatus.keyPresent) || oauthReady);

  if (profileLogin && key) {
    throw Object.assign(new Error("the current Hermes login does not accept a pasted API key"), { status: 400 });
  }
  if (profileLogin && !keepsProfileLogin) {
    throw Object.assign(new Error("the current Hermes login is no longer available"), { status: 400 });
  }

  const profileDir = propertyProfileDir(opts?.root);
  if (!existsSync(join(profileDir, "SOUL.md"))) {
    throw Object.assign(new Error("the worker pack is not installed — apply the pack first"), { status: 409 });
  }

  // an empty key means "keep the current credential" — but only if the new
  // provider actually has one; switching providers always needs a fresh key
  const envPath = join(profileDir, ".env");
  const hasExistingKey =
    existsSync(envPath) && new RegExp(`^${option.envVar}=.+`, "m").test(readFileSync(envPath, "utf8"));
  if (!key && !hasExistingKey && !keepsProfileLogin) {
    throw Object.assign(new Error(`an api key is required for ${option.label}`), { status: 400 });
  }
  if (key) upsertEnvLine(envPath, option.envVar, key);

  const configPath = join(profileDir, "config.yaml");
  const existingConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const provider = keepsProfileLogin ? input.providerId : option.id;
  const block =
    `model:\n  default: ${model}\n  provider: ${provider}\n  base_url: ${baseUrl ? JSON.stringify(baseUrl) : "''"}\n`;
  writeFileAtomic(configPath, withYamlBlock(existingConfig, "model", block));

  const status = modelStatus(opts?.root);
  return { ...status, keyPresent: true };
}
